"use strict";

const { app, BrowserWindow, Menu, shell, dialog, ipcMain } = require("electron");
const path = require("path");
const { spawn } = require("child_process");
const http = require("http");
const fs = require("fs");

const runtime = require("./runtime");

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/**
 * ROOT is the AURION tree that holds backend/, engine/, config/, lang/ and
 * apps/web/.  In dev that is the repository root; in a packaged build those
 * folders are shipped as extraResources next to the executable.
 */
function getRoot() {
  try {
    if (app.isPackaged) {
      const rp = process.resourcesPath;
      if (fs.existsSync(path.join(rp, "backend", "src", "index.js"))) return rp;
      const alt = path.resolve(rp, "..");
      if (fs.existsSync(path.join(alt, "backend", "src", "index.js"))) return alt;
      return rp;
    }
  } catch { /* fall through to the dev layout */ }
  return path.resolve(__dirname, "..", "..");
}

/**
 * The desk (backend/src/paths.js) and the engine (engine/aurion/config.py)
 * both resolve their state to <tree>/data.  The app has to look at the very
 * same folder, otherwise "Open logs" shows an empty directory while the real
 * desk.log sits in <tree>/data/logs.  windows-app/installer/install-windows.ps1 uses
 * <tree>/data/cache for its downloads too.
 *
 * That is also why the MSI installs per user (%LOCALAPPDATA%\Programs\AURION):
 * under C:\Program Files a standard user cannot create data/ at all.
 */
function getDataDir() {
  return path.join(getRoot(), "data");
}

let ROOT = getRoot();
let DATA_DIR = getDataDir();

function refreshRoots() {
  ROOT = getRoot();
  DATA_DIR = getDataDir();
  return { ROOT, DATA_DIR };
}

const DESK = process.env.AURION_DESK_URL || "http://127.0.0.1:8080";
const ENGINE_HOST = "127.0.0.1";
const ENGINE_PORT = 18765;
const APP_ID = "ai.aurion.desk";

let engineProc = null;
let deskProc = null;
let mainWin = null;

// Set while the post-install relaunch is in flight: closing every window for
// the relaunch must NOT trigger the window-all-closed -> app.quit() path.
let relaunching = false;
// Set once the installer window has reported success.  Closing the installer
// window any other way means the user gave up -> quit instead of lingering
// with zero visible windows.
let installCompleted = false;

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function secureMkdir(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* best effort */ }
}

function logLine(file, line) {
  try {
    const dir = path.join(DATA_DIR, "logs");
    secureMkdir(dir);
    const safe = runtime.redact(line);
    fs.appendFileSync(path.join(dir, file), safe.endsWith("\n") ? safe : safe + "\n");
  } catch { /* never let logging break startup */ }
}

// ---------------------------------------------------------------------------
// Prerequisite state
// ---------------------------------------------------------------------------

function checkPrereqs() {
  runtime.refreshPath(true);
  const checks = { python: false, node: false, pip: false, npm: false, backend: false, engine: false };
  const py = runtime.findPython();
  checks.python = Boolean(py);
  checks.pip = runtime.pythonHasPackages(py);
  const node = runtime.findNode();
  checks.node = Boolean(node);
  checks.backend = fs.existsSync(path.join(ROOT, "backend", "src", "index.js"));
  checks.engine = fs.existsSync(path.join(ROOT, "engine", "main.py"));
  // No package.json means there is nothing to install (dev tree without the
  // desk sources); a package.json without node_modules means "install me".
  checks.npm = fs.existsSync(path.join(ROOT, "backend", "package.json"))
    ? runtime.hasDeskPackages(ROOT)
    : true;
  checks.pythonVersion = py ? py.version : "";
  checks.nodeExe = node ? node.exe : "";
  checks.pythonLabel = py ? py.label : "";
  return checks;
}

// ---------------------------------------------------------------------------
// Installer
// ---------------------------------------------------------------------------

ipcMain.on("install-done", () => {
  installCompleted = true;
  relaunching = true;
  for (const w of BrowserWindow.getAllWindows()) {
    try { w.close(); } catch { /* already closing */ }
  }
  runtime.refreshPath(true);
  refreshRoots();
  setTimeout(() => {
    relaunching = false;
    createMainWindow().catch((e) => logLine("app.log", String(e)));
  }, 800);
});

ipcMain.handle("open-logs", async () => {
  try {
    secureMkdir(path.join(DATA_DIR, "logs"));
    const res = await shell.openPath(path.join(DATA_DIR, "logs"));
    return { ok: !res, error: res || "" };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle("open-data", async () => {
  try {
    secureMkdir(DATA_DIR);
    const res = await shell.openPath(DATA_DIR);
    return { ok: !res, error: res || "" };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle("run-installer", async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  function sendLog(msg) {
    try { win.webContents.send("installer-log", runtime.redact(msg)); } catch { /* window gone */ }
    logLine("installer.log", msg);
  }
  function sendProgress(p, total, name) {
    try {
      const pct = total ? Math.round((p / total) * 100) : p;
      win.webContents.send("installer-progress", { percent: pct, name });
    } catch { /* window gone */ }
  }

  try {
    sendLog("Starting secure installer...");
    refreshRoots();

    // 1) Preferred path: the bundled Node downloader (no PowerShell needed).
    try {
      const prereq = require("./prereq.js");
      await prereq.runFullInstall(
        (p, total, name) => sendProgress(p, total, name),
        (m) => sendLog(m)
      );
      runtime.refreshPath(true);
      sendLog("Prerequisites installed via the bundled downloader");
      return { ok: true, output: "Installed via the bundled secure downloader" };
    } catch (e) {
      sendLog("Bundled downloader failed: " + e.message + " - falling back to PowerShell");
      logLine("installer.log", e.stack || "");
    }

    // 2) Fallback: the console installer that ships with the tree.
    const psScript = path.join(ROOT, "windows-app", "installer", "install-windows.ps1");
    if (!fs.existsSync(psScript)) {
      throw new Error("install-windows.ps1 not found at " + psScript + ". Install Python 3.12 and Node.js 18+ manually.");
    }
    return await new Promise((resolve, reject) => {
      const child = spawn("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", psScript], {
        cwd: ROOT,
        windowsHide: true,
      });
      let output = "";
      const pump = (d) => {
        const s = d.toString();
        output += s;
        s.split("\n").forEach((l) => { if (l.trim()) sendLog(l.trim()); });
      };
      child.stdout.on("data", pump);
      child.stderr.on("data", pump);
      child.on("close", (code) => {
        runtime.refreshPath(true);
        if (code === 0) resolve({ ok: true, output: output.slice(-5000) });
        else reject(new Error("Installer exit " + code + "\n" + output.slice(-3000)));
      });
      child.on("error", reject);
    });
  } catch (err) {
    sendLog("Fatal: " + err.message);
    throw err;
  }
});

// ---------------------------------------------------------------------------
// Child processes
// ---------------------------------------------------------------------------

function startHidden(cwd, logFile, cmd, args, envExtra) {
  const child = spawn(cmd, args, {
    cwd,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: Object.assign({}, process.env, {
      PYTHONUNBUFFERED: "1",
      PYTHONIOENCODING: "utf-8",
    }, envExtra || {}),
  });
  child.stdout.on("data", (b) => logLine(logFile, b.toString()));
  child.stderr.on("data", (b) => logLine(logFile, b.toString()));
  child.on("exit", (code) => logLine(logFile, `${cmd} exit ${code} cwd=${cwd}`));
  child.on("error", (e) => logLine(logFile, `${cmd} error ${e.message}`));
  return child;
}

function pingDesk() {
  return new Promise((resolve) => {
    const req = http.get(DESK + "/api/health", { timeout: 1500 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
  });
}

async function waitDesk(seconds) {
  const tries = Math.max(1, Math.round((seconds || 20) * 2));
  for (let i = 0; i < tries; i++) {
    if (await pingDesk()) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function ensureStack() {
  refreshRoots();
  runtime.refreshPath(true);
  logLine("engine.log", `ROOT=${ROOT} DATA_DIR=${DATA_DIR} packaged=${app.isPackaged}`);

  if (await pingDesk()) {
    logLine("desk.log", "Desk already running - reusing it");
    return true;
  }

  secureMkdir(path.join(DATA_DIR, "logs"));
  secureMkdir(path.join(DATA_DIR, "cache"));
  secureMkdir(path.join(DATA_DIR, "exports"));
  secureMkdir(path.join(DATA_DIR, "uploads"));
  secureMkdir(path.join(DATA_DIR, "archive"));
  secureMkdir(path.join(ROOT, "engine", "models"));

  // A dead engine/desk from a previous run keeps the ports bound; only our own
  // process names are ever killed.
  const freed = runtime.freeStalePorts();
  if (freed) logLine("app.log", `Freed ${freed} stale AURION process(es) on the desk ports`);

  // --- engine -------------------------------------------------------------
  const engineMain = path.join(ROOT, "engine", "main.py");
  const py = runtime.findPython();
  if (!py) {
    logLine("engine.log", "No supported CPython (3.10-3.12) found - engine not started");
  } else if (!fs.existsSync(engineMain)) {
    logLine("engine.log", `Engine entry not found at ${engineMain}`);
  } else {
    const args = [...py.prefix, engineMain, "--host", ENGINE_HOST, "--port", String(ENGINE_PORT)];
    logLine("engine.log", `Starting engine: ${py.cmd} ${args.join(" ")} cwd=${ROOT}`);
    try {
      engineProc = startHidden(ROOT, "engine.log", py.cmd, args);
    } catch (err) {
      logLine("engine.log", String(err));
    }
  }

  // --- desk ---------------------------------------------------------------
  const backendDir = path.join(ROOT, "backend");
  const backendEntry = path.join(backendDir, "src", "index.js");
  const node = runtime.findNode();
  if (!node) {
    logLine("desk.log", "No supported Node.js (18-30) found - desk not started");
  } else if (!fs.existsSync(backendEntry)) {
    logLine("desk.log", `Backend entry not found at ${backendEntry}`);
  } else {
    logLine("desk.log", `Starting desk: ${node.exe} src/index.js cwd=${backendDir}`);
    try {
      deskProc = startHidden(backendDir, "desk.log", node.exe, ["src/index.js"]);
    } catch (err) {
      logLine("desk.log", String(err));
    }
  }

  return waitDesk(30);
}

function stopChildren() {
  runtime.killTree(engineProc);
  runtime.killTree(deskProc);
  engineProc = null;
  deskProc = null;
}

function postEngine(pathname, timeoutMs) {
  // Best-effort POST to the engine; always resolves (never rejects).
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    try {
      const req = http.request({
        host: ENGINE_HOST,
        port: ENGINE_PORT,
        path: pathname,
        method: "POST",
        headers: { "content-type": "application/json", "content-length": 2 },
        timeout: timeoutMs,
      }, (res) => { res.resume(); res.on("end", finish); });
      req.on("timeout", () => { try { req.destroy(); } catch {} finish(); });
      req.on("error", finish);
      req.end("{}");
      setTimeout(finish, timeoutMs + 500);
    } catch { finish(); }
  });
}

async function persistEngine() {
  // Mirror stop-aurion.cmd: flush engine state to disk before the kill,
  // otherwise in-memory-only state is lost on every app close.
  await postEngine("/v1/persist", 4000);
  await postEngine("/v1/shutdown", 4000);
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

function windowIcon() {
  const icon = path.join(__dirname, "icon.ico");
  return fs.existsSync(icon) ? icon : undefined;
}

function baseWebPreferences() {
  return {
    preload: path.join(__dirname, "preload.js"),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: false,
    // The desk is same-origin (apps/web only fetches relative paths), so the
    // same-origin policy can stay on.
    webSecurity: true,
  };
}

function loadHtml(win, fileName, html) {
  const p = path.join(DATA_DIR, "cache", fileName);
  secureMkdir(path.dirname(p));
  fs.writeFileSync(p, html, "utf8");
  win.loadFile(p);
  return p;
}

// ---------------------------------------------------------------------------
// Branded shell for the app's own pages (installer / loading / diagnostics).
// Mirrors apps/web/css/app.css: same palette, glass cards, aurora backdrop.
// ---------------------------------------------------------------------------
const AURION_MARK = `<svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round" stroke-linejoin="round">
  <path d="M8 40v-9a6 6 0 0 1 12 0v13" /><path d="M20 44V31a6 6 0 0 1 12 0v13" /><path d="M32 44V28" />
  <path d="M44 24v20a8 8 0 0 0 16 0V24" />
  <path d="M52 14c-3 3-3 6 0 8 3-2 3-5 0-8z" fill="#f2c14e" stroke="#f2c14e" stroke-width="1.5" />
</svg>`;

function shellCss() {
  return `
  :root{--bg:#06070b;--ink:#e8edf7;--muted:#8b93a7;--faint:#5b6274;--line:rgba(255,255,255,.08);
        --cyan:#3ee0c4;--violet:#7c6cff;--gold:#e8c07a;--rose:#ff6b8a;--glass:rgba(14,16,24,.62)}
  *{box-sizing:border-box}
  html,body{height:100%}
  body{margin:0;background:var(--bg);color:var(--ink);font-family:Vazirmatn,'Segoe UI',Tahoma,system-ui,sans-serif;
       -webkit-font-smoothing:antialiased;overflow:hidden;position:relative}
  body::before{content:"";position:fixed;inset:-40%;pointer-events:none;z-index:0;
    background:radial-gradient(60% 50% at 20% 10%,rgba(62,224,196,.16),transparent 60%),
               radial-gradient(50% 45% at 85% 20%,rgba(124,108,255,.16),transparent 60%),
               radial-gradient(45% 45% at 60% 95%,rgba(232,192,122,.10),transparent 60%);
    filter:blur(40px);animation:drift 22s ease-in-out infinite alternate}
  @keyframes drift{from{transform:translate3d(0,0,0) rotate(0)}to{transform:translate3d(3%,-2%,0) rotate(4deg)}}
  .wrap{position:relative;z-index:1;height:100%;display:flex;flex-direction:column;padding:26px 28px 22px;gap:14px}
  .brand{display:flex;align-items:center;gap:14px}
  .mark{width:46px;height:46px;border-radius:14px;display:grid;place-items:center;color:var(--cyan);
        background:linear-gradient(135deg,rgba(62,224,196,.16),rgba(124,108,255,.12));border:1px solid rgba(62,224,196,.25)}
  .mark svg{width:30px;height:30px}
  .mark-img{display:block;object-fit:contain;border-radius:18px;filter:drop-shadow(0 6px 18px rgba(62,224,196,.35))}
  .brand h1{margin:0;font-size:20px;font-weight:600;letter-spacing:.01em}
  .brand p{margin:2px 0 0;font-size:12.5px;color:var(--muted)}
  .card{background:var(--glass);border:1px solid var(--line);border-radius:20px;padding:16px 18px;
        backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);box-shadow:0 20px 60px rgba(0,0,0,.35)}
  .grow{flex:1;min-height:0;display:flex;flex-direction:column}
  .steps{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px}
  .step{display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:14px;border:1px solid var(--line);
        background:rgba(255,255,255,.03);font-size:12.5px;transition:all .3s}
  .step i{width:22px;height:22px;flex:none;border-radius:50%;display:grid;place-items:center;font-style:normal;font-size:11px;
          border:1.5px solid var(--faint);color:var(--faint)}
  .step.ok{border-color:rgba(62,224,196,.3);background:rgba(62,224,196,.07)}
  .step.ok i{border-color:var(--cyan);background:var(--cyan);color:#061014}
  .step.run i{border-color:var(--gold);color:var(--gold);animation:pulse 1.2s ease-in-out infinite}
  .step.bad{border-color:rgba(255,107,138,.35);background:rgba(255,107,138,.07)}
  .step.bad i{border-color:var(--rose);color:var(--rose)}
  @keyframes pulse{0%,100%{box-shadow:0 0 0 0 rgba(232,192,122,.45)}50%{box-shadow:0 0 0 6px rgba(232,192,122,0)}}
  .progress{height:8px;border-radius:99px;background:rgba(255,255,255,.06);overflow:hidden;margin:14px 0 8px}
  .bar{height:100%;width:0;border-radius:99px;background:linear-gradient(90deg,var(--cyan),var(--violet));
       transition:width .4s cubic-bezier(.22,.8,.24,1);box-shadow:0 0 18px rgba(62,224,196,.45)}
  .bar.indet{width:35%;animation:indet 1.4s ease-in-out infinite}
  @keyframes indet{0%{margin-inline-start:-35%}100%{margin-inline-start:100%}}
  .status{display:flex;justify-content:space-between;align-items:center;font-size:13px;color:var(--muted)}
  .status b{color:var(--ink);font-weight:500}
  .log{flex:1;min-height:90px;margin-top:10px;background:rgba(0,0,0,.35);border:1px solid var(--line);border-radius:12px;
       padding:10px 12px;font-family:'IBM Plex Mono',Consolas,monospace;font-size:11.5px;line-height:1.55;color:var(--muted);
       white-space:pre-wrap;overflow:auto;direction:ltr;text-align:left;scrollbar-width:thin}
  .actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
  .btn{border:0;border-radius:12px;padding:10px 18px;font:inherit;font-size:13.5px;font-weight:500;cursor:pointer;
       background:linear-gradient(135deg,var(--cyan),#2bb9a3);color:#061014;transition:transform .15s,filter .15s}
  .btn:hover{filter:brightness(1.08);transform:translateY(-1px)}
  .btn:disabled{opacity:.45;cursor:default;transform:none;filter:none}
  .btn.ghost{background:rgba(255,255,255,.06);color:var(--ink);border:1px solid var(--line)}
  .spin{width:44px;height:44px;border-radius:50%;border:3px solid rgba(255,255,255,.08);border-top-color:var(--cyan);
        animation:spin .9s linear infinite;margin:0 auto}
  @keyframes spin{to{transform:rotate(360deg)}}
  .center{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;gap:14px}
  .center h2{margin:0;font-size:17px;font-weight:500}
  .center p{margin:0;color:var(--muted);font-size:13px}
  code{font-family:'IBM Plex Mono',Consolas,monospace;font-size:12px;background:rgba(0,0,0,.35);padding:2px 7px;border-radius:6px;direction:ltr;display:inline-block}
  pre{margin:6px 0 0;max-height:150px;overflow:auto;background:rgba(0,0,0,.35);border:1px solid var(--line);border-radius:10px;
      padding:10px;font-family:'IBM Plex Mono',Consolas,monospace;font-size:11px;white-space:pre-wrap;direction:ltr;text-align:left;color:var(--muted)}
  .kv{display:flex;flex-wrap:wrap;gap:10px 18px;font-size:12.5px;color:var(--muted)}
  .kv span b{color:var(--ink);font-weight:500}
  .foot{font-size:11px;color:var(--faint);text-align:center}
  `;
}

function shellHead(title) {
  return `<!DOCTYPE html><html lang="fa" dir="rtl"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:">
<title>${title}</title><style>${shellCss()}</style></head><body><div class="wrap">`;
}

/** The real AURION mark (apps/web/icons/mark.png) as a data URI; falls back to the inline SVG. */
let _markUri = null;
function markImg(px) {
  if (_markUri === null) {
    _markUri = "";
    for (const cand of [path.join(ROOT, "apps", "web", "icons", "mark.png"), path.resolve(__dirname, "..", "..", "apps", "web", "icons", "mark.png")]) {
      try { if (fs.existsSync(cand)) { _markUri = "data:image/png;base64," + fs.readFileSync(cand).toString("base64"); break; } } catch { /* ignore */ }
    }
  }
  if (!_markUri) return `<div class="mark" style="width:${px}px;height:${px}px">${AURION_MARK}</div>`;
  return `<img class="mark-img" src="${_markUri}" alt="AURION" style="width:${px}px;height:${px}px" />`;
}

function shellBrand(title, sub) {
  return `<div class="brand">${markImg(52)}<div><h1>${title}</h1><p>${sub}</p></div></div>`;
}

const SHELL_TAIL = `</div></body></html>`;

function createInstallerWindow(missing) {
  const win = new BrowserWindow({
    width: 720,
    height: 560,
    minWidth: 600,
    minHeight: 460,
    backgroundColor: "#06070b",
    title: "AURION — آماده‌سازی",
    autoHideMenuBar: true,
    icon: windowIcon(),
    webPreferences: baseWebPreferences(),
  });

  const R = runtime.esc;
  const step = (id, ok, label) =>
    `<div class="step ${ok ? "ok" : ""}" id="st-${id}"><i>${ok ? "✓" : ""}</i><span>${R(label)}</span></div>`;

  const html = shellHead("AURION — آماده‌سازی") + shellBrand("AURION", "آماده‌سازی برای اولین اجرا") + `
  <div class="card grow">
    <div class="steps">
      ${step("py", missing.pythonOk, "Python 3.12" + (missing.pythonVersion ? " · " + missing.pythonVersion : ""))}
      ${step("node", missing.nodeOk, "Node.js 22")}
      ${step("pip", missing.pipOk, "کتابخانه‌های موتور")}
      ${step("npm", missing.npmOk, "کتابخانه‌های میزکار")}
    </div>
    <div class="progress"><div class="bar indet" id="bar"></div></div>
    <div class="status"><b id="statusText">در حال آماده‌سازی…</b><span id="pct"></span></div>
    <div class="log" id="log"></div>
  </div>
  <div class="actions">
    <button class="btn" id="installBtn" hidden>تلاش دوباره</button>
    <button class="btn ghost" id="openFolder">پوشهٔ لاگ</button>
    <span class="foot" style="margin-inline-start:auto">این مرحله فقط یک‌بار انجام می‌شود و به اینترنت نیاز دارد.</span>
  </div>
<script>
  const logEl = document.getElementById('log');
  const bar = document.getElementById('bar');
  const pct = document.getElementById('pct');
  const statusText = document.getElementById('statusText');
  const btn = document.getElementById('installBtn');
  const steps = { py: 'st-py', node: 'st-node', pip: 'st-pip', npm: 'st-npm' };
  function mark(id, cls) { const el = document.getElementById(steps[id]); if (!el) return; el.className = 'step ' + cls; el.querySelector('i').textContent = cls === 'ok' ? '✓' : cls === 'bad' ? '!' : ''; }
  function addLog(t) {
    logEl.textContent += "[" + new Date().toLocaleTimeString() + "] " + t + "\\n";
    logEl.scrollTop = logEl.scrollHeight;
    const l = t.toLowerCase();
    if (l.includes('python') && (l.includes('download') || l.includes('installer'))) mark('py', 'run');
    if (l === 'python installed' || l.includes('python installed')) mark('py', 'ok');
    if (l.includes('node') && (l.includes('download') || l.includes('msiexec') || l.includes('installing node'))) mark('node', 'run');
    if (l.includes('node.js installed') || l.includes('node installed')) mark('node', 'ok');
    if (l.includes('installing python packages')) mark('pip', 'run');
    if (l.includes('python packages ok')) mark('pip', 'ok');
    if (l.includes('installing desk packages')) mark('npm', 'run');
    if (l.includes('desk packages ok') || l.includes('desk packages already')) mark('npm', 'ok');
  }
  function setProgress(p, txt) {
    if (p == null) { bar.classList.add('indet'); pct.textContent = ''; }
    else { bar.classList.remove('indet'); bar.style.width = Math.min(100, Math.max(0, p)) + "%"; pct.textContent = Math.round(p) + '%'; }
    if (txt) statusText.textContent = txt;
  }
  window.aurionDesktop.onInstallerLog(addLog);
  window.aurionDesktop.onInstallerProgress((info) => setProgress(info.percent, info.name ? "دانلود " + info.name : undefined));
  async function run() {
    btn.hidden = true;
    setProgress(null, "در حال آماده‌سازی…");
    try {
      const res = await window.aurionDesktop.runInstaller();
      addLog(res.output || "done");
      ['py','node','pip','npm'].forEach((k) => mark(k, 'ok'));
      setProgress(100, "آماده شد — AURION در حال اجرا…");
      setTimeout(() => window.aurionDesktop.installDone(), 900);
    } catch (e) {
      addLog("ERROR: " + (e && e.message ? e.message : e));
      setProgress(0, "آماده‌سازی ناتمام ماند — اتصال اینترنت را بررسی و دوباره تلاش کنید");
      btn.hidden = false;
    }
  }
  btn.onclick = run;
  document.getElementById('openFolder').onclick = () => window.aurionDesktop.openLogs();
  setTimeout(run, 300);
</script>` + SHELL_TAIL;

  loadHtml(win, "installer.html", html);
  win.webContents.on("did-fail-load", (_e, code, desc, url) => {
    logLine("installer.log", `installer did-fail-load ${code} ${desc} ${url}`);
  });
  win.on("closed", () => {
    if (!installCompleted) {
      logLine("installer.log", "Installer window closed by the user before success - quitting");
      try { stopChildren(); } catch { /* nothing running yet */ }
      app.quit();
    }
  });
  return win;
}

function createLoadingWindow() {
  const win = new BrowserWindow({
    width: 460,
    height: 380,
    resizable: false,
    frame: false,
    backgroundColor: "#06070b",
    title: "AURION",
    autoHideMenuBar: true,
    icon: windowIcon(),
    webPreferences: baseWebPreferences(),
  });
  const html = shellHead("AURION") + `
  <div class="center">
    ${markImg(96)}
    <div class="spin"></div>
    <h2>AURION در حال راه‌اندازی است</h2>
    <p id="txt">موتور تحلیل و میزکار در پس‌زمینه بالا می‌آیند…</p>
  </div>
  <div class="foot">Live MetaTrader 5 Desk · Axiasoft</div>
<script>
  const msgs = ['موتور تحلیل و میزکار در پس‌زمینه بالا می‌آیند…', 'اتصال به سرویس داخلی…', 'تقریباً آماده است…'];
  let i = 0; setInterval(() => { i = (i + 1) % msgs.length; document.getElementById('txt').textContent = msgs[i]; }, 2600);
</script>` + SHELL_TAIL;
  loadHtml(win, "loading.html", html);
  return win;
}

function tailLog(name, lines) {
  try {
    const p = path.join(DATA_DIR, "logs", name);
    if (!fs.existsSync(p)) return "(no " + name + ")";
    const txt = fs.readFileSync(p, "utf8");
    return txt.split(/\r?\n/).filter(Boolean).slice(-(lines || 25)).join("\n");
  } catch (e) { return "(cannot read " + name + ": " + e.message + ")"; }
}

function showDeskFailure(win) {
  const R = runtime.esc;
  const checks = checkPrereqs();
  const kv = (ok, label, extra) => `<span>${ok ? "✅" : "❌"} <b>${R(label)}</b>${extra ? " · " + R(extra) : ""}</span>`;
  const html = shellHead("AURION") + shellBrand("AURION", "سرویس داخلی بالا نیامد") + `
  <div class="card">
    <div class="kv">
      ${kv(checks.python, "Python", checks.pythonLabel || checks.pythonVersion)}
      ${kv(checks.pip, "کتابخانه‌های موتور")}
      ${kv(checks.node, "Node.js")}
      ${kv(checks.npm, "کتابخانه‌های میزکار")}
    </div>
    <p style="margin:10px 0 0;font-size:12.5px;color:var(--muted)">مسیر نصب: <code>${R(ROOT)}</code></p>
  </div>
  <div class="card grow" style="gap:8px;overflow:auto">
    <b style="font-size:12.5px">desk.log</b><pre>${R(tailLog("desk.log", 25))}</pre>
    <b style="font-size:12.5px;margin-top:8px;display:block">engine.log</b><pre>${R(tailLog("engine.log", 15))}</pre>
  </div>
  <div class="actions">
    <button class="btn" id="retry">تلاش دوباره</button>
    <button class="btn ghost" id="reinstall">نصب دوبارهٔ پیش‌نیازها</button>
    <button class="btn ghost" id="logs">پوشهٔ لاگ</button>
  </div>
<script>
  document.getElementById('retry').onclick = () => window.aurionDesktop.retryStart();
  document.getElementById('reinstall').onclick = () => window.aurionDesktop.reinstallPrereqs();
  document.getElementById('logs').onclick = () => window.aurionDesktop.openLogs();
</script>` + SHELL_TAIL;
  loadHtml(win, "deskfail.html", html);
}

ipcMain.on("retry-start", () => {
  relaunching = true;
  for (const w of BrowserWindow.getAllWindows()) { try { w.close(); } catch { /* closing */ } }
  stopChildren();
  setTimeout(() => {
    relaunching = false;
    createMainWindow().catch((e) => logLine("app.log", String(e)));
  }, 600);
});

ipcMain.on("reinstall-prereqs", () => {
  relaunching = true;
  for (const w of BrowserWindow.getAllWindows()) { try { w.close(); } catch { /* closing */ } }
  stopChildren();
  setTimeout(() => {
    relaunching = false;
    const c = checkPrereqs();
    createInstallerWindow({ pythonOk: c.python, nodeOk: c.node, pipOk: c.pip, npmOk: c.npm, backendOk: c.backend, engineOk: c.engine, pythonVersion: c.pythonVersion });
  }, 600);
});

function showMissingTree(win, checks) {
  const R = runtime.esc;
  const html = shellHead("AURION") + shellBrand("AURION", "نصب ناقص است") + `
  <div class="card grow">
    <p style="margin:0 0 10px;font-size:13.5px">برخی از فایل‌های برنامه در این نصب وجود ندارند. لطفاً AURION را از طریق
      <b>Settings → Apps → AURION → Repair</b> تعمیر کنید یا نصب‌کننده را دوباره اجرا کنید.</p>
    <div class="kv">
      <span>${checks.backend ? "✅" : "❌"} <b>میزکار</b></span>
      <span>${checks.engine ? "✅" : "❌"} <b>موتور تحلیل</b></span>
    </div>
    <p style="margin:10px 0 0;font-size:12.5px;color:var(--muted)">مسیر نصب: <code>${R(ROOT)}</code></p>
  </div>
  <div class="actions">
    <button class="btn ghost" id="logs">پوشهٔ لاگ</button>
    <button class="btn ghost" id="data">پوشهٔ داده</button>
  </div>
<script>
  document.getElementById('logs').onclick = () => window.aurionDesktop.openLogs();
  document.getElementById('data').onclick = () => window.aurionDesktop.openData();
</script>` + SHELL_TAIL;
  loadHtml(win, "missing.html", html);
}

function buildMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: "AURION",
      submenu: [
        { label: "Reload desk", role: "reload" },
        { label: "Toggle console", role: "toggleDevTools" },
        { type: "separator" },
        { label: "Open data folder", click: () => shell.openPath(DATA_DIR) },
        { label: "Open logs folder", click: () => shell.openPath(path.join(DATA_DIR, "logs")) },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    { role: "editMenu" },
    { role: "viewMenu" },
  ]));
}

async function createMainWindow() {
  refreshRoots();
  secureMkdir(path.join(DATA_DIR, "logs"));
  secureMkdir(path.join(DATA_DIR, "cache"));
  logLine("app.log", `App start packaged=${app.isPackaged} ROOT=${ROOT} DATA=${DATA_DIR} __dirname=${__dirname} resources=${process.resourcesPath}`);

  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: "#06070b",
    title: "AURION",
    autoHideMenuBar: true,
    show: false,
    icon: windowIcon(),
    webPreferences: baseWebPreferences(),
  });
  mainWin = win;
  win.on("closed", () => { if (mainWin === win) mainWin = null; });
  buildMenu();

  const checks = checkPrereqs();
  logLine("app.log", `Prereq checks: ${JSON.stringify(checks)}`);

  const missing = {
    pythonOk: checks.python,
    nodeOk: checks.node,
    pipOk: checks.pip,
    npmOk: checks.npm,
    backendOk: checks.backend,
    engineOk: checks.engine,
    pythonVersion: checks.pythonVersion,
  };

  // Missing tree files can never be fixed by the installer.
  if (!checks.backend || !checks.engine) {
    logLine("app.log", "backend/engine files missing - showing the error page");
    showMissingTree(win, checks);
    try { win.show(); } catch { /* closing */ }
    return;
  }

  if (!checks.python || !checks.node || !checks.pip || !checks.npm) {
    logLine("app.log", "Prerequisites missing - showing the installer window (main stays hidden)");
    createInstallerWindow(missing);
    return;
  }

  const loadingWin = createLoadingWindow();
  const ok = await ensureStack();
  try { loadingWin.close(); } catch { /* already closed */ }

  if (!ok) {
    // No native message box + black page: render a branded diagnostic page
    // with the real error (tail of desk.log / engine.log) and a retry button.
    logLine("app.log", "Desk did not answer after ensureStack - showing the diagnostic page");
    showDeskFailure(win);
    try { win.show(); } catch { /* closing */ }
    return;
  }

  try { win.show(); } catch { /* closing */ }
  win.loadURL(DESK);
  win.webContents.on("did-fail-load", (_e, code, desc, url) => {
    logLine("app.log", `did-fail-load ${code} ${desc} ${url}`);
    if (code === -3) return; // -3 = aborted navigation
    showDeskFailure(win);
  });
  // The desk process died after start-up (port conflict, crash): show why.
  if (deskProc) {
    deskProc.once("exit", (code) => {
      if (relaunching || !mainWin || mainWin.isDestroyed()) return;
      logLine("app.log", `desk process exited (${code}) while the window is open`);
      showDeskFailure(mainWin);
    });
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

// A second launch must not start a second engine on port 18765.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWin) {
      if (mainWin.isMinimized()) mainWin.restore();
      mainWin.focus();
    }
  });

  app.whenReady().then(() => {
    if (runtime.isWindows()) {
      try { app.setAppUserModelId(APP_ID); } catch { /* older Electron */ }
    }
    refreshRoots();
    createMainWindow().catch((e) => logLine("app.log", "createMainWindow failed: " + String(e)));

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createMainWindow().catch((e) => logLine("app.log", String(e)));
      }
    });
  });

  app.on("window-all-closed", () => {
    if (relaunching) return;
    stopChildren();
    app.quit();
  });

  app.on("before-quit", () => stopChildren());

  app.on("web-contents-created", (_event, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith(DESK) || url.startsWith("http://127.0.0.1:8080") || url.startsWith("http://localhost:8080")) {
        return { action: "allow" };
      }
      shell.openExternal(url);
      return { action: "deny" };
    });
    contents.on("will-navigate", (e, url) => {
      const allowed = url.startsWith(DESK)
        || url.startsWith("http://127.0.0.1:8080")
        || url.startsWith("http://localhost:8080");
      if (!allowed && !url.startsWith("file://")) {
        e.preventDefault();
        shell.openExternal(url);
      }
    });
  });
}

// Exported so the startup logic can be exercised without a real Electron
// runtime (see the smoke test in the repo notes).  Electron ignores the
// module.exports of its main entry.
module.exports = { getRoot, getDataDir, checkPrereqs, pingDesk, waitDesk, stopChildren, ensureStack };
