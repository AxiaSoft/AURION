/**
 * Signal marks on the chart, and the card that explains them.
 *
 * A signal arrow on its own is an instruction: "buy here". What a trader
 * needs before acting on it is the case behind it - which strategy, what
 * entry, where the stop went, what it was reaching for. That lives in a
 * hover card, and a hover card is exactly the kind of thing that silently
 * stops appearing: a renamed field, a hit box that drifts off the marker,
 * a stale hover that survives a symbol change. None of that shows up in a
 * screenshot, so it is asserted here instead.
 *
 *     node apps/web/js/chart-signals.test.cjs
 */
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const here = __dirname;
const noop = () => {};

function makeEnv() {
  const log = { text: [], strokes: 0, fills: 0, arcs: [] };
  const store = new Map();
  const ctx = {
    canvas: null,
    setTransform: noop, save: noop, restore: noop, beginPath: noop, closePath: noop,
    moveTo: noop, lineTo: noop, arcTo: noop, ellipse: noop, rect: noop, roundRect: noop,
    arc: (x, y, r) => log.arcs.push({ x, y, r }),
    quadraticCurveTo: noop, bezierCurveTo: noop, clip: noop,
    fill: () => log.fills++, stroke: () => log.strokes++,
    fillRect: () => log.fills++, strokeRect: () => log.strokes++, clearRect: noop,
    fillText: (t) => log.text.push(String(t)),
    measureText: (t) => ({ width: String(t).length * 6 }),
    setLineDash: noop, createLinearGradient: () => ({ addColorStop: noop }),
  };
  const canvas = {
    getContext: () => ctx,
    width: 900, height: 500, style: {}, parentElement: null,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 900, height: 500 }),
    addEventListener: noop, removeEventListener: noop,
    setPointerCapture: noop, releasePointerCapture: noop,
  };
  const win = {
    devicePixelRatio: 1,
    ResizeObserver: function () { this.observe = noop; this.disconnect = noop; },
    getComputedStyle: () => ({ getPropertyValue: () => "" }),
    document: { documentElement: { dataset: {}, dir: "ltr" } },
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    console,
  };
  win.window = win; win.globalThis = win;
  vm.createContext(win);
  vm.runInContext(fs.readFileSync(path.join(here, "chart-series.js"), "utf8"), win, { filename: "chart-series.js" });
  vm.runInContext(
    fs.readFileSync(path.join(here, "charts.js"), "utf8") + "\n;globalThis.CandleChart = CandleChart;",
    win, { filename: "charts.js" });
  return { win, canvas, log };
}

function series(n) {
  const out = [];
  let p = 1.1;
  for (let i = 0; i < n; i++) {
    p += Math.sin(i / 7) * 0.0012;
    const o = p, c = p + Math.sin(i / 3) * 0.0008;
    const at = new Date(Date.UTC(2026, 0, 1) + i * 15 * 60000);
    out.push({
      time: at.toISOString().slice(0, 19),
      open: o, high: Math.max(o, c) + 0.0006, low: Math.min(o, c) - 0.0006, close: c, volume: 100,
    });
  }
  return out;
}

const BARS = series(400);

/** A strategy-shaped signal, the way engine/aurion/signals/strategy_signals.py emits it. */
function signalAt(index, type) {
  const bar = BARS[index];
  const entry = bar.close;
  return {
    index, time: bar.time, type, side: type, price: entry, entry,
    sl: type === "buy" ? entry - 0.004 : entry + 0.004,
    tp: type === "buy" ? entry + 0.009 : entry - 0.009,
    rr: 2.25, confidence: 0.84, strategy: "king",
    reason: "4x higher timeframe is bull (bos) - price in discount at 41% of range - entry chart choch",
    extra: { htf_bias: "bull", zone: "fvg", equilibrium: 0.41 },
  };
}

let failed = 0;
function check(name, cond) {
  if (cond === true) console.log("  ok  " + name);
  else { console.log("FAIL  " + name + (typeof cond === "string" ? "  — " + cond : "")); failed++; }
}

const { win, canvas, log } = makeEnv();
const chart = new win.CandleChart(canvas, { key: "sigtest" });
chart.setBars(BARS);
chart.draw();

/* ------------------------------------------------------------ hit boxes -- */

check("no marks means no hit boxes", chart._sigHits.length === 0);

const marks = [signalAt(380, "buy"), signalAt(390, "sell")];
chart.showSignals = true;
chart.setSignals(marks, true);

check("both visible marks get a hit box", chart._sigHits.length === 2 || String(chart._sigHits.length));

const box = chart._sigHits[0];
check("the hit box is big enough to aim at", box.w >= 24 && box.h >= 24);
check("the hit box is centred on its marker", Math.abs(box.x + box.w / 2 - box.cx) <= 1);

check("the pointer finds the mark it is over", chart.signalAt(box.cx, box.cy) === box);
check("the pointer finds nothing far away", chart.signalAt(box.cx + 300, box.cy) === null);
check("hidden marks expose no hit boxes", (() => {
  chart.setSignals(marks, false);
  chart.draw();
  const none = chart._sigHits.length === 0;
  chart.setSignals(marks, true);
  chart.draw();
  return none;
})());

/* ----------------------------------------------------------- hover card -- */

log.text.length = 0;
chart._sigHover = chart._sigHits[0];
chart.draw();
const card = log.text.join("\n");

check("the card names the side and the strategy", /BUY/.test(card) && /KING/.test(card));
check("the card shows the entry", card.indexOf("Entry") >= 0);
check("the card shows the stop", card.indexOf("SL") >= 0);
check("the card shows the target", card.indexOf("TP") >= 0);
check("the card shows the reward for the risk", card.indexOf("R:R") >= 0 && card.indexOf("2.25") >= 0);
check("the card shows the confidence", card.indexOf("84%") >= 0);
check("the card quotes the strategy's reasoning", /higher timeframe/.test(card));
check("prices are printed, not rounded away", (() => {
  const want = chart.fmtPrice(marks[0].entry);
  return card.indexOf(want) >= 0 || want;
})());

check("the reason is wrapped, not spilled off the card", (() => {
  // Every reason line must fit the card's inner width, or it paints over
  // the candles next to it.
  const lines = card.split("\n").filter((l) => /higher timeframe|discount|choch/.test(l));
  if (!lines.length) return "no reason lines";
  const tooWide = lines.filter((l) => l.length * 6 > 240);
  return tooWide.length === 0 || "wide: " + tooWide[0];
})());

check("no card is painted when nothing is hovered", (() => {
  chart._sigHover = null;
  log.text.length = 0;
  chart.draw();
  return log.text.join("\n").indexOf("R:R") < 0;
})());

/* ------------------------------------- the card must not outlive its data -- */

check("changing the marks drops a stale hover", (() => {
  chart._sigHover = chart._sigHits[0];
  chart.setSignals([signalAt(370, "buy")], true);
  return chart._sigHover === null;
})());

/* --------------------------------------------------------------- pinning -- */

chart.setSignals(marks, true);
chart.draw();

check("pinning a mark shows its card with no pointer involved", (() => {
  log.text.length = 0;
  chart.pinSignal(marks[1]);
  const out = log.text.join("\n");
  return /SELL/.test(out) && out.indexOf("R:R") >= 0;
})());

check("a pinned mark is matched by time, not identity", (() => {
  // The notification carries a copy of the signal, not the same object the
  // chart was handed - a copy is what crosses the host bridge as JSON.
  log.text.length = 0;
  chart.pinSignal(JSON.parse(JSON.stringify(marks[0])));
  return /BUY/.test(log.text.join("\n"));
})());

check("pinning scrolls an off-screen mark into view", (() => {
  const far = signalAt(40, "buy");
  chart.setSignals([far], true);
  chart.offset = 0;              // parked at the newest bar; bar 40 is way back
  chart.draw();
  const before = chart.slice();
  if (far.index >= before.start) return "fixture is already visible";
  chart.pinSignal(far);
  const after = chart.slice();
  return (far.index >= after.start && far.index < after.end) ||
    `window ${after.start}..${after.end} still misses ${far.index}`;
})());

check("the pinned mark is ringed so it stays findable", (() => {
  log.arcs.length = 0;
  chart.draw();
  // The ring is the only arc drawn at radius 13.
  return log.arcs.some((a) => a.r === 13);
})());

check("pinning survives a repaint", (() => {
  chart.draw();
  return chart._sigHover !== null;
})());

/* --------------------------------------------- the desk's end of the wire -- */

const app = fs.readFileSync(path.join(here, "app.js"), "utf8");

check("clicking a signal opens the EA chart, not the symbol browser", (() => {
  const fn = app.slice(app.indexOf("function openSignalChart"), app.indexOf("function pinPendingSignal"));
  return (fn.indexOf("openChartDesk(") >= 0 && fn.indexOf('show("markets"') < 0) ||
    "openSignalChart still routes to markets";
})());

check("following a signal turns the overlay back on", (() => {
  const fn = app.slice(app.indexOf("function openSignalChart"), app.indexOf("function pinPendingSignal"));
  return fn.indexOf("S.signalsEnabled = true") >= 0;
})());

check("the desk pins the signal once the marks have loaded", app.indexOf("pinPendingSignal()") > 0);

check("the notification leads with the entry", (() => {
  const fn = app.slice(app.indexOf("function signalDetail"), app.indexOf("function signalSource"));
  return fn.indexOf("signal.entry") > 0 && fn.indexOf("signal.entry") < fn.indexOf("signal.sl");
})());

check("the host toast carries enough to pin the mark on the way back", (() => {
  const fn = app.slice(app.indexOf("function notifyHost"), app.indexOf("function pushSignalCard"));
  return fn.indexOf("time:") > 0 && fn.indexOf("side:") > 0;
})());

/* ------------------------------------------------------------------------- */

console.log(failed === 0 ? "\nsignal marks: all checks passed" : `\n${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
