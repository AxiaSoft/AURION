"use strict";

/**
 * Keep the engine running. Nobody should have to close the app for that.
 *
 * Reported from the field, straight after an update: "the engine would
 * not start and I had to close the app and open it again". That is an
 * accurate description of the only recovery that existed. The launcher
 * starts the engine once, at boot, and then nothing anywhere watches it:
 * if it loses the race for its port against the process being replaced,
 * or dies on a bad import, or is killed with the window, the desk comes
 * up perfectly and every request behind it answers "engine_offline"
 * forever. Closing and reopening worked because the launcher runs again
 * - which is a restart of the whole product to fix one process.
 *
 * So the desk watches it. The engine is down for long enough to be
 * really down, the desk starts it, and says so in the log. That is also
 * what makes the update restart trustworthy: the restart script stops
 * both processes and starts them again, and if the engine half of that
 * does not take, this picks it up seconds later instead of leaving a
 * desk talking to nothing.
 *
 * Deliberately conservative, because the failure mode of a supervisor is
 * worse than the failure it fixes:
 *
 *   * It starts the engine only after several consecutive failed health
 *     checks, never on one. A busy engine that misses a poll is not a
 *     dead engine.
 *   * One start at a time, with a cooling-off period between attempts
 *     that grows, and a ceiling on consecutive attempts. An engine that
 *     cannot start - a missing library, an unsupported Python - must not
 *     be respawned in a loop; it must be reported once and left alone.
 *   * The counter resets the moment the engine answers, so a machine
 *     that has been healthy for a day is allowed a fresh set of attempts
 *     the next time something goes wrong.
 *   * The port is the lock. The engine binds it; a second one would
 *     fail and exit. Health is checked immediately before spawning, so
 *     the window in which two could be started is a few milliseconds
 *     wide, and losing that race costs one line in a log.
 *
 * AURION_NO_ENGINE_SUPERVISOR=1 switches it off, for a developer running
 * the engine by hand in a terminal.
 */

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const { ROOT, DATA } = require("./paths");
const engine = require("./engine");
const { load: loadConfig } = require("./config");

const CHECK_MS = 5000;
/* Three misses, not one: the engine is single-threaded in places and a
   backtest can make it slow to answer without being gone. */
const MISSES_BEFORE_START = 3;
const MAX_ATTEMPTS = 5;
/* Grows with each failed attempt: 10s, 20s, 40s, 80s, 160s. A machine
   that is missing a Python library will never start, and hammering it
   only fills the log. */
const BACKOFF_BASE_MS = 10000;

let timer = null;
let misses = 0;
let attempts = 0;
let lastAttemptAt = 0;
let starting = false;
let everSeenHealthy = false;

function logLine(text) {
  const file = path.join(DATA, "logs", "desk.log");
  try { fs.mkdirSync(path.join(DATA, "logs"), { recursive: true }); } catch { /* */ }
  try { fs.appendFileSync(file, `[${new Date().toISOString()}] supervisor: ${text}\n`); } catch { /* */ }
}

/**
 * Which Python, in the order the launcher itself trusts them.
 *
 * data/runtime.env is written by setup and holds absolute paths, which
 * is the only reliable answer on Windows: PATH does not contain a
 * per-user Python in a console that started before it was installed,
 * and the Store alias in WindowsApps is not an interpreter at all - it
 * exits silently when started detached, which is exactly how this
 * starts things.
 */
function findPython() {
  const tried = [];
  const envFile = path.join(DATA, "runtime.env");
  try {
    const raw = fs.readFileSync(envFile, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const m = /^\s*PYTHON\s*=\s*(.+?)\s*$/i.exec(line);
      if (m && m[1] && !/WindowsApps/i.test(m[1]) && fs.existsSync(m[1])) return { cmd: m[1], args: [], from: "runtime.env" };
      if (m) tried.push(m[1]);
    }
  } catch { /* no file is normal */ }

  const bundled = process.platform === "win32"
    ? path.join(ROOT, "runtime", "python", "python.exe")
    : path.join(ROOT, "runtime", "python", "bin", "python3");
  if (fs.existsSync(bundled)) return { cmd: bundled, args: [], from: "bundled runtime" };

  if (process.platform === "win32") {
    /* The launcher prefers `py -3.12`; without a probe we cannot know it
       exists, but a wrong guess costs one failed attempt and a log line,
       and `python` is the fallback underneath it. */
    return { cmd: "py", args: ["-3.12"], from: "py launcher" };
  }
  return { cmd: "python3", args: [], from: "PATH" };
}

function enginePort() {
  try {
    const cfg = loadConfig();
    return Number(process.env.AURION_ENGINE_PORT || (cfg.engine && cfg.engine.port) || 18765);
  } catch { return 18765; }
}

/* The one seam.
 *
 * Everything else here can be exercised honestly - health is a function
 * on another module and can be faked - but "did it decide to start the
 * engine" cannot be checked by actually starting one: a test suite that
 * spawns interpreters is a test suite that leaves processes behind on
 * whatever machine runs it. The decision is what matters and it is what
 * gets tested; the spawn is swapped out underneath. Production never
 * touches this, and the default is the real thing. */
let starter = null;
function setStarter(fn) { starter = typeof fn === "function" ? fn : null; }

/** Start one engine, detached, logging where the launcher logs. */
function startEngine() {
  if (starter) return starter();
  const log = path.join(DATA, "logs", "engine.log");
  try { fs.mkdirSync(path.join(DATA, "logs"), { recursive: true }); } catch { /* */ }
  const py = findPython();
  const port = String(enginePort());
  const mainPy = path.join("engine", "main.py");
  const args = [...py.args, mainPy, "--host", "127.0.0.1", "--port", port];

  try {
    let child;
    if (process.platform === "win32") {
      /* Through hidden.vbs, like the launcher: a detached console window
         popping up on a trader's screen every time the engine is
         recovered would be its own bug report. */
      const hidden = path.join(ROOT, "scripts", "hidden.vbs");
      child = spawn("cscript.exe", ["//nologo", hidden, ROOT, log, py.cmd, ...args], {
        detached: true, stdio: "ignore", windowsHide: true, cwd: ROOT,
      });
    } else {
      const out = fs.openSync(log, "a");
      child = spawn(py.cmd, args, { detached: true, stdio: ["ignore", out, out], cwd: ROOT });
    }
    child.unref();
    logLine(`started the engine with ${py.cmd} (${py.from}) on port ${port}`);
    return true;
  } catch (err) {
    logLine(`could not start the engine with ${py.cmd}: ${err.message}`);
    return false;
  }
}

async function tick() {
  if (starting) return;
  let alive = false;
  try { alive = await engine.healthy(); } catch { alive = false; }

  if (alive) {
    if (misses >= MISSES_BEFORE_START || attempts > 0) {
      logLine("the engine is answering again");
    }
    misses = 0;
    attempts = 0;
    everSeenHealthy = true;
    return;
  }

  misses += 1;
  if (misses < MISSES_BEFORE_START) return;

  if (attempts >= MAX_ATTEMPTS) {
    /* Said once, not every five seconds. Something is wrong that
       restarting cannot fix, and the engine log is where it is. */
    if (attempts === MAX_ATTEMPTS) {
      attempts += 1;
      logLine(`the engine did not come up after ${MAX_ATTEMPTS} attempts - see data/logs/engine.log. Not trying again until it answers.`);
    }
    return;
  }

  const wait = BACKOFF_BASE_MS * Math.pow(2, attempts);
  if (lastAttemptAt && Date.now() - lastAttemptAt < wait) return;

  starting = true;
  try {
    /* Asked again immediately before spawning: everything above took
       seconds, and the engine may have come back inside them. */
    let nowAlive = false;
    try { nowAlive = await engine.healthy(); } catch { nowAlive = false; }
    if (nowAlive) { misses = 0; attempts = 0; return; }

    attempts += 1;
    lastAttemptAt = Date.now();
    logLine(`the engine has not answered ${misses} checks in a row - starting it (attempt ${attempts} of ${MAX_ATTEMPTS})`);
    startEngine();
  } finally {
    starting = false;
  }
}

function start() {
  if (timer) return timer;
  if (process.env.AURION_NO_ENGINE_SUPERVISOR === "1") {
    logLine("disabled by AURION_NO_ENGINE_SUPERVISOR");
    return null;
  }
  timer = setInterval(() => { tick().catch(() => { /* never throw out of a timer */ }); }, CHECK_MS);
  /* Does not hold the process open: the desk's own server does that, and
     a supervisor that kept node alive by itself would turn a stopped
     desk into a process nobody can see. */
  if (timer.unref) timer.unref();
  return timer;
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
}

/** For the health endpoint and the tests: what the supervisor has seen. */
function state() {
  return {
    watching: Boolean(timer),
    misses,
    attempts,
    ever_seen_healthy: everSeenHealthy,
    last_attempt_at: lastAttemptAt ? new Date(lastAttemptAt).toISOString() : "",
    /* Said plainly, because this is the sentence support needs: the
       engine is down and the desk has given up trying to start it. */
    gave_up: attempts > MAX_ATTEMPTS,
  };
}

module.exports = { start, stop, state, startEngine, setStarter, findPython, tick, CHECK_MS, MISSES_BEFORE_START, MAX_ATTEMPTS };
