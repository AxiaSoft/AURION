/**
 * The entry point the robot planted, drawn on the chart.
 *
 * The complaint this answers: "the signal names an entry but I never see
 * the robot plant it". Two separate faults sat behind that. The engine
 * one is covered in engine/tests/test_entry_is_planted.py. This is the
 * other half - the chart only ever drew open positions, so an order
 * resting at a price looked exactly like a robot doing nothing.
 *
 * What matters here is not that *something* is drawn, but that a waiting
 * order cannot be mistaken for a live trade, and that it is drawn inside
 * the visible price range rather than off the top of the canvas - which
 * is the same as not drawing it.
 *
 *     node apps/web/js/chart-orders.test.cjs
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

let failed = 0;
function check(name, cond) {
  if (cond === true) console.log("  ok  " + name);
  else { console.log("FAIL  " + name + (typeof cond === "string" ? "  \u2014 " + cond : "")); failed++; }
}

const { win, canvas, log } = makeEnv();
const chart = new win.CandleChart(canvas, { key: "ordtest" });
chart.setBars(BARS);
chart.draw();

const last = BARS[BARS.length - 1].close;

/* ------------------------------------------------------- nothing resting -- */

check("a fresh chart has no resting orders", Array.isArray(chart.orders) && chart.orders.length === 0);
log.text.length = 0;
chart.draw();
check("and says nothing about waiting", !log.text.join("\n").includes("WAITING"));

/* --------------------------------------------------------- one planted ---- */

// A pullback entry: resting *below* the market, which is the normal case
// and also the one most likely to be drawn off-screen.
const order = {
  ticket: 5150, symbol: "EURUSD", type: "buy_limit", volume: 0.1,
  price: last - 0.0040, sl: last - 0.0090, tp: last + 0.0070,
};
chart.setOrders([order]);
log.text.length = 0;
chart.draw();
const painted = log.text.join("\n");

check("the planted entry is announced as waiting", painted.includes("WAITING"));
check("the order type is named, so it is not confused with a position",
  /BUY LIMIT/.test(painted));
check("the entry price is printed", painted.includes(chart.fmtPrice(order.price)));

/* --------------------------------------------- it is inside the viewport -- */

check("the resting entry is drawn within the visible price range", (() => {
  const L = chart.layout ? chart.layout() : null;
  if (!L || typeof L.yOf !== "function") return "no layout to measure against";
  const y = L.yOf(order.price);
  const top = L.plotT != null ? L.plotT : 0;
  const bot = L.plotB != null ? L.plotB : L.h;
  return (y >= top - 1 && y <= bot + 1) || `entry drawn at y=${y}, plot is ${top}..${bot}`;
})());

check("the stop is pulled into range too", (() => {
  const L = chart.layout ? chart.layout() : null;
  if (!L || typeof L.yOf !== "function") return "no layout";
  const y = L.yOf(order.sl);
  const top = L.plotT != null ? L.plotT : 0;
  const bot = L.plotB != null ? L.plotB : L.h;
  return (y >= top - 1 && y <= bot + 1) || `sl drawn at y=${y}, plot is ${top}..${bot}`;
})());

/* ------------------------------------------- waiting is not the same as in */

check("a position and a resting order are told apart", (() => {
  chart.setOrders([]);
  chart.setLevels([{
    ticket: 77, symbol: "EURUSD", type: "buy", volume: 0.1,
    price_open: last, price_current: last, sl: last - 0.004, tp: last + 0.004, profit: 3,
  }]);
  log.text.length = 0;
  chart.draw();
  const asPosition = log.text.join("\n");
  // An open trade must never claim to be waiting for anything.
  return !asPosition.includes("WAITING");
})());

/* ------------------------------------------------------------- hygiene ---- */

check("clearing the orders clears the drawing", (() => {
  chart.setLevels([]);
  chart.setOrders([order]);
  chart.draw();
  chart.setOrders([]);
  log.text.length = 0;
  chart.draw();
  return !log.text.join("\n").includes("WAITING");
})());

check("rubbish in the order list does not throw", (() => {
  try {
    chart.setOrders([null, undefined, {}, { price: 0 }, order]);
    chart.draw();
    return true;
  } catch (e) { return String(e && e.message || e); }
})());

check("setOrders ignores a non-array", (() => {
  chart.setOrders(null);
  chart.draw();
  return chart.orders.length === 0;
})());

console.log(failed ? `\nresting orders: ${failed} check(s) failed` : "\nresting orders: all checks passed");
process.exit(failed ? 1 : 0);
