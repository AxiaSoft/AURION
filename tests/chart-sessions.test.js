/**
 * Market sessions draw as spans, in their own band, and a position's
 * levels stay readable.
 *
 * Three real defects.
 *
 *  1. paintSessions read each bar's timestamp as `.time || .ts`, but
 *     norm() turns every incoming bar into a row keyed `t`. Every date
 *     was Invalid, so the bands and the open/close marks drew nothing
 *     at all - in live data as much as in the demo. The feature looked
 *     merely switched off, because the legend asks the wall clock
 *     rather than the chart and kept rendering happily.
 *
 *  2. Once it drew, it was unreadable: full-height tints, a dashed
 *     vertical at every open and close, and a labelled chip on each.
 *     A session is an interval, so it is now one bar per centre in a
 *     reserved strip - and reserved matters, because overlaid it sat
 *     on the candle lows and on the stop line of any trade priced
 *     near the bottom of the screen.
 *
 *  3. A stop and a target were drawn with the candle up/down colours.
 *     Those are built from each theme's own accent and are two shades
 *     of ONE hue by design, so the stop and the target came out the
 *     same colour.
 *
 * This runs the real painters against a recording context rather than
 * reading the source, because a regex cannot prove a thing was drawn.
 *
 *     node tests/chart-sessions.test.js
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

const { CandleChart, MARKET_SESSIONS } = require(path.join(__dirname, "..", "apps/web/js/charts.js"));

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

const LANE_H = 9;
const STRIP = MARKET_SESSIONS.length * (LANE_H + 1) - 1 + 5;

function layout(rows) {
  const plotL = 50, plotR = 850, plotT = 20, plotB = 470;
  const bw = (plotR - plotL) / rows.length;
  return {
    rows, plotL, plotR, plotT, plotB, bw, w: 900, h: 560, padR: 78,
    sessH: STRIP, sessT: plotB + 5,
    xOf: (i) => plotL + i * bw + bw / 2,
    yOf: (p) => plotB - (p - 1.0400) * 100000,
  };
}

function paint(key, on = true) {
  const { ctx, calls } = recorder();
  const c = Object.create(CandleChart.prototype);
  c.sessions = on;
  c.ctx = ctx;
  const L = layout(makeRows(key));
  c.paintSessions(L);
  return { calls, L };
}

/* ------------------------------------------------------------ it draws */

const run = paint("t");
const lanes = run.calls.fillRect.filter((r) => r.h === LANE_H);
ok(lanes.length > MARKET_SESSIONS.length,
  `the session strip is painted (${lanes.length} rects)`);

/* A span is narrower than the whole plot; a full-width rect is the empty
   track the lane always has. */
const spans = lanes.filter((r) => r.w < run.L.plotR - run.L.plotL - 1);
const laneYs = [...new Set(spans.map((r) => Math.round(r.y)))].sort((a, b) => a - b);
ok(laneYs.length === MARKET_SESSIONS.length,
  `every centre gets its own row (${laneYs.length} of ${MARKET_SESSIONS.length}: ${laneYs.join(", ")})`);

/* The rows must not sit on each other, or two centres read as one. */
let stacked = false;
for (let i = 1; i < laneYs.length; i++) if (laneYs[i] - laneYs[i - 1] < LANE_H) stacked = true;
ok(!stacked, "the rows are clear of each other");

/* The whole point of the redesign: the strip has its own band and never
   paints over the price. */
const intruding = run.calls.fillRect.filter((r) => r.y < run.L.plotB)
  .concat(run.calls.fillText.filter((t) => t.y < run.L.plotB));
ok(intruding.length === 0,
  `nothing is drawn over the plot (${intruding.length} intruding marks)`);

/* A span's edges ARE the open and the close, which is the question the
   chart is being asked. London opens at 07:00, and with 15-minute bars
   from midnight that is bar 28. */
const london = MARKET_SESSIONS.find((s) => s.id === "london");
const lonLane = laneYs[MARKET_SESSIONS.indexOf(london)];
const lonSpans = spans.filter((r) => Math.round(r.y) === lonLane).sort((a, b) => a.x - b.x);
ok(lonSpans.length >= 1 && Math.abs(lonSpans[0].x - run.L.xOf(28)) < 1,
  `a span starts where its centre opens (London at bar 28, x=${lonSpans[0] && Math.round(lonSpans[0].x)} vs ${Math.round(run.L.xOf(28))})`);
/* London closes at 16:00, so the last bar it covers is 15:45 - bar 63. */
ok(lonSpans.length >= 1 && Math.abs((lonSpans[0].x + lonSpans[0].w) - run.L.xOf(63)) < 1,
  `...and ends where it closes, nine hours later (x=${lonSpans[0] && Math.round(lonSpans[0].x + lonSpans[0].w)} vs ${Math.round(run.L.xOf(63))})`);

/* Named in place, so there is no legend to map colours back to centres. */
const named = run.calls.fillText.map((t) => t.t);
ok(MARKET_SESSIONS.every((s) => named.includes(s.label)),
  `every row is named on the chart (${named.join(", ")})`);

/* The regression itself: rows are keyed `t`, and that must be the key
   that works. Reading `.time` produced Invalid Date and silence. */
ok(paint("time").calls.fillRect.filter((r) => r.h === LANE_H && r.w < 790).length > 0,
  "a row keyed `time` still works, so raw bars are not broken by the fix");
ok(paint("nonsense").calls.fillText.length === 0,
  "an unparseable bar draws no spans rather than nonsense ones");

/* Nothing may be drawn when the feature is off - it is a preference. */
const off = paint("t", false).calls;
ok(off.fillRect.length === 0 && off.fillText.length === 0,
  "switching sessions off draws nothing at all");

/* ...and the band it reserves goes back to the price when it is off. */
{
  const c = Object.create(CandleChart.prototype);
  c.sessions = true;
  const on = c.sessionStripH(560, 14, 26);
  c.sessions = false;
  ok(on > 0 && c.sessionStripH(560, 14, 26) === 0,
    `the strip only reserves height while it is on (${on}px, then 0)`);
  c.sessions = true;
  ok(c.sessionStripH(150, 14, 26) === 0,
    "a short chart keeps its price and drops the strip");

  /* The chart's button bar floats over the foot of the canvas on touch.
     Measured: 32px tall, starting 44px above the bottom. The strip has
     to clear it or it is read through a row of buttons. */
  c._pointerType = "touch";
  const coarse = c.sessionStripH(560, 14, 26);
  ok(coarse >= on + 44,
    `a touch layout reserves room for the floating buttons (${coarse}px vs ${on}px)`);
  delete c._pointerType;
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

console.log(`\nchart-sessions + signal tap: ${passed} of ${passed + failed} checks passed`);
process.exitCode = failed ? 1 : 0;
