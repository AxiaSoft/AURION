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

/* barTime lives in charts.js, which the page loads before app.js.
   These sandboxes lift single functions out of app.js, so anything
   app.js calls from the other file has to be handed over with them -
   mergeOlder de-duplicates on the normalised bar time. */
const BAR_TIME = "function barTime(v){let t=String(v==null?'':v).trim();"
  + "if(!t)return '';return t.replace(' ','T').replace(/\\.\\d+/,'')"
  + ".replace(/(Z|[+-]\\d{2}:?\\d{2})$/,'');}";

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
  /* It used to have to name HISTORY_DAYS here. It must NOT any more:
     pulling the full six months every time a series was loaded is what
     made the desk sit behind the start-up video, so the loader now
     asks for the period the chart is set to show - chartDays() - and
     the six months are one press of the range strip away. What is
     still forbidden is a fixed bar count, which is the original bug:
     800 bars is eight days of M15 and thirteen hours of M1. */
  const load = APP.slice(APP.indexOf("async function pickMarket"));
  const body = load.slice(0, load.indexOf("\nfunction typing"));
  if (/count=800/.test(body)) throw new Error("the 800-bar request is still there");
  if (!/barsForDays\(timeframe, chartDays\(\)\)/.test(body)) {
    throw new Error("the loader does not derive its count from the timeframe");
  }
  if (/barsForDays\(timeframe, HISTORY_DAYS\)/.test(body)) {
    throw new Error("it is back to pulling the whole window before anything is drawn");
  }
});

check("the period the chart opens with is a real period, not a bar count", () => {
  const open = /const CHART_OPEN_DAYS = (\d+);/.exec(APP);
  if (!open) throw new Error("nothing states what a chart opens with");
  const d = Number(open[1]);
  if (d < 7) throw new Error("a chart opens on " + d + " days, which is the old 'ends a week back' complaint");
  if (d >= Number(days[1])) throw new Error("the first fetch is still the whole promise");
  /* And every timeframe must still clear the useful floor at that
     period, exactly as it had to at thirty. */
  for (const tf of ["M1", "M5", "M15", "M30", "H1", "H4", "D1"]) {
    if (barsForDays(tf, d) < 400) throw new Error(tf + " opens with " + barsForDays(tf, d) + " bars");
  }
  return d + " days";
});

check("reaching the oldest bar fetches one slab BEHIND it, once at a time", () => {
  /* Run rather than read. The first version of this grepped for the
     names of the two guards, which still appear in the source when the
     guards themselves are deleted - both mutations sailed through.

     What is being checked changed with the complaint "the chart loads
     far too much". A drag used to re-ask for a BIGGER NEWEST window,
     so every bar already on the screen came down the wire again and
     the sixth month cost a quarter of a million M1 bars. A drag now
     asks for one bounded slab ENDING at the oldest bar held, which
     the engine reads out of AURION's own database. */
  const bar = (i) => ({ time: "2026-01-01 00:" + String(i % 60).padStart(2, "0") + ":00", open: 1, high: 1, low: 1, close: 1 });
  const held = [];
  for (let i = 0; i < 800; i += 1) held.push(bar(i));
  const box = {
    S: { chartFocus: { symbol: "EURUSD", timeframe: "M15" }, candles: held, chart: { setBars(b) { box.S.candles = b; } } },
    calls: [],
    API: {
      get(url) {
        box.calls.push(url);
        const out = [];
        for (let i = 0; i < 400; i += 1) out.push({ time: "2025-12-31 " + String(Math.floor(i / 60)).padStart(2, "0") + ":" + String(i % 60).padStart(2, "0") + ":00" });
        return Promise.resolve({ data: out });
      },
    },
    $: () => null,
    /* The hint line now also drives the veil over a chart that has no
       candles yet; that lives in the DOM and this sandbox has none. */
    paintChartVeils: () => {},
    signalCoverageNote: () => "",
    signalCoveragePct: () => -1,
    console,
  };
  vm.createContext(box);
  vm.runInContext((consts ? consts[0] : "") + "\n" + days[0] + "\n" + cap[0] + "\n"
    + /const CHART_OPEN_DAYS = \d+;/.exec(APP)[0] + "\n"
    + /const HIST_RETRY_MS = \d+;/.exec(APP)[0] + "\n"
    + liftFn("barsForDays") + "\n" + liftFn("chartDays")
    + "\n" + liftFn("historyStep") + "\n" + liftFn("oldestHeldTime")
    + "\n" + BAR_TIME + "\n" + liftFn("mergeOlder")
    + "\n" + liftFn("noteHistoryDepth") + "\n" + liftFn("historyDepthOf")
    + "\n" + liftFn("noteHistoryProgress")
    + "\n" + liftFn("paintHistoryEdge")
    /* loadOlderSlab now checks that the bars it is given actually
       claim to be this symbol's before it merges them - the
       wrong-price-candle fix - so the guard has to come into the
       sandbox with it. */
    + "\n" + liftFn("barsSaySeries") + "\n" + liftFn("loadOlderSlab")
    + "\n" + liftFn("loadMoreHistory")
    + "\nthis.loadMoreHistory = loadMoreHistory;", box);

  /* Two scrolls in the same tick must produce one request. */
  const a = box.loadMoreHistory();
  const b = box.loadMoreHistory();
  return Promise.all([a, b]).then(() => {
    if (box.calls.length !== 1) throw new Error(box.calls.length + " requests went out for one burst");
    const url = box.calls[0];
    const before = /before=([^&]+)/.exec(url);
    if (!before) throw new Error("the ask does not say where the held history begins: " + url);
    if (decodeURIComponent(before[1]) !== held[0].time) {
      throw new Error("it asked from the wrong edge: " + decodeURIComponent(before[1]));
    }
    const got = Number(/count=(\d+)/.exec(url)[1]);
    if (!(got > 0) || got > 8000) throw new Error("the slab is not bounded: " + got);
    if (box.S.candles.length !== 1200) {
      throw new Error("the older bars were not put in front: " + box.S.candles.length);
    }

    /* Now there is nothing older, anywhere. The desk must stop asking -
       otherwise every scroll at the start of history is a request
       forever. */
    box.API.get = (url2) => { box.calls.push(url2); return Promise.resolve({ data: [] }); };
    return box.loadMoreHistory().then(() => box.loadMoreHistory()).then(() => {
      if (box.calls.length !== 2) {
        throw new Error("kept asking after the history ran out (" + box.calls.length + " calls)");
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
