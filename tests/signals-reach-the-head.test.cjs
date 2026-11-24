/**
 * "It should be signalling all the way to the head of the chart, and
 *  it is not."
 *
 * The backward fill was working: the engine analyses the history a
 * slab per request and the desk keeps asking until the engine reports
 * `complete`. What was missing was the other direction.
 *
 * `complete` is not a property of the analysis. It is a property of
 * the analysis AGAINST A PARTICULAR RIGHT-HAND EDGE - and that edge
 * moves. A bar closes every minute, the live stream appends it, and
 * the desk had stopped asking the moment the engine first said
 * "complete". An hour later the newest sixty candles carried no
 * marks, and an unanalysed candle is indistinguishable from a candle
 * with no setup on it.
 *
 * Catching up is cheap on the engine's side - it remembers what it
 * analysed and re-reads only the new bars plus one of overlap - so
 * the fix is for the desk to notice the edge has moved and ask.
 *
 *     node tests/signals-reach-the-head.test.cjs
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");
const APP = fs.readFileSync(path.join(ROOT, "apps", "web", "js", "app.js"), "utf8");
const { barTime } = require(path.join(ROOT, "apps", "web", "js", "charts.js"));

let fails = 0;
const ok = (c, m) => { if (!c) { fails += 1; console.log("FAIL " + m); } else console.log("ok   " + m); };

/** A named top-level function, with its braces balanced. */
function grab(src, name) {
  let i = src.indexOf("function " + name + "(");
  if (i < 0) throw new Error("missing " + name);
  if (src.slice(Math.max(0, i - 6), i) === "async ") i -= 6;
  const j = src.indexOf("{", i);
  let d = 0;
  for (let k = j; k < src.length; k += 1) {
    if (src[k] === "{") d += 1;
    else if (src[k] === "}") { d -= 1; if (!d) return src.slice(i, k + 1); }
  }
  throw new Error("unterminated " + name);
}

/* A desk with the two functions under test and nothing else: a fake
   clock for the debounce, and a fetch that only records that it was
   asked. */
function desk(state) {
  const timers = [];
  const box = {
    S: Object.assign({ signalsEnabled: true, showSignals: true, signalsLoading: false }, state),
    barTime,
    asked: [],
    fetchChartSignals: (sym, tf) => { box.asked.push(sym + "|" + tf); },
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    clearTimeout: (id) => { if (id) timers[id - 1] = null; },
    console,
  };
  vm.createContext(box);
  vm.runInContext(
    /const SIGNAL_FILL_DELAY_MS = \d+;/.exec(APP)[0] + "\n"
    + grab(APP, "signalsReachHead") + "\n" + grab(APP, "scheduleSignalFill") + "\n"
    + "this.signalsReachHead = signalsReachHead;"
    + "this.scheduleSignalFill = scheduleSignalFill;", box);
  box.tick = () => { const run = timers.slice(); timers.length = 0; run.forEach((fn) => fn && fn()); };
  return box;
}

const bars = (n, from) => Array.from({ length: n }, (_, i) => ({
  time: "2026-11-23T" + String((from || 0) + i).padStart(2, "0") + ":00:00",
}));

/* ---------------------------------------------------------------- 1 */
{
  /* The state the trader was left in: the engine has analysed
     everything it was given and said so, and then four more bars
     closed. */
  const d = desk({
    symbol: "EURUSD", timeframe: "M15",
    candles: bars(10),
    signalCoverage: { complete: true, toTime: "2026-11-23T05:00:00" },
  });
  ok(d.signalsReachHead() === false,
    "the analysis stopped four bars short of the newest candle and the desk can tell");

  d.scheduleSignalFill("EURUSD", "M15");
  d.tick();
  ok(d.asked.length === 1 && d.asked[0] === "EURUSD|M15",
    "...so it asks again, even though the engine called itself complete");
}

/* ---------------------------------------------------------------- 2 */
{
  /* Genuinely caught up: no work, no timer, no request. */
  const d = desk({
    symbol: "EURUSD", timeframe: "M15",
    candles: bars(10),
    signalCoverage: { complete: true, toTime: "2026-11-23T09:00:00" },
  });
  ok(d.signalsReachHead() === true, "a covered head reads as covered");
  d.scheduleSignalFill("EURUSD", "M15");
  d.tick();
  ok(d.asked.length === 0, "a chart that is up to date is not re-analysed on a loop");
}

/* ---------------------------------------------------------------- 3 */
{
  /* The desk can hold a bar the engine's bounded window does not
     reach. That must cost ONE pass, not a request every 1.2s for the
     rest of the session. */
  const d = desk({
    symbol: "EURUSD", timeframe: "M15",
    candles: bars(10),
    signalCoverage: { complete: true, toTime: "2026-11-23T08:00:00" },
    _signalHead: "2026-11-23T09:00:00",
  });
  ok(d.signalsReachHead() === true,
    "a pass that already ran against this newest bar is not run again");
}

/* ---------------------------------------------------------------- 4 */
{
  /* The backward fill still works: incomplete means keep going,
     whatever the edge is doing. */
  const d = desk({
    symbol: "EURUSD", timeframe: "M15",
    candles: bars(10),
    signalCoverage: { complete: false, toTime: "2026-11-23T09:00:00" },
  });
  d.scheduleSignalFill("EURUSD", "M15");
  d.tick();
  ok(d.asked.length === 1, "history still fills in backwards slab by slab");
}

/* ---------------------------------------------------------------- 5 */
{
  /* One pass at a time. A second replay queued behind the first is
     the engine doing the same work twice. */
  const d = desk({
    symbol: "EURUSD", timeframe: "M15", signalsLoading: true,
    candles: bars(10),
    signalCoverage: { complete: false, toTime: "2026-11-23T05:00:00" },
  });
  d.scheduleSignalFill("EURUSD", "M15");
  d.tick();
  ok(d.asked.length === 0, "a pass already in the air is not doubled up");
  d.S.signalsLoading = false;
  d.tick();
  ok(d.asked.length === 1, "...and the one it deferred is not lost either");
}

/* ---------------------------------------------------------------- 6 */
{
  /* Trader moved on. */
  const d = desk({
    symbol: "XAUUSD", timeframe: "M15",
    candles: bars(10),
    signalCoverage: { complete: false, toTime: "2026-11-23T05:00:00" },
  });
  d.scheduleSignalFill("EURUSD", "M15");
  d.tick();
  ok(d.asked.length === 0, "a chart nobody is looking at is not analysed");
}

/* ---------------------------------------------------------------- 7 */
{
  /* The trigger itself: a bar the chart has never seen means the
     previous one has closed. Without this the desk only notices the
     edge moved the next time something else happens to ask. */
  const handler = APP.slice(APP.indexOf('if (msg.type === "candle")'),
    APP.indexOf('if (msg.type === "hist_progress")'));
  const appended = handler.slice(handler.indexOf("S.candles.push(c);"));
  ok(/scheduleSignalFill\(/.test(appended.slice(0, 900)),
    "a closing bar does not ask for the marks that belong to it");
  ok(!/scheduleSignalFill\(/.test(handler.slice(0, handler.indexOf("S.candles.push(c);"))),
    "...and a mere price update on the forming bar does not, or every tick is a request");

  /* And the pass records which edge it ran against, or check 3 above
     has nothing to compare with. */
  const fetch = grab(APP, "fetchChartSignals");
  ok(/S\._signalHead\s*=/.test(fetch),
    "the pass does not record the right-hand edge it was run against");
}

console.log(fails
  ? "\nsignals-reach-the-head: " + fails + " check(s) failed"
  : "\nsignals-reach-the-head: all good");
process.exit(fails ? 1 : 0);
