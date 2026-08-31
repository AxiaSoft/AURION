"use strict";

/**
 * Bundled prerequisite downloader for the AURION Windows app.
 *
 * It performs the same steps as windows-app/installer/install-windows.ps1, but
 * without needing PowerShell, so it also works from the packaged app.
 */

const fs = require("fs");
const path = require("path");
const https = require("https");
const { spawn, spawnSync } = require("child_process");

const runtime = require("./runtime");

function getRoot() {
  try {
    const rp = process.resourcesPath || path.resolve(__dirname, "..", "..");
    if (fs.existsSync(path.join(rp, "backend", "src", "index.js"))) return rp;
    const alt = path.resolve(rp, "..");
    if (fs.existsSync(path.join(alt, "backend", "src", "index.js"))) return alt;
  } catch { /* fall through */ }
  return path.resolve(__dirname, "..", "..");
}

let ROOT = getRoot();
let DATA_DIR = path.join(ROOT, "data");

function refreshPaths() {
  ROOT = getRoot();
  DATA_DIR = path.join(ROOT, "data");
  return { ROOT, DATA_DIR };
}

function log(msg) {
  try {
    const { DATA_DIR: D } = refreshPaths();
    const dir = path.join(D, "logs");
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, "installer.log"), `[${new Date().toISOString()}] ${runtime.redact(msg)}\n`);
  } catch { /* best effort */ }
  console.log(msg);
}

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------

/**
 * Download to <dest>.part and rename on success, so a half-finished file is
 * never mistaken for a good one.  Rejects redirects that leave an open handle
 * (on Windows unlinking an open file fails).
 */
function downloadFile(url, dest, onProgress, redirects) {
  const hops = redirects || 0;
  return new Promise((resolve, reject) => {
    if (hops > 5) return reject(new Error("Too many redirects for " + url));
    const tmp = dest + ".part";
    try { fs.mkdirSync(path.dirname(dest), { recursive: true }); } catch { /* exists */ }
    const file = fs.createWriteStream(tmp);
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      file.close(() => {
        try { fs.unlinkSync(tmp); } catch { /* ignore */ }
        reject(err);
      });
    };
    const req = https.get(url, (res) => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        file.close(() => {
          try { fs.unlinkSync(tmp); } catch { /* ignore */ }
          downloadFile(res.headers.location, dest, onProgress, hops + 1).then(resolve, reject);
        });
        return;
      }
      if (status !== 200) {
        res.resume();
        return fail(new Error(`HTTP ${status} for ${url}`));
      }
      const total = parseInt(res.headers["content-length"] || "0", 10);
      let downloaded = 0;
      res.on("data", (chunk) => {
        downloaded += chunk.length;
        if (onProgress && total) onProgress(downloaded, total);
      });
      res.pipe(file);
      file.on("finish", () => {
        if (settled) return;
        settled = true;
        file.close(() => {
          try {
            if (fs.existsSync(dest)) fs.unlinkSync(dest);
            fs.renameSync(tmp, dest);
            resolve(dest);
          } catch (e) { reject(e); }
        });
      });
      file.on("error", fail);
      res.on("error", fail);
    });
    req.on("error", fail);
    req.setTimeout(60000, () => req.destroy(new Error("Download timeout: " + url)));
  });
}

/** An MSI is an OLE compound file: D0 CF 11 E0. Anything else is an error page. */
function isMsi(file) {
  try {
    const fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(8);
    fs.readSync(fd, buf, 0, 8, 0);
    fs.closeSync(fd);
    return buf[0] === 0xd0 && buf[1] === 0xcf && buf[2] === 0x11 && buf[3] === 0xe0;
  } catch { return false; }
}

/** A Windows installer is a PE file: MZ. */
function isPe(file) {
  try {
    const fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(2);
    fs.readSync(fd, buf, 0, 2, 0);
    fs.closeSync(fd);
    return buf[0] === 0x4d && buf[1] === 0x5a;
  } catch { return false; }
}

// ---------------------------------------------------------------------------
// Python
// ---------------------------------------------------------------------------

const PYTHON_URLS = [
  "https://www.python.org/ftp/python/3.12.10/python-3.12.10-amd64.exe",
  "https://www.python.org/ftp/python/3.12.8/python-3.12.8-amd64.exe",
];

async function installPython(cacheDir, onProgress) {
  if (runtime.findPython()) {
    log("Supported Python already present");
    return true;
  }
  const cache = cacheDir;
  let installer = null;
  for (const url of PYTHON_URLS) {
    const dest = path.join(cache, path.basename(url));
    try {
      if (!fs.existsSync(dest) || !isPe(dest) || fs.statSync(dest).size < 10 * 1024 * 1024) {
        log(`Downloading Python from ${url}`);
        await downloadFile(url, dest, onProgress);
      }
      if (isPe(dest)) { installer = dest; break; }
      log(`${dest} is not a Windows installer - discarding`);
      try { fs.unlinkSync(dest); } catch { /* ignore */ }
    } catch (e) {
      log(`Python download failed ${url}: ${e.message}`);
    }
  }
  if (!installer) throw new Error("Could not download the Python 3.12 installer");

  log("Running the Python 3.12 silent installer");
  return new Promise((resolve, reject) => {
    const child = spawn(installer, [
      "/quiet", "InstallAllUsers=0", "PrependPath=1",
      "Include_launcher=1", "Include_pip=1", "Include_test=0",
    ], { windowsHide: true });
    child.on("close", (code) => {
      if (code === 0 || code === 3010) {
        runtime.refreshPath(true);
        log("Python installed");
        resolve(true);
      } else {
        reject(new Error("Python installer exit " + code));
      }
    });
    child.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// Node.js
// ---------------------------------------------------------------------------

// LTS first: scripts/fix-npm.ps1 documents Node 26 failing TLS mid-tarball
// (ERR_SSL_CIPHER_OPERATION_FAILED) during "npm install", so 22 LTS is tried
// before the current release.  backend/package.json accepts >=18 <=30.
const NODE_URLS = [
  "https://nodejs.org/dist/v22.22.3/node-v22.22.3-x64.msi",
  "https://nodejs.org/dist/v26.8.1/node-v26.8.1-x64.msi",
  "https://nodejs.org/dist/v26.5.1/node-v26.5.1-x64.msi",
  "https://npmmirror.com/mirrors/node/v22.22.3/node-v22.22.3-x64.msi",
];

async function installNode(cacheDir, onProgress) {
  const existing = runtime.findNode();
  if (existing) {
    log(`Node.js ${existing.version} already present at ${existing.exe}`);
    return true;
  }
  let msiPath = null;
  for (const url of NODE_URLS) {
    const dest = path.join(cacheDir, path.basename(url));
    try {
      if (!fs.existsSync(dest) || !isMsi(dest)) {
        log(`Downloading Node from ${url}`);
        await downloadFile(url, dest, onProgress);
      }
      if (isMsi(dest) && fs.statSync(dest).size > 8 * 1024 * 1024) { msiPath = dest; break; }
      log(`${dest} is not a valid MSI - discarding`);
      try { fs.unlinkSync(dest); } catch { /* ignore */ }
    } catch (e) {
      log(`Node download failed ${url}: ${e.message}`);
    }
  }
  if (!msiPath) throw new Error("Failed to download a Node.js MSI");

  log(`Installing Node MSI ${msiPath}`);
  return new Promise((resolve, reject) => {
    const { DATA_DIR: D } = refreshPaths();
    const logDir = path.join(D, "logs");
    fs.mkdirSync(logDir, { recursive: true });
    const logFile = path.join(logDir, "node-msi.log");
    const child = spawn("msiexec.exe", ["/i", msiPath, "/qn", "/norestart", "/L*v", logFile], { windowsHide: true });
    child.on("close", (code) => {
      if (code === 0 || code === 3010) {
        runtime.refreshPath(true);
        log("Node installed");
        resolve(true);
      } else {
        reject(new Error(`msiexec exit ${code} (1620 = not a valid MSI). Log: ${logFile}`));
      }
    });
    child.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// Packages
// ---------------------------------------------------------------------------

function pipInstall(py, args, timeout) {
  return spawnSync(py.cmd, [...py.prefix, "-m", "pip", "--disable-pip-version-check", ...args], {
    cwd: ROOT,
    windowsHide: true,
    timeout: timeout || 600000,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
}

async function installPipPackages() {
  const { ROOT: R } = refreshPaths();
  const reqFile = path.join(R, "engine", "requirements.txt");
  const py = runtime.findPython();
  if (!py) throw new Error("No supported Python (3.10-3.12) available for pip install");
  log(`Installing Python packages with ${py.label}`);

  if (!fs.existsSync(reqFile)) {
    log(`requirements.txt not found at ${reqFile}, skipping pip install`);
    return true;
  }
  let res = pipInstall(py, ["install", "--no-cache-dir", "-r", reqFile]);
  if (res.status !== 0) {
    log("pip install failed: " + String(res.stderr || res.stdout || "").slice(-1500));
    throw new Error("pip install -r engine/requirements.txt failed");
  }
  // Optional: the MT5 API and the PostgreSQL driver.  Their absence must not
  // abort the install - SQLite and the EA bridge still work.
  for (const extra of [["MetaTrader5>=5.0.4874"], ["psycopg[binary]>=3.1"]]) {
    const r = pipInstall(py, ["install", "--no-cache-dir", ...extra], 300000);
    if (r.status !== 0) log(`Optional package skipped: ${extra[0]}`);
  }
  const check = spawnSync(py.cmd, [...py.prefix, "-c", "import numpy, pandas, sklearn, fastapi, uvicorn; print('py-stack', numpy.__version__, 'ok')"], {
    encoding: "utf8", windowsHide: true, timeout: 120000,
  });
  if (check.status !== 0) {
    throw new Error("Python stack import failed: " + String(check.stderr || "").slice(-800));
  }
  log("Python packages ok: " + String(check.stdout || "").trim());
  return true;
}

function installNpmPackages() {
  const { ROOT: R } = refreshPaths();
  if (runtime.hasDeskPackages(R)) {
    log("Desk packages already present");
    return true;
  }
  const backend = path.join(R, "backend");
  if (!fs.existsSync(path.join(backend, "package.json"))) {
    log(`backend/package.json not found at ${backend}, skipping npm install`);
    return true;
  }
  const node = runtime.findNode();
  if (!node) throw new Error("Node.js 18+ is required to install the desk packages");
  const npmDir = path.dirname(node.exe);
  const npmCli = fs.existsSync(path.join(npmDir, "node_modules", "npm", "bin", "npm-cli.js"))
    ? path.join(npmDir, "node_modules", "npm", "bin", "npm-cli.js")
    : null;

  log("Installing desk packages (npm install --omit=dev)");
  const args = npmCli
    ? [npmCli, "install", "--no-audit", "--no-fund", "--omit=dev"]
    : ["install", "--no-audit", "--no-fund", "--omit=dev"];
  const cmd = npmCli ? node.exe : "npm";
  const res = spawnSync(cmd, args, {
    cwd: backend,
    windowsHide: true,
    shell: !npmCli,           // npm is a .cmd shim on Windows
    timeout: 900000,
    encoding: "utf8",
    env: Object.assign({}, process.env, {
      NPM_CONFIG_FETCH_RETRIES: "5",
      NPM_CONFIG_FETCH_RETRY_MINTIMEOUT: "20000",
      NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT: "120000",
    }),
  });
  if (res.status !== 0) {
    log("npm install failed: " + String(res.stderr || res.stdout || "").slice(-1500));
    throw new Error("npm install failed in backend/");
  }
  if (!runtime.hasDeskPackages(R)) throw new Error("npm finished but express/ws/jsonwebtoken/bcryptjs are missing");
  log("Desk packages ok");
  return true;
}

// ---------------------------------------------------------------------------
// Local tree preparation
// ---------------------------------------------------------------------------

function prepareFolders() {
  const { ROOT: R, DATA_DIR: D } = refreshPaths();
  for (const rel of ["logs", "cache", "exports", "uploads", "archive", "ea-inbox"]) {
    try { fs.mkdirSync(path.join(D, rel), { recursive: true }); } catch { /* best effort */ }
  }
  try { fs.mkdirSync(path.join(R, "engine", "models"), { recursive: true }); } catch { /* best effort */ }
}

function copyExpertAdvisor() {
  const { ROOT: R } = refreshPaths();
  const src = path.join(R, "engine", "ea", "AurionBridge.mq5");
  if (!fs.existsSync(src) || !process.env.APPDATA) return 0;
  const terminals = path.join(process.env.APPDATA, "MetaQuotes", "Terminal");
  if (!fs.existsSync(terminals)) return 0;
  let copied = 0;
  for (const entry of fs.readdirSync(terminals, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const experts = path.join(terminals, entry.name, "MQL5", "Experts", "Aurion");
    if (!fs.existsSync(path.join(terminals, entry.name, "MQL5", "Experts"))) continue;
    try {
      fs.mkdirSync(experts, { recursive: true });
      fs.copyFileSync(src, path.join(experts, "AurionBridge.mq5"));
      const alias = path.join(R, "engine", "ea", "AurionChartAgent.mq5");
      if (fs.existsSync(alias)) fs.copyFileSync(alias, path.join(experts, "AurionChartAgent.mq5"));
      copied++;
      log("EA copied -> " + experts);
    } catch (e) {
      log("EA copy failed for " + experts + ": " + e.message);
    }
  }
  if (copied === 0) log("No local MetaTrader 5 Experts folder found yet");
  return copied;
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

async function runFullInstall(onProgress, onLog) {
  const { ROOT: R, DATA_DIR: D } = refreshPaths();
  runtime.refreshPath(true);
  const cacheDir = path.join(D, "cache");
  fs.mkdirSync(cacheDir, { recursive: true });

  const steps = [
    { name: "Python 3.12", fn: () => installPython(cacheDir, onProgress) },
    { name: "Node.js LTS", fn: () => installNode(cacheDir, onProgress) },
    { name: "Python packages", fn: () => installPipPackages() },
    { name: "Desk packages", fn: () => installNpmPackages() },
    { name: "Folders + EA", fn: async () => { prepareFolders(); copyExpertAdvisor(); return true; } },
  ];

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (onLog) onLog(`[${i + 1}/${steps.length}] ${step.name}...`);
    log(`[${i + 1}/${steps.length}] ${step.name}`);
    if (onProgress) onProgress((i / steps.length) * 100, 100, step.name);
    await step.fn();
    runtime.refreshPath(true);
    if (onProgress) onProgress(((i + 1) / steps.length) * 100, 100, step.name);
  }
  if (onLog) onLog("All prerequisites installed");
  log(`Install finished. ROOT=${R}`);
  return true;
}

module.exports = {
  refreshPaths,
  isMsi,
  isPe,
  runFullInstall,
  downloadFile,
  installPython,
  installNode,
  installPipPackages,
  installNpmPackages,
  prepareFolders,
  copyExpertAdvisor,
};
