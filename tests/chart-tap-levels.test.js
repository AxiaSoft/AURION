/**
 * Reading a signal with a finger, and an open position's levels.
 *
 * Two defects, both measured in a real browser before anything was
 * changed, and both about a chart drawn on a canvas - where there is no
 * DOM to assert against, so these run the real handlers and the real
 * painters against recording stand-ins.
 *
 *  1. A signal card needed several taps and moved the chart. The card
 *     was a hover construct and a finger never hovers.
 *
 *  2. A stop and a target were drawn with the candle up/down colours.
 *     Those are built from each theme's own accent and are two shades
 *     of ONE hue by design, so the stop and the target came out the
 *     same colour - on the default glass theme, both teal.
 *
 *     node tests/chart-tap-levels.test.js
 */
const path = require("node:path");

let failed = 0, passed = 0;
const ok = (c, m) => { if (!c) { failed++; console.log("FAIL " + m); } else { passed++; console.log("ok   " + m); } };

/* ------------------------------------------------------- a fake canvas */

let CSSVARS = {};
global.window = {
  addEventListener() {}, devicePixelRatio: 1, __aurionThemeRev: 0,
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  getComputedStyle: () => ({ getPropertyValue: (n) => CSSVARS[n] || "" }),
};
global.document = {
  documentElement: { dataset: {} },
  createElement: () => ({ getContext: () => null, style: {}, addEventListener() {} }),
  addEventListener() {},
};

const { CandleChart } = require(path.join(__dirname, "..", "apps/web/js/charts.js"));

function recorder() {
  const calls = { fillRect: [], strokeRect: [], fillText: [], strokes: [] };
  let pen = null;
  const ctx = {
    canvas: { width: 900, height: 500 },
    save() {}, restore() {}, closePath() {}, clip() {},
    /* A rounded span is roundRect + fill, not fillRect - record it the
       same way so the two paths are measured alike. */
    fill() { if (pen && pen.rect) { calls.fillRect.push({ ...pen, color: ctx.fillStyle }); pen = null; } },
    setLineDash(d) { ctx._dash = d; }, roundRect(x, y, w, h) { pen = { x, y, w, h, rect: true }; },
    arc() {}, translate() {}, scale() {},
    beginPath() { if (!pen || !pen.rect) pen = null; },
    moveTo(x, y) { pen = { x0: x, y0: y }; },
    lineTo(x, y) { if (pen) { pen.x1 = x; pen.y1 = y; } },
    stroke() {
      if (pen && pen.x1 !== undefined) {
        calls.strokes.push({ ...pen, color: ctx.strokeStyle, width: ctx.lineWidth, dash: ctx._dash });
      }
    },
    measureText: (t) => ({ width: String(t).length * 6 }),
    fillRect: (x, y, w, h) => calls.fillRect.push({ x, y, w, h, color: ctx.fillStyle }),
    strokeRect: (x, y, w, h) => calls.strokeRect.push({ x, y, w, h }),
    fillText: (t, x, y) => calls.fillText.push({ t: String(t), x, y, color: ctx.fillStyle }),
  };
  return { ctx, calls };
}

/** A day and a half of M15 bars, keyed the way norm() keys them. */
function makeRows(key) {
  const rows = [];
  const start = Date.UTC(2026, 9, 29, 0, 0, 0);
  for (let i = 0; i < 140; i++) {
    rows.push({ [key]: new Date(start + i * 15 * 60000).toISOString(), o: 1, h: 1.1, l: 0.9, c: 1.05 });
  }
  return rows;
}

function layout(rows) {
  const plotL = 50, plotR = 850, plotT = 20, plotB = 470;
  const bw = (plotR - plotL) / rows.length;
  return {
    rows, plotL, plotR, plotT, plotB, bw, w: 900, h: 560, padR: 78,
    xOf: (i) => plotL + i * bw + bw / 2,
    yOf: (p) => plotB - (p - 1.0400) * 100000,
  };
}

/* ============================================ a stop is not a down bar */

/**
 * Every theme now builds its candle colours from its own accent, so
 * --candle-up and --candle-down are two shades of one hue - on the
 * glass theme, two teals. Drawing a stop and a target with them made
 * the two lines of a trade that matter most indistinguishable.
 */
{
  CSSVARS = {
    "--candle-up": "#66ffe5", "--candle-down": "#299986",   // glass: one hue
    "--ok": "#26d07c", "--bad": "#f4475b",
  };
  window.__aurionThemeRev = 1;                               // bust the cache

  const { ctx, calls } = recorder();
  const c = Object.create(CandleChart.prototype);
  c.ctx = ctx;
  c.levels = [{ sl: 1.0451, tp: 1.0497, price_open: 1.0469, type: "buy" }];
  c.fmtPrice = (p) => Number(p).toFixed(4);
  const L = layout(makeRows("t"));
  c.paintLevels(L);

  const hue = (col) => {
    const m = String(col).match(/-?\d+(\.\d+)?/g).slice(0, 3).map(Number);
    const [r, g, b] = m, mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    if (mx === mn) return 0;
    const d = mx - mn;
    let h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return ((h * 60) + 360) % 360;
  };
  const sl = calls.strokes.find((k) => Math.abs(k.y0 - L.yOf(1.0451)) < 0.5);
  const tp = calls.strokes.find((k) => Math.abs(k.y0 - L.yOf(1.0497)) < 0.5);
  ok(sl && tp, "the stop and the target are both drawn");
  const apart = sl && tp ? Math.abs(((hue(sl.color) - hue(tp.color) + 540) % 360) - 180) : 0;
  ok(apart > 60,
    `a stop and a target are told apart by colour (${Math.round(apart)} degrees of hue)`);

  /* No wash. The levels used to fill from each line back to the entry
     across the full width, which covered the candles in red and green. */
  ok(calls.fillRect.length === 0,
    `the levels are lines, not filled bands (${calls.fillRect.length} fills)`);

  /* The entry is dashed and the stop and target are not, so the three
     are told apart by more than colour. */
  const entry = calls.strokes.find((k) => Math.abs(k.y0 - L.yOf(1.0469)) < 0.5);
  ok(entry && entry.dash && entry.dash.length > 0 && (!sl.dash || !sl.dash.length),
    "the entry is dashed where the stop and target are solid");

  /* The price tags belong on the price axis, not over the oldest
     candles on screen. */
  const tags = recorder();
  const c2 = Object.create(CandleChart.prototype);
  c2.ctx = tags.ctx;
  c2.levels = c.levels;
  c2.fmtPrice = c.fmtPrice;
  c2.paintLevelLabels(L);
  const onAxis = tags.calls.fillRect.every((r) => r.x >= L.w - L.padR);
  ok(tags.calls.fillRect.length === 3 && onAxis,
    `all three tags sit in the price gutter (${tags.calls.fillRect.length} tags, on axis: ${onAxis})`);

  CSSVARS = {};
  window.__aurionThemeRev = 2;
}

/* ======================================================= one tap, no jump */

/**
 * Reading a signal on a phone took several taps and moved the chart.
 *
 * The card is a hover construct and a finger never hovers: a tap emits
 * pointerdown and pointerup and no pointermove, so the branch that sets
 * _sigHover was never reached. Measured with real touch events before
 * the fix: hover stayed false after one tap, after two, and after a
 * wait. It only ever appeared because a hand holding a phone wobbles -
 * and that same wobble, rounded against a bar a few pixels wide, panned
 * the chart by a whole bar. That is the jump.
 */
function tapRig() {
  const c = Object.create(CandleChart.prototype);
  const sig = { index: 7, type: "buy", time: "2026-10-29T08:00:00Z" };
  c.pointers = new Map();
  c.canvas = { style: {}, setPointerCapture() {}, releasePointerCapture() {} };
  c.cursorFor = () => "default";
  c.draw = () => { c._drew = (c._drew || 0) + 1; };
  c.clearLongPress = () => {};
  c.hit = () => null;
  c.tool = "cursor";
  c.opts = {};
  c._moved = false;
  c._longFired = false;
  c._sigHover = null;
  c._pinned = null;
  c._downSig = { sig };
  return { c, sig };
}
const touchUp = { pointerType: "touch", pointerId: 1, clientX: 100, clientY: 100 };

{
  const { c, sig } = tapRig();
  c.onUp(touchUp);
  ok(c._sigHover && c._sigHover.sig === sig,
    "one tap on a signal opens its card");
  ok(c._pinned === sig, "and pins it, so a redraw keeps it on screen");
}
{
  /* Tapping the same signal again puts it away: on a canvas there is no
     close button to find. */
  const { c, sig } = tapRig();
  c.onUp(touchUp);
  c._downSig = { sig };
  c._moved = false;
  c.onUp(touchUp);
  ok(!c._sigHover && !c._pinned, "tapping the same signal again closes the card");
}
{
  const { c } = tapRig();
  c.onUp(touchUp);
  c._downSig = null;          // the next tap lands on empty chart
  c._moved = false;
  c.onUp(touchUp);
  ok(!c._sigHover && !c._pinned, "tapping anywhere else closes the card");
}
{
  /* A drag is not a tap, however it ends. */
  const { c } = tapRig();
  c._moved = true;
  c.onUp(touchUp);
  ok(!c._sigHover, "a drag that happens to end on a signal does not open the card");
}
{
  /* A mouse keeps the hover behaviour it always had. */
  const { c } = tapRig();
  c.onUp({ pointerType: "mouse", pointerId: 1, clientX: 100, clientY: 100 });
  ok(!c._sigHover, "a mouse click does not go through the tap path");
}

console.log(`\nchart taps + levels: ${passed} of ${passed + failed} checks passed`);
process.exitCode = failed ? 1 : 0;
