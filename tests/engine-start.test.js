/**
 * The engine has to be startable by every route that claims to start it.
 *
 * Reported from the field, and it cost a day: an update stopped the
 * engine, the desk sat on its refreshing screen, and afterwards nothing
 * would bring the engine back. Not closing the app, not
 * stop-aurion.cmd, and - the detail that made it look fatal - not
 * start-engine.cmd either, which is the script a user is told to run
 * when the engine is down.
 *
 * start-engine.cmd could never have worked on that machine. It ran, and
 * only ever ran:
 *
 *     py -3.12 engine\main.py --host 127.0.0.1 --port 18765
 *
 * Setup unpacks a private interpreter into runtime\python and writes
 * its absolute path into data\runtime.env. start-aurion.cmd looks there
 * first, and so does the desk's engine supervisor - neither needs a
 * `py` launcher to exist. A clean install usually has no system-wide
 * Python 3.12 at all, so the repair script was the one thing guaranteed
 * to fail, and it failed with a message about Python that read as "your
 * installation is broken".
 *
 * What is pinned here:
 *
 *   1. There is ONE resolver, and the hand-run scripts call it.
 *   2. It looks in the documented order, and it refuses the Microsoft
 *      Store alias, which is not an interpreter.
 *   3. No script hard-codes `py -3.12` as its only route to Python, or
 *      a bare `node` as its only route to Node.
 *   4. The three starters agree about the port and the host.
 *   5. A port already held is reported as such rather than left to look
 *      like a crash - that failure is indistinguishable from "it will
 *      not start", because a second engine cannot bind and exits.
 *   6. The resolver is callable: no setlocal, or the variables it sets
 *      would not survive into the caller.
 *
 *     node tests/engine-start.test.js
 */

"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

const RESOLVER = read("scripts/find-runtime.cmd");
const START_ENGINE = read("start-engine.cmd");
const START_DESK = read("start-desk.cmd");
const START_ALL = read("start-aurion.cmd");
const SUPERVISOR = read("backend/src/engine-supervisor.js");

let pass = 0;
const fails = [];
function check(name, fn) {
  try {
    const note = fn();
    pass++;
    console.log("PASS  " + name + (note ? "  — " + note : ""));
  } catch (e) {
    fails.push(name);
    console.log("FAIL  " + name + "\n      " + e.message);
  }
}

/* ---------------------------------------------- 1. one resolver, called */

check("the hand-run scripts ask the shared resolver, not their own guess", () => {
  for (const [name, src] of [["start-engine.cmd", START_ENGINE], ["start-desk.cmd", START_DESK]]) {
    if (!/call "%~dp0scripts\\find-runtime\.cmd"/.test(src)) {
      throw new Error(name + " does not call scripts\\find-runtime.cmd");
    }
  }
  return "both call it";
});

check("the resolver can be called at all", () => {
  /* setlocal would throw away every variable it sets the moment it
     returns, which is the whole point of the file. */
  if (/^\s*setlocal/mi.test(RESOLVER)) throw new Error("find-runtime.cmd uses setlocal, so it sets nothing for its caller");
  if (!/set "AURION_PYCMD=/.test(RESOLVER)) throw new Error("it never sets AURION_PYCMD");
  if (!/set "AURION_NODECMD=/.test(RESOLVER)) throw new Error("it never sets AURION_NODECMD");
  /* And it must say where the answer came from: a machine that fails
     has to be able to report which interpreter it actually used. */
  if (!/AURION_PYFROM/.test(RESOLVER) || !/AURION_NODEFROM/.test(RESOLVER)) {
    throw new Error("the resolver does not record where it found them");
  }
  return "no setlocal, both variables set";
});

/* ------------------------------------------------- 2. the search order */

check("Python is looked for in the documented order", () => {
  const at = (needle) => {
    const i = RESOLVER.indexOf(needle);
    if (i < 0) throw new Error("the resolver never mentions " + needle);
    return i;
  };
  const bundled = at("runtime\\python\\python.exe");
  const env = at("AURION_ENV_PY");
  const launcher = at("py -%%V");
  if (!(bundled < env && env < launcher)) {
    throw new Error("the order is bundled runtime, then runtime.env, then the py launcher");
  }
  /* The engine is pinned to a NumPy with no wheels above CPython 3.12,
     so a bare `python` is only acceptable after a version check. */
  const plain = RESOLVER.slice(RESOLVER.indexOf(":PY_PLAIN"));
  if (!/\(3,10\) <= sys\.version_info\[:2\] <= \(3,12\)/.test(plain)) {
    throw new Error("a `python` of any version would be accepted");
  }
  return "runtime\\python -> runtime.env -> py -3.12/3.11/3.10 -> python";
});

check("the Microsoft Store alias is refused", () => {
  /* %LOCALAPPDATA%\\Microsoft\\WindowsApps\\python.exe is an app
     execution alias. Started detached it exits with no output and no
     log, which is how a run once failed with two empty log files. */
  if (!/WindowsApps/.test(RESOLVER)) throw new Error("the resolver does not know about the Store alias");
  if (!/AURION_ENV_PY_CLEAN/.test(RESOLVER)) throw new Error("the alias is mentioned but never tested for");
  /* The desk's supervisor has always refused it; the two must agree. */
  if (!/WindowsApps/i.test(SUPERVISOR)) throw new Error("the supervisor no longer refuses it");
  return "skipped in both";
});

check("Node is looked for the same way", () => {
  const bundled = RESOLVER.indexOf("runtime\\node\\node.exe");
  const env = RESOLVER.indexOf("AURION_ENV_NODE");
  if (bundled < 0 || env < 0) throw new Error("the resolver does not look for a bundled or recorded Node");
  if (!(bundled < env)) throw new Error("the recorded path is consulted before AURION's own copy");
  if (!/where node/.test(RESOLVER)) throw new Error("there is no PATH fallback");
  return "runtime\\node -> runtime.env -> PATH -> Program Files";
});

/* -------------------------------------------- 3. nothing guesses again */

check("no starter hard-codes a single interpreter", () => {
  const offenders = [];
  for (const [name, src] of [["start-engine.cmd", START_ENGINE], ["start-desk.cmd", START_DESK]]) {
    /* The failure messages are allowed to NAME py -3.12 as one of the
       places that were tried; what they may not do is run it as the
       only route. */
    for (const line of src.split(/\r?\n/)) {
      const t = line.trim();
      if (/^(rem\b|echo\b|:|@echo)/i.test(t)) continue;
      if (/^py\s+-3\.\d+\s/.test(t)) offenders.push(name + ": " + t);
      if (/^node\s+src\\index\.js/.test(t)) offenders.push(name + ": " + t);
    }
  }
  if (offenders.length) throw new Error("still guessing:\n      " + offenders.join("\n      "));
  return "every start goes through the resolver";
});

check("the launcher's own search is unchanged", () => {
  /* start-aurion.cmd was always right. This work must not have
     "simplified" it into the bug it never had. */
  if (!/runtime\\python\\python\.exe/.test(START_ALL)) throw new Error("the launcher lost its bundled-runtime branch");
  if (!/runtime\.env/.test(START_ALL)) throw new Error("the launcher no longer reads runtime.env");
  return "intact";
});

/* ------------------------------------------------- 4. they agree on it */

check("every route starts the same engine on the same port", () => {
  if (!/--host 127\.0\.0\.1 --port %AURION_PORT%/.test(START_ENGINE)) {
    throw new Error("start-engine.cmd no longer binds the configured port to localhost");
  }
  if (!/set "AURION_PORT=18765"/.test(START_ENGINE)) throw new Error("the default port moved");
  if (!/--host", "127\.0\.0\.1", "--port"/.test(SUPERVISOR.replace(/\s+/g, " "))) {
    throw new Error("the supervisor starts the engine with different arguments");
  }
  if (!/engine\\main\.py --host 127\.0\.0\.1 --port 18765/.test(START_ALL)) {
    throw new Error("the launcher disagrees with the hand-run script");
  }
  return "127.0.0.1:18765 everywhere";
});

/* ------------------------------------------- 5. the quiet failure mode */

check("a port that is already held is named, not left to look like a crash", () => {
  if (!/netstat/.test(START_ENGINE)) throw new Error("start-engine.cmd never looks at who holds the port");
  if (!/tasklist/.test(START_ENGINE)) throw new Error("the holder is detected but never named");
  if (!/stop-engine\.ps1/.test(START_ENGINE)) throw new Error("it does not say how to free the port");
  /* And it must not start an engine on top of a held port: that engine
     exits in silence while the old one keeps answering, which is the
     bug stop-engine.ps1 was written for. */
  const held = START_ENGINE.slice(START_ENGINE.indexOf("\n:HELD"));
  if (/main\.py/.test(held)) throw new Error("it starts an engine anyway after reporting the port is held");
  return "reported, and nothing is started";
});

check("a missing library is named one by one, not as 'install the requirements'", () => {
  if (!/import fastapi,numpy,sklearn/.test(START_ENGINE)) throw new Error("the libraries are never probed");
  if (!/find_spec/.test(START_ENGINE)) throw new Error("the missing ones are not named");
  if (!/provision\.ps1/.test(START_ENGINE)) throw new Error("no repair is offered");
  return "named, with the repair beside them";
});

check("the window stays open on every failure", () => {
  /* Double-clicked, a cmd window closes the instant the script ends.
     Every exit that carries a reason has to pause, or the reason is
     the one thing the user never sees. */
  const labels = ["NOPY", "HELD", "NOLIBS", "FAILED"];
  for (const label of labels) {
    /* The label itself, not the `goto` that jumps to it. */
    const at = START_ENGINE.indexOf("\n:" + label);
    if (at < 0) throw new Error("start-engine.cmd has no :" + label + " branch");
    const block = START_ENGINE.slice(at, START_ENGINE.indexOf("exit /b", at));
    if (!/pause/.test(block)) throw new Error(":" + label + " exits without pausing");
  }
  return labels.length + " failure branches, all readable";
});

/* ------------------------------------------------------ 6. the doctor */

check("there is one read-only command that explains a dead engine", () => {
  const doc = read("scripts/engine-doctor.ps1");
  for (const [what, re] of [
    ["the interpreter", /runtime\\python\\python\.exe/],
    ["the port holders", /Get-NetTCPConnection/],
    ["the engine's own health", /\/health/],
    ["whether it is running the files on disk", /restart_required/],
    ["the last error in the log", /engine\.log/],
  ]) {
    if (!re.test(doc)) throw new Error("engine-doctor.ps1 does not report " + what);
  }
  /* It must change nothing: a diagnostic that starts or kills processes
     destroys the state it was called to describe. */
  for (const bad of [/Stop-Process/, /Start-Process/, /Remove-Item/, /Set-Content/, /Out-File/]) {
    if (bad.test(doc)) throw new Error("the doctor is not read-only: " + bad);
  }
  if (!/start-engine\.cmd[\s\S]*engine-doctor\.ps1/.test(START_ENGINE + "\n" + read("start-engine.cmd"))
      && !/engine-doctor\.ps1/.test(START_ENGINE)) {
    throw new Error("nothing points a stuck user at it");
  }
  return "reads five things, writes nothing";
});

check("the resolver and the doctor are shipped", () => {
  const stage = read("installer/tools/stage.ps1");
  if (!/Copy-Tree -From \(Join-Path \$Root "scripts"\)/.test(stage)) {
    throw new Error("the scripts folder is no longer staged, so the resolver would not install");
  }
  const excluded = /-ExcludeFiles @\(([^)]*)\)/.exec(stage);
  if (excluded && /find-runtime|engine-doctor/.test(excluded[1])) {
    throw new Error("the new scripts are excluded from the package");
  }
  return "scripts\\ ships whole";
});

/* ---------------------------------- 7. the alias, by every door it uses */

/*
 * The Store alias is not a path to be blacklisted. It is an outcome.
 *
 * The first guard refused it only where it had been SEEN: the path
 * recorded in data\runtime.env. Then a field machine came back with
 * exactly the same fault and a clean runtime.env, because the alias had
 * walked in through `py -3.12` - the launcher resolved to the Store
 * build, setup asked that interpreter for sys.executable, got a
 * WindowsApps path back, and wrote it into runtime.env itself. The
 * file every script distrusted was being poisoned by the one script
 * every user is told to run.
 *
 * So the test is no longer "is WindowsApps mentioned". It is: does each
 * lookup ask the interpreter where it actually lives, and does setup
 * refuse to write the answer down when it is the alias.
 */

check("the py launcher is asked what it really resolves to", () => {
  const probe = /py -%%V -c "([^"]+)"/.exec(RESOLVER);
  if (!probe) throw new Error("the resolver no longer probes the launcher at all");
  if (!/sys\.executable/.test(probe[1])) {
    throw new Error("`py -3.12` is believed on the strength of running - it can BE the Store alias");
  }
  if (!/windowsapps/i.test(probe[1])) throw new Error("the probe does not test for the alias");
  return "sys.executable, not exit status";
});

check("a bare python is checked for the alias as well as for its version", () => {
  const plain = RESOLVER.slice(RESOLVER.indexOf(":PY_PLAIN"));
  if (!/windowsapps/i.test(plain)) {
    throw new Error("on a stock Windows a bare `python` IS the alias, and it would be accepted");
  }
  return "version and identity";
});

check("the supervisor verifies the launcher before it spawns through it", () => {
  if (!/sys\.executable/.test(SUPERVISOR)) {
    throw new Error("the supervisor still returns `py -3.12` unverified");
  }
  if (!/STORE_ALIAS/.test(SUPERVISOR)) throw new Error("there is no single rule for the alias");
  /* It starts the engine DETACHED, which is the one way the alias
     fails with no output and no log - so guessing here is expensive. */
  if (!/detached: true/.test(SUPERVISOR)) throw new Error("the supervisor no longer starts detached (check this test)");
  return "probed, then spawned";
});

check("setup refuses to record the alias, whichever lookup produced it", () => {
  const prov = read("scripts/provision.ps1");
  if (!/function Test-NotStoreAlias/.test(prov)) {
    throw new Error("provision.ps1 has no single test for the alias");
  }
  /* The py-launcher branch is where it got in. */
  const launcher = prov.slice(prov.indexOf("foreach ($v in @(\"3.12\""));
  if (!/Test-NotStoreAlias/.test(launcher.slice(0, 900))) {
    throw new Error("`py -3.x` is still accepted without asking where it resolves");
  }
  /* And the last line of defence: runtime.env is written once and
     believed by every launcher afterwards. */
  const rec = prov.slice(prov.indexOf("Recording the runtimes"));
  if (!/WindowsApps/.test(rec)) throw new Error("setup would still write the alias into runtime.env");
  return "refused at the lookup and again at the pen";
});

check("refusing the alias explains itself instead of saying 'no Python'", () => {
  const prov = read("scripts/provision.ps1");
  /* On the machine this was written for, "no Python found" is a lie
     that sends the user hunting for an installer: Python 3.12 is right
     there and imports everything. It is the Store build, and the only
     thing it cannot do is run detached - which is the only way AURION
     ever starts it. The message has to say that, or the refusal reads
     as setup breaking a working machine. */
  if (!/function Explain-NoPython/.test(prov)) {
    throw new Error("setup refuses the alias without ever saying why");
  }
  if (!/StoreAliasSeen/.test(prov)) throw new Error("the explanation cannot tell the two cases apart");
  if (!/runtime\\python/.test(prov)) throw new Error("it does not say what the repair produces");
  return "refused, with the reason and the way out";
});

check("the doctor reports the alias however it was found", () => {
  const doc = read("scripts/engine-doctor.ps1");
  if (!/sys\.executable/.test(doc)) {
    throw new Error("the doctor judges `py -3.12` by whether it runs, which the alias does");
  }
  if (!/provision\.ps1/.test(doc)) throw new Error("it names the fault but not the repair");
  return "named with its repair";
});

/* ------------------------------- 8. the doctor knows its own processes */

check("a process is ours by what it runs, not by whose interpreter it borrowed", () => {
  const doc = read("scripts/engine-doctor.ps1");
  /*
   * Reported from the field. The doctor printed:
   *
   *   18765  held by python3.12 (pid 13496)  C:\Program Files\WindowsApps\...
   *
   * and told the user to go and kill it. That process was AURION's own
   * engine. A machine without runtime\python runs our engine under a
   * borrowed interpreter, and an interpreter is never inside the
   * install folder - so the test "$proc.Path starts with $Root" called
   * both halves of the product foreign, every time, on exactly the
   * machines that needed the doctor.
   */
  if (!/Win32_Process/.test(doc)) throw new Error("the doctor never reads a command line");
  if (!/CommandLine/.test(doc)) throw new Error("ownership is still decided by the executable alone");
  if (!/engine\\main\.py/.test(doc)) throw new Error("it does not look for the one file only AURION runs");
  /* A second installation holding this one's port is the opposite
     advice, so it must not be swept into "this installation". */
  if (!/ANOTHER AURION installation/.test(doc)) {
    throw new Error("another installation's engine would be reported as ours");
  }
  return "command line first, path second";
});

check("our own engine holding a port it no longer serves is called out", () => {
  const doc = read("scripts/engine-doctor.ps1");
  /* The quiet one: the port is held by OUR engine, which has stopped
     answering. Nothing new can bind, so every start exits in silence -
     which the user reads as "the engine will not start". */
  if (!/still holding/.test(doc)) {
    throw new Error("a live but unresponsive engine is reported as two unrelated facts");
  }
  if (!/stop-engine\.ps1/.test(doc)) throw new Error("no way out is offered");
  return "the two facts are joined up";
});

console.log("\nengine-start: " + pass + " of " + (pass + fails.length) + " checks passed");
if (fails.length) {
  console.error("\nFAILED:\n  " + fails.join("\n  "));
  process.exit(1);
}
