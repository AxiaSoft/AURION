/**
 * An update that fails offers a way forward; an update that succeeds
 * closes the product and opens it again; and the settings page no
 * longer offers to restart or erase the machine.
 *
 * Asked for in these words:
 *   "when an update hits an internet problem or any other problem,
 *    put a try-again option, or get it updated anyway, or cancel the
 *    update - choose the right option for the error"
 *   "after installing any update the application should shut down
 *    once and open again, not restart"
 *   "remove the restart and factory-reset options from the system
 *    part of the settings"
 *
 *     node tests/update-recovery-and-relaunch.test.js
 */

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");
const APP = read("apps", "web", "js", "app.js");
const HOST = read("backend", "src", "host.js");
const UPDATER = read("backend", "src", "updater.js");
const EN = JSON.parse(read("lang", "en.json"));
const FA = JSON.parse(read("lang", "fa.json"));
const AR = JSON.parse(read("lang", "ar.json"));

const results = [];
function check(name, fn) {
  try {
    const note = fn();
    results.push(true);
    console.log("PASS  " + name + (note ? "  - " + note : ""));
  } catch (e) {
    results.push(false);
    console.log("FAIL  " + name + "\n      " + e.message);
  }
}

/** Strip REM/# comments, so a rule is never confirmed by its own prose. */
const code = (src) => src
  .split(/\r?\n/)
  .filter((line) => !/^\s*(REM\b|::|#)/i.test(line))
  .join("\n");

function liftFn(src, name) {
  let at = src.indexOf("function " + name + "(");
  if (at < 0) throw new Error(name + " is missing");
  if (src.slice(at - 6, at) === "async ") at -= 6;
  const open = src.indexOf("{", at);
  let depth = 0, end = open;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") { depth -= 1; if (!depth) { end = i; break; } }
  }
  return src.slice(at, end + 1);
}

/* ── 1. the right option for the error ─────────────────────────────── */

function classifier() {
  const box = { console };
  vm.createContext(box);
  vm.runInContext(
    /const UPDATE_RETRY_ERRORS = new Set\(\[[^\]]*\]\);/.exec(APP)[0] + "\n"
    + /const UPDATE_BLOCKED_ERRORS = new Set\(\[[^\]]*\]\);/.exec(APP)[0] + "\n"
    + liftFn(APP, "updateFailureKind")
    + "\nthis.kind = updateFailureKind;", box);
  return box.kind;
}

check("a connection problem is offered another go", () => {
  /* The case that was reported: the internet drops mid-update and the
     screen prints a code with nothing to press. */
  const kind = classifier();
  if (kind({ error: "network_error" }) !== "retry") {
    throw new Error("a network error is not treated as retryable");
  }
  return "network_error -> retry";
});

check("a rate limit is told to wait rather than invited to hammer it", () => {
  const kind = classifier();
  if (kind({ error: "github_rate_limited" }) !== "wait") {
    throw new Error("the rate limit is not distinguished from an ordinary failure");
  }
});

check("a misconfiguration is not offered a pointless retry", () => {
  /* Retrying against a server that was never configured cannot
     succeed, and a button that cannot succeed is worse than no
     button: it hides the real problem behind a second failure. */
  const kind = classifier();
  for (const e of ["update_server_not_configured", "no_server", "update_not_found"]) {
    if (kind({ error: e }) !== "blocked") throw new Error(e + " still offers a retry");
  }
  return "3 blocked codes";
});

check("an unrecognised failure is treated as retryable, not as a dead end", () => {
  /* Most failures arrive as whatever an exception happened to say.
     Treating those as permanent leaves the user stuck behind a
     message nobody wrote, which is the complaint. */
  const kind = classifier();
  if (kind({ error: "EBUSY: resource busy" }) !== "retry") {
    throw new Error("an unknown error is a dead end");
  }
  if (kind({ error: "" }) !== "retry") throw new Error("an empty error is a dead end");
});

check("the failure screen actually renders the buttons", () => {
  /* The classifier is only worth anything if the screen uses it. */
  const fn = liftFn(APP, "runUpdateInstall");
  if (!/updateFailureKind\(ar\)/.test(fn)) throw new Error("the screen does not classify the error");
  if (!/data-upd-retry/.test(fn)) throw new Error("there is no retry button");
  if (!/data-upd-cancel/.test(fn)) throw new Error("there is no cancel button");
  if (!/canRetry\s*\?/.test(fn)) throw new Error("the retry button is shown unconditionally");
  if (!/runUpdateInstall\(upd\)/.test(fn.slice(fn.indexOf("data-upd-retry")))) {
    throw new Error("pressing retry does not run the install again");
  }
});

check("a part-applied install is always finishable, even when blocked", () => {
  /* Half the files replaced is worse than either end, so this one
     case overrides the classification. */
  const fn = liftFn(APP, "runUpdateInstall");
  if (!/const stuckPartway = Boolean\(ar && ar\.applied_count\)/.test(fn)) {
    throw new Error("the screen does not notice a part-applied install");
  }
  if (!/kind !== "blocked" \|\| stuckPartway/.test(fn)) {
    throw new Error("a blocked error with files already written offers no way to finish");
  }
  if (!/err_cancel_partial_confirm/.test(fn)) {
    throw new Error("cancelling a half-done install does not warn");
  }
});

check("every new string exists in all three packs", () => {
  const keys = ["err_retry", "err_retry_later", "err_finish", "err_cancel",
    "err_cancel_partial", "err_cancel_partial_confirm"];
  for (const [name, pack] of [["en", EN], ["fa", FA], ["ar", AR]]) {
    for (const k of keys) {
      if (typeof pack.upd[k] !== "string" || !pack.upd[k].trim()) {
        throw new Error(`${name} is missing upd.${k}`);
      }
    }
  }
  return keys.length + " keys x 3 packs";
});

/* ── 2. shut down and open again, not restart ──────────────────────── */

check("the two scripts exist and are different things", () => {
  for (const f of ["relaunch-aurion.cmd", "relaunch-aurion.sh"]) {
    if (!fs.existsSync(path.join(ROOT, "scripts", f))) throw new Error(f + " is missing");
  }
  /* Comments stripped first. Both of these files EXPLAIN the scope
     they use, so a grep over the raw text matches the prose that
     describes the rule rather than the line that implements it -
     two mutations sailed through on exactly that. */
  const cmd = code(read("scripts", "relaunch-aurion.cmd"));
  const restart = code(read("scripts", "restart-aurion.cmd"));
  /* The one difference that matters: a restart frees the engine's
     ports only and leaves the desk and its window standing, which is
     precisely why it cannot pick up new desk files. */
  if (!/-Scope all/.test(cmd)) throw new Error("the relaunch does not stop the desk");
  if (!/-Scope engine/.test(restart)) throw new Error("the restart has started stopping the desk too");
  if (!/taskkill\s+\/im\s+AURION\.exe/i.test(cmd)) {
    throw new Error("the relaunch never closes the window, so it is a restart with extra steps");
  }
});

check("the relaunch starts the product again even if a port is stuck", () => {
  /* "Nothing runs" is not the safe outcome of a failed shutdown. */
  const cmd = code(read("scripts", "relaunch-aurion.cmd"));
  /* The LABEL, not the `goto` that jumps to it. Anchored to the
     start of a line, because slicing from the goto includes the
     ordinary success path below it - and then this check passes
     however broken the failure path is. */
  const at = cmd.search(/^:HELD$/m);
  if (at < 0) throw new Error("the relaunch has no failure path at all");
  const held = cmd.slice(at);
  /* :OPENWINDOW is what starts the product now - the window first, and
     start-aurion.cmd only as its fallback. The failure path has to reach
     it like the success path does. */
  if (!/call :OPENWINDOW/.test(held)) {
    throw new Error("a stuck port leaves the user with no desk at all");
  }
  const sh = code(read("scripts", "relaunch-aurion.sh"));
  if (!/8080/.test(sh)) throw new Error("the shell relaunch does not free the desk port");
  if (!/node src\/index\.js/.test(sh)) throw new Error("the shell relaunch never starts the desk again");
});

check("installing an update relaunches rather than restarts", () => {
  if (!/hostctl\.scheduleRelaunch\(\)/.test(UPDATER)) {
    throw new Error("the apply still only restarts, so new desk files would not be read");
  }
  if (/hostctl\.scheduleRestart\(\)/.test(UPDATER)) {
    throw new Error("the apply still calls the restart");
  }
});

check("host.js can do both, and picks by name rather than by a bare flag", () => {
  if (!/function scheduleRelaunch\(\)/.test(HOST)) throw new Error("there is no scheduleRelaunch");
  if (!/scheduleRelaunch/.test(HOST.slice(HOST.indexOf("module.exports")))) {
    throw new Error("scheduleRelaunch is not exported");
  }
  if (!/relaunch-aurion\.cmd/.test(HOST) || !/relaunch-aurion\.sh/.test(HOST)) {
    throw new Error("host.js does not know about the relaunch scripts");
  }
  /* The ordinary restart must survive: the engine-only path still
     wants it, and replacing it would take the window down for a
     problem that never needed that. */
  if (!/restart-aurion\.cmd/.test(HOST)) throw new Error("the plain restart was lost");
});

/* ── 3. the settings page no longer offers either ──────────────────── */

check("restart and factory reset are gone from the system settings", () => {
  if (/id="sys-restart"/.test(APP)) throw new Error("the restart button is still on the settings page");
  if (/id="sys-factory"/.test(APP)) throw new Error("the factory-reset button is still on the settings page");
  if (/id="danger-zone"/.test(APP)) throw new Error("the danger zone card is still rendered");
  if (/\$\("sys-restart"\)\s*;/.test(APP) || /\$\("sys-factory"\)\s*;/.test(APP)) {
    throw new Error("the buttons are unbound but still looked up");
  }
});

check("...but the recovery paths behind them still work", () => {
  /* Removing a menu item must not remove the ability. The update
     flow and support's scripts both go through these. */
  if (!/\/api\/host\/restart/.test(APP)) throw new Error("the restart route is no longer reachable at all");
  if (!/guarded\.post\("\/host\/restart"/.test(read("backend", "src", "index.js"))) {
    throw new Error("the backend restart route was removed too");
  }
  if (!/factory-reset/.test(read("backend", "src", "index.js"))) {
    throw new Error("the factory-reset route was removed too");
  }
});

/* ── 4. the window really closes, and no blank page is left ───────── */

/* Reported after the relaunch shipped:
 *   "I asked for the whole program to close after an update - the
 *    window too - and come back on the new version. The window never
 *    closes, and when the update finishes an empty html page comes up
 *    and I have to press F5."
 * Three separate faults, pinned here one by one. */

const WINDOW = read("installer", "window", "AppWindow.cs");
const CMD = read("scripts", "relaunch-aurion.cmd");

check("the relaunch does not leave the window standing on a question", () => {
  /* taskkill without /f is a WM_CLOSE, which the shell answers with
     the quit confirmation - and nobody is there to press Yes. The
     polite ask is still right as an opener; what was missing is the
     part that makes it final. */
  if (!/taskkill \/f \/im AURION\.exe/.test(CMD)) {
    throw new Error("a cancelled close leaves AURION.exe alive forever");
  }
  const polite = CMD.indexOf("taskkill /im AURION.exe");
  const forced = CMD.indexOf("taskkill /f /im AURION.exe");
  if (polite < 0 || forced < polite) {
    throw new Error("the window is killed before it is ever asked to save its state");
  }
  if (!/tasklist \/fi "imagename eq AURION\.exe"/i.test(CMD)) {
    throw new Error("the force is unconditional rather than a fallback");
  }
});

check("the page closes the product instead of reloading itself", () => {
  if (!/function closeForUpdateRelaunch\(/.test(APP)) {
    throw new Error("the update still ends in a same-window reload");
  }
  if (!/closeForUpdateRelaunch\(host, mark\)/.test(APP)) {
    throw new Error("finishUpdateRestart never asks the window to close");
  }
  const fn = APP.slice(APP.indexOf("function closeForUpdateRelaunch("));
  if (!/tellHost\(\{ type: "shutdown"/.test(fn.slice(0, 1200))) {
    throw new Error("nothing tells the shell to go");
  }
  /* In a browser tab there is no window to close, so the old ending
     has to stay reachable. */
  if (!/return false;/.test(fn.slice(0, 600))) {
    throw new Error("a browser tab is left with no ending at all");
  }
});

check("the update asks for a full relaunch, and the route obeys it", () => {
  if (!/API\.post\("\/api\/host\/restart", \{ full: true \}\)/.test(APP)) {
    throw new Error("the update's restart still takes the engine-only path");
  }
  const BACKEND = read("backend", "src", "index.js");
  const route = BACKEND.slice(BACKEND.indexOf('guarded.post("/host/restart"'));
  if (!/hostctl\.scheduleRelaunch\(\)/.test(route.slice(0, 600))) {
    throw new Error("the route cannot do a full relaunch at all");
  }
  if (!/hostctl\.scheduleRestart\(\)/.test(route.slice(0, 600))) {
    throw new Error("the engine-only restart was lost");
  }
});

check("a failed navigation is retried rather than left on screen", () => {
  if (!/private async Task RetryNavigationAsync\(\)/.test(WINDOW)) {
    throw new Error("the blank page has no cure but F5");
  }
  if (!/if \(!e\.IsSuccess\)/.test(WINDOW)) {
    throw new Error("NavigationCompleted still treats a failure as an arrival");
  }
  const retry = WINDOW.slice(WINDOW.indexOf("private async Task RetryNavigationAsync()"));
  if (!/DeskIsAnsweringAsync\(\)/.test(retry.slice(0, 1800))) {
    throw new Error("the retry navigates blind instead of waiting for the desk");
  }
  if (!/Navigate\(DeskUrl\)/.test(retry.slice(0, 1800))) {
    throw new Error("the retry never reloads the page");
  }
});

check("the closing screen says so, in every language", () => {
  for (const [name, pack] of [["en", EN], ["fa", FA], ["ar", AR]]) {
    if (!pack.upd || !pack.upd.inst_closing || !pack.upd.inst_closing_sub) {
      throw new Error(`${name} has no words for the closing screen`);
    }
  }
});

/* ── 5. ...and it actually comes back ─────────────────────────────── */

/* Reported after the close was fixed: "I asked for the app to close
 * and open again after an update. It closes. It never opens."
 *
 * Two causes, and the second one is still true even though the
 * product is running afterwards - there is simply nothing on screen. */

check("a promised relaunch survives the shutdown that follows it", () => {
  /* The script sits on a 600 ms timer so the HTTP reply can get out
     first. process.exit throws pending timers away without running
     them - and the update now ends by shutting the product down
     within those 600 ms. */
  if (!/function flushPendingRestart\(/.test(HOST)) {
    throw new Error("nothing can start the script early, so a fast shutdown loses it");
  }
  if (!/flushPendingRestart/.test(HOST.slice(HOST.indexOf("module.exports")))) {
    throw new Error("flushPendingRestart is not exported");
  }
  if (!/process\.on\("exit"/.test(HOST)) {
    throw new Error("no backstop for the other ways this process can end");
  }
  const BACKEND = read("backend", "src", "index.js");
  const fn = BACKEND.slice(BACKEND.indexOf("function shutdownAurion("));
  const head = fn.slice(0, fn.indexOf("supervisor.stop()"));
  if (!/hostctl\.flushPendingRestart\(\)/.test(head)) {
    throw new Error("the shutdown does not keep the promise to come back, or keeps it too late");
  }
});

check("a relaunch already promised is not downgraded to a restart", () => {
  if (!/full: full \|\| Boolean\(pending && pending\.full\)/.test(HOST)) {
    throw new Error("a later engine-only restart can replace an update's full relaunch");
  }
});

check("the relaunch puts the window back on screen", () => {
  /* start-aurion.cmd starts the engine and the desk and stops there.
     It opens a browser only when AURION_NO_BROWSER is unset - and the
     window sets exactly that, so the desk and this script inherit it.
     Nothing opened AURION again. */
  const cmd = read("scripts", "relaunch-aurion.cmd");
  if (!/:OPENWINDOW/.test(cmd)) throw new Error("the relaunch never opens the window");
  const body = cmd.slice(cmd.indexOf(":OPENWINDOW"));
  if (!/start "" "%~dp0[.][.][\\/]+AURION[.]exe"/.test(body)) {
    throw new Error("the window is not started by name");
  }
  if (!/start "" "http:\/\/127\.0\.0\.1:8080"/.test(body)) {
    throw new Error("a tree with no shell beside it is left with nothing on screen");
  }
  /* Both endings - the clean one and the port-held one - have to show
     the trader something. */
  const calls = cmd.match(/call :OPENWINDOW/g) || [];
  if (calls.length < 2) {
    throw new Error("one of the two endings still finishes with no window");
  }
  if (cmd.indexOf("start-aurion.cmd") < 0) {
    throw new Error("nothing can bring the services up when there is no shell");
  }
});

/* --- the three faults reported after an update ----------------------
 *
 * "1. When the update finishes it only shuts down and the app closes -
 *     I want it to run again by itself afterwards.
 *  2. When I open the app myself after an update, the AURION experts
 *     are not detected and their files are not found in the settings
 *     either; I have to shut it down once and open it again before it
 *     comes up properly, the experts appear and the app connects to
 *     MetaTrader."
 *
 * One cause. AURION.exe sets AURION_OWNER_PID to its own pid for the
 * desk it launches, so the desk can take the engine down if the window
 * is killed (see watchOwner). That variable travelled from the window,
 * through the desk, into this script - which kills the window and then
 * started a new desk, handing it the pid of the process it had just
 * killed. The new desk looked its owner up, found a corpse, and shut
 * itself and the engine down seconds after starting.
 */

check("the relaunch does not hand the new desk a dead owner", () => {
  const cmd = code(read("scripts", "relaunch-aurion.cmd"));
  const at = cmd.search(/^:OPENWINDOW$/m);
  if (at < 0) throw new Error("there is no start path to clear it in");
  const open = cmd.slice(at);
  if (!/set "AURION_OWNER_PID="/.test(open)) {
    throw new Error("the pid of the window this script just killed is passed on");
  }
  if (!/set "AURION_NO_BROWSER="/.test(open)) {
    throw new Error("a variable set by a window that is gone still suppresses the fallback");
  }
  const clear = open.indexOf('set "AURION_OWNER_PID="');
  const run = open.indexOf("AURION.exe");
  if (clear > run) throw new Error("it is cleared after the product has already started");
  return "cleared before anything starts";
});

check("the relaunch starts the product once, not twice", () => {
  /* start-aurion.cmd begins by running stop-engine.ps1. Calling it and
     THEN opening the window meant AURION.exe's own launch stopped the
     engine and desk that had just been started here and started them
     again - three processes racing for two ports, which is why the
     engine sometimes came up without its EA bridge. */
  const cmd = code(read("scripts", "relaunch-aurion.cmd"));
  const at = cmd.search(/^:OPENWINDOW$/m);
  const open = cmd.slice(at);
  const before = cmd.slice(0, at);
  if (/call "%~dp0\.\.\\start-aurion\.cmd"/.test(before)) {
    throw new Error("the launcher is still called before the window is opened");
  }
  const win = open.indexOf('start "" "%~dp0..\\AURION.exe"');
  const launcher = open.indexOf('call "%~dp0..\\start-aurion.cmd"');
  if (win < 0 || launcher < 0) throw new Error("one of the two ways to start is missing");
  if (launcher < win) throw new Error("the launcher still runs before the window");
  return "window first, launcher as its fallback";
});

check("...and a window that will not start is not the end of it", () => {
  const cmd = code(read("scripts", "relaunch-aurion.cmd"));
  const open = cmd.slice(cmd.search(/^:OPENWINDOW$/m));
  if (!/tasklist \/fi "imagename eq AURION\.exe"/.test(open)) {
    throw new Error("nothing checks whether the window actually came up");
  }
  if (!/call "%~dp0\.\.\\start-aurion\.cmd"/.test(open)) {
    throw new Error("there is no fallback when it did not");
  }
  return "checked, with the launcher behind it";
});

check("the same variable is cleared on the other platform too", () => {
  const sh = read("scripts", "relaunch-aurion.sh");
  if (!/unset AURION_OWNER_PID/.test(sh)) {
    throw new Error("the shell relaunch still passes the owner pid on");
  }
  return "unset before the desk is started";
});

check("a desk whose owner is already dead does not shut itself down", () => {
  /* The second lock on the same door, in the desk itself: a pid that
     was never alive on our watch cannot be something we watched die. */
  const idx = read("backend", "src", "index.js");
  if (!/function pidAlive\(/.test(idx)) throw new Error("there is no liveness check to reuse");
  const fn = idx.slice(idx.indexOf("function watchOwner("));
  const body = fn.slice(0, fn.indexOf("\n}\n"));
  if (!/if \(!pidAlive\(owner\)\) \{/.test(body)) {
    throw new Error("a stale inherited pid is still treated as a window that disappeared");
  }
  if (!/return null;/.test(body.slice(body.indexOf("if (!pidAlive(owner))")))) {
    throw new Error("it notices but still arms the watch");
  }
  return "ignored, and said so in the log";
});

console.log("");
const bad = results.filter((r) => !r).length;
console.log(`update-recovery-and-relaunch: ${bad ? bad + " of " + results.length + " checks FAILED" : results.length + " checks passed"}`);
process.exit(bad ? 1 : 0);
