/**
 * Four reports about not being told what the desk is doing.
 *
 *   1. "Until the candles for a symbol have finished downloading,
 *      don't show that symbol's chart - put a loading state in it and
 *      show how the download is going."
 *
 *   3. "Same in the app when I change timeframe: until the new
 *      timeframe is actually drawn, put loading over the chart."
 *
 *   2. "Show the state of the chart analysis and the signalling, and
 *      show it precisely - that analysis square is half the screen
 *      with 'analysing' written in it, and then the signals are shown
 *      OUTSIDE the square."
 *
 *   4. "I tried to backtest M5 on a symbol whose chart was on H1 in
 *      the app, and the M5 backtest said there was nothing there."
 *
 * One and three are the same gap seen twice: the desk caches exactly
 * one series, so every timeframe change leaves the canvas with
 * nothing to draw, and an empty rectangle is indistinguishable from a
 * dead market or a hung desk.
 *
 * Two was a label on the wrong rectangle. The shaded half-screen was
 * the stretch that had NOT been analysed; calling it "still
 * analysing" made it read as a claim about itself, and the finished
 * work outside it then looked like a contradiction.
 *
 * Four is a timeframe nothing had ever asked MetaTrader for. It does
 * not exist in the terminal until something requests it, the first
 * answer is routinely empty while the terminal goes to the broker,
 * and one ask was all the backtest made before reporting the broker
 * had no history.
 *
 *     node tests/waiting-and-scanning.test.cjs
 */
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");
const APP = read("apps", "web", "js", "app.js");
const CHARTS = read("apps", "web", "js", "charts.js");
const CSS = read("apps", "web", "css", "chart.css");
const TRADER = read("engine", "aurion", "runtime", "trader.py");
const BRIDGE = read("engine", "aurion", "mt5", "bridge.py");
const PACKS = ["en", "fa", "ar"].map((c) => [c, JSON.parse(read("lang", c + ".json"))]);

let fails = 0;
const ok = (c, m) => { if (!c) { fails += 1; console.log("FAIL " + m); } else console.log("ok   " + m); };

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

/** A class method, by name, with its braces balanced. */
function method(src, name) {
  const i = src.indexOf("\n  " + name + "(");
  if (i < 0) throw new Error("missing method " + name);
  const j = src.indexOf("{", i);
  let d = 0;
  for (let k = j; k < src.length; k += 1) {
    if (src[k] === "{") d += 1;
    else if (src[k] === "}") { d -= 1; if (!d) return src.slice(i, k + 1); }
  }
  throw new Error("unterminated " + name);
}

/* A DOM small enough to read and real enough to place things in. */
function makeDom() {
  const mk = (tag) => {
    const el = {
      tagName: String(tag).toUpperCase(),
      children: [], className: "", innerHTML: "", hidden: false,
      attrs: {}, parentElement: null, isConnected: true,
      classList: {
        add: (c) => { if (!el.className.split(" ").includes(c)) el.className = (el.className + " " + c).trim(); },
        remove: (c) => { el.className = el.className.split(" ").filter((x) => x && x !== c).join(" "); },
        contains: (c) => el.className.split(" ").includes(c),
      },
      setAttribute: (k, v) => { el.attrs[k] = String(v); },
      getAttribute: (k) => (k in el.attrs ? el.attrs[k] : null),
      appendChild: (kid) => { kid.parentElement = el; el.children.push(kid); return kid; },
      remove: () => {
        if (!el.parentElement) return;
        el.parentElement.children = el.parentElement.children.filter((k) => k !== el);
        el.parentElement = null;
      },
      // Only the ":scope > .cls" form this code uses.
      querySelector: (sel) => {
        const cls = String(sel).replace(":scope > .", "").replace(".", "");
        return el.children.find((k) => k.classList.contains(cls)) || null;
      },
    };
    return el;
  };
  return { mk };
}

const { mk } = makeDom();

/** The veil functions, lifted and run against that DOM. */
function veilKit(opts) {
  opts = opts || {};
  const S = opts.S || {};
  const stub = `
    const S = __S;
    const I18N = { t: (k, v) => k + "|" + JSON.stringify(v || {}) };
    const fmt = (n) => String(n);
    const esc = (t) => String(t);
    const document = { createElement: __mk, querySelectorAll: () => __minis };
    const $ = (id) => __byId[id] || null;
    const cachedCandlesFor = __cached;
  `;
  return new Function("__S", "__mk", "__minis", "__byId", "__cached",
    stub
    + grab(APP, "veilOf") + "\n" + grab(APP, "historyProgressOf") + "\n"
    + grab(APP, "veilState") + "\n" + grab(APP, "paintVeil") + "\n"
    + grab(APP, "clearVeil") + "\n" + grab(APP, "haveBarsFor") + "\n"
    + grab(APP, "paintChartVeils")
    + "\nreturn { paintChartVeils, clearVeil, veilState, S };")(
    S, (t) => mk(t), opts.minis || [], opts.byId || {},
    opts.cached || (() => null),
  );
}

const veilOn = (box) => {
  const el = box.querySelector(":scope > .chart-veil");
  return el && !el.hidden ? el : null;
};
/* So that a missing veil fails its own check rather than throwing and
   taking the rest of the file with it. */
const inner = (box) => { const el = veilOn(box); return el ? String(el.innerHTML) : ""; };

/* ============================ 1 & 3. nothing to draw says nothing to draw */
{
  const box = mk("div");
  box.attrs.id = "tv-chartbox";
  const S = { chartFocus: { symbol: "XAUUSD", timeframe: "M5" }, histProgress: {} };
  const kit = veilKit({ S, byId: { "tv-chartbox": box }, cached: () => null });

  kit.paintChartVeils();
  ok(Boolean(veilOn(box)), "a chart with no candles for its series is covered, not left empty");
  ok(/veil_loading/.test(inner(box)), "...and says it is loading them");
  ok(/chart-veil-spin/.test(inner(box)), "with something that shows it is still going");
  ok(box.classList.contains("is-waiting"), "the box is marked as waiting");

  // The download reports itself: the veil becomes a number that moves.
  S.histProgress["XAUUSD.M5"] = { have: 12480, want: 51840, done: false, at: Date.now() };
  kit.paintChartVeils();
  ok(/veil_getting/.test(inner(box)), "once MetaTrader is sending, it says so");
  ok(/12480/.test(inner(box)) && /51840/.test(inner(box)),
    "with the two numbers the trader is waiting on");
  ok(/width:24%/.test(inner(box)), "and a bar at the right place");

  // The candles arrive.
  const kit2 = veilKit({ S, byId: { "tv-chartbox": box }, cached: () => [{ time: "t", close: 1 }] });
  kit2.paintChartVeils();
  ok(!veilOn(box), "the veil comes off the moment there are bars to draw");
  ok(!box.classList.contains("is-waiting"), "and the box stops saying it is waiting");

  /* The one thing worse than no spinner: one that cannot stop. A
     download that has finished and still produced nothing is not a
     loading state. */
  const S3 = { chartFocus: { symbol: "EURUSD", timeframe: "M1" }, histProgress: {
    "EURUSD.M1": { have: 0, want: 4000, done: true, at: Date.now() },
  } };
  const box3 = mk("div");
  const kit3 = veilKit({ S: S3, byId: { "tv-chartbox": box3 }, cached: () => null });
  kit3.paintChartVeils();
  ok(/veil_none/.test(inner(box3)), "a finished download with no bars says that instead");
  ok(veilOn(box3) && !/chart-veil-spin/.test(inner(box3)), "and stops spinning");
}

{
  /* The timeframe change is the same gap: the desk holds one series,
     so M5 after H1 has nothing cached under it. */
  const held = { "XAUUSD|H1": [{ time: "t", close: 1 }] };
  const cached = (sym, tf) => held[sym + "|" + tf] || null;
  const box = mk("div");
  const S = { chartFocus: { symbol: "XAUUSD", timeframe: "H1" }, histProgress: {} };
  const kit = veilKit({ S, byId: { "tv-chartbox": box }, cached });
  kit.paintChartVeils();
  ok(!veilOn(box), "the chart the trader is already reading is never covered");
  S.chartFocus = { symbol: "XAUUSD", timeframe: "M5" };
  kit.paintChartVeils();
  ok(Boolean(veilOn(box)), "switching to a timeframe with nothing behind it raises the veil");
  held["XAUUSD|M5"] = [{ time: "t", close: 1 }];
  kit.paintChartVeils();
  ok(!veilOn(box), "and drops it when that timeframe's candles are in");
}

{
  // Each card on the experts page answers for its own symbol.
  const mini = (sym, tf) => {
    const box = mk("div");
    const cv = mk("canvas");
    cv.attrs["data-mini"] = sym;
    cv.attrs["data-tf"] = tf;
    box.appendChild(cv);
    return { box, cv };
  };
  const a = mini("XAUUSD", "M15");
  const b = mini("EURUSD", "M15");
  const S = { histProgress: {}, _mini: { "XAUUSD|M15": [{ time: "t", close: 1 }] } };
  const kit = veilKit({ S, minis: [a.cv, b.cv], cached: () => null });
  kit.paintChartVeils();
  ok(!veilOn(a.box), "a card whose candles are held shows its chart");
  ok(Boolean(veilOn(b.box)), "a card whose candles are not held shows that it is waiting");
  S._mini["EURUSD|M15"] = [{ time: "t", close: 1 }];
  kit.paintChartVeils();
  ok(!veilOn(b.box), "and uncovers itself when they land");
}

{
  // Wiring: the places that change what is held have to say so.
  ok(/paintChartVeils\(\);/.test(grab(APP, "paintHistoryEdge")),
    "every download progress report repaints the veils");
  ok(grab(APP, "paintHistoryEdge").indexOf("paintChartVeils")
     < grab(APP, "paintHistoryEdge").indexOf('$("tv-hint")'),
    "...before the early return, since the experts page has no hint line");
  ok(/paintChartVeils\(\)/.test(grab(APP, "bindChartDesk")),
    "mounting a chart decides straight away whether it has anything to draw");
  ok(/clearVeil\(cv\.parentElement\)/.test(grab(APP, "paintMiniCharts")),
    "a card uncovers itself as its own bars arrive");
  ok(/S\.candlesKey = String\(S\.symbol/.test(APP),
    "bars pushed over the socket are stamped with their series, or the veil would never lift");
  for (const key of ["veil_loading", "veil_getting", "veil_none"]) {
    for (const [name, pack] of PACKS) {
      ok(typeof pack.charts[key] === "string", `${name} has charts.${key}`);
    }
  }
  ok(/\.chart-veil\s*\{/.test(CSS), "the veil has a style");
  ok(/\.chart-veil\s*\{[^}]*position:\s*absolute[^}]*inset:\s*0/.test(CSS.replace(/\s+/g, " ")),
    "...that covers the whole box");
  ok(/prefers-reduced-motion[^}]*\}[^@]*\.chart-veil-spin\s*\{\s*animation:\s*none/.test(CSS.replace(/\s+/g, " "))
     || /\.chart-veil-spin\s*\{\s*animation:\s*none\s*\}/.test(CSS.replace(/\s+/g, " ")),
    "and stops turning for anyone who asked for less motion");
}

/* ===================== 2. the analysis says which candles, precisely */
{
  const cov = method(CHARTS, "paintSignalCoverage");
  ok(/signals_unanalysed/.test(cov),
    "the shaded stretch now says it has NOT been analysed");
  ok(!/signals_analysing/.test(cov),
    "...instead of claiming the analysis is happening inside it");
  ok(/signals_doing_now/.test(cov),
    "and the slab actually being worked through is labelled separately");
  ok(/cov\.busy/.test(cov),
    "that outline is only drawn while a pass is really in the air");
  ok(!/if \(!this\.signals \|\| !this\.signals\.length\) return;/.test(cov),
    "a chart with no marks yet still shows the boundary - it is the one most likely to be misread");

  // The desk's own sentence under the chart.
  const note = new Function("__S", `
    const S = __S;
    const I18N = { t: (k, v) => k + "|" + JSON.stringify(v || {}) };
    const fmt = (n) => String(n);
    ` + grab(APP, "histDate") + "\n" + grab(APP, "signalCoverageNote")
    + "\n" + grab(APP, "signalCoveragePct")
    + "\nreturn { signalCoverageNote, signalCoveragePct };");

  const S = {
    signalsEnabled: true, showSignals: true,
    signalCoverage: {
      from: 8000, to: 9200, bars: 17280, complete: false,
      fromTime: "2026-03-12T00:00:00", toTime: "2026-10-05T00:00:00",
      nextFrom: 6500, nextTo: 8001,
      nextFromTime: "2026-02-01T00:00:00", nextToTime: "2026-03-12T00:00:00",
      busy: false,
    },
  };
  let api = note(S);
  ok(/scan_progress/.test(api.signalCoverageNote()), "between passes it reports how far it has got");
  ok(/1200/.test(api.signalCoverageNote()) && /17280/.test(api.signalCoverageNote()),
    "with the candles analysed and the candles there are");
  ok(api.signalCoveragePct() === 7, "and a bar that matches those two numbers");

  S.signalCoverage.busy = true;
  api = note(S);
  const doing = api.signalCoverageNote();
  ok(/scan_doing/.test(doing), "while a pass runs it names the slab being worked on");
  ok(/1501/.test(doing), "how many candles that is");
  ok(/2026/.test(doing), "and when they are - a date the trader can find on their own chart");

  S.signalCoverage.complete = true;
  api = note(S);
  ok(/scan_done/.test(api.signalCoverageNote()), "and when it is finished it says so");
  ok(api.signalCoveragePct() === -1, "with no progress bar left over");

  // Busy has to be switched on and off around the request.
  ok(/markSignalsBusy\(true\)/.test(APP) && /markSignalsBusy\(false\)/.test(APP),
    "the desk marks the pass as running and as finished");
  ok(/markSignalsBusy\(false\);/.test(grab(APP, "fetchChartSignals").split("finally")[1] || ""),
    "...and the finish is in a finally, so a failed pass cannot leave the outline up");
  ok(/next_from/.test(TRADER) && /next_to/.test(TRADER),
    "the engine reports which bars the next pass will cover");
  ok(/covered_from_time/.test(TRADER),
    "and names the covered candles by time, which an index cannot be checked against");
  ok(/_chart_mark_plan\(symbol, timeframe, armed, bars\)/.test(
    TRADER.slice(TRADER.indexOf("def _chart_marks_merge"))),
    "by re-planning rather than by a second copy of the planner's arithmetic");
  for (const key of ["signals_unanalysed", "signals_doing_now"]) {
    for (const [name, pack] of PACKS) {
      ok(typeof pack.chart[key] === "string", `${name} has chart.${key}`);
    }
  }
  for (const key of ["scan_done", "scan_progress", "scan_doing"]) {
    for (const [name, pack] of PACKS) {
      ok(typeof pack.charts[key] === "string", `${name} has charts.${key}`);
    }
  }
}

/* =============== 4. a timeframe nothing has asked MetaTrader for yet */
{
  const bt = TRADER.slice(TRADER.indexOf("async def backtest("), TRADER.indexOf("async def backtest(") + 9000);
  ok(/tries=3/.test(bt),
    "a backtest asks the terminal more than once for a series it has never built");
  ok(/history_downloading/.test(bt),
    "and reports a download in progress rather than an empty archive");
  ok(/"no_history"/.test(bt),
    "...while still saying 'no history' when the terminal has answered that it holds none");
  const empty = bt.slice(bt.indexOf("if not bars:"), bt.indexOf("window = _slice_bars"));
  ok(/answered\s*=\s*bool\(depth\.get\("at"\)\)/.test(empty),
    "the two are told apart by whether the terminal actually answered");
  ok(/available <= 0/.test(empty), "and by what it said it holds");
  ok(/_filling/.test(bt),
    "a period outside a series that is still filling is not reported as a fixed range either");

  // The bridge has to be willing to ask again.
  const pull = BRIDGE.slice(BRIDGE.indexOf("async def pull_candles("), BRIDGE.indexOf("async def _prime_agent("));
  ok(/tries: int = 1/.test(pull), "one try stays the default, for everything on a timer");
  ok(/for attempt in range\(max\(1, int\(tries or 1\)\)\)/.test(pull), "and a caller can insist");
  ok(/if attempt == 0 and not self\._may_ask_history/.test(pull),
    "the back-off still guards the first ask, so a poll cannot turn into a loop");
  ok(/break/.test(pull), "and the loop stops as soon as the series is long enough");

  for (const code of ["history_downloading", "no_bars_in_period_filling", "no_bars_in_period_have_filling"]) {
    for (const [name, pack] of PACKS) {
      ok(typeof (pack.engerr || {})[code] === "string", `${name} explains ${code}`);
    }
  }
  const en = PACKS.find(([c]) => c === "en")[1].engerr.history_downloading;
  ok(/\{timeframe\}/.test(en) && /\{symbol\}/.test(en), "the sentence names the series it is about");
  ok(/again/i.test(en), "and tells the trader what to do about it");
}

console.log(fails ? `\n${fails} failed` : "\nall good");
process.exit(fails ? 1 : 0);
