/**
 * Reading the two charts a backtest leaves behind.
 *
 * Asked for, in these words: on the equity curve, hovering - or
 * touching, on a phone - any point should show the equity and the
 * profit or loss there; on the chart above it, every trade should be
 * marked, and hovering or touching an entry or an exit should draw a
 * box around the stretch that trade was running for; and that chart
 * should be turnable to its beginning and its end.
 *
 * Both charts are canvases, so the checks drive the real drawing and
 * the real listeners against a recording context rather than reading
 * the source. A grep would pass for the whole life of the bug.
 *
 *     node tests/backtest-read-charts.test.js
 */

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const SRC = fs.readFileSync(path.join(ROOT, "apps", "web", "js", "app.js"), "utf8");
const CSS = fs.readFileSync(path.join(ROOT, "apps", "web", "css", "app.css"), "utf8");
const PACKS = ["en", "fa", "ar"].map((c) => [c, JSON.parse(fs.readFileSync(path.join(ROOT, "lang", c + ".json"), "utf8"))]);

let fails = 0;
const ok = (c, m) => { if (!c) { fails += 1; console.log("FAIL " + m); } else console.log("ok   " + m); };

function grab(name) {
  let i = SRC.indexOf("function " + name + "(");
  if (i < 0) throw new Error("missing " + name);
  if (SRC.slice(i - 6, i) === "async ") i -= 6;
  const j = SRC.indexOf("{", i);
  let d = 0;
  for (let k = j; k < SRC.length; k += 1) {
    if (SRC[k] === "{") d += 1;
    else if (SRC[k] === "}") { d -= 1; if (!d) return SRC.slice(i, k + 1); }
  }
  throw new Error("unterminated " + name);
}
const konst = (name) => {
  const m = SRC.match(new RegExp("const " + name + " = ([^;]+);"));
  if (!m) throw new Error("missing const " + name);
  return "const " + name + " = " + m[1] + ";";
};

/* ------------------------------------------------- a recording canvas */

function makeCtx() {
  const calls = [];
  const rec = (name) => (...a) => { calls.push({ name, a }); };
  return {
    calls,
    setTransform: rec("setTransform"), clearRect: rec("clearRect"),
    beginPath: rec("beginPath"), moveTo: rec("moveTo"), lineTo: rec("lineTo"),
    closePath: rec("closePath"), stroke: rec("stroke"), fill: rec("fill"),
    fillRect: rec("fillRect"), strokeRect: rec("strokeRect"), arc: rec("arc"),
    // The equity curve fills its profit and loss halves separately,
    // each clipped to its own side of the starting line.
    rect: rec("rect"), clip: rec("clip"),
    setLineDash: rec("setLineDash"), save: rec("save"), restore: rec("restore"),
    fillText: rec("fillText"),
    createLinearGradient: () => ({ addColorStop() {} }),
  };
}

function makeHost() {
  const kids = [];
  return {
    clientWidth: 600, clientHeight: 240, kids,
    querySelector(sel) { return kids.find((k) => ("." + k.className).includes(sel)) || null; },
    appendChild(el) { kids.push(el); return el; },
  };
}

function makeCanvas(host) {
  const ctx = makeCtx();
  const listeners = {};
  return {
    ctx, listeners, dataset: {}, style: {}, width: 0, height: 0,
    parentElement: host,
    getContext: () => ctx,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 600, height: 240 }),
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    setPointerCapture() {}, releasePointerCapture() {},
    fire(type, ev) { for (const fn of listeners[type] || []) fn({ preventDefault() {}, pointerId: 1, pointerType: "mouse", ...ev }); },
  };
}

/* ------------------------------------------------------ the sandbox */

const NAMES = [
  "btDoneMarks", "btPannableBars", "btReplayView", "btResetReplayView",
  "btPanReplay", "btZoomReplay", "btMarkAt", "btCurveIndexAt",
  "btTip", "btPlaceTip", "btPaintReplayTip", "btPaintCurveTip",
  "btBindReplay", "btBindCurve", "drawReplayChart", "drawEquityCurve",
  "btSide", "btWhy", "btWhen", "btPips",
];

const stub = `
  const I18N = { lang: "en", locale: () => "en-GB", t: (k) => k };
  const esc = (x) => String(x == null ? "" : x);
  const fmt = (v, d = 2) => Number(v || 0).toFixed(d);
  const clsPnl = (n) => (Number(n) > 0 ? "up" : Number(n) < 0 ? "down" : "");
  const price = (v) => Number(v || 0).toFixed(5);
  const dpForPrice = () => 5;
  const S = { backtest: { symbol: "EURUSD", timeframe: "M15", pip_size: 0.0001 } };
  const window = { devicePixelRatio: 1 };
  const requestAnimationFrame = (f) => { f(); return 1; };
  const getComputedStyle = () => ({ getPropertyValue: () => "#26d07c" });
  let canvases = {};
  const $ = (id) => canvases[id] || null;
  const document = {
    createElement: () => ({
      className: "", hidden: true, style: {}, innerHTML: "",
      offsetWidth: 150, offsetHeight: 60,
    }),
  };
  const setCanvas = (id, cv) => { canvases[id] = cv; };
`;

const api = new Function(
  stub + NAMES.map(grab).join("\n") + "\n"
  + konst("BT_REPLAY_SPAN") + "\n" + konst("BT_REPLAY_MIN_SPAN") + "\n"
  + "return { S, setCanvas, " + NAMES.join(", ") + " };"
)();

/* ------------------------------------------------------- fixtures */

const bar = (i) => ({
  t: "2026-01-" + String(1 + Math.floor(i / 24)).padStart(2, "0") + " " + String(i % 24).padStart(2, "0") + ":00:00",
  o: 1.1 + i * 0.001, h: 1.1 + i * 0.001 + 0.002, l: 1.1 + i * 0.001 - 0.002, c: 1.1 + i * 0.001 + 0.0005,
});
const ALL = [];
for (let i = 0; i < 480; i += 1) ALL.push(bar(i));

const run = {
  symbol: "EURUSD", timeframe: "M15", ok: true, running: false,
  pip_size: 0.0001,
  data: { first_bar: ALL[0].t, last_bar: ALL[ALL.length - 1].t },
  trades: [],
};
for (let i = 0; i < 90; i += 1) {
  const a = i * 5, b = a + 3;
  run.trades.push({
    time: ALL[a].t, exit_time: ALL[b].t, type: i % 2 ? "sell" : "buy",
    volume: 0.1, entry: ALL[a].c, exit: ALL[b].c,
    profit: i % 3 ? 12.5 : -7.25, pips: i % 3 ? 12.5 : -7.25, exit_reason: "tp",
  });
}

/* ------------------------------------------- 1. every trade is marked */

const marks = api.btDoneMarks(run);
ok(marks.length === run.trades.length * 2,
  `every trade contributes an entry and an exit (${marks.length} marks for ${run.trades.length} trades)`);
ok(!/slice\(-60\)/.test(grab("btDoneMarks")),
  "the chart is no longer limited to the last sixty trades");
ok(marks.every((m) => m.id != null && m.inT && m.outT),
  "each mark knows the trade it belongs to, and both of its ends");
{
  const open = api.btDoneMarks({ trades: [{ time: ALL[0].t, type: "buy", entry: 1.1 }] });
  ok(open.length === 1 && open[0].kind === "in" && open[0].open === true,
    "a trade still running is marked as an entry with no close");
}

/* ------------------------------- 2. the whole tested window is reachable */

api.S._btBars = { key: "EURUSD|M15", pending: false, bars: ALL };
const pannable = api.btPannableBars(run, ALL.slice(-160));
ok(pannable.length === ALL.length,
  `a finished run can be turned through its whole window (${pannable.length} bars)`);
{
  const clipped = api.btPannableBars(
    { ...run, data: { first_bar: ALL[100].t, last_bar: ALL[300].t } }, ALL.slice(-160));
  ok(clipped.length === 201 && clipped[0].t === ALL[100].t && clipped[200].t === ALL[300].t,
    "and only through the window that was actually tested");
  api.S._btBars = null;
  ok(api.btPannableBars(run, ALL.slice(-20)).length === 20,
    "with no candles of its own it falls back to the frozen frame");
  api.S._btBars = { key: "EURUSD|M15", pending: false, bars: ALL };
}

/* ------------------------------------------- 3. drawing, panning, zoom */

const host = makeHost();
const cv = makeCanvas(host);
api.setCanvas("bt-replay", cv);
api.S._btReplay = { bars: pannable, marks };
api.btResetReplayView("EURUSD|M15|x|" + pannable.length);
api.drawReplayChart(pannable, marks);

let geom = api.S._btGeom;
ok(geom && geom.total === ALL.length, "the chart remembers how long the run is");
ok(geom.count < geom.total, `it draws a slice, not all ${geom.total} bars at once (${geom.count})`);
ok(geom.marks.length > 0 && geom.marks.length < marks.length,
  "only the marks inside that slice are placed");
ok(cv.dataset.btBound === "1", "the canvas is wired for a pointer");
ok(Object.keys(cv.listeners).includes("pointerdown") && Object.keys(cv.listeners).includes("pointermove"),
  "with pointer events, so a finger and a mouse are the same gesture");

{
  // The newest bar is on screen before anything is dragged.
  const last = geom.start + geom.count;
  ok(last === ALL.length, "it opens at the end of the run");
  const moved = api.btPanReplay(-200);
  api.drawReplayChart(pannable, marks);
  ok(moved && api.S._btGeom.start < geom.start, "dragging back moves the window into the past");
  // All the way to the first bar, and no further.
  api.btPanReplay(-99999);
  api.drawReplayChart(pannable, marks);
  ok(api.S._btGeom.start === 0, "it reaches the very first bar of the run");
  ok(api.btPanReplay(-50) === false, "and refuses to go past it");
  api.btPanReplay(99999);
  api.drawReplayChart(pannable, marks);
  ok(api.S._btGeom.start + api.S._btGeom.count === ALL.length, "and back to the very last");
  ok(api.btPanReplay(50) === false, "and refuses to go past that either");
}

{
  const before = api.S._btGeom.count;
  api.btZoomReplay(2);
  api.drawReplayChart(pannable, marks);
  ok(api.S._btGeom.count > before, "zooming out shows more of the run");
  api.btZoomReplay(0.01);
  api.drawReplayChart(pannable, marks);
  ok(api.S._btGeom.count >= 2, "and zooming in never collapses the chart to nothing");
  api.S._btView = null;
  api.drawReplayChart(pannable, marks);
}

/* --------------------------------- 4. hovering a trade outlines it */

{
  const m = api.S._btGeom.marks.find((x) => x.kind === "in" && x.outT);
  ok(Boolean(m), "there is an entry on screen to point at");

  const plain = cv.ctx.calls.length;
  cv.ctx.calls.length = 0;
  cv.fire("pointermove", { clientX: m.x, clientY: m.y });
  ok(api.S._btHover && api.S._btHover.id === m.id, "pointing at an entry picks up its trade");

  const rects = cv.ctx.calls.filter((c) => c.name === "fillRect");
  const dashed = cv.ctx.calls.filter((c) => c.name === "strokeRect");
  ok(rects.length > 0 && dashed.length > 0,
    "a box is drawn around the stretch the trade was running for");
  const band = rects.find((r) => r.a[2] > 2);
  ok(Boolean(band), "the box spans more than a single bar");
  ok(plain > 0, "and the ordinary chart was drawn without one");

  const tip = host.kids.find((k) => k.className === "bt-tip");
  ok(tip && !tip.hidden, "a panel says which trade it is");
  ok(/bt\.t_entry/.test(tip.innerHTML) && /bt\.t_exit/.test(tip.innerHTML) && /bt\.t_pnl/.test(tip.innerHTML),
    "naming its entry, its exit and what it made");

  /* The exit of the same trade must answer identically - the request
     was "when I hover the entry OR the end of it". */
  const out = api.S._btGeom.marks.find((x) => x.kind === "out" && x.id === m.id);
  if (out) {
    cv.fire("pointermove", { clientX: out.x, clientY: out.y });
    ok(api.S._btHover && api.S._btHover.id === m.id, "and so does its exit");
  } else {
    ok(true, "and so does its exit (not in this slice)");
  }

  // Empty space is not a trade.
  cv.fire("pointermove", { clientX: 2, clientY: 2 });
  ok(api.S._btHover === null, "pointing at nothing clears it");
  const gone = host.kids.find((k) => k.className === "bt-tip");
  ok(gone.hidden === true, "and puts the panel away");
}

{
  /* A touch keeps its answer: a finger has nowhere to hover, so
     lifting it must not wipe what it was asking about. */
  const m = api.S._btGeom.marks.find((x) => x.kind === "in" && x.outT);
  cv.fire("pointerdown", { clientX: m.x, clientY: m.y, pointerType: "touch" });
  ok(api.S._btHover && api.S._btHover.id === m.id, "a touch selects the trade under it");
  cv.fire("pointerup", { clientX: m.x, clientY: m.y, pointerType: "touch" });
  ok(api.S._btHover && api.S._btHover.id === m.id, "and lifting the finger keeps it on screen");
  cv.fire("pointerleave", { pointerType: "touch" });
  ok(api.S._btHover !== null, "a touch leaving the canvas does not wipe it either");
  cv.fire("pointerleave", { pointerType: "mouse" });
  ok(api.S._btHover === null, "but a mouse leaving means the question is over");
}

{
  /* A drag is a drag, not a tap: moving the chart must not also
     select whatever happened to be under the finger when it landed. */
  api.S._btView = null;
  api.drawReplayChart(pannable, marks);
  const startAt = api.S._btGeom.start;
  cv.fire("pointerdown", { clientX: 400, clientY: 100, pointerType: "touch" });
  cv.fire("pointermove", { clientX: 460, clientY: 100, pointerType: "touch" });
  cv.fire("pointermove", { clientX: 520, clientY: 100, pointerType: "touch" });
  cv.fire("pointerup", { clientX: 520, clientY: 100, pointerType: "touch" });
  ok(api.S._btGeom.start < startAt, "dragging with a finger moves through the window");
}

{
  // A new run must not inherit the last one's scroll position.
  api.btPanReplay(-100);
  api.btResetReplayView("XAUUSD|M15|y|" + pannable.length);
  ok(api.S._btView === null && api.S._btHover === null,
    "a different run opens at its own end with nothing selected");
}

/* --------------------------------- 5. the equity curve answers a point */

{
  const curve = [];
  for (let i = 0; i < 300; i += 1) curve.push(10000 + i * 3 - (i % 17) * 11);
  const chost = makeHost();
  const ccv = makeCanvas(chost);
  api.setCanvas("bt-curve", ccv);
  api.S._btCurveAt = null;
  api.drawEquityCurve(curve);
  ok(ccv.dataset.btBound === "1", "the curve is wired for a pointer too");

  const tipBefore = chost.kids.find((k) => k.className === "bt-tip");
  ok(!tipBefore || tipBefore.hidden, "and says nothing until it is asked");

  ccv.fire("pointermove", { clientX: 300, clientY: 80 });
  const at = api.S._btCurveAt;
  ok(Number.isFinite(at) && at > 0 && at < curve.length, `a point on the curve is identified (${at})`);
  const tip = chost.kids.find((k) => k.className === "bt-tip");
  ok(tip && !tip.hidden, "the panel appears");
  ok(/bt\.tip_equity/.test(tip.innerHTML), "stating the equity at that point");
  ok(/bt\.tip_pnl/.test(tip.innerHTML), "and the profit or loss there");
  ok(tip.innerHTML.includes(curve[at].toFixed(2)), "the equity is the figure the run reported, not an interpolation");
  const pnl = curve[at] - curve[0];
  ok(tip.innerHTML.includes((pnl > 0 ? "+" : "") + pnl.toFixed(2)),
    "and the profit is measured from where the run started");

  // Ends are reachable: the first and the last point, not just the middle.
  ok(api.btCurveIndexAt(0) === 0, "the far left is the first point of the run");
  ok(api.btCurveIndexAt(10000) === curve.length - 1, "the far right is its last");

  ccv.fire("pointerdown", { clientX: 120, clientY: 90, pointerType: "touch" });
  ok(api.S._btCurveAt !== at, "a touch reads the curve where it lands");
  ccv.fire("pointerleave", { pointerType: "touch" });
  ok(api.S._btCurveAt !== null, "and keeps the answer when the finger lifts");
  ccv.fire("pointerleave", { pointerType: "mouse" });
  ok(api.S._btCurveAt === null, "a mouse leaving clears it");

  // A different run's curve must not be read at the old index.
  api.S._btCurveAt = 250;
  api.drawEquityCurve(curve.slice(0, 40));
  ok(api.S._btCurveAt === null, "a new curve starts unasked rather than at a stale point");
}

/* -------------------------------------------- 6. styling and language */

ok(/\.bt-tip\{/.test(CSS), "the panel is styled");
ok(/\.bt-tip\[hidden\]\{\s*display:none\s*\}/.test(CSS.replace(/\s+/g, " ")),
  "and is really hidden when it has nothing to say");
ok(/\.bt-tip\{[^}]*pointer-events:none/.test(CSS),
  "it never eats the pointer it exists to answer");
ok(/\.bt-live-chart canvas\{[^}]*touch-action:pan-y/.test(CSS),
  "the replay chart leaves vertical scrolling to the page on a phone");
ok(/\.bt-curve canvas\{[^}]*touch-action:pan-y/.test(CSS),
  "and so does the curve");
ok(/\.bt-live-chart canvas\{[^}]*cursor:grab/.test(CSS),
  "the replay chart looks draggable");

const keys = ["tip_equity", "tip_pnl", "tip_point", "tip_open", "tip_when", "curve_hover_hint", "replay_hover_hint"];
for (const [code, pack] of PACKS) {
  const missing = keys.filter((k) => !pack.bt || !pack.bt[k]);
  ok(missing.length === 0, `${code} translates the new text (${missing.join(", ") || "all present"})`);
}
ok(!/EURUSD|XAUUSD|GBPUSD/i.test(JSON.stringify(PACKS.map(([, p]) => p.bt))),
  "none of it names an instrument");

console.log(fails ? `\nbacktest-read-charts: ${fails} failed` : "\nbacktest-read-charts: all good");
process.exit(fails ? 1 : 0);
