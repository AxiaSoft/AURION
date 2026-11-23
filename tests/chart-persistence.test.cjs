/**
 * Charts must survive leaving the page and coming back.
 *
 * Reported as: "when I move between pages the charts jump - they take
 * a long time to load; a chart should stay where it is until I come
 * back to that page, whether it is an EA chart, the backtest or the
 * market. And curve charts must not disappear and reappear later."
 *
 * Two separate faults were behind that one sentence.
 *
 *   1. Nothing was painted from what the desk already held. Opening a
 *      chart workspace always waited on POST /api/market plus a
 *      thirty-day GET /api/candles before the first bar appeared -
 *      even when those exact bars were in memory from a minute ago.
 *      Same on the history page, whose equity curve waited on
 *      /api/history, and on the backtest page, whose chart of the
 *      tested window was not redrawn at all.
 *   2. The window itself was thrown away. A remount rebuilt the chart
 *      at the default zoom parked at the live edge, so a trader who
 *      had scrolled back and zoomed in came back to a different
 *      picture of the same instrument.
 *
 * The chart class is run for real here, in a context with its own
 * localStorage, because "is the window restored" is a question about
 * behaviour and a grep would pass for the whole life of the bug.
 *
 *     node tests/chart-persistence.test.cjs
 */
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const WEB = path.join(ROOT, "apps", "web", "js");
const app = fs.readFileSync(path.join(WEB, "app.js"), "utf8");
const noop = () => {};

let failed = 0;
const check = (name, cond) => {
  if (cond === true) console.log("ok   " + name);
  else { console.log("FAIL " + name + (typeof cond === "string" ? " → " + cond : "")); failed++; }
};

/* ------------------------------------------------- the chart, for real */
function makeEl() {
  return {
    innerHTML: "", dataset: {}, style: { setProperty: noop, removeProperty: noop },
    classList: { add: noop, remove: noop, contains: () => false, toggle: () => false },
    appendChild: noop, querySelector: () => null, querySelectorAll: () => [],
    addEventListener: noop, setAttribute: noop, getAttribute: () => null, focus: noop, remove: noop,
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 900, height: 500 }),
  };
}
const ctx2d = new Proxy({}, {
  get: (t, k) => {
    if (k === "measureText") return () => ({ width: 10 });
    if (k === "createLinearGradient") return () => ({ addColorStop: noop });
    return noop;
  },
});
function makeCanvas() {
  return {
    getContext: () => ctx2d, width: 0, height: 0, style: {}, parentElement: makeEl(),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 900, height: 500 }),
    addEventListener: noop, setPointerCapture: noop,
  };
}

/* A localStorage that really stores, because that is the thing under
   test. Shared across the two charts below on purpose: they stand for
   the same chart before and after a page change. */
const store = new Map();
const win = {
  devicePixelRatio: 1,
  ResizeObserver: function () { this.observe = noop; this.disconnect = noop; },
  requestAnimationFrame: (fn) => fn(),
  getComputedStyle: () => ({ getPropertyValue: () => "" }),
  localStorage: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  },
  setTimeout: (fn) => { fn(); return 0; },      // the save throttle, run at once
  clearTimeout: noop,
  document: {
    documentElement: { dataset: {}, dir: "ltr" },
    body: makeEl(),
    fullscreenElement: null,
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => makeEl(),
    addEventListener: noop,
  },
  addEventListener: noop,
  console,
};
win.window = win; win.globalThis = win;
vm.createContext(win);
for (const f of ["chart-series.js", "charts.js"]) {
  vm.runInContext(fs.readFileSync(path.join(WEB, f), "utf8") +
    (f === "charts.js" ? "\n;globalThis.CandleChart = CandleChart;" : ""), win, { filename: f });
}

const bars = (n) => Array.from({ length: n }, (_, i) => {
  const at = new Date(Date.UTC(2026, 0, 1) + i * 900000);
  return { time: at.toISOString().slice(0, 19), open: 1, high: 1.2, low: 0.9, close: 1.1, volume: 5 };
});

/* ---- a chart opened, moved, and opened again --------------------- */
{
  const first = new win.CandleChart(makeCanvas(), { key: "EURUSD.M15" });
  first.setBars(bars(600));
  first.span = 64;                 // zoomed in
  first.offset = 120;              // and scrolled back
  first.changed();                 // what a pan or a wheel ends with

  check("the window was written down", store.has("aurion.chartview.EURUSD.M15") === true);

  const again = new win.CandleChart(makeCanvas(), { key: "EURUSD.M15" });
  check("a chart with a remembered window says so before any bars arrive",
    again.hasStoredView() === true);
  again.setBars(bars(600));
  check("the zoom is the one it was left at", again.span === 64 || `span ${again.span}`);
  check("and so is the place", again.offset === 120 || `offset ${again.offset}`);
  check("the stored window is consumed, not re-applied for ever",
    again.hasStoredView() === false);
}

/* ---- a different chart must not inherit it ----------------------- */
{
  const other = new win.CandleChart(makeCanvas(), { key: "XAUUSD.H1" });
  other.setBars(bars(600));
  check("another instrument opens on its own default, not the last chart's window",
    other.offset === 0 && other.span !== 64);
}

/* ---- the zoom keeps; the place goes stale ------------------------ */
{
  store.set("aurion.chartview.GBPUSD.M5", JSON.stringify({
    span: 48, offset: 300, at: Date.now() - (7 * 60 * 60 * 1000),   // seven hours ago
  }));
  const old = new win.CandleChart(makeCanvas(), { key: "GBPUSD.M5" });
  old.setBars(bars(600));
  check("a zoom level survives a night away", old.span === 48 || `span ${old.span}`);
  /* `offset` counts bars back from the NEWEST bar, so hours later the
     same number points at a different week. A stale place is dropped
     and the chart opens where it should: at the live edge. */
  check("a stale scroll position is not restored", old.offset === 0 || `offset ${old.offset}`);
}

/* ---- rubbish in storage cannot break a chart --------------------- */
{
  store.set("aurion.chartview.USDJPY.H4", "{not json");
  const bad = new win.CandleChart(makeCanvas(), { key: "USDJPY.H4" });
  bad.setBars(bars(200));
  check("a corrupt stored window is ignored rather than thrown",
    bad.offset === 0 && bad.span > 0);
}

/* ---- a chart with no key stores nothing -------------------------- */
{
  const before = store.size;
  const anon = new win.CandleChart(makeCanvas(), {});
  anon.setBars(bars(100));
  anon.changed();
  check("an unkeyed chart writes nothing to storage", store.size === before);
}

/* --------------------------------------- painting from what we hold */
const lift = (name) => {
  let i = app.indexOf("function " + name + "(");
  if (i < 0) throw new Error("missing " + name);
  if (app.slice(Math.max(0, i - 6), i) === "async ") i -= 6;
  let d = 0;
  const j = app.indexOf("{", i);
  for (let k = j; k < app.length; k++) {
    if (app[k] === "{") d++;
    else if (app[k] === "}") { d--; if (!d) return app.slice(i, k + 1); }
  }
  throw new Error("unterminated " + name);
};

{
  const cached = new Function("S", lift("cachedCandlesFor") +
    "\nreturn cachedCandlesFor;");
  const held = [{ time: "t", close: 1 }];
  const hit = cached({ candles: held, candlesKey: "EURUSD|M15" })("EURUSD", "M15");
  check("bars we hold for this very series are offered", hit === held);
  const miss = cached({ candles: held, candlesKey: "EURUSD|M15" })("EURUSD", "H1");
  check("bars of another timeframe are refused", miss === null);
  const wrongSym = cached({ candles: held, candlesKey: "XAUUSD|M15" })("EURUSD", "M15");
  check("bars of another instrument are refused", wrongSym === null);
  const none = cached({ candles: [], candlesKey: "EURUSD|M15" })("EURUSD", "M15");
  check("an empty cache is not offered as a chart", none === null);
  const unknown = cached({ candles: held, candlesKey: "" })("EURUSD", "M15");
  check("bars of unknown provenance are refused", unknown === null);
}

{
  /* The workspace must put bars up BEFORE it awaits anything. */
  const fn = lift("bindChartDesk");
  const paintAt = fn.indexOf("cachedCandlesFor(");
  const fetchAt = fn.indexOf("await pickMarket(");
  check("the chart workspace paints from the cache", paintAt > 0);
  check("...and does so before it asks the engine for anything",
    paintAt > 0 && fetchAt > paintAt);
  check("...while still refreshing in the background", fetchAt > 0);
  check("a restored window is not pushed back to the live edge",
    /hasStoredView\(\)/.test(fn) === true);
  check("and the refresh does not undo it either", /&& !held\)/.test(fn) === true);
}

{
  const fn = lift("loadHistory");
  const cacheAt = fn.indexOf("S._histRows");
  const fetchAt = fn.indexOf("await API.get");
  check("the history page draws the ledger it already has", cacheAt > 0);
  check("...before waiting on the request", cacheAt > 0 && fetchAt > cacheAt);
  check("the P&L curve is painted from the cached series too",
    fn.indexOf("paintPnl()") < fetchAt && fn.indexOf("S._pnl") < fetchAt);
  check("and the fresh rows are kept for the next visit",
    fn.lastIndexOf("S._histRows =") > fetchAt);
}

{
  /* The backtest page: its result chart is painted by
     paintBacktestLive, which the template does not call - so coming
     back to the page left the window chart blank for ever. */
  const bind = app.slice(app.indexOf('if (view === "backtest") {'));
  const body = bind.slice(0, bind.indexOf('if (view === "history") {'));
  check("returning to the backtest repaints the whole result",
    /paintBacktestResults\(btNow\)/.test(body));
  check("...without scrolling the page under the trader",
    !/paintBacktestResults\(btNow, \{ reveal/.test(body));
  check("...and from state alone, with no new request",
    !/API\.(get|post)\(/.test(body.slice(0, body.indexOf("paintBacktestResults"))));
}

{
  /* The cache has to be dropped when it stops being true, or the desk
     would paint a chart of an instrument whose expert is gone. */
  const fn = lift("pruneDeadSymbols");
  check("losing the symbol clears the remembered series",
    (fn.match(/S\.candlesKey = ""/g) || []).length >= 2);
}

console.log(failed ? `\n${failed} failed` : "\nall good");
process.exit(failed ? 1 : 0);
