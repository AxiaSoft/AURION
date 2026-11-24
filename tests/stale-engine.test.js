/**
 * A restart that cannot replace the engine must fail loudly.
 *
 * Reported from the field, and it beat every recovery the product
 * offered:
 *
 *     Engine running c41fe0a155a016fa · files on disk afc90d9a62857752
 *
 * The files on disk were the new build. Restart did not change the
 * number. Repair install did not change the number. Restarting Windows
 * did - which is the signature of a process nothing was managing to
 * kill.
 *
 * Three lines of PowerShell, copied into start-aurion.cmd,
 * restart-aurion.cmd and stop-aurion.cmd, were the whole fault:
 *
 *     Stop-Process -Force -ErrorAction SilentlyContinue
 *     timeout /t 2
 *     start the engine
 *
 * Nothing in that waits for the process to die, nothing notices when
 * the kill is refused, the port list was typed in rather than read from
 * the configuration, and the owner had to be named exactly node,
 * python, pythonw or py. When the kill failed, the launcher started a
 * new engine, that engine could not bind the port and exited, and the
 * OLD one answered /health with 200 - so the launcher declared success
 * and the desk told the user to run a Repair that goes through the same
 * line.
 *
 * This file holds every part of that shut:
 *   1. no launcher still carries the fire-and-forget kill;
 *   2. the stop script waits, reports refusals, and reads its ports;
 *   3. a caller that cannot free the ports does not start an engine;
 *   4. the engine says which folder its fingerprint describes;
 *   5. the desk can tell "old process" from "second installation", and
 *      offers Restart/Repair only where they can possibly work.
 */

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

let fails = 0;
const ok = (cond, name) => {
  if (!cond) fails++;
  console.log(`${cond ? "ok  " : "  x "} ${name}`);
};

const STOP_PS = read("scripts/stop-engine.ps1");
const START = read("start-aurion.cmd");
const RESTART = read("scripts/restart-aurion.cmd");
const STOP_CMD = read("stop-aurion.cmd");
const SERVER_PY = read("engine/aurion/api/server.py");
const ENGINEJS = read("backend/src/engine.js");
const APP = read("apps/web/js/app.js");
const EN = JSON.parse(read("lang/en.json"));
const FA = JSON.parse(read("lang/fa.json"));
const AR = JSON.parse(read("lang/ar.json"));

/* ---------------------------------------- 1. the bad kill is gone */
console.log("\n=== the fire-and-forget kill is gone ===");
{
  const launchers = [
    ["start-aurion.cmd", START],
    ["scripts/restart-aurion.cmd", RESTART],
    ["stop-aurion.cmd", STOP_CMD],
  ];
  for (const [name, src] of launchers) {
    ok(!/\$own\s*=\s*@\(/.test(src),
      `${name} no longer carries the inline process-name allowlist`);
    ok(!/Stop-Process[^\n]*SilentlyContinue/.test(src),
      `${name} does not swallow the outcome of its own kill`);
    ok(/stop-engine\.ps1/.test(src),
      `${name} goes through the script that waits and verifies`);
  }
}

/* ------------------------------------- 2. the stop script verifies */
console.log("\n=== stop-engine.ps1 proves the ports are free ===");
{
  ok(/Get-Date\)\.AddSeconds\(\$TimeoutSec\)/.test(STOP_PS),
    "it waits against a deadline instead of a fixed sleep");
  ok(/while\s*\(\$true\)/.test(STOP_PS) && /Get-PortOwners/.test(STOP_PS),
    "and the wait re-reads the port rather than assuming");
  ok(/-ErrorAction Stop/.test(STOP_PS) && /catch\s*{/.test(STOP_PS),
    "a refused kill is caught, not discarded - access denied is the interesting case");
  ok(/exit 1/.test(STOP_PS) && /exit 0/.test(STOP_PS),
    "it reports success and failure through the exit code");
  ok(/ConvertFrom-Json/.test(STOP_PS) && /config\\aurion\.json/.test(STOP_PS),
    "the ports come from the configuration, so a customised port is still freed");
  ok(/foreach \(\$p in 18765, 18766\)/.test(STOP_PS),
    "with the shipped engine ports as a fallback, never as the only answer");
  /* The desk's port is now scoped. Freeing it is right when the whole
     product is being stopped and catastrophic when only the engine is
     being replaced: it killed the desk that had asked for the restart,
     and the failure path then started nothing, so the trader was left
     with no desk, no engine and no way to be told why. */
  ok(/\[ValidateSet\("all", "engine"\)\]/.test(STOP_PS),
    "the caller can ask for the engine alone");
  ok(/if \(\$Which -eq "all"\) \{ \$found\.Add\(8080\)/.test(STOP_PS),
    "...and the desk's port is only in the list when the whole product is stopping");
  ok(/if \(\$Which -eq "all"\) \{ \$wanted \+= \$json\.backend\.port \}/.test(STOP_PS),
    "...including a desk on a non-default port");
  ok(/\^python\[0-9\.\]\*\$/.test(STOP_PS),
    "any CPython name matches, not just the four that were typed in");
  ok(/StartsWith\(\$RootFull\.ToLower\(\)\)/.test(STOP_PS),
    "and anything running from inside this installation is recognised as ours");
  ok(/is not AURION/.test(STOP_PS) && /left alone/.test(STOP_PS),
    "somebody else's program on our port is never killed");
  ok(/restart Windows/i.test(STOP_PS),
    "and when it truly cannot win, it names the cure that does work");
}

/* ----------- 3. a failed stop is survivable, and never silent ------
 *
 * This section used to require the opposite: a launcher that could not
 * free the port had to start NOTHING. The reasoning was sound - an
 * engine that loses the bind exits, the survivor answers /health, and
 * the launcher reports success having changed nothing - but the remedy
 * was worse than the disease. A trader who hit it was left with no
 * desk, no engine and no window: nothing to read an explanation on and
 * nothing to press. That is the reported "I restart it and the app
 * never comes back, and then nothing works at all".
 *
 * What makes starting safe now is that the engine refuses to be a
 * duplicate itself (section 3a), so the launcher no longer has to
 * enforce it by refusing to launch.
 */
console.log("\n=== a launcher that cannot free the port still brings the desk back ===");
{
  const startIdx = START.indexOf("stop-engine.ps1");
  /* The real launch line, not the comment at the top of the file that
     also contains engine\main.py - an indexOf that finds the comment
     would pass no matter where the stop was moved to. */
  const launchIdx = START.indexOf("hidden.vbs\" \"%CD%\" \"%CD%\\data\\logs\\engine.log\"");
  ok(startIdx > 0 && launchIdx > startIdx,
    "start-aurion.cmd still frees the ports before it launches the engine");
  const between = START.slice(startIdx, launchIdx);
  ok(/if errorlevel 1 call :PORTHELD/.test(between),
    "a port it could not free is reported...");
  /* lastIndexOf: the first ":PORTHELD" in the file is the `call` that
     jumps here, not the block itself. */
  const held = START.slice(START.lastIndexOf(":PORTHELD"));
  /* REM lines stripped first: the block explains what it used to do,
     and that explanation contains the very line we are asserting is
     gone. A source assertion that reads comments passes or fails on
     prose. */
  const heldCode = held.slice(0, held.indexOf("goto :eof"))
    .split(/\r?\n/).filter((l) => !/^\s*REM\b/i.test(l)).join("\n");
  ok(/goto :eof/.test(held) && !/exit \/b 1/.test(heldCode),
    "...and then the launch continues rather than abandoning the machine");

  const rIdx = RESTART.indexOf("stop-engine.ps1");
  ok(rIdx > 0 && /-Scope engine/.test(RESTART),
    "a restart frees the engine only - the desk is not collateral");
  const rHeld = RESTART.slice(RESTART.lastIndexOf(":HELD"));
  ok(/call "%~dp0\.\.\\start-aurion\.cmd"/.test(rHeld),
    "and a restart that cannot replace the engine still brings the desk back");
  ok(/exit \/b 0/.test(rHeld),
    "...reporting success, because the product IS running");
}

/* ------------- 3a. the engine refuses to be the second engine ----- */
console.log("\n=== a second engine declines instead of booting ===");
{
  const MAIN = read("engine/main.py");
  /* uvicorn.run() runs application startup BEFORE it binds the socket,
     and our startup attaches MetaTrader and starts every trading loop.
     So a doomed duplicate used to boot the entire product - seconds of
     numpy, pandas and scikit-learn on a machine that was already too
     busy to answer a health check - and only then discover the port was
     taken. That is what turned one slow moment into the engine going
     offline and online and offline again. */
  ok(/def _claim_port\(/.test(MAIN),
    "the engine claims its port itself");
  const claimIdx = MAIN.indexOf("sock = _claim_port(");
  const numpyIdx = MAIN.indexOf("import numpy", claimIdx > 0 ? 0 : 0);
  const uviIdx = MAIN.indexOf("import uvicorn");
  ok(claimIdx > 0, "...before it serves");
  ok(claimIdx < uviIdx,
    "the port is claimed before uvicorn is even imported");
  ok(MAIN.indexOf("import numpy", claimIdx) > claimIdx,
    "a duplicate does not pay for numpy before finding out it is not needed");
  ok(/Server\(config\)\.run\(sockets=\[sock\]\)/.test(MAIN),
    "and the socket it claimed is the one uvicorn serves, so there is no race in between");
  ok(/_EXIT_PORT_BUSY = 3/.test(MAIN),
    "'already running' has its own exit code, so the desk can tell it from a failure");
  /* Asserted on code, not prose: the comment above _claim_port names
     SO_REUSEADDR precisely to explain why it is not set. */
  ok(!/setsockopt/.test(MAIN),
    "and nothing lets a second process steal a live port");
}

/* --------------------------- 4. the engine names its own folder */
console.log("\n=== the engine says which tree it fingerprinted ===");
{
  ok(/"source_dir": str\(build_id\.SOURCE_DIR\)/.test(SERVER_PY),
    "health reports the folder the build id describes");
  ok(/"pid": os\.getpid\(\)/.test(SERVER_PY),
    "and which process is answering, so a survivor can be named");
  ok(/"started_at": _STARTED_AT/.test(SERVER_PY),
    "and since when, which is what makes it recognisable as a survivor");
  ok(/_STARTED_AT = utc_iso\(\)/.test(SERVER_PY),
    "the start time is taken once, not re-read on every poll");
}

/* ---------------------- 5. two causes, two different answers */
console.log("\n=== the desk tells the two causes apart ===");
{
  ok(/different_tree/.test(ENGINEJS),
    "the backend compares the folders, not only the fingerprints");
  ok(/engine_dir/.test(ENGINEJS) && /disk_dir/.test(ENGINEJS),
    "and reports both paths so the comparison can be checked");
  ok(/replace\(\/\[\\\\\\\\\/\]\+\$\/, ""\)\.toLowerCase\(\)/.test(ENGINEJS)
     || /toLowerCase\(\)/.test(ENGINEJS),
    "the paths are compared the way Windows hands them back");

  ok(/function engineStaleAdvice\(/.test(APP),
    "the desk builds its advice from which state this actually is");
  ok(/verdict\.differentTree/.test(APP),
    "and knows about the second-installation case");
  const advice = APP.slice(APP.indexOf("function engineStaleAdvice("));
  ok(/engine_stale_tree/.test(advice.slice(0, 1200)),
    "a second installation gets the message about folders");
  ok(/engine_stale_cure/.test(advice.slice(0, 1200)),
    "a surviving process gets the cure that works");
  ok(/const actionable = !verdict\.differentTree;/.test(APP),
    "Restart and Repair are withheld where they cannot possibly work");
}

/* ------------------------------------------ 6. the wording itself */
console.log("\n=== the advice is no longer wrong ===");
{
  for (const [name, pack] of [["en", EN], ["fa", FA], ["ar", AR]]) {
    const upd = pack.upd || {};
    for (const key of ["engine_stale_cure", "engine_stale_pid", "engine_stale_tree", "engine_dirs"]) {
      ok(typeof upd[key] === "string" && upd[key].length > 10, `${name} has upd.${key}`);
    }
    ok(/\{pid\}/.test(upd.engine_stale_pid || "") && /\{since\}/.test(upd.engine_stale_pid || ""),
      `${name} names the process and when it started`);
    ok(/\{engine\}/.test(upd.engine_stale_tree || "") && /\{disk\}/.test(upd.engine_stale_tree || ""),
      `${name} names both folders`);
  }
  /* The exact sentence the customer followed twice, to no effect. */
  ok(!/Repair install\.$/.test(EN.upd.engine_stale_body),
    "english no longer ends by recommending the repair that cannot help");
  ok(/Repair install both/.test(EN.upd.engine_stale_body),
    "it says instead that restart and repair both go through the step that did not work");
  ok(!/«ترمیم نصب» را بزنید/.test(FA.upd.engine_stale_body),
    "persian no longer tells the user to press Repair install");
  ok(/stop-aurion\.cmd/.test(EN.upd.engine_stale_cure)
     && /stop-aurion\.cmd/.test(FA.upd.engine_stale_cure)
     && /stop-aurion\.cmd/.test(AR.upd.engine_stale_cure),
    "every language names the thing to actually run");
}

/* ------------------------------------------- 7. no instrument names */
{
  const texts = JSON.stringify([EN.upd, FA.upd, AR.upd]);
  ok(!/EURUSD|XAUUSD/i.test(texts), "the new help text names no instrument");
}

console.log(`\n${fails ? fails + " FAILED of" : "all"} ${fails ? "" : "checks passed"}`);
process.exit(fails ? 1 : 0);
