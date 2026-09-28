/**
 * Picking up and moving a drawing.
 *
 * The geometry is the part that can silently be wrong - a hit test that is a
 * few pixels out feels like the chart ignoring you - so it is tested directly
 * against a stub chart rather than through the canvas.
 *
 *     node apps/web/js/drawings.test.cjs
 */
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// charts.js is a browser script; give it just enough of a window to define its
// class, then borrow the two methods under test.
const src = fs.readFileSync(path.join(__dirname, "charts.js"), "utf8");
const sandbox = { window: {}, document: { documentElement: { dataset: {} } }, module: { exports: {} } };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(src + "\n;globalThis.__CandleChart = CandleChart;", sandbox);
const CandleChart = sandbox.__CandleChart;

const chart = Object.create(CandleChart.prototype);
chart.drawings = [];
// A layout where price maps 1:1 to y and bar index 1:1 to x, so the numbers in
// the assertions are the numbers in the picture.
const L = {};
chart.xyOf = (_L, pt) => (pt ? { x: pt.gi * 10, y: pt.p } : null);

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log("  ok  " + name); };

check("distance to a segment is measured to the segment, not its ends", () => {
  const a = { x: 0, y: 0 }, b = { x: 100, y: 0 };
  assert.equal(chart.nearSegment(50, 5, a, b), 5, "beside the middle");
  assert.equal(Math.round(chart.nearSegment(-10, 0, a, b)), 10, "past the start");
});

check("a click on a trend line selects it", () => {
  chart.drawings = [{ kind: "trend", a: { gi: 0, p: 0 }, b: { gi: 10, p: 100 } }];
  assert.ok(chart.shapeAt(L, 50, 50), "on the line");
  assert.equal(chart.shapeAt(L, 50, 90), null, "well away from it");
});

check("an anchor takes priority over the line it belongs to", () => {
  chart.drawings = [{ kind: "trend", a: { gi: 0, p: 0 }, b: { gi: 10, p: 100 } }];
  assert.equal(chart.shapeAt(L, 100, 100).handle, "b");
  assert.equal(chart.shapeAt(L, 50, 50).handle, null);
});

check("the topmost drawing wins when they overlap", () => {
  const under = { kind: "trend", a: { gi: 0, p: 0 }, b: { gi: 10, p: 100 }, id: "under" };
  const over = { kind: "trend", a: { gi: 0, p: 0 }, b: { gi: 10, p: 100 }, id: "over" };
  chart.drawings = [under, over];
  assert.equal(chart.shapeAt(L, 50, 50).shape.id, "over");
});

check("a horizontal line is grabbable anywhere along it", () => {
  chart.drawings = [{ kind: "hline", a: { gi: 3, p: 40 } }];
  assert.ok(chart.shapeAt(L, 500, 41), "far from its anchor");
  assert.equal(chart.shapeAt(L, 500, 80), null);
});

check("moving a shape moves every anchor together", () => {
  const shape = { kind: "trend", a: { gi: 0, p: 0 }, b: { gi: 10, p: 100 } };
  chart.drawings = [shape];
  chart.selected = shape;
  chart.draw = () => {};
  chart.moveSelected({ gi: 0, p: 0 }, { gi: 2, p: 5 }, null);
  assert.deepEqual(shape.a, { gi: 2, p: 5 });
  assert.deepEqual(shape.b, { gi: 12, p: 105 }, "the shape keeps its size");
});

check("dragging one handle moves only that handle", () => {
  const shape = { kind: "trend", a: { gi: 0, p: 0 }, b: { gi: 10, p: 100 } };
  chart.selected = shape;
  chart.moveSelected({ gi: 10, p: 100 }, { gi: 14, p: 120 }, "b");
  assert.deepEqual(shape.a, { gi: 0, p: 0 }, "the other end stays put");
  assert.deepEqual(shape.b, { gi: 14, p: 120 });
});

check("delete removes the selection and nothing else", () => {
  const keep = { kind: "trend", a: { gi: 0, p: 0 }, b: { gi: 1, p: 1 } };
  const drop = { kind: "trend", a: { gi: 2, p: 2 }, b: { gi: 3, p: 3 } };
  chart.drawings = [keep, drop];
  chart.selected = drop;
  assert.equal(chart.deleteSelected(), true);
  assert.deepEqual(chart.drawings, [keep]);
  assert.equal(chart.selected, null);
  assert.equal(chart.deleteSelected(), false, "nothing selected, nothing happens");
});

console.log(`\n${passed} checks passed.`);
