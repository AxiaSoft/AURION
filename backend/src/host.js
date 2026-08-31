"use strict";

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { ROOT, DATA, CONFIG, USERS, SECRET_FILE, EXPORTS, UPLOADS, ACCESS_DB } = require("./paths");

const FACTORY = path.join(ROOT, "config", "aurion.factory.json");

function wipeFile(file) {
  try {
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } catch { /* keep going */ }
}

function wipeDirContents(dir) {
  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      return;
    }
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      try {
        fs.rmSync(full, { recursive: true, force: true });
      } catch { /* */ }
    }
  } catch { /* */ }
}

function restoreFactoryConfig() {
  if (!fs.existsSync(FACTORY)) return false;
  fs.copyFileSync(FACTORY, CONFIG);
  return true;
}

function wipeDeskState() {
  wipeFile(USERS);
  wipeFile(SECRET_FILE);
  wipeFile(ACCESS_DB);
  wipeFile(ACCESS_DB + "-wal");
  wipeFile(ACCESS_DB + "-shm");
  wipeDirContents(path.join(DATA, "logs"));
  wipeDirContents(EXPORTS);
  wipeDirContents(UPLOADS);
  wipeDirContents(path.join(DATA, "archive"));
  for (const name of ["aurion.engine.db", "aurion.engine.db-wal", "aurion.engine.db-shm"]) {
    wipeFile(path.join(DATA, name));
  }
  wipeDirContents(path.join(ROOT, "engine", "models"));
  try { fs.mkdirSync(path.join(DATA, "logs"), { recursive: true }); } catch { /* */ }
  try { fs.mkdirSync(path.join(ROOT, "engine", "models"), { recursive: true }); } catch { /* */ }
}

function scheduleRestart() {
  const log = path.join(DATA, "logs", "desk.log");
  try { fs.mkdirSync(path.join(DATA, "logs"), { recursive: true }); } catch { /* */ }
  const hidden = path.join(ROOT, "scripts", "hidden.vbs");
  const win = path.join(ROOT, "scripts", "restart-aurion.cmd");
  const sh = path.join(ROOT, "scripts", "restart-aurion.sh");
  setTimeout(() => {
    try {
      if (process.platform === "win32") {
        const child = spawn(
          "cscript.exe",
          ["//nologo", hidden, ROOT, log, "cmd", "/c", win],
          { detached: true, stdio: "ignore", windowsHide: true, cwd: ROOT }
        );
        child.unref();
      } else {
        const child = spawn("bash", [sh], {
          detached: true,
          stdio: "ignore",
          cwd: ROOT,
        });
        child.unref();
      }
    } catch (err) {
      try { fs.appendFileSync(log, `restart spawn failed: ${err.message}\n`); } catch { /* */ }
    }
  }, 600);
}

module.exports = { restoreFactoryConfig, wipeDeskState, scheduleRestart, FACTORY };
