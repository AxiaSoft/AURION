/**
 * The price scale holds still unless it has to move.
 *
 * Reported from a live desk: with a stop and a target on the chart, the
 * two lines "keep jumping and reappearing, they are not still". The
 * lines were never the problem. layout() re-fitted the price scale on
 * every draw, so any tick that set a new extreme - and any new candle
 * that pushed the old extreme out of the window - remapped every price
 * to a different pixel row. Candles drifting is hard to see; a
 * horizontal reference line drifting is not.
 *
 * Measured before the fix, on a 120-bar window: 5.7px when a tick made
 * a new high, another 2.8px when the next candle arrived. In a live
 * market both happen several times a minute, so the lines never settle.
 *
 * This runs charts.js head-less - no browser, no canvas - because the
 * question is arithmetic: given the same price, does layout() return
 * the same row?
 *
 *     node tests/chart-scale-stability.test.js
 */

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const CHARTS = path.join(ROOT, "apps", "web", "js", "charts.js");

/* ---------------------------------------------------------- reporting -- */
const results = [];
function check(name, fn) {
  try {
    const note = fn();
    results.push(true);
    console.log("PASS  " + name + (typeof note === "string" ? "  - " + note : ""));
  } catch (e) {
    results.push(false);
    console.log("FAIL  " + name + "\n      " + e.message);
  }
}

/* ------------------------------------------------- a canvas-free stage -- */
function stubCtx() {
  const noop = () => {};
  return new Proxy({}, {
    get: (t, k) => {
      if (k === "measureText") return () => ({ width: 10 });
      if (k === "canvas") return { width: 1200, height: 800 };
      if (k === "createLinearGradient") return () => ({ addColorStop: noop });
      return typeof t[k] === "undefined" ? noop : t[k];
    },
    set: () => true,
  });
}

global.window = global;
global.document = {
  documentElement: { dataset: {}, style: { setProperty() {} } },
  createElement: () => ({ getContext: () => stubCtx(), style: {}, dataset: {} }),
  addEventListener() {}, removeEventListener() {},
};
global.devicePixelRatio = 1;
global.requestAnimationFrame = (f) => setTimeout(f, 0);
global.cancelAnimationFrame = () => {};
global.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
global.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
global.getComputedStyle = () => ({ getPropertyValue: () => "" });
global.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
global.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };

const { CandleChart } = require(CHARTS);

function makeChart() {
  const canvas = {
    width: 1200, height: 800, clientWidth: 1200, clientHeight: 800,
    getContext: () => stubCtx(),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1200, height: 800 }),
    addEventListener() {}, removeEventListener() {},
    style: {}, dataset: {}, parentElement: { appendChild() {} },
  };
  return new CandleChart(canvas, {});
}

/* A realistic window: 120 bars spanning about 200 pips, with a stop and
   a target INSIDE that range. Getting this wrong hides the bug - levels
   wider than the candles pin the scale by themselves and nothing moves,
   which is how the first attempt at this test passed against broken
   code. */
function series(n) {
  const rows = [];
  for (let i = 0; i < n; i += 1) {
    const base = 1.05 + Math.sin(i / 11) * 0.0100;
    rows.push({
      time: new Date(Date.UTC(2026, 0, 1) + i * 900000).toISOString(),
      open: base, high: base + 0.0012, low: base - 0.0012, close: base + 0.0004,
    });
  }
  return rows;
}
const SL = 1.0495;
const POS = [{ ticket: 1, symbol: "EURUSD", type: "buy", price_open: 1.0505, sl: SL, tp: 1.0520, price_current: 1.0505 }];

const rowOf = (c, price) => {
  const L = c.layout();
  if (!L) throw new Error("no layout");
  return L.yOf(price);
};

/* ----------------------------------------------------------- the checks -- */

check("a tick that stays inside the frame does not move a reference line", () => {
  const c = makeChart();
  const rows = series(120);
  c.setBars(rows.map((r) => ({ ...r })));
  c.setLevels(POS);
  const before = rowOf(c, SL);
  const last = rows[rows.length - 1];
  last.high += 0.0002; last.close += 0.0002;
  c.setBars(rows.map((r) => ({ ...r })));
  const after = rowOf(c, SL);
  if (Math.abs(after - before) > 0.01) {
    throw new Error("the stop moved " + Math.abs(after - before).toFixed(2) + "px");
  }
  return "0px";
});

check("a tick that makes a new high does not move it either", () => {
  const c = makeChart();
  const rows = series(120);
  c.setBars(rows.map((r) => ({ ...r })));
  c.setLevels(POS);
  const before = rowOf(c, SL);
  const last = rows[rows.length - 1];
  last.high = Math.max.apply(null, rows.map((r) => r.high)) + 0.0004;
  last.close = last.high - 0.0001;
  c.setBars(rows.map((r) => ({ ...r })));
  const after = rowOf(c, SL);
  if (Math.abs(after - before) > 0.01) {
    throw new Error("the stop moved " + Math.abs(after - before).toFixed(2) + "px on a new high");
  }
  return "0px";
});

check("a new candle arriving does not move it", () => {
  const c = makeChart();
  const rows = series(120);
  c.setBars(rows.map((r) => ({ ...r })));
  c.setLevels(POS);
  const before = rowOf(c, SL);
  const last = rows[rows.length - 1];
  rows.push({
    time: new Date(Date.UTC(2026, 0, 1) + 120 * 900000).toISOString(),
    open: last.close, high: last.close + 0.0003, low: last.close - 0.0003, close: last.close,
  });
  c.setBars(rows.map((r) => ({ ...r })));
  const after = rowOf(c, SL);
  if (Math.abs(after - before) > 0.01) {
    throw new Error("the stop moved " + Math.abs(after - before).toFixed(2) + "px on a new bar");
  }
  return "0px";
});

check("twenty ticks in a row leave the line exactly where it started", () => {
  /* One still frame proves nothing; drift is cumulative. */
  const c = makeChart();
  const rows = series(120);
  c.setBars(rows.map((r) => ({ ...r })));
  c.setLevels(POS);
  const start = rowOf(c, SL);
  const seen = new Set([Math.round(start * 100)]);
  for (let i = 0; i < 20; i += 1) {
    const last = rows[rows.length - 1];
    last.high += 0.00005;
    last.close += 0.00004;
    c.setBars(rows.map((r) => ({ ...r })));
    seen.add(Math.round(rowOf(c, SL) * 100));
  }
  if (seen.size !== 1) throw new Error("the stop occupied " + seen.size + " different rows over 20 ticks");
  return "one row across 20 ticks";
});

check("the scale still follows price out of the window", () => {
  /* The other half. A frame that never re-fits is not stable, it is
     broken: the market walks off the top of the screen. */
  const c = makeChart();
  const rows = series(120);
  c.setBars(rows.map((r) => ({ ...r })));
  c.setLevels(POS);
  rowOf(c, SL);
  for (let i = 0; i < 10; i += 1) {
    rows.push({
      time: new Date(Date.UTC(2026, 0, 1) + (121 + i) * 900000).toISOString(),
      open: 1.070 + i * 0.002, high: 1.072 + i * 0.002,
      low: 1.069 + i * 0.002, close: 1.071 + i * 0.002,
    });
  }
  c.setBars(rows.map((r) => ({ ...r })));
  const L = c.layout();
  const top = rows[rows.length - 1].high;
  const yTop = L.yOf(top);
  if (!(yTop >= L.plotT && yTop <= L.plotB)) {
    throw new Error("the new high at " + top + " is off the plot (y=" + Math.round(yTop) + ")");
  }
  const ySl = L.yOf(SL);
  if (!(ySl >= L.plotT && ySl <= L.plotB)) throw new Error("the stop fell off the plot");
  return "re-fitted to " + c._fit.mn.toFixed(3) + ".." + c._fit.mx.toFixed(3);
});

check("a deliberate gesture re-frames at once", () => {
  /* Sticky must not mean stuck: zooming, panning or switching the scale
     is the viewer asking for a different frame. */
  const c = makeChart();
  c.setBars(series(120).map((r) => ({ ...r })));
  c.setLevels(POS);
  c.layout();
  if (!c._fit) throw new Error("no frame was remembered to begin with");

  /* The frame is non-null again the moment the gesture redraws, so
     "is it null afterwards" says nothing. What matters is that the
     gesture dropped it, forcing that redraw to re-fit. */
  let dropped = 0;
  const real = c.forgetScaleFit.bind(c);
  c.forgetScaleFit = function () { dropped += 1; return real(); };

  for (const [name, call] of [
    ["zoom", () => c.zoom(1)],
    ["pan", () => c.pan(5)],
    ["fit", () => c.fit()],
    ["log scale", () => c.setLogScale(true)],
    ["invert", () => c.setInvertScale(true)],
    ["auto scale", () => c.setAutoScale(true)],
  ]) {
    const was = dropped;
    call();
    if (dropped === was) throw new Error(name + " did not drop the remembered frame");
  }
  return "zoom, pan, fit, log, invert and auto all re-frame";
});

check("the axis and the frame round to the same ladder", () => {
  /* The window is snapped outward to a nice step so that ordinary drift
     has somewhere to go. Using the step the axis already draws means the
     frame also lands on numbers worth reading, rather than on a second
     private set of round numbers. */
  if (typeof CandleChart.niceStep !== "function") throw new Error("niceStep is not shared");
  const cases = [[0.0007, 0.001], [0.0012, 0.002], [0.004, 0.005], [7, 10], [23, 50]];
  for (const [raw, want] of cases) {
    const got = CandleChart.niceStep(raw);
    if (Math.abs(got - want) > want * 1e-9) {
      throw new Error("niceStep(" + raw + ") = " + got + ", expected " + want);
    }
  }
  const src = fs.readFileSync(CHARTS, "utf8");
  if (/const nice = \(raw\) => \{/.test(src)) {
    throw new Error("the axis still carries its own copy of the nice-number rule");
  }
  return "one ladder";
});

/* ------------------------------------------------------------- report -- */
const failed = results.filter((x) => !x).length;
console.log("\nchart-scale-stability: " + (failed
  ? failed + " of " + results.length + " checks FAILED"
  : results.length + " checks passed"));
if (failed) process.exitCode = 1;
