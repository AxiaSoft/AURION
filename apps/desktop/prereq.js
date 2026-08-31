const fs = require("fs");
const path = require("path");
const https = require("https");
const { spawn, execSync } = require("child_process");
const crypto = require("crypto");

function getRoot() {
  try {
    // In packaged app, extraResources are in process.resourcesPath
    const rp = process.resourcesPath || path.resolve(__dirname, "..", "..");
    if (fs.existsSync(path.join(rp, "backend", "src", "index.js")) || fs.existsSync(path.join(rp, "backend"))) return rp;
    const alt = path.join(rp, "..");
    if (fs.existsSync(path.join(alt, "backend"))) return alt;
    // dev
    return path.resolve(__dirname, "..", "..");
  } catch { return path.resolve(__dirname, "..", ".."); }
}
function getDataDir() {
  try {
    const { app } = require("electron");
    if (app && app.isPackaged) return app.getPath("userData");
  } catch {}
  try {
    const electron = require("electron");
    if (electron.app && electron.app.isPackaged) return electron.app.getPath("userData");
  } catch {}
  return path.join(getRoot(), "data");
}
let ROOT = getRoot();
let DATA_DIR = getDataDir();
function refreshPaths() {
  ROOT = getRoot();
  DATA_DIR = getDataDir();
  return { ROOT, DATA_DIR };
}

function log(msg) {
  try {
    const { ROOT: R, DATA_DIR: D } = refreshPaths();
    const dir = path.join(D, "logs");
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, "installer.log"), `[${new Date().toISOString()}] ${msg}\n`);
  } catch {}
  console.log(msg);
}

function checkPython() {
  for (const ver of ["3.13", "3.12", "3.11"]) {
    try {
      const [maj,min]=ver.split('.').map(Number);
      execSync(`py -${ver} -c "import sys; assert sys.version_info[:2]==(${maj},${min})"`, { timeout: 5000, windowsHide: true });
      return true;
    } catch {}
  }
  try {
    execSync('python -c "import sys; assert sys.version_info[:2]>=(3,11)"', { timeout: 5000, windowsHide: true });
    return true;
  } catch { return false; }
}

function checkNode() {
  try {
    const v = execSync('node -p "process.versions.node.split(\'.\')[0]"', { timeout: 3000, encoding: "utf8", windowsHide: true });
    const maj = parseInt(String(v).trim(), 10);
    return maj >= 18 && maj <= 30;
  } catch { return false; }
}

function downloadFile(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // redirect
        file.close();
        fs.unlinkSync(dest);
        return downloadFile(res.headers.location, dest, onProgress).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        file.close();
        try { fs.unlinkSync(dest); } catch {}
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const total = parseInt(res.headers["content-length"] || "0", 10);
      let downloaded = 0;
      res.on("data", (chunk) => {
        downloaded += chunk.length;
        if (onProgress && total) onProgress(downloaded, total);
      });
      res.pipe(file);
      file.on("finish", () => {
        file.close(() => resolve(dest));
      });
    }).on("error", (err) => {
      try { fs.unlinkSync(dest); } catch {}
      reject(err);
    });
  });
}

async function installPython(cacheDir, onProgress) {
  if (checkPython()) {
    log("Python 3.12 already present");
    return true;
  }
  const url = "https://www.python.org/ftp/python/3.12.10/python-3.12.10-amd64.exe";
  const dest = path.join(cacheDir, "python-3.12.10-amd64.exe");
  if (!fs.existsSync(dest)) {
    log(`Downloading Python from ${url}`);
    await downloadFile(url, dest, onProgress);
  }
  log("Running Python installer silent");
  return new Promise((resolve, reject) => {
    const child = spawn(dest, ["/quiet", "InstallAllUsers=0", "PrependPath=1", "Include_launcher=1"], { windowsHide: true });
    child.on("close", (code) => {
      if (code === 0 || code === 3010) {
        log("Python installed");
        resolve(true);
      } else {
        reject(new Error("Python installer exit " + code));
      }
    });
    child.on("error", reject);
  });
}

async function installNode(cacheDir, onProgress) {
  if (checkNode()) {
    log("Node.js already present");
    return true;
  }
  const urls = [
    "https://nodejs.org/dist/v26.8.1/node-v26.8.1-x64.msi",
    "https://nodejs.org/dist/v26.5.1/node-v26.5.1-x64.msi",
    "https://nodejs.org/dist/v22.22.3/node-v22.22.3-x64.msi",
  ];
  let msiPath = null;
  for (const url of urls) {
    const name = path.basename(url);
    const dest = path.join(cacheDir, name);
    try {
      if (!fs.existsSync(dest)) {
        log(`Downloading Node from ${url}`);
        await downloadFile(url, dest, onProgress);
      }
      // verify MSI header
      const fd = fs.openSync(dest, "r");
      const buf = Buffer.alloc(8);
      fs.readSync(fd, buf, 0, 8, 0);
      fs.closeSync(fd);
      if (buf[0] === 0xD0 && buf[1] === 0xCF) {
        msiPath = dest;
        break;
      } else {
        fs.unlinkSync(dest);
      }
    } catch (e) {
      log(`Node download failed ${url}: ${e.message}`);
    }
  }
  if (!msiPath) throw new Error("Failed to download Node.js MSI");
  log(`Installing Node MSI ${msiPath}`);
  return new Promise((resolve, reject) => {
    const { DATA_DIR: D } = refreshPaths();
    const logFile = path.join(D, "logs", "node-msi.log");
    const child = spawn("msiexec.exe", ["/i", msiPath, "/qn", "/norestart", "/L*v", logFile], { windowsHide: true });
    child.on("close", (code) => {
      if (code === 0 || code === 3010) {
        log("Node installed");
        resolve(true);
      } else {
        reject(new Error("msiexec exit " + code));
      }
    });
    child.on("error", reject);
  });
}

async function installPipPackages(onProgress) {
  log("Installing Python packages");
  const { ROOT: R } = refreshPaths();
  const reqFile = path.join(R, "engine", "requirements.txt");
  if (!fs.existsSync(reqFile)) {
    log(`requirements.txt not found at ${reqFile}, skipping pip install`);
    return true;
  }
  const pyVers = ["3.13", "3.12", "3.11"];
  let ok = false;
  let lastErr = null;
  for (const ver of pyVers) {
    try {
      execSync(`py -${ver} -m pip install --upgrade pip`, { timeout: 120000, windowsHide: true });
      execSync(`py -${ver} -m pip install -r "${reqFile}"`, { timeout: 300000, windowsHide: true });
      log("Python packages ok via py -"+ver);
      ok = true;
      break;
    } catch (e) {
      lastErr = e;
      log(`pip install via ${ver} failed: ${e.message}`);
    }
  }
  if (!ok) {
    try {
      execSync("python -m pip install --upgrade pip", { timeout: 120000, windowsHide: true });
      execSync(`python -m pip install -r "${reqFile}"`, { timeout: 300000, windowsHide: true });
      log("Python packages ok via python");
      ok = true;
    } catch (e) {
      lastErr = e;
    }
  }
  if (!ok) {
    log("pip install failed: " + (lastErr && lastErr.message));
    throw lastErr || new Error("pip failed");
  }
}

async function installNpmPackages() {
  const { ROOT: R } = refreshPaths();
  const nm = path.join(R, "backend", "node_modules", "express");
  const nm2 = path.join(R, "backend", "node_modules", "fastify");
  if (fs.existsSync(nm) || fs.existsSync(nm2)) {
    log("npm packages already present");
    return true;
  }
  const pkg = path.join(R, "backend", "package.json");
  if (!fs.existsSync(pkg)) {
    log(`backend/package.json not found at ${pkg}, skipping npm install`);
    return true;
  }
  log("Installing npm packages");
  return new Promise((resolve, reject) => {
    const child = spawn("npm", ["install", "--no-audit", "--no-fund"], { cwd: path.join(R, "backend"), windowsHide: true, shell: true });
    let out = "";
    child.stdout.on("data", (d) => out += d.toString());
    child.stderr.on("data", (d) => out += d.toString());
    child.on("close", (code) => {
      if (code === 0) {
        log("npm ok");
        resolve(true);
      } else {
        log("npm failed: " + out.slice(-2000));
        reject(new Error("npm install failed"));
      }
    });
  });
}

async function runFullInstall(onProgress, onLog) {
  const { ROOT: R, DATA_DIR: D } = refreshPaths();
  const cacheDir = path.join(D, "cache");
  fs.mkdirSync(cacheDir, { recursive: true });
  const steps = [
    { name: "Python 3.12+", fn: () => installPython(cacheDir, onProgress) },
    { name: "Node.js LTS", fn: () => installNode(cacheDir, onProgress) },
    { name: "Python packages", fn: () => installPipPackages(onProgress) },
    { name: "Node packages", fn: () => installNpmPackages() },
  ];
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    onLog && onLog(`[${i+1}/${steps.length}] ${step.name}...`);
    onProgress && onProgress((i / steps.length) * 100, 100, step.name);
    await step.fn();
    onProgress && onProgress(((i+1) / steps.length) * 100, 100, step.name);
  }
  onLog && onLog("All prerequisites installed");
  return true;
}

module.exports = { checkPython, checkNode, runFullInstall, downloadFile };
