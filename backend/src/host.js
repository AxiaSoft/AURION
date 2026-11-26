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

/**
 * Bring the product back.
 *
 * `kind` picks WHICH of the two scripts runs, and they are not
 * interchangeable:
 *
 *   "restart"  stop the engine, leave the desk and its window
 *              standing, start the engine again. Right for anything
 *              that only changed the engine's state - it is quick and
 *              the trader does not lose their window.
 *
 *   "relaunch" close AURION completely - engine, desk and window -
 *              and open it from nothing.
 *
 * An update must use the second, which is what was asked for: "after
 * installing any update the application should shut down once and
 * open again, not restart". It is also the only correct choice, not
 * a preference. A restart leaves the Node desk process alive, and
 * Node keeps the modules it required for the life of that process;
 * the shell keeps its loaded assemblies; the service worker keeps a
 * cached index.html. An update rewrites all three on disk and none
 * of them would be re-read, so the files would be new and the
 * running program would not be.
 */
function scheduleRestart(kind) {
  const log = path.join(DATA, "logs", "desk.log");
  try { fs.mkdirSync(path.join(DATA, "logs"), { recursive: true }); } catch { /* */ }
  const hidden = path.join(ROOT, "scripts", "hidden.vbs");
  const full = String(kind || "restart") === "relaunch";
  const win = path.join(ROOT, "scripts", full ? "relaunch-aurion.cmd" : "restart-aurion.cmd");
  const sh = path.join(ROOT, "scripts", full ? "relaunch-aurion.sh" : "restart-aurion.sh");
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
      try { fs.appendFileSync(log, `${full ? "relaunch" : "restart"} spawn failed: ${err.message}\n`); } catch { /* */ }
    }
  }, 600);
}

/** Close AURION completely and open it again. See scheduleRestart. */
function scheduleRelaunch() { return scheduleRestart("relaunch"); }

module.exports = { restoreFactoryConfig, wipeDeskState, scheduleRestart, scheduleRelaunch, FACTORY };
