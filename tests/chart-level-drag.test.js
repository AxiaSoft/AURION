/**
 * Dragging a stop or a target on the chart.
 *
 * Asked for alongside the drifting-levels fix: "make it possible to
 * change the stop and target price from the chart". The chart reports
 * the intent and nothing more - it never sends the order itself, and it
 * never paints the line at the new price before the broker has
 * confirmed, because that would be drawing a state that does not exist.
 *
 * Run without a canvas; the questions are about hit-testing and state.
 *
 *     node tests/chart-level-drag.test.js
 */

const path = require("node:path");
const ROOT = path.resolve(__dirname, "..");
const CHARTS = path.join(ROOT, "apps", "web", "js", "charts.js");

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

function stubCtx() {
  const noop = () => {};
  return new Proxy({}, { get: (t, k) => {
    if (k === "measureText") return () => ({ width: 10 });
    if (k === "canvas") return { width: 1200, height: 800 };
    if (k === "createLinearGradient") return () => ({ addColorStop: noop });
    return typeof t[k] === "undefined" ? noop : t[k];
  }, set: () => true });
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
const { CandleChart } = require(CHARTS);

const SL = 1.0460, TP = 1.0540, OPEN = 1.0500;

function makeChart(opts) {
  const canvas = {
    width: 1200, height: 800, clientWidth: 1200, clientHeight: 800,
    getContext: () => stubCtx(),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1200, height: 800 }),
    addEventListener() {}, removeEventListener() {},
    setPointerCapture() {}, releasePointerCapture() {},
    style: {}, dataset: {}, parentElement: { appendChild() {} },
  };
  const c = new CandleChart(canvas, opts || {});
  const rows = [];
  for (let i = 0; i < 160; i += 1) {
    const b = 1.05 + Math.sin(i / 11) * 0.004;
    rows.push({ time: new Date(Date.UTC(2026, 0, 1) + i * 900000).toISOString(),
      open: b, high: b + 0.0008, low: b - 0.0008, close: b + 0.0002 });
  }
  c.setBars(rows);
  c.setLevels([{ ticket: 77, symbol: "EURUSD", type: "buy",
    price_open: OPEN, sl: SL, tp: TP, price_current: 1.0505 }]);
  c.setTool("cursor");
  c.draw();          // zones are recorded while painting
  c._L = c.layout();
  return c;
}

const yOf = (c, price) => c.layout().yOf(price);
const at = (c, price, dx) => ({ clientX: (dx == null ? 400 : dx), clientY: yOf(c, price),
  pointerId: 1, pointerType: "mouse", preventDefault() {} });

/* ----------------------------------------------------------------------- */

check("the stop and the target are findable on screen", () => {
  const c = makeChart();
  if (!Array.isArray(c._lvlZones) || c._lvlZones.length !== 2) {
    throw new Error("expected two zones, got " + JSON.stringify(c._lvlZones));
  }
  const kinds = c._lvlZones.map((z) => z.kind).sort().join(",");
  if (kinds !== "sl,tp") throw new Error("zones are " + kinds);
  const sl = c.levelAt(400, yOf(c, SL));
  if (!sl || sl.kind !== "sl") throw new Error("the stop is not grabbable at its own price");
  const tp = c.levelAt(400, yOf(c, TP));
  if (!tp || tp.kind !== "tp") throw new Error("the target is not grabbable at its own price");
});

check("empty chart space is not a level", () => {
  const c = makeChart();
  const away = yOf(c, SL) - 40;
  if (c.levelAt(400, away)) throw new Error("grabbed a level 40px away from one");
  if (c.levelAt(400, yOf(c, OPEN))) throw new Error("the entry line is not a level to drag");
});

check("a finger gets a bigger grab than a mouse", () => {
  /* A fingertip covers more than a line and cannot see what it covers. */
  const c = makeChart();
  const near = yOf(c, SL) + 9;
  c._pointerType = "mouse";
  if (c.levelAt(400, near)) throw new Error("a mouse grabbed from 9px away");
  c._pointerType = "touch";
  if (!c.levelAt(400, near)) throw new Error("a finger could not grab from 9px away");
});

check("a drawing tool never grabs a broker level", () => {
  /* Mid-drawing, the trader is placing a shape. Moving a live stop by
     accident is a very expensive surprise. */
  const c = makeChart();
  c.setTool("trend");
  if (c.levelAt(400, yOf(c, SL))) throw new Error("the trend tool grabbed the stop");
  c.setTool("cursor");
  if (!c.levelAt(400, yOf(c, SL))) throw new Error("the cursor cannot grab it either");
});

check("a press on the stop starts a drag instead of the usual click", () => {
  const c = makeChart();
  c.onDown(at(c, SL));
  if (!c._lvlDrag) throw new Error("no drag began");
  if (c._lvlDrag.kind !== "sl" || c._lvlDrag.ticket !== 77) {
    throw new Error("wrong level: " + JSON.stringify(c._lvlDrag));
  }
  if (c.drag) throw new Error("the ordinary chart drag started as well");
});

check("moving carries the line and the price with it", () => {
  const c = makeChart();
  c.onDown(at(c, SL));
  const want = 1.0470;
  c.onMove(at(c, want));
  const got = c._lvlDrag.price;
  if (Math.abs(got - want) > 0.0002) throw new Error("line is at " + got + ", pointer at " + want);
  if (c._lvlDrag.from !== SL) throw new Error("it forgot where it came from");
});

check("letting go reports the move once, and does not send it", () => {
  const seen = [];
  const c = makeChart({ onLevelMove: (d) => seen.push(d) });
  c.onDown(at(c, SL));
  c.onMove(at(c, 1.0470));
  c.onUp(at(c, 1.0470));
  if (seen.length !== 1) throw new Error("reported " + seen.length + " times");
  if (seen[0].kind !== "sl" || seen[0].ticket !== 77) throw new Error("wrong payload");
  if (Math.abs(seen[0].price - 1.0470) > 0.0002) throw new Error("wrong price: " + seen[0].price);
  if (Math.abs(seen[0].from - SL) > 1e-9) throw new Error("wrong origin");
  if (c._lvlDrag) throw new Error("the drag did not end");
});

check("the chart keeps hold of the real price all through the drag", () => {
  /* Tested DURING the drag, not after it. Afterwards the preview is gone
     and both readings agree whatever the code does, which is why the
     first version of this check passed against a deliberately broken
     build. Mid-drag the two must differ: the preview follows the
     pointer, the recorded price is still the broker's, and that is what
     the line snaps back to when the confirmation is declined. */
  const c = makeChart({ onLevelMove: () => {} });
  c.onDown(at(c, SL));
  c.onMove(at(c, 1.0470));
  const mid = (c._lvlZones || []).find((z) => z.kind === "sl");
  if (!mid) throw new Error("the stop vanished mid-drag");
  if (Math.abs(mid.price - SL) > 1e-9) {
    throw new Error("mid-drag the chart already calls the stop " + mid.price);
  }
  if (Math.abs(c._lvlDrag.price - 1.0470) > 0.0002) throw new Error("the preview is not following");

  c.endLevelDrag(false);                       // declined
  const after = (c._lvlZones || []).find((z) => z.kind === "sl");
  if (Math.abs(after.price - SL) > 1e-9) throw new Error("it did not snap back");
});

check("a drag that goes nowhere is not an order", () => {
  const seen = [];
  const c = makeChart({ onLevelMove: (d) => seen.push(d) });
  c.onDown(at(c, SL));
  c.onUp(at(c, SL));
  if (seen.length) throw new Error("a press with no movement was reported as a move");
});

check("the desk decides, not the chart", () => {
  /* charts.js must contain no order call of its own. Changing a live
     stop is real money; the confirmation, the wording and the failure
     handling belong with every other order path. */
  const src = require("node:fs").readFileSync(CHARTS, "utf8");
  if (/\/api\/order|API\.post|fetch\s*\(/.test(src)) {
    throw new Error("the renderer is talking to the order endpoint");
  }
});

check("the desk refuses a stop dragged to the winning side", () => {
  /* Read off app.js rather than executed: the handler needs the whole
     desk. What is asserted is that the guard exists and is applied to
     both kinds, because the broker would reject these anyway and a
     rejection three seconds later is a worse answer than one now. */
  const app = require("node:fs").readFileSync(path.join(ROOT, "apps", "web", "js", "app.js"), "utf8");
  const fn = app.slice(app.indexOf("async function onChartLevelMove"));
  const body = fn.slice(0, fn.indexOf("\nfunction bindChartDesk"));
  if (!body) throw new Error("onChartLevelMove is missing");
  if (!/chart\.lvl_sl_side/.test(body) || !/chart\.lvl_tp_side/.test(body)) {
    throw new Error("the wrong-side guard does not cover both kinds");
  }
  if (!/askConfirm\(/.test(body)) throw new Error("a live stop is moved without asking");
  if (!/action: "modify"/.test(body)) throw new Error("it does not send a modify");
  /* Both legs must be sent: an order that omits the one not being
     dragged would clear it at the broker. */
  if (!/sl: isSl \? Number\(shown\) : Number\(pos\.sl/.test(body)
      || !/tp: isSl \? Number\(pos\.tp[^)]*\) : Number\(shown\)/.test(body)) {
    throw new Error("the untouched leg is not carried through, so it would be cleared");
  }
});

const failed = results.filter((x) => !x).length;
console.log("\nchart-level-drag: " + (failed
  ? failed + " of " + results.length + " checks FAILED"
  : results.length + " checks passed"));
if (failed) process.exitCode = 1;
