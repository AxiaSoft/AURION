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
/** The script that has been promised but not yet started, if any. */
let pending = null;

/** Start the script now. Safe to call twice: the second call is a no-op. */
function runScriptNow(kind) {
  if (!pending && kind === undefined) return false;
  const job = pending || { full: String(kind || "restart") === "relaunch", timer: null };
  pending = null;
  try { if (job.timer) clearTimeout(job.timer); } catch { /* */ }
  const log = path.join(DATA, "logs", "desk.log");
  try { fs.mkdirSync(path.join(DATA, "logs"), { recursive: true }); } catch { /* */ }
  const hidden = path.join(ROOT, "scripts", "hidden.vbs");
  const win = path.join(ROOT, "scripts", job.full ? "relaunch-aurion.cmd" : "restart-aurion.cmd");
  const sh = path.join(ROOT, "scripts", job.full ? "relaunch-aurion.sh" : "restart-aurion.sh");
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
    return true;
  } catch (err) {
    try { fs.appendFileSync(log, `${job.full ? "relaunch" : "restart"} spawn failed: ${err.message}\n`); } catch { /* */ }
    return false;
  }
}

/**
 * Start whatever was promised, immediately, because this process is
 * about to end.
 *
 * The reported fault, and it was introduced by making the update
 * ending work: "I asked for the app to close and open again after an
 * update. It closes. It never opens."
 *
 * The scheduling below waits 600 ms before spawning, so the HTTP
 * reply that asked for it can reach the desk first. That was safe for
 * as long as nothing else was in a hurry. It stopped being safe the
 * moment the update started ENDING the product itself: the page asks
 * for the relaunch and then tells the window to close, the window
 * stops the engine and posts /api/shutdown, and this process calls
 * process.exit - which throws away pending timers without running
 * them. The script was never started, so nothing was ever going to
 * open AURION again.
 *
 * A promise to restart must therefore survive the shutdown that
 * follows it. shutdownAurion calls this on its way out, and the exit
 * hook below is the backstop for every other way this process can
 * end.
 */
function flushPendingRestart() {
  if (!pending) return false;
  return runScriptNow();
}

process.on("exit", () => { try { flushPendingRestart(); } catch { /* */ } });

function scheduleRestart(kind) {
  const full = String(kind || "restart") === "relaunch";
  try { if (pending && pending.timer) clearTimeout(pending.timer); } catch { /* */ }
  /* A relaunch already promised is not replaced by a lesser restart:
     an update's full relaunch must not be downgraded by whatever
     else happens to call this while it is being carried out. */
  const job = { full: full || Boolean(pending && pending.full), timer: null };
  pending = job;
  job.timer = setTimeout(() => {
    if (pending === job) runScriptNow();
  }, 600);
  /* Deliberately NOT unref'd: an unreferenced timer would let Node
     exit with the promise unkept. */
}

/** Close AURION completely and open it again. See scheduleRestart. */
function scheduleRelaunch() { return scheduleRestart("relaunch"); }

module.exports = {
  restoreFactoryConfig,
  wipeDeskState,
  scheduleRestart,
  scheduleRelaunch,
  flushPendingRestart,
  FACTORY,
};
