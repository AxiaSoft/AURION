/**
 * Market sessions actually draw, and their labels do not print on top of
 * each other.
 *
 * Two real defects, both invisible to any "does the option exist" test:
 *
 *  1. paintSessions read each bar's timestamp as `.time || .ts`, but
 *     norm() turns every incoming bar into a row keyed `t`. So the date
 *     was Invalid for every bar and the bands and the open/close marks
 *     drew nothing at all - in live data as much as in the demo. The
 *     feature looked merely switched off, because the legend asks the
 *     wall clock rather than the chart and kept rendering happily.
 *
 *  2. The labels stacked on an index that only counted the centres
 *     changing on ONE candle, so two sessions opening a few bars apart
 *     both claimed the first row and overprinted: "New York 12:0Sydney
 *     21:00".
 *
 * This runs the real painter against a recording context rather than
 * reading the source, because a regex cannot prove a thing was drawn.
 *
 *     node tests/chart-sessions.test.js
 */
const path = require("node:path");

let failed = 0, passed = 0;
const ok = (c, m) => { if (!c) { failed++; console.log("FAIL " + m); } else { passed++; console.log("ok   " + m); } };

/* ------------------------------------------------------- a fake canvas */

global.window = {
  addEventListener() {}, devicePixelRatio: 1,
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  getComputedStyle: () => ({ getPropertyValue: () => "" }),
};
global.document = {
  documentElement: { dataset: {} },
  createElement: () => ({ getContext: () => null, style: {}, addEventListener() {} }),
  addEventListener() {},
};

const { CandleChart, MARKET_SESSIONS } = require(path.join(__dirname, "..", "apps/web/js/charts.js"));

function recorder() {
  const calls = { fillRect: [], strokeRect: [], fillText: [], moveTo: [], lineTo: [] };
  const ctx = {
    canvas: { width: 900, height: 500 },
    save() {}, restore() {}, beginPath() {}, stroke() {}, fill() {}, closePath() {},
    setLineDash() {}, clip() {}, roundRect() {}, arc() {}, translate() {}, scale() {},
    measureText: (s) => ({ width: String(s).length * 6 }),
    fillRect: (x, y, w, h) => calls.fillRect.push({ x, y, w, h }),
    strokeRect: (x, y, w, h) => calls.strokeRect.push({ x, y, w, h }),
    fillText: (t, x, y) => calls.fillText.push({ t: String(t), x, y }),
    moveTo: (x, y) => calls.moveTo.push({ x, y }),
    lineTo: (x, y) => calls.lineTo.push({ x, y }),
  };
  return { ctx, calls };
}

/** A day and a half of M15 bars, keyed the way norm() keys them. */
function makeRows(key) {
  const rows = [];
  const start = Date.UTC(2026, 9, 29, 0, 0, 0);
  for (let i = 0; i < 140; i++) {
    const iso = new Date(start + i * 15 * 60000).toISOString();
    rows.push({ [key]: iso, o: 1, h: 1.1, l: 0.9, c: 1.05 });
  }
  return rows;
}

function layout(rows) {
  const plotL = 50, plotR = 850, plotT = 20, plotB = 470;
  const bw = (plotR - plotL) / rows.length;
  return { rows, plotL, plotR, plotT, plotB, bw, xOf: (i) => plotL + i * bw + bw / 2 };
}

function paint(key) {
  const { ctx, calls } = recorder();
  const c = Object.create(CandleChart.prototype);
  c.sessions = true;
  c.ctx = ctx;
  const L = layout(makeRows(key));
  c.paintSessions(L);
  return { calls, L };
}

/* ------------------------------------------------------------ it draws */

const run = paint("t");

ok(run.calls.fillRect.length > 50,
  `the session bands are painted (${run.calls.fillRect.length} fills)`);

const names = MARKET_SESSIONS.map((s) => s.label);
const labels = run.calls.fillText.map((f) => f.t).filter((t) => names.some((n) => t.startsWith(n)));
ok(labels.length > 0, `the open/close marks are labelled (${labels.length} chips: ${labels.slice(0, 4).join(", ")})`);

/* Both ends, not just one: a session that opens off-screen still closes. */
const hasOpen = labels.some((t) => MARKET_SESSIONS.some((s) => t === `${s.label} ${String(s.open).padStart(2, "0")}:00`));
const hasClose = labels.some((t) => MARKET_SESSIONS.some((s) => t === `${s.label} ${String(s.close).padStart(2, "0")}:00`));
ok(hasOpen && hasClose, `both an open and a close are marked (open ${hasOpen}, close ${hasClose})`);

/* The regression itself: rows are keyed `t`, and that must be the key
   that works. Reading `.time` produced Invalid Date and silence. */
const viaTime = paint("time");
ok(viaTime.calls.fillText.length > 0,
  "a row keyed `time` still works, so raw bars are not broken by the fix");

/* --------------------------------------------- and the labels are legible */

/* Chips are the 13px-high filled rects; the bands are full plot height.
   Only the fills: a close chip is a fill AND a stroke at the same place,
   so counting both would report every close as overlapping itself. */
const chips = run.calls.fillRect.filter((r) => r.h === 13 && r.w > 10);
ok(chips.length >= 2, `there are label chips to check (${chips.length})`);

let clashes = [];
for (let i = 0; i < chips.length; i++) {
  for (let j = i + 1; j < chips.length; j++) {
    const a = chips[i], b = chips[j];
    if (a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y) {
      clashes.push(`(${Math.round(a.x)},${Math.round(a.y)}) over (${Math.round(b.x)},${Math.round(b.y)})`);
    }
  }
}
ok(clashes.length === 0,
  `no two session labels overlap (${clashes.slice(0, 3).join("; ") || chips.length + " chips, all clear"})`);

/* Nothing may be drawn when the feature is off - it is a preference. */
const offRun = (() => {
  const { ctx, calls } = recorder();
  const c = Object.create(CandleChart.prototype);
  c.sessions = false; c.ctx = ctx;
  c.paintSessions(layout(makeRows("t")));
  return calls;
})();
ok(offRun.fillRect.length === 0 && offRun.fillText.length === 0,
  "switching sessions off draws nothing at all");

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
