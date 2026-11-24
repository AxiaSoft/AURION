/**
 * The chart has to signal while the candle is still open.
 *
 * Reported, and open since the very first list: "it should signal as
 * the chart moves, not only on finished candles."
 *
 * The marks on the canvas were a replay over CLOSED bars. On M15 a
 * setup that appeared thirty seconds into a candle was therefore
 * invisible for the next fourteen and a half minutes — the whole of
 * the period a trader sits in front of the screen for — and by the
 * time it was drawn it was history.
 *
 * The engine's watch pass already asked every armed strategy the same
 * question every two seconds in order to keep the strategy CARDS
 * honest. It now sends that reading to the chart as well, as a second
 * and clearly provisional layer.
 *
 * What is proved here is behaviour, not wording. The chart class is
 * constructed for real and painted against a stub 2D context that
 * records what was drawn, because "is the forming mark retired when
 * the bar closes" is a question a grep will answer wrongly for the
 * whole life of the bug.
 *
 *     node tests/live-signalling.test.cjs
 */
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const WEB = path.join(ROOT, "apps", "web", "js");
const app = fs.readFileSync(path.join(WEB, "app.js"), "utf8");
const noop = () => {};

/* The label the forming mark paints, in any of the three languages.
   Everything else on the canvas - axis prices, times, the OHLC
   legend - is text too, so counting strings is not the question;
   counting THIS string is. */
const FORMING = /FORMING|شکل|تكوّن/;

let failed = 0;
const check = (name, cond) => {
  if (cond === true) console.log("ok   " + name);
  else { console.log("FAIL " + name + (typeof cond === "string" ? " → " + cond : "")); failed++; }
};

/* ---------------------------------------------- a chart that records */

/* Every stroke and every string, in order. The forming mark is drawn
   as an OUTLINE and the confirmed one as a FILL, so counting the two
   is how this suite tells them apart without reading pixels. */
function recorder() {
  const log = { fills: 0, strokes: 0, texts: [], dashes: [] };
  const ctx = new Proxy({}, {
    get: (t, k) => {
      if (k === "measureText") return () => ({ width: 30 });
      if (k === "createLinearGradient") return () => ({ addColorStop: noop });
      if (k === "fill") return () => { log.fills++; };
      if (k === "stroke") return () => { log.strokes++; };
      if (k === "strokeRect") return () => { log.strokes++; };
      if (k === "fillText") return (s) => { log.texts.push(String(s)); };
      if (k === "setLineDash") return (d) => { if (d && d.length) log.dashes.push(d.join(",")); };
      return noop;
    },
    set: () => true,
  });
  return { ctx, log };
}

function makeEl() {
  return {
    innerHTML: "", dataset: {}, style: { setProperty: noop, removeProperty: noop },
    classList: { add: noop, remove: noop, contains: () => false, toggle: () => false },
    appendChild: noop, querySelector: () => null, querySelectorAll: () => [],
    addEventListener: noop, setAttribute: noop, getAttribute: () => null, focus: noop, remove: noop,
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 900, height: 500 }),
  };
}

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
  setTimeout: (fn) => { fn(); return 0; },
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

const STEP = 900000;                                    // M15, in ms
const START = Date.UTC(2026, 0, 1);
const at = (i) => new Date(START + i * STEP).toISOString().slice(0, 19);
const bars = (n) => Array.from({ length: n }, (_, i) => ({
  time: at(i), open: 1.1, high: 1.2, low: 1.0, close: 1.15, volume: 5,
}));

function chartWith(n) {
  const { ctx, log } = recorder();
  const canvas = {
    getContext: () => ctx, width: 900, height: 500, style: {}, parentElement: makeEl(),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 900, height: 500 }),
    addEventListener: noop, setPointerCapture: noop,
  };
  const chart = new win.CandleChart(canvas, {});
  chart.setBars(bars(n));
  return { chart, log };
}
const reset = (log) => { log.fills = 0; log.strokes = 0; log.texts = []; log.dashes = []; };

/* ------------------------------------------- it is drawn, and it is
                                                drawn provisionally */
{
  const { chart, log } = chartWith(300);
  chart.setSignals([], true);
  reset(log);
  chart.setLiveSignals([{
    strategy: "price_action", side: "buy", time: at(299),
    price: 1.14, sl: 1.09, tp: 1.25, confidence: 0.7, reason: "trend and structure agree",
  }]);
  check("a setup on the open candle reaches the canvas",
    log.texts.some((t) => FORMING.test(t)) || log.texts.join("|"));
  check("and it is dashed, because it is not a finding yet", log.dashes.length > 0);

  /* The confirmed mark fills its triangle; this one only strokes an
     outline. If a future edit makes them look the same, the trader
     loses the only cue that says "this can still disappear". */
  const outlineOnly = log.fills === 0;
  check("it is an outline, never a solid arrow", outlineOnly || `fills ${log.fills}`);
}

/* ------------------------------------- the rule that retires it: the
                                          newest bar, and only that */
{
  const { chart, log } = chartWith(300);
  chart.setSignals([], true);
  chart.setLiveSignals([{ strategy: "p", side: "buy", time: at(299), price: 1.14 }]);
  reset(log);
  chart.draw();
  const drawnOnHead = log.texts.filter((t) => FORMING.test(t)).length;
  check("while that candle is the newest one, the mark is painted", drawnOnHead === 1);

  /* The candle closes: a new bar arrives and nobody sends anything.
     The provisional mark has to retire itself. */
  chart.setBars(bars(301));
  reset(log);
  chart.draw();
  const after = log.texts.filter((t) => FORMING.test(t));
  check("the moment the bar closes it stops being drawn, with no message",
    after.length === 0 || after.join("|"));
}

/* ------------------------------------------------- an old mark cannot
                                                     be revived */
{
  const { chart, log } = chartWith(300);
  chart.setSignals([], true);
  chart.setLiveSignals([{ strategy: "p", side: "sell", time: at(100), price: 1.14 }]);
  reset(log);
  chart.draw();
  const stale = log.texts.filter((t) => FORMING.test(t));
  check("a forming mark naming an older bar is refused outright",
    stale.length === 0 || stale.join("|"));
}

/* -------------------------------------------- one switch, all marks */
{
  const { chart, log } = chartWith(300);
  chart.setSignals([], false);
  chart.setLiveSignals([{ strategy: "p", side: "buy", time: at(299), price: 1.14 }]);
  reset(log);
  chart.draw();
  const hidden = log.texts.filter((t) => FORMING.test(t));
  check("signals switched off hides the forming layer too",
    hidden.length === 0 || hidden.join("|"));
}

/* ----------------------------------- two strategies, two readable marks */
{
  const { chart, log } = chartWith(300);
  chart.setSignals([], true);
  reset(log);
  chart.setLiveSignals([
    { strategy: "price_action", side: "buy", time: at(299), price: 1.14 },
    { strategy: "smart_money", side: "buy", time: at(299), price: 1.14 },
  ]);
  const labels = log.texts.filter((t) => FORMING.test(t)).length;
  check("two strategies agreeing are two marks, not one drawn twice", labels === 2 || `drew ${labels}`);
  check("and they are hoverable, so the stop and target can be read",
    (chart._sigHits || []).filter((h) => h.sig && h.sig.forming).length === 2);
}

/* --------------------------------- it never pollutes the real marks */
{
  const { chart } = chartWith(300);
  chart.setSignals([{ type: "buy", time: at(298), price: 1.1, strategy: "x" }], true);
  chart.setLiveSignals([{ strategy: "p", side: "buy", time: at(299), price: 1.14 }]);
  check("the confirmed marks are left exactly as they were",
    chart.signals.length === 1 && chart.signals[0].time === at(298));
  check("and the two layers are held apart",
    Array.isArray(chart.liveSignals) && chart.liveSignals !== chart.signals);
  chart.setLiveSignals([]);
  check("clearing the forming layer does not clear the confirmed one",
    chart.signals.length === 1 && chart.liveSignals.length === 0);
}

/* ---------------------------------- rubbish from the wire is survivable */
{
  const { chart } = chartWith(300);
  chart.setSignals([], true);
  let threw = "";
  try {
    chart.setLiveSignals(null);
    chart.setLiveSignals([{}, { side: "buy" }, { side: "buy", time: at(299) }]);
  } catch (e) { threw = String(e && e.message); }
  check("a malformed forming mark cannot take the chart down", threw === "" || threw);
}

/* ------------------------------------------------- the desk's filter */
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
  const make = (S, feat = true) => {
    const sent = [];
    S.chart = { setLiveSignals: (rows) => sent.push(rows) };
    const fn = new Function("S", "licFeat",
      lift("applyLiveSignals") + "\nreturn applyLiveSignals;")(S, () => feat);
    return { fn, sent, S };
  };
  const mark = (sym, tf) => ({
    symbol: sym, timeframe: tf, time: at(299),
    signals: [{ strategy: "p", side: "buy", time: at(299), price: 1.1 }],
  });

  {
    const { fn, sent, S } = make({ symbol: "EURUSD", timeframe: "M15", signalsEnabled: true, showSignals: true });
    fn(mark("EURUSD", "M15"));
    check("a reading of the chart in front of the trader is applied",
      sent.length === 1 && sent[0].length === 1 && S.liveSignals.length === 1);
  }
  {
    const { fn, sent } = make({ symbol: "EURUSD", timeframe: "M15", signalsEnabled: true, showSignals: true });
    fn(mark("XAUUSD", "M15"));
    check("another instrument's reading is dropped, not drawn here", sent.length === 0);
  }
  {
    const { fn, sent } = make({ symbol: "EURUSD", timeframe: "M15", signalsEnabled: true, showSignals: true });
    fn(mark("EURUSD", "H1"));
    check("another timeframe's reading is dropped too", sent.length === 0);
  }
  {
    const { fn, sent, S } = make({ symbol: "EURUSD", timeframe: "M15", signalsEnabled: true, showSignals: true });
    fn({ symbol: "EURUSD", timeframe: "M15", time: at(299), signals: [] });
    check("a setup that evaporated clears the chart rather than lingering",
      sent.length === 1 && sent[0].length === 0 && S.liveSignals.length === 0);
  }
  {
    const { fn, sent, S } = make({ symbol: "EURUSD", timeframe: "M15", signalsEnabled: false, showSignals: true });
    fn(mark("EURUSD", "M15"));
    check("signals off means the forming layer is emptied, not filled",
      sent.length === 1 && sent[0].length === 0 && S.liveSignals.length === 0);
  }
  {
    const { fn, sent } = make(
      { symbol: "EURUSD", timeframe: "M15", signalsEnabled: true, showSignals: true }, false);
    fn(mark("EURUSD", "M15"));
    check("without the premium feature nothing is drawn on this layer",
      sent.length === 1 && sent[0].length === 0);
  }
  {
    // No chart on screen at all: the message must be harmless.
    let threw = "";
    const fn = new Function("S", "licFeat",
      lift("applyLiveSignals") + "\nreturn applyLiveSignals;")(
      { symbol: "EURUSD", timeframe: "M15", signalsEnabled: true, showSignals: true }, () => true);
    try { fn(mark("EURUSD", "M15")); } catch (e) { threw = String(e && e.message); }
    check("a reading that arrives with no chart open is ignored quietly", threw === "" || threw);
  }
}

/* ------------------------------------------- it is wired to the stream */
{
  check("the stream handler routes live_signal to the desk",
    /msg\.type === "live_signal"[\s\S]{0,120}applyLiveSignals/.test(app));
  const pick = app.slice(app.indexOf("async function pickMarket("));
  check("switching market drops the forming marks first",
    pick.slice(0, 1200).includes("clearLiveSignals()"));
  check("the forming layer never feeds the confirmed one",
    app.indexOf("S.chartSignals = rows") === -1);
}

/* ------------------------------------------------- the engine's half */
{
  const trader = fs.readFileSync(path.join(ROOT, "engine", "aurion", "runtime", "trader.py"), "utf8");
  const start = trader.indexOf("async def _publish_forming(");
  check("the watch pass has something to publish with", start > 0);
  const body = trader.slice(start, trader.indexOf("\n    async def ", start + 10));
  check("a forming mark carries the time of the bar it was seen on",
    body.includes('"time": bar_time'));
  check("and is labelled as provisional on the wire", body.includes('"forming": True'));
  check("only entries are sent; a hold is not a mark",
    body.includes('if action not in {"buy", "sell"}'));
  for (const forbidden of ["_dispatch_signal", "send_order", "place_order", "close_position"]) {
    check("the forming pass cannot reach " + forbidden, !body.includes(forbidden));
  }
  check("it is droppable on a backlogged desk, like a tick",
    fs.readFileSync(path.join(ROOT, "engine", "aurion", "runtime", "bus.py"), "utf8")
      .includes('"live_signal"'));
  check("trading is still decided on closed bars only",
    /if self\._is_closed_bar\(payload\):\s*\n\s*await self\._on_closed_candle\(payload\)/.test(trader));
}

/* ----------------------------------------------------- the wording */
{
  for (const tag of ["en", "fa", "ar"]) {
    const words = JSON.parse(fs.readFileSync(path.join(ROOT, "lang", tag + ".json"), "utf8"));
    check(tag + " has a word for a setup that is still forming",
      Boolean(words.signal && words.signal.forming && words.signal.forming_note));
  }
  const html = fs.readFileSync(path.join(ROOT, "apps", "web", "index.html"), "utf8");
  check("charts.js is cache-busted past the last build", /charts\.js\?v=desk2(4[2-9]|[5-9]\d)/.test(html));
  check("app.js is cache-busted past the last build", /app\.js\?v=desk2(8[1-9]|9\d)/.test(html));
}

console.log("\n" + (failed ? "FAILED " + failed : "live-signalling: all ok"));
process.exit(failed ? 1 : 0);
