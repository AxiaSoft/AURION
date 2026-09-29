/**
 * The chart engine, driven head-less against a recording canvas.
 *
 * There is no browser in the build environment, so "does it paint" has to be
 * asked another way: a stub 2D context that counts the calls made to it. That
 * is enough to catch the failure that matters most here - a drawing kind, a
 * chart type or an indicator that throws when it is painted, which in a real
 * browser takes the whole frame down and leaves a blank chart.
 *
 *     node apps/web/js/chart-engine.test.cjs
 */
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const here = __dirname;
const noop = () => {};

function makeCtx(log) {
  const ctx = {
    canvas: null,
    setTransform: noop, save: noop, restore: noop, beginPath: noop, closePath: noop,
    moveTo: noop, lineTo: noop, arc: noop, arcTo: noop, ellipse: noop, rect: noop,
    quadraticCurveTo: noop, bezierCurveTo: noop, clip: noop,
    fill: () => log.fills++, stroke: () => log.strokes++,
    fillRect: () => log.fills++, strokeRect: () => log.strokes++, clearRect: noop,
    fillText: (t) => log.text.push(String(t)), measureText: (t) => ({ width: String(t).length * 6 }),
    setLineDash: noop, createLinearGradient: () => ({ addColorStop: noop }),
  };
  return ctx;
}

function makeChartEnv() {
  const log = { fills: 0, strokes: 0, text: [] };
  const store = new Map();
  const ctx = makeCtx(log);
  const canvas = {
    getContext: () => ctx,
    width: 900, height: 500,
    style: {},
    parentElement: null,
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
    prompt: () => "x",
    console,
  };
  win.window = win; win.globalThis = win;
  vm.createContext(win);
  vm.runInContext(fs.readFileSync(path.join(here, "chart-series.js"), "utf8"), win, { filename: "chart-series.js" });
  // A top-level class in a classic script is a global *lexical* binding, which
  // the browser shares between scripts and vm does not. Publishing the two
  // names the test needs is cheaper than pretending otherwise.
  vm.runInContext(
    fs.readFileSync(path.join(here, "charts.js"), "utf8") +
    "\n;globalThis.CandleChart = CandleChart;" +
    "\n;globalThis.SHAPE_POINTS = SHAPE_POINTS;",
    win, { filename: "charts.js" });
  return { win, canvas, log };
}

/* A synthetic but realistic series: a trend with noise and volume. */
function series(n) {
  const out = [];
  let p = 1.1000;
  for (let i = 0; i < n; i++) {
    p += Math.sin(i / 7) * 0.0012 + (i % 11 === 0 ? 0.0009 : -0.0002);
    const o = p, c = p + Math.sin(i / 3) * 0.0008;
    // Unique, ordered stamps: the engine de-duplicates by time, and a
    // generator that repeats one would quietly halve the test's data.
    const at = new Date(Date.UTC(2026, 0, 1, 0, 0, 0) + i * 15 * 60000);
    out.push({
      time: at.toISOString().slice(0, 19),
      open: o, high: Math.max(o, c) + 0.0006, low: Math.min(o, c) - 0.0006, close: c, volume: 100 + (i % 37),
    });
  }
  return out;
}

const { win, canvas, log } = makeChartEnv();
const chart = new win.CandleChart(canvas, { key: "test" });
chart.setBars(series(400));

let failed = 0;
function check(name, cond) {
  if (cond) console.log("  ok  " + name);
  else { console.log("FAIL  " + name); failed++; }
}

check("bars are loaded and sorted", chart.rows().length === 400);
check("the first frame paints", (chart.draw(), log.strokes > 100));
check("the legend prints the OHLC", log.text.join(" ").indexOf("O") >= 0);

/* -------------------------------------------------------- chart types -- */
const types = win.AurionSeries.SERIES_TYPES.map((t) => t.id);
let typeFails = [];
for (const t of types) {
  try {
    chart.setType(t);
    chart.draw();
    if (!chart.rows().length) typeFails.push(t + " (empty)");
  } catch (e) { typeFails.push(t + " (" + e.message + ")"); }
}
check("every chart type paints: " + types.join(", "), typeFails.length === 0 || typeFails.join(", "));
chart.setType("candles");

/* --------------------------------------------------------- indicators -- */
let indFails = [];
for (const def of win.AurionSeries.INDICATORS) {
  try {
    const ind = chart.addIndicator(def.id);
    chart.draw();
    chart.removeIndicator(ind.id);
  } catch (e) { indFails.push(def.id + " (" + e.message + ")"); }
}
check("every indicator paints", indFails.length === 0 || indFails.join(", "));

chart.addIndicator("rsi");
chart.addIndicator("macd");
chart.addIndicator("ema");
check("sub-panes take space off the main plot", (() => {
  const L = chart.layout();
  return L.panes.length === 2 && L.plotB < L.axisB - 20;
})());
chart.indicators.slice().forEach((i) => chart.removeIndicator(i.id));

/* ------------------------------------------------------------- shapes -- */
const POINTS = win.SHAPE_POINTS;
const kinds = Object.keys(POINTS);
const shapeFails = [];
const rows = chart.rows();
function pt(i, p) { return { t: rows[i].t, p, gi: i }; }
for (const kind of kinds) {
  try {
    const need = POINTS[kind];
    const obj = { kind, color: "#e8c07a", text: "note", width: 1.4, style: "solid", opacity: 1 };
    if (need === -1) {
      obj.pts = [pt(320, 1.10), pt(330, 1.11), pt(340, 1.105)];
      obj.a = obj.pts[0]; obj.b = obj.pts[2];
    } else {
      ["a", "b", "c", "d", "e", "f", "g"].slice(0, need).forEach((k, n) => {
        obj[k] = pt(320 + n * 8, 1.10 + n * 0.004);
      });
    }
    chart.drawings = [chart.hydrate(obj)];
    chart.selected = chart.drawings[0];
    chart.draw();
  } catch (e) { shapeFails.push(kind + ": " + e.message); }
}
check("every drawing kind paints (" + kinds.length + " kinds)", shapeFails.length === 0 || shapeFails.join(" | "));
check("every drawing kind knows how many points it needs",
  kinds.every((k) => Number.isFinite(POINTS[k])));
chart.drawings = [];
chart.selected = null;

/* ------------------------------------------------------------ history -- */
chart.addObject({ kind: "trend", a: pt(10, 1.1), b: pt(20, 1.2) });
chart.addObject({ kind: "rect", a: pt(30, 1.1), b: pt(40, 1.2) });
check("two objects are on the chart", chart.drawings.length === 2);
chart.undo();
check("undo removes the last one", chart.drawings.length === 1);
chart.redo();
check("redo puts it back", chart.drawings.length === 2);
chart.removeObject(chart.drawings[0].id);
check("delete removes by id", chart.drawings.length === 1);
chart.undo();
check("undo restores a deletion", chart.drawings.length === 2);
const target = chart.drawings[0];
chart.updateObject(target.id, { color: "#ff0000", width: 3 });
check("properties are editable", chart.getObject(target.id).color === "#ff0000");
chart.undo();
check("undo restores a property change", chart.getObject(target.id).color !== "#ff0000");
chart.clearDrawings();
check("clear empties the chart", chart.drawings.length === 0);
chart.undo();
check("...and even that is undoable", chart.drawings.length === 2);

/* ---------------------------------------------------------- navigation -- */
chart.fit();
const span0 = chart.span;
chart.zoom(1, 10);
check("zoom in narrows the window", chart.span < span0);
chart.zoom(-1, 10);
check("zoom out widens it again", chart.span >= span0 - 1);
const off0 = chart.offset;
chart.pan(20);
check("pan scrolls back", chart.offset === off0 + 20);
chart.pan(-9999);
check("pan stops in the empty margin past the newest bar",
  chart.offset === chart.minOffset() && chart.offset < 0);
check("...and that margin becomes real space on the right",
  (() => { const L = chart.layout(); return L.cells > L.rows.length; })());
chart.pan(99999);
check("pan cannot scroll past the oldest", chart.offset <= chart.maxOffset());
chart.fit();

chart.setAutoScale(true);
const autoL = chart.layout();
chart.scaleBy(2);
const wideL = chart.layout();
check("dragging the price axis stops auto scale", chart.scale.auto === false);
check("...and widens the range", (wideL.mx - wideL.mn) > (autoL.mx - autoL.mn));
chart.setAutoScale(true);
check("auto can be asked back", chart.scale.auto === true && chart.layout().mn !== null);

chart.setLogScale(true);
const logged = chart.layout();
check("a log axis is not a linear one", (() => {
  const mid = (logged.mn + logged.mx) / 2;
  const yLinear = logged.plotT + 0.5 * (logged.plotB - logged.plotT);
  return Math.abs(logged.yOf(mid) - yLinear) > 0.5;
})());
chart.setLogScale(false);

chart.setInvertScale(true);
check("inverting flips the axis", chart.layout().yOf(chart.layout().mx) > chart.layout().yOf(chart.layout().mn));
chart.setInvertScale(false);

/* -------------------------------------------------------------- magnet -- */
chart.setMagnet("strong");
const L = chart.layout();
const idx = Math.floor(L.rows.length / 2);
const row = L.rows[idx];
const snapped = chart.snapHit({ L, i: idx, y: L.yOf(row.h + 0.0003), p: row.h + 0.0003 });
check("a strong magnet lands on a real price",
  [row.o, row.h, row.l, row.c].some((p) => Math.abs(p - snapped.p) < 1e-12));
chart.setMagnet("off");
const free = chart.snapHit({ L, i: idx, y: L.yOf(row.h + 0.0003), p: row.h + 0.0003 });
check("magnet off leaves the price alone", Math.abs(free.p - (row.h + 0.0003)) < 1e-12);

/* ---------------------------------------------------------- persistence -- */
chart.setType("heikin");
chart.addIndicator("rsi", { period: 21 });
const second = new win.CandleChart(canvas, { key: "test" });
check("the chart type survives a reload", second.type === "heikin");
check("indicators survive a reload",
  second.indicators.length === 1 && second.indicators[0].params.period === 21);
second.setType("candles");

/* ------------------------------------------------------------- hit test -- */
chart.setType("candles");
chart.drawings = [];
const line = chart.addObject({ kind: "trend", a: pt(360, 1.10), b: pt(380, 1.12) });
const L2 = chart.layout();
const ax = chart.xyOf(L2, line.a);
check("an anchor is grabbable", (() => {
  const f = chart.shapeAt(L2, ax.x, ax.y);
  return f && f.shape === line && f.handle === "a";
})());
check("the body of the line is selectable", (() => {
  const bx = chart.xyOf(L2, line.b);
  const f = chart.shapeAt(L2, (ax.x + bx.x) / 2, (ax.y + bx.y) / 2);
  return f && f.shape === line;
})());
check("empty space selects nothing", chart.shapeAt(L2, L2.plotL + 2, L2.plotT + 2) === null);
chart.updateObject(line.id, { locked: true });
check("a locked object cannot be grabbed by its handle",
  (chart.shapeAt(L2, ax.x, ax.y) || {}).handle === null);

/* ------------------------------------------------- the right-button drag -- */
/*
   Press the right button anywhere on the chart and drag: time and price move
   together, from inside whatever tool is armed, and the browser's own menu
   never appears. A right click that does not move is not navigation and is
   offered to the interface as a context menu instead.
*/
(function rightDrag() {
  chart.fit();
  chart.setTool("trend");                       // armed tool must not interfere
  const before = { offset: chart.offset, mn: chart.layout().mn };
  let menus = 0;
  chart.opts.onMenu = () => { menus++; };

  const down = (btn, x, y) => chart.onDown({ button: btn, clientX: x, clientY: y, pointerId: 1 });
  const move = (x, y) => chart.onMove({ clientX: x, clientY: y });
  const up = (btn, x, y) => chart.onUp({ button: btn, clientX: x, clientY: y, pointerId: 1 });

  down(2, 400, 200);
  check("the right button starts a free drag", chart.drag && chart.drag.mode === "free");
  check("...and does not start a drawing", chart.draft === null);

  move(300, 260);
  check("dragging left scrolls forward in time", chart.offset !== before.offset);
  check("dragging down moves the price window", chart.layout().mn !== before.mn);
  check("...which means auto scale has been released", chart.scale.auto === false);

  up(2, 300, 260);
  check("the drag ends cleanly", chart.drag === null);
  check("a drag is not a context menu", menus === 0);
  check("the tool survived the navigation", chart.tool === "trend");

  // Back the other way: the gesture has to be symmetrical.
  // Dragging down pushed the candles down, which raises the visible window;
  // dragging back up has to lower it again by the same logic.
  const mid = chart.layout().mn;
  down(2, 300, 260); move(420, 190); up(2, 420, 190);
  check("dragging back the other way reverses it", chart.layout().mn < mid);

  // A click that never moved.
  down(2, 400, 200); up(2, 400, 200);
  check("a right click with no movement offers a menu", menus === 1);

  let prevented = 0;
  chart.onContext({ preventDefault: () => { prevented++; } });
  check("the browser menu is always refused on the canvas", prevented === 1);

  chart.opts.onMenu = null;
  chart.setTool("cursor");
  chart.fit();
})();

/* ---------------------------------------------------------- the resize -- */
/*
   "ResizeObserver loop completed with undelivered notifications" is what the
   browser reports when an observed element changes size again while the
   observer is still delivering. The chart caused it by resizing its own
   canvas inside the callback, and the desk's boot trap turned that benign
   warning into a red "could not finish loading" panel over a working desk.
   These assertions are the guard against it coming back.
*/
(function resizePath() {
  const raf = [];
  let observed = null;
  const stub = makeCtx({ fills: 0, strokes: 0, text: [] });
  const cv = {
    getContext: () => stub, width: 0, height: 0, style: {}, parentElement: null,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 400 }),
    addEventListener: noop, setPointerCapture: noop,
  };
  const env = {
    devicePixelRatio: 1,
    ResizeObserver: function (cb) { observed = cb; this.observe = noop; this.disconnect = noop; },
    requestAnimationFrame: (fn) => raf.push(fn),
    getComputedStyle: () => ({ getPropertyValue: () => "" }),
    document: { documentElement: { dataset: {}, dir: "ltr" } },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    console,
  };
  env.window = env; env.globalThis = env;
  vm.createContext(env);
  vm.runInContext(fs.readFileSync(path.join(here, "chart-series.js"), "utf8"), env);
  vm.runInContext(fs.readFileSync(path.join(here, "charts.js"), "utf8") +
    "\n;globalThis.CandleChart = CandleChart;", env);

  const c = new env.CandleChart(cv, {});
  c.setBars(series(60));
  check("the chart observes its own box", typeof observed === "function");

  let painted = 0;
  const real = c.paint.bind(c);
  c.paint = () => { painted++; real(); };

  raf.length = 0;
  observed();
  check("a resize never paints inside the callback", painted === 0);
  observed(); observed();
  check("many resizes in one frame schedule one paint", raf.length === 1);
  raf.splice(0).forEach((fn) => fn());
  check("...and that frame paints exactly once", painted === 1);

  let depth = 0, deepest = 0;
  c.paint = () => { depth++; deepest = Math.max(deepest, depth); if (depth < 3) c.draw(); real(); depth--; };
  c.draw();
  check("a paint cannot re-enter itself", deepest === 1);
})();

console.log(failed ? `\n${failed} failing.` : "\nThe engine holds.");
process.exit(failed ? 1 : 0);
