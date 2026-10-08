/**
 * Three complaints about the chart, turned into assertions.
 *
 *   1. A line showed no price, so the number it was drawn to mark had to be
 *      read off the axis by eye.
 *   2. The tool disarmed itself the instant a shape was released, so marking
 *      up a session meant re-clicking the tool between every line.
 *   3. Keeping the tool armed is only tolerable if the drawings already on
 *      the chart stay grabbable, which is the part that is easy to break.
 *
 *     node --test apps/web/js/chart-draw-ux.test.cjs
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const src = fs.readFileSync(path.join(__dirname, "charts.js"), "utf8");
const sandbox = { window: {}, document: { documentElement: { dataset: {} } }, module: { exports: {} } };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(src + "\n;globalThis.__CandleChart = CandleChart;", sandbox);
const CandleChart = sandbox.__CandleChart;

/** A chart with just enough wiring for paintShape to run and be watched. */
function painter() {
  const chart = Object.create(CandleChart.prototype);
  const tags = [];
  const noop = () => {};
  chart.ctx = {
    save: noop, restore: noop, beginPath: noop, moveTo: noop, lineTo: noop,
    stroke: noop, fill: noop, closePath: noop, fillRect: noop, fillText: noop,
    setLineDash: noop, measureText: () => ({ width: 40 }),
  };
  chart.styleFor = () => "#e8c07a";
  chart.fmtPrice = (p) => Number(p).toFixed(2);
  chart.strokePath = noop;
  chart.arrowHead = noop;
  chart.extend = CandleChart.prototype.extend;
  chart.tag = (x, y, text) => { tags.push({ x, y, text }); };
  chart.anchorPoints = (d) => ["a", "b", "c", "d", "e"].filter((k) => d[k]).map((k) => d[k]);
  chart.xyOf = (_L, pt) => (pt ? { x: pt.gi * 10, y: pt.p } : null);
  chart.tags = tags;
  return chart;
}

const L = {
  plotL: 0, plotR: 500, plotT: 0, plotB: 400,
  yOf: (p) => p,
  pOf: (y) => y,
  rows: [],
};

test("a horizontal line says what price it is", () => {
  const chart = painter();
  chart.paintShape(L, { kind: "hline", a: { gi: 1, p: 120 } });
  assert.equal(chart.tags.length, 1);
  assert.equal(chart.tags[0].text, "120.00");
  assert.equal(chart.tags[0].x, L.plotR, "parked on the price axis, like the last price");
});

test("a horizontal ray says its price too", () => {
  const chart = painter();
  chart.paintShape(L, { kind: "hray", a: { gi: 1, p: 99.5 } });
  assert.deepEqual(chart.tags.map((t) => t.text), ["99.50"]);
});

test("a crossline says its price", () => {
  const chart = painter();
  chart.paintShape(L, { kind: "crossline", a: { gi: 3, p: 42 } });
  assert.deepEqual(chart.tags.map((t) => t.text), ["42.00"]);
});

test("a trend line prints the price at the end it points to", () => {
  const chart = painter();
  chart.paintShape(L, { kind: "trend", a: { gi: 0, p: 100 }, b: { gi: 10, p: 200 } });
  assert.deepEqual(chart.tags.map((t) => t.text), ["200.00"]);
});

test("a ray prints the price where it leaves the chart, not where it was drawn", () => {
  const chart = painter();
  // From (0,100) to (100,200): slope 1 price per pixel. At the right edge,
  // x = 500, the line is at 500.
  chart.paintShape(L, { kind: "ray", a: { gi: 0, p: 100 }, b: { gi: 10, p: 200 } });
  const tag = chart.tags[0];
  assert.equal(tag.x, L.plotR);
  assert.ok(Number(tag.text) > 200, "the number followed the line to the edge: " + tag.text);
});

test("the price tag can be switched off per shape", () => {
  const chart = painter();
  chart.paintShape(L, { kind: "hline", a: { gi: 1, p: 120 }, showPrice: false });
  chart.paintShape(L, { kind: "trend", a: { gi: 0, p: 1 }, b: { gi: 1, p: 2 }, showPrice: false });
  assert.deepEqual(chart.tags, []);
});

test("a measurement keeps its own label and does not gain a price", () => {
  const chart = painter();
  chart.paintShape(L, { kind: "measure", a: { gi: 0, p: 100 }, b: { gi: 10, p: 200 } });
  assert.equal(chart.tags.length, 1, "one label, the measurement's own");
  assert.ok(chart.tags[0].text.includes("%"), chart.tags[0].text);
});

/* ---------------------------------------------------------------------- */

/** A chart armed with a drawing tool, with the pointer plumbing stubbed. */
function clicker(tool, shapes) {
  const chart = Object.create(CandleChart.prototype);
  chart.opts = {};
  chart.tool = tool;
  chart.drawings = shapes || [];
  chart.selected = null;
  chart.draft = null;
  chart.drag = null;
  chart.magnet = "off";
  chart.canvas = { style: {}, setPointerCapture() {} };
  chart.draw = () => {};
  chart.changed = () => {};
  chart.snapshot = () => {};
  chart.persist = () => {};
  chart.hit = () => ({ L, x: 50, y: 50, p: 50, i: 5, gi: 5, valid: true });
  chart.snapHit = (raw) => raw;
  chart.point = (h) => ({ t: "", p: h.p, gi: h.gi, gx: h.gi });
  chart.pendingHit = () => null;
  chart.shapeAt = () => chart._found || null;
  chart.colorFor = () => "#e8c07a";
  chart.needs = () => 2;
  return chart;
}

const press = (over) => ({ button: 0, pointerId: 1, clientX: 50, clientY: 50, altKey: false, ...over });

test("with a tool armed, clicking an existing drawing moves it instead of drawing", () => {
  const shape = { id: "s1", kind: "trend", a: { gi: 0, p: 0 }, b: { gi: 10, p: 100 } };
  const chart = clicker("trend", [shape]);
  chart._found = { shape, handle: null };
  chart.onDown(press());
  assert.equal(chart.selected, shape, "the shape under the pointer is selected");
  assert.equal(chart.drag && chart.drag.mode, "shape", "and it is being dragged");
  assert.equal(chart.draft, null, "no new line was started on top of it");
});

test("a locked drawing is selected but not dragged", () => {
  const shape = { id: "s1", kind: "trend", locked: true, a: { gi: 0, p: 0 }, b: { gi: 10, p: 100 } };
  const chart = clicker("trend", [shape]);
  chart._found = { shape, handle: null };
  chart.onDown(press());
  assert.equal(chart.selected, shape);
  assert.equal(chart.drag, null);
});

test("holding alt draws across a drawing on purpose", () => {
  const shape = { id: "s1", kind: "trend", a: { gi: 0, p: 0 }, b: { gi: 10, p: 100 } };
  const chart = clicker("trend", [shape]);
  chart._found = { shape, handle: null };
  chart.onDown(press({ altKey: true }));
  assert.ok(chart.draft, "a new draft was started");
  assert.equal(chart.draft.kind, "trend");
  assert.equal(chart.drag, null);
});

test("empty space still starts a drawing", () => {
  const chart = clicker("trend", []);
  chart._found = null;
  chart.onDown(press());
  assert.ok(chart.draft);
  assert.equal(chart.draft.kind, "trend");
});

test("a drawing in progress is not interrupted by the shape underneath", () => {
  const shape = { id: "s1", kind: "trend", a: { gi: 0, p: 0 }, b: { gi: 10, p: 100 } };
  const chart = clicker("trend", [shape]);
  chart._found = { shape, handle: null };
  chart.draft = { kind: "trend", a: { gi: 1, p: 1 }, b: { gi: 1, p: 1 } };
  chart.anchorKeys = () => ["a", "b"];
  chart.placed = () => 1;
  chart.commitDraft = () => { chart._committed = true; };
  chart.onDown(press());
  assert.equal(chart._committed, true, "the second click finished the line being drawn");
  assert.equal(chart.drag, null);
});

/* ---------------------------------------------------------------------- */

test("the tool lock is on by default and survives a reload", () => {
  // The behaviour module keeps the preference in localStorage; the default
  // has to be "armed", because that is the request this change answers.
  const ui = fs.readFileSync(path.join(__dirname, "chart-tools.js"), "utf8");
  assert.match(ui, /function toolLocked\(\)\s*{\s*return read\(LS_TOOLLOCK, "1"\) === "1"/);
  assert.match(ui, /if \(!toolLocked\(\) && chart\.tool !== "cursor"\) pickTool\("cursor"\)/);
  assert.match(ui, /id="tv-toollock"/, "and there is a switch for it on the rail");
});

test("escape disarms the tool", () => {
  const ui = fs.readFileSync(path.join(__dirname, "chart-tools.js"), "utf8");
  const esc = ui.slice(ui.indexOf('case "Escape":'), ui.indexOf('case "Delete":'));
  assert.match(esc, /pickTool\("cursor"\)/, "a tool that stays armed must be escapable");
});

test("the style bar offers colour, thickness and the price toggle", () => {
  const ui = fs.readFileSync(path.join(__dirname, "chart-tools.js"), "utf8");
  assert.match(ui, /data-swatch=/, "preset colours");
  assert.match(ui, /data-style-color/, "and a custom one");
  assert.match(ui, /data-swidth=/, "thickness");
  assert.match(ui, /data-style-price/, "the price tag");
  assert.match(ui, /data-style-del/, "and a way out");
  assert.match(ui, /paintStyleBar\(\);/, "painted whenever the selection changes");
});
