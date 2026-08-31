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
  for (const w of BrowserWindow.getAllWindows()) {
    try { w.close(); } catch { /* already closing */ }
  }
  runtime.refreshPath(true);
  refreshRoots();
  setTimeout(() => { createMainWindow().catch((e) => logLine("app.log", String(e))); }, 800);
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

function createInstallerWindow(missing) {
  const win = new BrowserWindow({
    width: 780,
    height: 600,
    minWidth: 640,
    minHeight: 480,
    backgroundColor: "#06070b",
    title: "AURION - نصب پیش‌نیازها",
    autoHideMenuBar: true,
    icon: windowIcon(),
    webPreferences: baseWebPreferences(),
  });

  const R = runtime.esc;
  const badge = (ok, label) =>
    `<span class="badge ${ok ? "ok" : "bad"}">${ok ? "✅" : "❌"} ${R(label)}</span>`;

  const html = `<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<title>AURION Installer</title>
<style>
  body { font-family: 'Segoe UI', Tahoma, sans-serif; background:#06070b; color:#e6e8f0; margin:0; padding:24px; }
  h1 { font-size:22px; margin:0 0 12px; }
  .card { background:#10131f; border:1px solid #1e233a; border-radius:12px; padding:16px; margin:12px 0; }
  .status { display:flex; gap:10px; flex-wrap:wrap; }
  .badge { padding:4px 10px; border-radius:20px; font-size:12px; }
  .ok { background:#0a2a1a; color:#5ee9a8; border:1px solid #1a5a3a; }
  .bad { background:#2a0a0a; color:#ff8a8a; border:1px solid #5a1a1a; }
  .log { background:#080a12; border:1px solid #1a1f35; border-radius:8px; height:220px; overflow:auto; padding:10px; font-family:Consolas, monospace; font-size:12px; white-space:pre-wrap; direction:ltr; text-align:left; }
  button { background:#4f46e5; color:white; border:0; padding:10px 18px; border-radius:8px; cursor:pointer; font-size:14px; margin-inline-end:8px; }
  button:disabled { opacity:0.5; cursor:not-allowed; }
  .progress { height:10px; background:#1a1f35; border-radius:8px; overflow:hidden; margin:12px 0; }
  .bar { height:100%; background:linear-gradient(90deg,#4f46e5,#06b6d4); width:0%; transition:width 0.3s; }
  .hint { font-size:12px; opacity:0.7; margin-top:8px; }
  code { background:#080a12; padding:2px 6px; border-radius:4px; direction:ltr; }
</style>
</head>
<body>
  <h1>🚀 نصب AURION — بررسی پیش‌نیازها</h1>
  <div class="card">
    <div>پیش‌نیازها به‌صورت خودکار دانلود و نصب می‌شوند.</div>
    <div style="margin-top:6px">ROOT: <code>${R(ROOT)}</code><br>DATA: <code>${R(DATA_DIR)}</code></div>
    <div class="status" style="margin-top:12px;">
      ${badge(missing.pythonOk, "Python 3.10–3.12 " + (missing.pythonVersion ? "(" + R(missing.pythonVersion) + ")" : ""))}
      ${badge(missing.nodeOk, "Node.js 18+")}
      ${badge(missing.pipOk, "پکیج‌های پایتون")}
      ${badge(missing.npmOk, "پکیج‌های دسک")}
      ${badge(missing.backendOk, "فایل‌های backend")}
      ${badge(missing.engineOk, "فایل‌های engine")}
    </div>
    <div class="progress"><div class="bar" id="bar"></div></div>
    <div id="statusText">آماده نصب...</div>
    <div class="hint">اگر backend یا engine مفقود است، فایل‌های برنامه همراه نصب‌کننده بسته‌بندی نشده‌اند؛ MSI را دوباره بسازید.</div>
  </div>
  <div class="card">
    <div style="display:flex; gap:10px;">
      <button id="installBtn">نصب خودکار پیش‌نیازها</button>
      <button id="openFolder">باز کردن پوشه لاگ</button>
    </div>
    <div class="log" id="log"></div>
  </div>
<script>
  const logEl = document.getElementById('log');
  const bar = document.getElementById('bar');
  const statusText = document.getElementById('statusText');
  const btn = document.getElementById('installBtn');
  function addLog(t) {
    logEl.textContent += "[" + new Date().toLocaleTimeString() + "] " + t + "\\n";
    logEl.scrollTop = logEl.scrollHeight;
  }
  function setProgress(p, txt) {
    bar.style.width = Math.min(100, Math.max(0, p)) + "%";
    if (txt) statusText.textContent = txt;
  }
  window.aurionDesktop.onInstallerLog(addLog);
  window.aurionDesktop.onInstallerProgress((info) => setProgress(info.percent, info.name ? "نصب " + info.name + " ..." : undefined));
  btn.onclick = async () => {
    btn.disabled = true;
    setProgress(5, "در حال اجرای نصب‌کننده امن...");
    addLog("شروع نصب خودکار...");
    try {
      const res = await window.aurionDesktop.runInstaller();
      addLog(res.output || "نصب تمام شد");
      setProgress(100, "نصب کامل شد - در حال راه‌اندازی AURION...");
      setTimeout(() => window.aurionDesktop.installDone(), 1200);
    } catch (e) {
      addLog("❌ خطا: " + (e && e.message ? e.message : e));
      setProgress(0, "خطا - دوباره تلاش کنید");
      btn.disabled = false;
    }
  };
  document.getElementById('openFolder').onclick = () => window.aurionDesktop.openLogs();
  addLog("✅ برای نصب خودکار کلیک کنید.");
</script>
</body>
</html>`;

  loadHtml(win, "installer.html", html);
  win.webContents.on("did-fail-load", (_e, code, desc, url) => {
    logLine("installer.log", `installer did-fail-load ${code} ${desc} ${url}`);
  });
  return win;
}

function createLoadingWindow() {
  const win = new BrowserWindow({
    width: 520,
    height: 400,
    backgroundColor: "#06070b",
    title: "AURION - در حال راه‌اندازی",
    autoHideMenuBar: true,
    icon: windowIcon(),
    webPreferences: baseWebPreferences(),
  });
  const R = runtime.esc;
  const html = `<!DOCTYPE html>
<html dir="rtl" lang="fa"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<style>
  body{background:#06070b;color:#e6e8f0;font-family:'Segoe UI',Tahoma;padding:24px;text-align:center}
  .spinner{width:40px;height:40px;border:4px solid #1e233a;border-top:4px solid #4f46e5;border-radius:50%;animation:spin 1s linear infinite;margin:20px auto}
  @keyframes spin{to{transform:rotate(360deg)}}
  .log{font-family:Consolas,monospace;font-size:11px;background:#10131f;border:1px solid #1e233a;border-radius:8px;padding:10px;height:150px;overflow:auto;white-space:pre-wrap;text-align:left;direction:ltr;margin-top:16px}
  code{background:#10131f;padding:2px 6px;border-radius:4px;direction:ltr}
</style></head><body>
<h2>⏳ AURION در حال راه‌اندازی...</h2>
<div class="spinner"></div>
<div id="txt">در حال بررسی بک‌اند روی <code>${R(DESK)}</code></div>
<div class="log" id="log"></div>
<script>
  const logEl = document.getElementById('log');
  const txt = document.getElementById('txt');
  let dots = 0;
  setInterval(() => { dots = (dots + 1) % 4; txt.textContent = 'در حال بررسی بک‌اند روی ${R(DESK)}' + '.'.repeat(dots); }, 500);
  function add(t) { logEl.textContent += '[' + new Date().toLocaleTimeString() + '] ' + t + '\\n'; logEl.scrollTop = logEl.scrollHeight; }
  add('ROOT=${R(ROOT)}');
  add('DATA=${R(DATA_DIR)}');
  add('Waiting for ${R(DESK)}/api/health ...');
</script>
</body></html>`;
  loadHtml(win, "loading.html", html);
  return win;
}

function showMissingTree(win, checks) {
  const R = runtime.esc;
  const html = `<!DOCTYPE html>
<html dir="rtl" lang="fa"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<style>
  body{background:#06070b;color:#e6e8f0;font-family:'Segoe UI',Tahoma;padding:24px}
  .card{background:#10131f;border:1px solid #5a1a1a;border-radius:12px;padding:16px;margin:12px 0}
  button{background:#4f46e5;color:white;border:0;padding:10px 18px;border-radius:8px;cursor:pointer;margin-inline-end:8px}
  code{background:#080a12;padding:2px 6px;border-radius:4px;direction:ltr}
</style></head><body>
<h1>❌ فایل‌های AURION یافت نشد</h1>
<div class="card">
  <p>ROOT: <code>${R(ROOT)}</code></p>
  <p>DATA: <code>${R(DATA_DIR)}</code></p>
  <p>backend: ${checks.backend ? "✅" : "❌ مفقود"} — <code>${R(path.join(ROOT, "backend"))}</code></p>
  <p>engine: ${checks.engine ? "✅" : "❌ مفقود"} — <code>${R(path.join(ROOT, "engine"))}</code></p>
  <p>یعنی MSI بدون extraResources ساخته شده است. دوباره با <code>windows-app/packaging/build-msi-windows.ps1</code> بسازید.</p>
  <p>لاگ‌ها: <code>${R(path.join(DATA_DIR, "logs"))}</code></p>
</div>
<button id="logs">باز کردن پوشه لاگ</button>
<button id="data">باز کردن پوشه دیتا</button>
<script>
  document.getElementById('logs').onclick = () => window.aurionDesktop.openLogs();
  document.getElementById('data').onclick = () => window.aurionDesktop.openData();
</script>
</body></html>`;
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
    return;
  }

  if (!checks.python || !checks.node || !checks.pip || !checks.npm) {
    logLine("app.log", "Prerequisites missing - showing the installer window");
    createInstallerWindow(missing);
    return;
  }

  const loadingWin = createLoadingWindow();
  const ok = await ensureStack();
  try { loadingWin.close(); } catch { /* already closed */ }

  if (!ok) {
    logLine("app.log", "Desk did not answer after ensureStack");
    dialog.showMessageBox(win, {
      type: "warning",
      title: "AURION",
      message: `Desk did not answer on ${DESK}.`,
      detail: `Logs: ${path.join(DATA_DIR, "logs")}\nROOT: ${ROOT}`,
    });
    // Load anyway; did-fail-load renders the diagnostic page.
  }

  win.loadURL(DESK);
  win.webContents.on("did-fail-load", (_e, code, desc, url) => {
    logLine("app.log", `did-fail-load ${code} ${desc} ${url}`);
    if (code === -3) return; // -3 = aborted navigation
    const R = runtime.esc;
    const failHtml = `<!DOCTYPE html>
<html dir="rtl" lang="fa"><head><meta charset="utf-8">
<style>
  body{background:#06070b;color:#e6e8f0;font-family:'Segoe UI',Tahoma;padding:24px}
  .card{background:#10131f;border:1px solid #1e233a;border-radius:12px;padding:16px}
  code{background:#080a12;padding:2px 6px;border-radius:4px;direction:ltr}
</style></head><body>
<h2>⚠️ ارتباط با بک‌اند برقرار نشد</h2>
<div class="card">
  <p>آدرس: <code>${R(DESK)}</code></p>
  <p>کد خطا: ${R(code)} — ${R(desc)}</p>
  <p>ROOT: <code>${R(ROOT)}</code></p>
  <p>لاگ‌ها: <code>${R(path.join(DATA_DIR, "logs"))}</code> (desk.log ، engine.log)</p>
  <p>معمولاً یا Python/Node نصب نشده، یا پورت 8080 در اختیار برنامه دیگری است.</p>
</div>
</body></html>`;
    loadHtml(win, "fail.html", failHtml);
  });
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
