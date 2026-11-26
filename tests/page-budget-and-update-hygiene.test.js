/**
 * Four faults, reported together.
 *
 *   1. "I said download 10 000 candles. On M5 it is downloading
 *       51 840, and the engine keeps dropping, and settings will not
 *       save - it says the engine is off."
 *   2. "After every update, clear every cache of the previous
 *       version. Every cache there is."
 *   3. "Put a cancel button on the repair install so the repair can
 *       be stopped."
 *   4. "An update must shut the app down completely, clear the
 *       caches, and bring it back up on the new version by itself."
 *
 * The arithmetic behind the first one, which is also the link to the
 * other half of that report: 180 days of M5 is 180 x 1440 / 5 =
 * 51 840 bars, which is what at_least_window() returns for M5 and
 * exactly the number on the trader's screen. The page budget is
 * 10 000 (PAGE_BARS), so one /api/market call was asking for 5.18
 * times the entire budget - and the desk posts /api/market
 * immediately before every /api/candles, on every symbol and
 * timeframe change. The AI inference over those bars then ran INLINE
 * on the event loop, so the engine stopped answering the desk's 5 s
 * health check: "the engine is off", settings refusing to save.
 *
 *     node tests/page-budget-and-update-hygiene.test.js
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");
const APP = read("apps", "web", "js", "app.js");
const UPDATER = read("backend", "src", "updater.js");
const INDEX = read("backend", "src", "index.js");
const TRADER = read("engine", "aurion", "runtime", "trader.py");
const SERVER = read("engine", "aurion", "api", "server.py");
const RELAUNCH_CMD = read("scripts", "relaunch-aurion.cmd");
const RELAUNCH_SH = read("scripts", "relaunch-aurion.sh");

let passed = 0;
let failed = 0;
const ok = (cond, name) => {
  if (cond) { passed++; console.log("ok   " + name); }
  else { failed++; console.log("FAIL " + name); }
};
const section = (t) => console.log("\n\u2014 " + t + "\n");

/** A Python function body, by name, with its comments and docstring gone. */
function pyBody(src, name) {
  const at = src.indexOf("    async def " + name + "(");
  const start = at < 0 ? src.indexOf("    def " + name + "(") : at;
  if (start < 0) throw new Error("trader.py has no " + name);
  const next = src.indexOf("\n    async def ", start + 10);
  const next2 = src.indexOf("\n    def ", start + 10);
  const end = Math.min(next < 0 ? src.length : next, next2 < 0 ? src.length : next2);
  return src.slice(start, end)
    .replace(/"""[\s\S]*?"""/g, "")
    .replace(/^\s*#.*$/gm, "");
}

/** A JS function body, by name, comments stripped. */
function jsBody(src, name) {
  const at = src.search(new RegExp("^(?:async )?function " + name + "\\s*\\(", "m"));
  if (at < 0) throw new Error("no function " + name);
  const end = src.indexOf("\n}\n", at);
  return src.slice(at, end < 0 ? src.length : end)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

/* ============================================ 1. the page budget */

section("1. a chart costs one page, not the whole promise");

{
  // The reproduction, as arithmetic. If these drift apart the number
  // on the trader's screen is not the number this test is about.
  const histPy = read("engine", "aurion", "util", "history.py");
  const pageBars = Number(/PAGE_BARS = ([\d_]+)/.exec(histPy)[1].replace(/_/g, ""));
  const days = Number(/HISTORY_DAYS = (\d+)/.exec(histPy)[1]);
  const fullM5 = (days * 24 * 60) / 5;
  ok(pageBars === 10000, `the page budget is ${pageBars} bars, as asked for`);
  ok(fullM5 === 51840, `and the whole promise on M5 is ${fullM5} bars - the number reported`);

  const body = pyBody(TRADER, "set_market");
  ok(!/at_least_window\(/.test(body),
    "set_market no longer raises its ask to the six-month floor");
  ok(/page_window\(timeframe\)/.test(body),
    "...it asks for one page when nobody named a number");
  ok(/exact=True/.test(body),
    "and says so to the bridge, which would otherwise reapply the floor");
  ok(/asked = int\(count or 0\)/.test(body),
    "a caller that names a window is believed");
}

{
  const body = pyBody(TRADER, "set_market");
  /* The other half of the same report. 51 840 bars of inference on
     the event loop is why the desk could not reach the engine: the
     health check gives it five seconds. */
  ok(/await asyncio\.to_thread\(self\.ai\.infer/.test(body),
    "inference runs off the event loop, so the engine answers while it thinks");
  ok(!/\n\s*self\.ai\.infer\(/.test(body),
    "...and the blocking call is gone, not merely wrapped somewhere else");
}

{
  ok(/int\(body\.get\("count"\) or body\.get\("bars"\) or 0\)/.test(SERVER),
    "/v1/market carries the window the desk named");
  ok(/trader\.set_market\(symbol, timeframe, count\)/.test(SERVER),
    "...and passes it on");
}

{
  const pick = APP.slice(APP.indexOf("const r = await API.post(\"/api/market\"") - 700,
                         APP.indexOf("const r = await API.post(\"/api/market\"") + 400);
  ok(/count: marketCount/.test(pick), "the desk tells the engine how much it is drawing");
  ok(/const marketCount = prime \? CHART_PRIME_BARS : barsForDays\(timeframe, chartDays\(timeframe\)\)/.test(pick),
    "...and it is the same number it is about to fetch, not a second opinion");
}

{
  /* The desk's own page maths, run rather than read: M5 must land on
     one page, not on six months. */
  const tfm = /const TF_MINUTES = ([^;]+);/.exec(APP);
  const kit = new Function(
    "const TF_MINUTES = " + (tfm ? tfm[1] : "{M5:5}") + ";\n"
    + "const HISTORY_DAYS = " + /const HISTORY_DAYS = (\d+);/.exec(APP)[1] + ";\n"
    + "const HISTORY_MAX = " + /const HISTORY_MAX = (\d+);/.exec(APP)[1] + ";\n"
    + "const PAGE_BARS = " + /const PAGE_BARS = (\d+);/.exec(APP)[1] + ";\n"
    + "const PAGE_DAY_STEPS = " + /const PAGE_DAY_STEPS = (\[[^\]]+\]);/.exec(APP)[1] + ";\n"
    + jsBody(APP, "barsForDays") + "}\n"
    + jsBody(APP, "pageDays") + "}\n"
    + jsBody(APP, "chartDays") + "}\n"
    + "return { ask: (tf) => barsForDays(tf, chartDays(tf)) };")();
  ok(kit.ask("M5") === 8640, `M5 opens on ${kit.ask("M5")} bars, inside the 10 000 budget`);
  ok(kit.ask("M5") < 51840, "...and nothing like the 51 840 that was reported");
  ok(kit.ask("M1") <= 10080, "M1 is one week, which is the budget on that timeframe");
  for (const tf of ["M1", "M5", "M15", "M30", "H1", "H4", "D1"]) {
    ok(kit.ask(tf) <= 10080, `${tf} asks for ${kit.ask(tf)} bars, within one page`);
  }
}

/* ======================================== 2. every cache, cleared */

section("2. after an update, every cache of the old version goes");

{
  const body = jsBody(UPDATER, "purgeCaches");
  ok(/purgeBytecode\(path\.join\(base, "engine"\)\)/.test(body),
    "the Python bytecode still goes - it was only ever the first of them");
  ok(/"cache", "tmp", "update_tmp"/.test(body), "the desk and engine scratch directories go");
  ok(/EBWebView/.test(body) && /"Code Cache"/.test(body) && /"Service Worker"/.test(body),
    "and so does the shell's browser cache, which holds the old app.js");

  /* The line between a cache and the user's data. Deleting any of
     these would be a bug of its own. */
  for (const keep of ["update_backups", "license", "logs", "aurion.json"]) {
    ok(!new RegExp(keep).test(body), `${keep} is not touched - it cannot be rebuilt`);
  }

  ok(/const purged = purgeCaches\(\);/.test(UPDATER),
    "the apply calls it, rather than only the bytecode half");
  const purgeAt = UPDATER.indexOf("const purged = purgeCaches();");
  const relaunchAt = UPDATER.indexOf("hostctl.scheduleRelaunch()");
  ok(purgeAt > 0 && relaunchAt > purgeAt,
    "...and before the relaunch, not after the process has gone");
}

{
  /* Run it. A path list that no longer deletes anything would read
     perfectly well. */
  const updater = require(path.join(ROOT, "backend", "src", "updater.js"));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aurion-cache-"));
  fs.mkdirSync(path.join(tmp, "engine", "aurion", "__pycache__"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "engine", "aurion", "__pycache__", "x.pyc"), "old");
  fs.writeFileSync(path.join(tmp, "engine", "aurion", "stale.pyc"), "old");
  fs.mkdirSync(path.join(tmp, "data", "cache"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "data", "cache", "x.json"), "{}");
  fs.mkdirSync(path.join(tmp, "data", "license"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "data", "license", "state.json"), "{}");
  fs.mkdirSync(path.join(tmp, "data", "update_backups"), { recursive: true });

  const removed = updater.purgeCaches(tmp);
  ok(!fs.existsSync(path.join(tmp, "engine", "aurion", "__pycache__")), "the __pycache__ is gone");
  ok(!fs.existsSync(path.join(tmp, "engine", "aurion", "stale.pyc")), "the loose .pyc is gone");
  ok(!fs.existsSync(path.join(tmp, "data", "cache")), "the scratch cache is gone");
  ok(fs.existsSync(path.join(tmp, "data", "license", "state.json")),
    "the licence survives, which is the thing that must never be mistaken for a cache");
  ok(fs.existsSync(path.join(tmp, "data", "update_backups")),
    "and so does the way back from a bad install");
  ok(removed.length >= 3, `it reports what it removed (${removed.length} paths)`);
  fs.rmSync(tmp, { recursive: true, force: true });
}

{
  /* The one cache nothing inside the process can delete: Windows
     holds it open for as long as AURION.exe is alive. */
  const strip = (s) => s.replace(/^\s*(REM|::|#).*$/gm, "");
  const cmd = strip(RELAUNCH_CMD);
  /* Every subtree, not just the first one: Chromium keeps the
     compiled JavaScript in Code Cache and the fetched desk in
     Service Worker, and leaving either behind means the new build
     comes up running old code out of the one that was missed. */
  for (const part of ["Default\\Cache", "Default\\Code Cache", "Default\\Service Worker",
                      "Default\\GPUCache", "ShaderCache", "GrShaderCache"]) {
    ok(cmd.includes("EBWebView\\" + part), `the relaunch script wipes EBWebView\\${part}`);
  }
  const killAt = cmd.indexOf("taskkill /im AURION.exe");
  const wipeAt = cmd.indexOf("EBWebView");
  const startAt = cmd.lastIndexOf("call \"%~dp0..\\start-aurion.cmd\"");
  ok(killAt > 0 && wipeAt > killAt, "...after the window is actually gone, which is the only moment it can");
  ok(wipeAt < startAt, "...and before the new build is started");
  ok(/^:WIPE$/m.test(cmd), "the delete is one routine, so every path gets the same treatment");
  ok(/rd \/s \/q/.test(cmd), "and it really deletes");

  const sh = strip(RELAUNCH_SH);
  ok(/rm -rf data\/cache/.test(sh), "the POSIX twin clears the same scratch");
  ok(/__pycache__/.test(sh), "and the bytecode, for a relaunch that did not come from the updater");
}

{
  const body = jsBody(APP, "dropBrowserCaches");
  ok(/caches\.keys\(\)/.test(body) && /caches\.delete/.test(body),
    "the page drops the Cache Storage the service worker filled");
  ok(/getRegistrations/.test(body) && /unregister\(\)/.test(body),
    "...and unregisters the worker, which would otherwise refill it");
  ok(/setTimeout\(r, \d+\)/.test(body),
    "and it cannot hang the reload - a desk that never comes back looks broken");
  ok(/reloadFresh\(/.test(APP) && !/setTimeout\(\(\) => location\.replace\("\/\?v=" \+ Date\.now\(\)\)/.test(APP),
    "every post-update reload goes through it, not through a bare cache-busting query");
}

/* ============================================ 3. stopping a repair */

section("3. a repair can be stopped, and stopping it undoes it");

{
  ok(/function cancelApply\(\)/.test(UPDATER), "the updater can be asked to stop");
  const cancel = jsBody(UPDATER, "cancelApply");
  ok(/if \(!applyProgress\.active\)/.test(cancel),
    "a cancel with nothing running is refused rather than left armed for the next install");

  const apply = UPDATER.slice(UPDATER.indexOf("for (const f of files) {"),
                              UPDATER.indexOf("for (const f of files) {") + 1200);
  ok(/if \(takeCancel\(\)\)/.test(apply), "the write loop checks between files");
  ok(apply.indexOf("takeCancel()") < apply.indexOf("takeFromSnapshot"),
    "...before fetching the next one, so a cancel costs nothing more");
  ok(/restoreFromBackup\(backupDir, applied\)/.test(apply),
    "and what was already written is put back");
  ok(/cancelled: true/.test(apply), "the answer says it was stopped, not that it failed");

  const restore = jsBody(UPDATER, "restoreFromBackup");
  ok(/fs\.copyFileSync\(backup, target\)/.test(restore), "a file that existed is restored from its backup");
  ok(/fs\.rmSync\(target, \{ force: true \}\)/.test(restore),
    "and one this run CREATED is removed, since it has no backup to go back to");

  ok(/cancelRequested = false;\n  const applied = \[\];/.test(UPDATER),
    "a stale cancel cannot kill the next install");
}

{
  ok(/guarded\.post\("\/system\/update\/cancel"/.test(INDEX), "there is a route for it");
  const route = INDEX.slice(INDEX.indexOf('guarded.post("/system/update/cancel"'),
                            INDEX.indexOf('guarded.post("/system/update/cancel"') + 420);
  ok(/req\.user\.role !== "owner"/.test(route), "owner-only, like the install it stops");
  ok(/res\.status\(409\)/.test(route), "and 'nothing is running' is not reported as success");
}

{
  const body = jsBody(APP, "runRepairInstall");
  ok(/id="upd-repair-cancel"/.test(body), "the repair screen carries the button");
  ok(/API\.post\("\/api\/system\/update\/cancel", \{\}\)/.test(body), "...which calls the route");
  ok(/if \(r && r\.cancelled\)/.test(body),
    "a stopped repair is reported as stopped");
  ok(body.indexOf("if (r && r.cancelled)") < body.indexOf("if (!r || !r.ok)"),
    "...and not as a failure, which is what the generic branch below would call it");
  ok(/repair_cancelling/.test(body), "the button says what is happening while it happens");
  const packs = ["en", "fa", "ar"].map((l) => JSON.parse(read("lang", l + ".json")));
  for (const k of ["repair_cancel", "repair_cancelling", "repair_cancelled"]) {
    ok(packs.every((p) => p.upd && p.upd[k]), `every language has upd.${k}`);
  }
}

/* ================================== 4. shut down, clear, come back */

section("4. an update shuts the product down and brings it back itself");

{
  ok(/hostctl\.scheduleRelaunch\(\)/.test(UPDATER) && !/hostctl\.scheduleRestart\(\)/.test(UPDATER),
    "the apply relaunches rather than restarting - the whole product goes down");
  const strip = (s) => s.replace(/^\s*(REM|::|#).*$/gm, "");
  const cmd = strip(RELAUNCH_CMD);
  ok(/taskkill \/im AURION\.exe/.test(cmd), "the window is closed");
  ok(/-Scope all/.test(cmd), "the engine AND the desk's own port are released");
  ok(/start-aurion\.cmd/.test(cmd), "and the product is started again by the script, with nobody asked");
  const order = [cmd.indexOf("taskkill"), cmd.indexOf("EBWebView"), cmd.lastIndexOf("start-aurion.cmd")];
  ok(order[0] < order[1] && order[1] < order[2],
    "in the order the request named: shut down, clear the caches, come back up");
}

console.log("");
console.log(`page-budget-and-update-hygiene: ${failed ? failed + " of " + (passed + failed) + " checks FAILED" : passed + " checks passed"}`);
process.exit(failed ? 1 : 0);
