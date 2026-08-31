const { app, BrowserWindow, Menu, shell, dialog, ipcMain } = require("electron");
const path = require("path");
const { spawn, execSync } = require("child_process");
const http = require("http");
const fs = require("fs");

// ---- ROOT & DATA DIR RESOLUTION (packaged vs dev) ----
function getRoot() {
  // In dev: apps/desktop -> ../../ = repo root
  // In packaged: extraResources (backend, engine, config, lang, apps/web) are in process.resourcesPath
  try {
    if (app.isPackaged) {
      // resourcesPath = .../resources ; our extraResources are there directly
      // Check if backend exists there, if not try app.getAppPath() parent
      const rp = process.resourcesPath;
      if (fs.existsSync(path.join(rp, "backend", "src", "index.js")) || fs.existsSync(path.join(rp, "backend"))) {
        return rp;
      }
      // fallback: resources/../  (some configs)
      const alt = path.join(rp, "..");
      if (fs.existsSync(path.join(alt, "backend"))) return alt;
      return rp;
    }
  } catch {}
  return path.resolve(__dirname, "..", "..");
}
function getDataDir() {
  try {
    if (app.isPackaged) {
      // Use userData to avoid permission issues in Program Files
      const ud = app.getPath("userData");
      return ud;
    }
  } catch {}
  return path.join(getRoot(), "data");
}
let ROOT = getRoot();
let DATA_DIR = getDataDir();

const DESK = process.env.AURION_DESK_URL || "http://127.0.0.1:8080";
let engineProc = null;
let deskProc = null;
let mainWin = null;

ipcMain.on("install-done", async () => {
  try {
    const all = BrowserWindow.getAllWindows();
    for (const w of all) w.close();
  } catch {}
  // refresh ROOT after install (might have changed)
  ROOT = getRoot();
  DATA_DIR = getDataDir();
  setTimeout(() => createMainWindow(), 800);
});

ipcMain.handle("open-logs", async () => {
  try {
    shell.openPath(path.join(DATA_DIR, "logs"));
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle("open-data", async () => {
  try {
    shell.openPath(DATA_DIR);
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle("run-installer", async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  function sendLog(msg) {
    try { win.webContents.send("installer-log", msg); } catch {}
    try {
      const dir = path.join(DATA_DIR, "logs");
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(path.join(dir, "installer.log"), msg + "\n");
    } catch {}
  }
  function sendProgress(p, total, name) {
    try {
      const pct = total ? Math.round((p/total)*100) : p;
      win.webContents.send("installer-progress", { percent: pct, name });
    } catch {}
  }
  try {
    sendLog("Starting secure installer...");
    ROOT = getRoot();
    // Try Node prereq module first
    try {
      const prereqPath = path.join(__dirname, "prereq.js");
      const prereq = require(prereqPath);
      // override ROOT inside prereq by env? prereq uses its own getRoot, so fine
      await prereq.runFullInstall(
        (p, total, name) => sendProgress(p, total, name),
        (m) => sendLog(m)
      );
      sendLog("Prerequisites installed via Node downloader");
      return { ok: true, output: "Installed via secure downloader" };
    } catch (e) {
      sendLog("Node downloader failed: " + e.message + " - falling back to PowerShell");
      sendLog(e.stack || "");
    }
    // Fallback to PowerShell script (dev only)
    const psScript = path.join(ROOT, "scripts", "install-windows.ps1");
    if (!fs.existsSync(psScript)) {
      throw new Error("install-windows.ps1 not found at " + psScript + ". Please install Python 3.12 and Node.js manually.");
    }
    return await new Promise((resolve, reject) => {
      const child = spawn("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", psScript], {
        cwd: ROOT,
        windowsHide: true,
      });
      let output = "";
      child.stdout.on("data", (d) => {
        const s = d.toString();
        output += s;
        s.split("\n").forEach(l => { if(l.trim()) sendLog(l.trim()); });
      });
      child.stderr.on("data", (d) => {
        const s = d.toString();
        output += s;
        s.split("\n").forEach(l => { if(l.trim()) sendLog(l.trim()); });
      });
      child.on("close", (code) => {
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

function secureMkdir(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
}
function logLine(file, line) {
  try {
    const dir = path.join(DATA_DIR, "logs");
    secureMkdir(dir);
    let safe = String(line || "");
    safe = safe.replace(/code=\d{6}/gi, "code=***");
    safe = safe.replace(/password[=:]\\s*\\S+/gi, "password=***");
    const fp = path.join(dir, file);
    fs.appendFileSync(fp, safe.endsWith("\n") ? safe : safe + "\n");
  } catch (_) {}
}
function startHidden(cwd, logFile, cmd, args, envExtra = {}) {
  const child = spawn(cmd, args, {
    cwd,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...envExtra },
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
      resolve(res.statusCode === 200);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
  });
}
function checkPrereqs() {
  const checks = { python: false, node: false, pip: false, npm: false, backend: false, engine: false };
  // backend/engine existence
  try {
    if (fs.existsSync(path.join(ROOT, "backend", "src", "index.js"))) checks.backend = true;
    if (fs.existsSync(path.join(ROOT, "engine", "aurion"))) checks.engine = true;
  } catch {}
  for (const ver of ["3.13", "3.12", "3.11"]) {
    try {
      execSync(`py -${ver} -c "import sys; exit(0 if sys.version_info[:2]==(${ver.split('.')[0]},${ver.split('.')[1]}) else 1)"`, { timeout: 5000, windowsHide: true });
      checks.python = true; break;
    } catch {}
  }
  if (!checks.python) {
    try {
      execSync('python -c "import sys; exit(0 if sys.version_info[:2]>=(3,11) else 1)"', { timeout: 5000, windowsHide: true });
      checks.python = true;
    } catch {}
  }
  try {
    const nodeVer = execSync("node -p \"process.versions.node.split('.')[0]\"", { timeout: 3000, encoding: "utf8", windowsHide: true });
    const major = parseInt(String(nodeVer).trim(), 10);
    if (major >= 18 && major <= 30) checks.node = true;
  } catch {}
  for (const ver of ["3.13", "3.12", "3.11"]) {
    try {
      execSync(`py -${ver} -c "import fastapi,numpy"`, { timeout: 5000, windowsHide: true });
      checks.pip = true; break;
    } catch {}
  }
  if (!checks.pip) {
    try { execSync('python -c "import fastapi,numpy"', { timeout: 5000, windowsHide: true }); checks.pip = true; } catch {}
  }
  try {
    if (fs.existsSync(path.join(ROOT, "backend", "node_modules", "express")) || fs.existsSync(path.join(ROOT, "backend", "node_modules", "fastify"))) checks.npm = true;
    else if (fs.existsSync(path.join(ROOT, "backend", "package.json"))) {
      // if package.json exists but node_modules missing, we need install
      checks.npm = false;
    } else {
      checks.npm = true; // if backend not in extraResources (dev), ignore?
    }
  } catch {}
  return checks;
}
async function ensureStack() {
  ROOT = getRoot();
  DATA_DIR = getDataDir();
  logLine("engine.log", `ROOT=${ROOT} DATA_DIR=${DATA_DIR} packaged=${app.isPackaged}`);
  if (await pingDesk()) {
    logLine("desk.log", "Desk already running");
    return true;
  }
  // ensure data dirs
  secureMkdir(path.join(DATA_DIR, "logs"));
  secureMkdir(path.join(DATA_DIR, "cache"));

  const py = process.env.AURION_PYTHON || "py";
  const pyArgs = py === "py" ? ["-3.12", path.join(ROOT, "engine", "main.py"), "--host", "127.0.0.1", "--port", "18765"] : [path.join(ROOT, "engine", "main.py"), "--host", "127.0.0.1", "--port", "18765"];
  // fallback if engine/main.py not at ROOT/engine
  let engineMain = path.join(ROOT, "engine", "main.py");
  if (!fs.existsSync(engineMain)) {
    // try alternative: engine/aurion/api/server.py ?
    const alt = path.join(ROOT, "engine", "aurion", "api", "server.py");
    if (fs.existsSync(alt)) engineMain = alt;
  }
  if (fs.existsSync(engineMain)) {
    try {
      const args = engineMain.endsWith("server.py") ? [engineMain] : ["-3.12", engineMain, "--host", "127.0.0.1", "--port", "18765"];
      // if py -3.12 fails, try python
      let usePy = py;
      let useArgs = pyArgs;
      if (engineMain.endsWith("server.py")) {
        usePy = "py";
        useArgs = ["-3.12", engineMain];
      }
      logLine("engine.log", `Starting engine: ${usePy} ${useArgs.join(" ")} cwd=${ROOT}`);
      engineProc = startHidden(ROOT, "engine.log", usePy, useArgs);
    } catch (err) {
      logLine("engine.log", String(err));
    }
  } else {
    logLine("engine.log", `Engine main not found at ${engineMain}`);
  }
  await new Promise((r) => setTimeout(r, 2500));
  const backendDir = path.join(ROOT, "backend");
  const backendEntry = path.join(backendDir, "src", "index.js");
  if (fs.existsSync(backendEntry)) {
    try {
      logLine("desk.log", `Starting desk: node src/index.js cwd=${backendDir}`);
      deskProc = startHidden(backendDir, "desk.log", "node", ["src/index.js"]);
    } catch (err) {
      logLine("desk.log", String(err));
    }
  } else {
    logLine("desk.log", `Backend entry not found at ${backendEntry}`);
  }
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (await pingDesk()) return true;
  }
  return false;
}
function createInstallerWindow(missing) {
  const win = new BrowserWindow({
    width: 780,
    height: 560,
    minWidth: 640,
    minHeight: 480,
    backgroundColor: "#06070b",
    title: "AURION - نصب پیش‌نیازها",
    autoHideMenuBar: true,
    icon: fs.existsSync(path.join(__dirname, "icon.ico")) ? path.join(__dirname, "icon.ico") : undefined,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: false,
    },
  });
  const html = `
  <!DOCTYPE html>
  <html lang="fa" dir="rtl">
  <head>
  <meta charset="utf-8">
  <title>AURION Installer</title>
  <style>
    body { font-family: 'Segoe UI', Tahoma, sans-serif; background:#06070b; color:#e6e8f0; margin:0; padding:24px; }
    h1 { font-size:22px; margin:0 0 12px; }
    .card { background:#10131f; border:1px solid #1e233a; border-radius:12px; padding:16px; margin:12px 0; }
    .status { display:flex; gap:10px; flex-wrap:wrap; }
    .badge { padding:4px 10px; border-radius:20px; font-size:12px; }
    .ok { background:#0a2a1a; color:#5ee9a8; border:1px solid #1a5a3a; }
    .bad { background:#2a0a0a; color:#ff8a8a; border:1px solid #5a1a1a; }
    .log { background:#080a12; border:1px solid #1a1f35; border-radius:8px; height:220px; overflow:auto; padding:10px; font-family:Consolas, monospace; font-size:12px; white-space:pre-wrap; }
    button { background:#4f46e5; color:white; border:0; padding:10px 18px; border-radius:8px; cursor:pointer; font-size:14px; margin-inline-end:8px; }
    button:disabled { opacity:0.5; cursor:not-allowed; }
    .progress { height:10px; background:#1a1f35; border-radius:8px; overflow:hidden; margin:12px 0; }
    .bar { height:100%; background:linear-gradient(90deg,#4f46e5,#06b6d4); width:0%; transition:width 0.3s; }
    .hint { font-size:12px; opacity:0.7; margin-top:8px; }
  </style>
  </head>
  <body>
    <h1>🚀 نصب AURION - بررسی پیش‌نیازها</h1>
    <div class="card">
      <div>این برنامه روی سیستم خام، پیش‌نیازها را به صورت خودکار دانلود می‌کند. ROOT: ${ROOT.replace(/\\/g,'/')}<br/>DATA: ${DATA_DIR.replace(/\\/g,'/')}</div>
      <div class="status" style="margin-top:12px;">
        <span class="badge ${missing.python ? 'bad' : 'ok'}">Python 3.12: ${missing.python ? '❌ نیاز به نصب' : '✅'}</span>
        <span class="badge ${missing.node ? 'bad' : 'ok'}">Node.js 18+: ${missing.node ? '❌' : '✅'}</span>
        <span class="badge ${missing.pip ? 'bad' : 'ok'}">Python Packages: ${missing.pip ? '❌' : '✅'}</span>
        <span class="badge ${missing.npm ? 'bad' : 'ok'}">Node Packages: ${missing.npm ? '❌' : '✅'}</span>
        <span class="badge ${missing.backend ? 'bad' : 'ok'}">Backend files: ${missing.backend ? '❌ مفقود' : '✅'}</span>
        <span class="badge ${missing.engine ? 'bad' : 'ok'}">Engine files: ${missing.engine ? '❌ مفقود' : '✅'}</span>
      </div>
      <div class="progress"><div class="bar" id="bar"></div></div>
      <div id="statusText">آماده نصب...</div>
      <div class="hint">اگر backend/engine مفقود است، MSI با extraResources ساخته نشده - دوباره build کنید.</div>
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
        const time = new Date().toLocaleTimeString();
        logEl.textContent += "[" + time + "] " + t + "\\n";
        logEl.scrollTop = logEl.scrollHeight;
      }
      function setProgress(p, txt) {
        bar.style.width = Math.min(100, Math.max(0, p)) + "%";
        if (txt) statusText.textContent = txt;
      }
      window.aurionDesktop.onInstallerLog((msg) => addLog(msg));
      window.aurionDesktop.onInstallerProgress((info) => setProgress(info.percent, info.name ? "نصب " + info.name + " ..." : undefined));
      btn.onclick = async () => {
        btn.disabled = true;
        setProgress(5, "در حال اجرای نصب‌کننده امن...");
        addLog("شروع نصب خودکار...");
        try {
          const res = await window.aurionDesktop.runInstaller();
          addLog(res.output || "نصب تمام شد");
          setProgress(100, "نصب کامل شد - در حال راه‌اندازی AURION...");
          setTimeout(() => window.aurionDesktop.installDone(), 1500);
        } catch (e) {
          addLog("❌ خطا: " + e.message);
          setProgress(0, "خطا - دوباره تلاش کنید");
          btn.disabled = false;
        }
      };
      document.getElementById('openFolder').onclick = () => window.aurionDesktop.openLogs();
      addLog("✅ سیستم آماده. برای نصب خودکار کلیک کنید.");
    </script>
  </body>
  </html>`;

  const tmpHtml = path.join(DATA_DIR, "cache", "installer.html");
  secureMkdir(path.dirname(tmpHtml));
  fs.writeFileSync(tmpHtml, html, "utf8");
  win.loadFile(tmpHtml);
  win.webContents.on("did-fail-load", (_e, code, desc, url) => {
    logLine("installer.log", `installer did-fail-load ${code} ${desc} ${url}`);
  });
  return win;
}

function createLoadingWindow() {
  const win = new BrowserWindow({
    width: 480,
    height: 360,
    backgroundColor: "#06070b",
    title: "AURION - در حال راه‌اندازی",
    autoHideMenuBar: true,
    icon: fs.existsSync(path.join(__dirname, "icon.ico")) ? path.join(__dirname, "icon.ico") : undefined,
    webPreferences: { contextIsolation: true, preload: path.join(__dirname, "preload.js"), sandbox: false, webSecurity: false },
  });
  const html = `
  <html dir="rtl" lang="fa"><head><meta charset="utf-8"><style>
  body{background:#06070b;color:#e6e8f0;font-family:Segoe UI;padding:24px;text-align:center}
  .spinner{width:40px;height:40px;border:4px solid #1e233a;border-top:4px solid #4f46e5;border-radius:50%;animation:spin 1s linear infinite;margin:20px auto}
  @keyframes spin{to{transform:rotate(360deg)}}
  .log{font-family:Consolas;font-size:11px;background:#10131f;border:1px solid #1e233a;border-radius:8px;padding:10px;height:120px;overflow:auto;white-space:pre-wrap;text-align:left;direction:ltr;margin-top:16px}
  </style></head><body>
  <h2>⏳ AURION در حال راه‌اندازی...</h2>
  <div class="spinner"></div>
  <div id="txt">در حال بررسی بک‌اند روی ${DESK}</div>
  <div class="log" id="log"></div>
  <script>
    const logEl=document.getElementById('log');
    const txt=document.getElementById('txt');
    let dots=0;
    setInterval(()=>{dots=(dots+1)%4; txt.textContent='در حال بررسی بک‌اند روی ${DESK}' + '.'.repeat(dots)}, 500);
    function add(t){logEl.textContent+='['+new Date().toLocaleTimeString()+'] '+t+'\\n'; logEl.scrollTop=logEl.scrollHeight;}
    add('ROOT=${ROOT}');
    add('DATA=${DATA_DIR}');
    add('Waiting for ${DESK}/api/health ...');
  </script>
  </body></html>`;
  const p = path.join(DATA_DIR, "cache", "loading.html");
  secureMkdir(path.dirname(p));
  fs.writeFileSync(p, html, "utf8");
  win.loadFile(p);
  return win;
}

async function createMainWindow() {
  ROOT = getRoot();
  DATA_DIR = getDataDir();
  secureMkdir(path.join(DATA_DIR, "logs"));
  secureMkdir(path.join(DATA_DIR, "cache"));
  logLine("app.log", `App start packaged=${app.isPackaged} ROOT=${ROOT} DATA=${DATA_DIR} __dirname=${__dirname} resources=${process.resourcesPath}`);

  const icon = path.join(__dirname, "icon.ico");
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: "#06070b",
    title: "AURION",
    autoHideMenuBar: true,
    icon: fs.existsSync(icon) ? icon : undefined,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: false,
    },
  });
  mainWin = win;

  const checks = checkPrereqs();
  logLine("app.log", `Prereq checks: ${JSON.stringify(checks)}`);
  const missing = {
    python: !checks.python,
    node: !checks.node,
    pip: !checks.pip,
    npm: !checks.npm,
    backend: !checks.backend,
    engine: !checks.engine,
  };
  const needsInstall = missing.python || missing.node || missing.pip || missing.npm || missing.backend || missing.engine;

  if (needsInstall && (missing.python || missing.node || missing.pip || missing.npm)) {
    logLine("app.log", "Needs install, showing installer window");
    createInstallerWindow(missing);
    return;
  }
  if (missing.backend || missing.engine) {
    // Critical files missing -> show error instead of black screen
    const html = `
    <html dir="rtl" lang="fa"><head><meta charset="utf-8"><style>
    body{background:#06070b;color:#e6e8f0;font-family:Segoe UI;padding:24px}
    .card{background:#10131f;border:1px solid #5a1a1a;border-radius:12px;padding:16px;margin:12px 0}
    button{background:#4f46e5;color:white;border:0;padding:10px 18px;border-radius:8px;cursor:pointer}
    code{background:#080a12;padding:2px 6px;border-radius:4px}
    </style></head><body>
    <h1>❌ فایل‌های AURION یافت نشد</h1>
    <div class="card">
      <p>ROOT: <code>${ROOT}</code></p>
      <p>DATA: <code>${DATA_DIR}</code></p>
      <p>backend: ${checks.backend ? '✅' : '❌ مفقود'} - ${path.join(ROOT,'backend')}</p>
      <p>engine: ${checks.engine ? '✅' : '❌ مفقود'} - ${path.join(ROOT,'engine')}</p>
      <p>این یعنی MSI بدون extraResources ساخته شده. لطفاً دوباره با کانفیگ جدید build کنید.</p>
      <p>لاگ‌ها: <code>${path.join(DATA_DIR,'logs')}</code></p>
    </div>
    <button onclick="window.aurionDesktop.openLogs()">باز کردن پوشه لاگ</button>
    <button onclick="window.aurionDesktop.openData()">باز کردن پوشه دیتا</button>
    </body></html>`;
    const p = path.join(DATA_DIR, "cache", "missing.html");
    fs.writeFileSync(p, html, "utf8");
    win.loadFile(p);
    return;
  }

  // Show loading while ensuring stack
  const loadingWin = createLoadingWindow();
  const ok = await ensureStack();
  try { loadingWin.close(); } catch {}

  if (!ok) {
    logLine("app.log", "Desk did not answer after ensureStack");
    dialog.showMessageBox(win, {
      type: "warning",
      title: "AURION",
      message: `Desk did not answer on ${DESK}. Check logs at ${path.join(DATA_DIR,'logs')}.\nROOT=${ROOT}`,
    });
    // Still try to load, will show error page if fails
  }
  win.loadURL(DESK);
  win.webContents.on("did-fail-load", (_e, code, desc, url) => {
    logLine("app.log", `did-fail-load ${code} ${desc} ${url}`);
    if (code !== -3) { // -3 = aborted
      const failHtml = `
      <html dir="rtl" lang="fa"><head><meta charset="utf-8"><style>
      body{background:#06070b;color:#e6e8f0;font-family:Segoe UI;padding:24px}
      .card{background:#10131f;border:1px solid #1e233a;border-radius:12px;padding:16px}
      </style></head><body>
      <h2>⚠️ ارتباط با بک‌اند برقرار نشد</h2>
      <div class="card">
        <p>آدرس: <code>${DESK}</code></p>
        <p>کد خطا: ${code} - ${desc}</p>
        <p>ROOT: <code>${ROOT}</code></p>
        <p>لاگ‌ها: <code>${path.join(DATA_DIR,'logs')}/desk.log , engine.log</code></p>
        <p>لطفاً لاگ‌ها را بررسی کنید. معمولاً Python یا Node نصب نشده یا پورت 8080 مشغول است.</p>
      </div>
      </body></html>`;
      const fp = path.join(DATA_DIR, "cache", "fail.html");
      fs.writeFileSync(fp, failHtml, "utf8");
      win.loadFile(fp);
    }
  });
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
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
    ])
  );
}

app.whenReady().then(createMainWindow);
app.on("window-all-closed", () => {
  try { if (engineProc) engineProc.kill(); } catch {}
  try { if (deskProc) deskProc.kill(); } catch {}
  app.quit();
});
app.on("web-contents-created", (event, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http://127.0.0.1:8080") || url.startsWith("http://localhost:8080") || url.startsWith(DESK)) {
      return { action: "allow" };
    }
    shell.openExternal(url);
    return { action: "deny" };
  });
  contents.on("will-navigate", (e, url) => {
    const allowed = url.startsWith(DESK) || url.startsWith("http://127.0.0.1:8080") || url.startsWith("http://localhost:8080");
    if (!allowed && !url.startsWith("file://")) {
      e.preventDefault();
      shell.openExternal(url);
    }
  });
});
