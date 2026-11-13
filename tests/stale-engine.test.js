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
  ok(/8080, 18765, 18766/.test(STOP_PS),
    "with the shipped ports as a fallback, never as the only answer");
  ok(/\^python\[0-9\.\]\*\$/.test(STOP_PS),
    "any CPython name matches, not just the four that were typed in");
  ok(/StartsWith\(\$RootFull\.ToLower\(\)\)/.test(STOP_PS),
    "and anything running from inside this installation is recognised as ours");
  ok(/is not AURION/.test(STOP_PS) && /left alone/.test(STOP_PS),
    "somebody else's program on our port is never killed");
  ok(/restart Windows/i.test(STOP_PS),
    "and when it truly cannot win, it names the cure that does work");
}

/* ------------------------------- 3. a failed stop starts nothing */
console.log("\n=== a launcher that cannot free the port starts nothing ===");
{
  /* The precise bug: the engine was started regardless, lost the bind,
     exited, and the survivor answered health - so success was reported
     by a launcher that had changed nothing. */
  const startIdx = START.indexOf("stop-engine.ps1");
  /* The real launch line, not the comment at the top of the file that
     also contains engine\main.py - an indexOf that finds the comment
     would pass no matter where the stop was moved to. */
  const launchIdx = START.indexOf("hidden.vbs\" \"%CD%\" \"%CD%\\data\\logs\\engine.log\"");
  ok(startIdx > 0 && launchIdx > startIdx,
    "start-aurion.cmd frees the ports before it launches the engine");
  const between = START.slice(startIdx, launchIdx);
  ok(/if errorlevel 1 goto :PORTHELD/.test(between),
    "and refuses to launch when they could not be freed");
  ok(/:PORTHELD/.test(START) && /exit \/b 1/.test(START.slice(START.indexOf(":PORTHELD"))),
    "the refusal path exists and exits non-zero");

  const rIdx = RESTART.indexOf("stop-engine.ps1");
  const rStart = RESTART.indexOf("start-aurion.cmd");
  ok(rIdx > 0 && rStart > rIdx && /if errorlevel 1 goto :HELD/.test(RESTART.slice(rIdx, rStart)),
    "restart-aurion.cmd will not restart on top of a surviving engine");
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
