/**
 * How far back the chart reaches, and what happens at the end of it.
 *
 * Reported: "the chart in AURION shows very little - I want at least
 * thirty days back, and the further back I scroll the more it should
 * load."
 *
 * The desk asked for 800 bars whatever the timeframe. On M15 that is
 * about eight days, so the chart simply ended a week back. The ask is
 * now derived from the timeframe, and scrolling to the oldest bar we
 * hold goes and fetches a wider window.
 *
 *     node tests/chart-history-depth.test.js
 */

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");
const APP = fs.readFileSync(path.join(ROOT, "apps", "web", "js", "app.js"), "utf8");
const CHARTS = path.join(ROOT, "apps", "web", "js", "charts.js");

const results = [];
const pending = [];
/* An async check has to be waited for. Without this the summary printed
   before the promise settled, so a failing asynchronous check reported
   PASS and then threw into an empty stack - which is how the first
   version of the request-batching check "passed" while failing. */
function check(name, fn) {
  try {
    const note = fn();
    if (note && typeof note.then === "function") {
      const slot = results.push(null) - 1;
      pending.push(note.then(
        () => { results[slot] = true; console.log("PASS  " + name); },
        (e) => { results[slot] = false; console.log("FAIL  " + name + "\n      " + e.message); }
      ));
      return;
    }
    results.push(true);
    console.log("PASS  " + name + (typeof note === "string" ? "  - " + note : ""));
  } catch (e) {
    results.push(false);
    console.log("FAIL  " + name + "\n      " + e.message);
  }
}

/* barsForDays is a pure function; lift it out and run it rather than
   matching the source, so the arithmetic itself is what is checked. */
function liftFn(name) {
  let at = APP.indexOf("function " + name + "(");
  if (at < 0) throw new Error(name + " is missing from app.js");
  /* Take the async keyword with it. Slicing from "function" alone drops
     it and every await inside becomes a syntax error. */
  if (APP.slice(at - 6, at) === "async ") at -= 6;
  const open = APP.indexOf("{", at);
  let depth = 0, end = open;
  for (let i = open; i < APP.length; i += 1) {
    if (APP[i] === "{") depth += 1;
    else if (APP[i] === "}") { depth -= 1; if (!depth) { end = i; break; } }
  }
  return APP.slice(at, end + 1);
}

const consts = /const TF_MINUTES = \{[^}]*\};/.exec(APP);
const days = /const HISTORY_DAYS = (\d+);/.exec(APP);
const cap = /const HISTORY_MAX = (\d+);/.exec(APP);

const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(
  (consts ? consts[0] : "") + "\n" +
  (days ? days[0] : "") + "\n" +
  (cap ? cap[0] : "") + "\n" +
  liftFn("barsForDays") + "\nthis.barsForDays = barsForDays;", sandbox);
const barsForDays = sandbox.barsForDays;

/* ----------------------------------------------------------------------- */

check("thirty days is the floor on every timeframe the desk offers", () => {
  /* Called WITHOUT a days argument, so the horizon constant itself is
     under test. Passing 30 explicitly - as this check first did - meant
     lowering HISTORY_DAYS to a week went unnoticed. */
  const mins = { M1: 1, M5: 5, M15: 15, M30: 30, H1: 60, H4: 240, D1: 1440 };
  const short = [];
  for (const [tf, m] of Object.entries(mins)) {
    const bars = barsForDays(tf);
    const reach = (bars * m) / (24 * 60);
    /* M1 cannot reach thirty days inside the engine's 3000-bar buffer -
       that would be 43200 bars - so it is capped and says so. Every
       timeframe the cap does not bite on must clear thirty days. */
    if (bars < Number(cap[1]) && reach < 30) short.push(`${tf}: ${bars} bars = ${reach.toFixed(1)}d`);
  }
  if (short.length) throw new Error(short.join(", "));
  if (Number(days[1]) < 30) throw new Error("the horizon is set to " + days[1] + " days");
  return "M5 upward all reach 30d; M1 is capped at the buffer";
});

check("the ask scales with the timeframe instead of being one number", () => {
  if (barsForDays("M5", 30) === barsForDays("H4", 30)) {
    throw new Error("M5 and H4 ask for the same number of bars");
  }
  if (!(barsForDays("M5", 30) > barsForDays("M15", 30))) {
    throw new Error("a smaller timeframe does not ask for more bars");
  }
});

check("it never asks for more than the engine keeps, nor a useless handful", () => {
  const big = barsForDays("M1", 3650);
  if (big > Number(cap[1])) throw new Error("asked for " + big + ", buffer holds " + cap[1]);
  const small = barsForDays("MN1", 30);
  if (small < 400) throw new Error("a monthly chart would open with " + small + " bars");
});

check("an unknown timeframe falls back rather than producing NaN", () => {
  const n = barsForDays("nonsense", 30);
  if (!Number.isFinite(n) || n <= 0) throw new Error("got " + n);
});

check("the desk's own loader uses it, and no longer hard-codes 800", () => {
  const load = APP.slice(APP.indexOf("async function pickMarket"));
  const body = load.slice(0, load.indexOf("\nfunction typing"));
  if (/count=800/.test(body)) throw new Error("the 800-bar request is still there");
  if (!/barsForDays\(timeframe, HISTORY_DAYS\)/.test(body)) {
    throw new Error("the loader does not derive its count from the timeframe");
  }
});

check("reaching the oldest bar asks for more, once at a time", () => {
  /* Run rather than read. The first version of this grepped for the
     names of the two guards, which still appear in the source when the
     guards themselves are deleted - both mutations sailed through. */
  const box = {
    S: { chartFocus: { symbol: "EURUSD", timeframe: "M15" }, candles: new Array(800), chart: { setBars() {} } },
    calls: [],
    API: { get(url) { box.calls.push(url); return Promise.resolve({ data: new Array(1600) }); } },
    console,
  };
  vm.createContext(box);
  vm.runInContext((consts ? consts[0] : "") + "\n" + days[0] + "\n" + cap[0] + "\n"
    + liftFn("barsForDays") + "\n" + liftFn("loadMoreHistory")
    + "\nthis.loadMoreHistory = loadMoreHistory;", box);

  /* Two scrolls in the same tick must produce one request. */
  const a = box.loadMoreHistory();
  const b = box.loadMoreHistory();
  return Promise.all([a, b]).then(() => {
    if (box.calls.length !== 1) throw new Error(box.calls.length + " requests went out for one burst");
    const got = Number(/count=(\d+)/.exec(box.calls[0])[1]);
    if (!(got > 800)) throw new Error("it did not widen the window: " + box.calls[0]);

    /* Now the broker has no more. The answer stops growing, so the desk
       must stop asking - otherwise every scroll at the start of history
       is a request forever. */
    box.S.candles = new Array(1600);
    box.API.get = (url) => { box.calls.push(url); return Promise.resolve({ data: new Array(1600) }); };
    return box.loadMoreHistory().then(() => box.loadMoreHistory()).then(() => {
      if (box.calls.length !== 2) {
        throw new Error("kept asking after the answer stopped growing (" + box.calls.length + " calls)");
      }
    });
  });
});

check("the trigger is measured in bars, not pixels", () => {
  /* A pixel threshold means a different amount of warning at every zoom
     level, and none at all when zoomed right out. */
  const fn = APP.slice(APP.indexOf("function maybeLoadMoreHistory"));
  const body = fn.slice(0, fn.indexOf("\nconst CHART_HISTORY_LEAD"));
  if (!/maxOffset\(\)\s*-\s*S\.chart\.offset/.test(body)) {
    throw new Error("the distance to the oldest bar is not what is measured");
  }
});

check("every way of scrolling reports it, not just the keyboard", () => {
  /* The first wiring only announced pan(), which the arrow keys and the
     buttons use. Dragging - how anyone actually reaches deep history -
     moves offset directly and would never have asked for more. */
  const src = fs.readFileSync(CHARTS, "utf8");
  if (!/scrolled\(\)\s*\{/.test(src)) throw new Error("charts.js has no scroll report");
  const pan = src.slice(src.indexOf("  pan(bars) {"));
  if (!/this\.scrolled\(\);/.test(pan.slice(0, 400))) throw new Error("pan() is silent");
  const drags = src.split("this.clampOffset();").length - 1;
  const reports = src.split("this.scrolled();").length - 1;
  if (reports < 3) {
    throw new Error(`only ${reports} scroll reports for ${drags} offset changes - the drag paths are silent`);
  }
});

check("new history does not move the view out from under the reader", () => {
  /* setBars keeps the span and the offset when bars already existed.
     If it reset them, every fetch would throw the trader back to the
     live edge - the opposite of what they asked for by scrolling. */
  const src = fs.readFileSync(CHARTS, "utf8");
  const fn = src.slice(src.indexOf("  setBars(bars) {"));
  const body = fn.slice(0, fn.indexOf("\n  }"));
  if (!/const had = this\.bars\.length > 0/.test(body)) throw new Error("setBars cannot tell a refill from a first load");
  if (!/this\.offset = prevOff/.test(body)) throw new Error("a refill resets the scroll position");
});

Promise.all(pending).then(() => {
  const failed = results.filter((x) => !x).length;
  console.log("\nchart-history-depth: " + (failed
    ? failed + " of " + results.length + " checks FAILED"
    : results.length + " checks passed"));
  if (failed) process.exitCode = 1;
});
