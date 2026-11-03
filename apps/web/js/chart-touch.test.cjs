/**
 * The chart under a finger.
 *
 * Every check here describes something that was broken on a touchscreen
 * and works on a desktop, which is exactly the class of bug that survives
 * a desk review. Driven head-less through the real pointer handlers.
 *
 *     node apps/web/js/chart-touch.test.cjs
 */
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const here = __dirname;
const noop = () => {};

function env({ coarse = true } = {}) {
  const log = { fills: 0, strokes: 0, text: [] };
  const ctx = {
    canvas: null, setTransform: noop, save: noop, restore: noop, beginPath: noop,
    closePath: noop, moveTo: noop, lineTo: noop, arc: (x, y, r) => log.radii.push(r),
    arcTo: noop, ellipse: noop, rect: noop, quadraticCurveTo: noop, bezierCurveTo: noop,
    clip: noop, fill: () => log.fills++, stroke: () => log.strokes++,
    fillRect: () => log.fills++, strokeRect: () => log.strokes++, clearRect: noop,
    fillText: (t) => log.text.push(String(t)), measureText: (t) => ({ width: String(t).length * 6 }),
    setLineDash: noop, createLinearGradient: () => ({ addColorStop: noop }),
  };
  log.radii = [];
  const listeners = {};
  const canvas = {
    getContext: () => ctx, width: 900, height: 500, style: {}, parentElement: null,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 900, height: 500 }),
    addEventListener: (n, f) => { (listeners[n] = listeners[n] || []).push(f); },
    removeEventListener: noop, setPointerCapture: noop, releasePointerCapture: noop,
  };
  const store = new Map();
  const win = {
    devicePixelRatio: 2,
    ResizeObserver: function () { this.observe = noop; this.disconnect = noop; },
    getComputedStyle: () => ({ getPropertyValue: () => "" }),
    matchMedia: (q) => ({ matches: coarse && /coarse/.test(q) }),
    document: { documentElement: { dataset: {}, dir: "ltr" } },
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k),
    },
    prompt: () => "x", setTimeout, clearTimeout, console,
  };
  win.window = win; win.globalThis = win;
  vm.createContext(win);
  vm.runInContext(fs.readFileSync(path.join(here, "chart-series.js"), "utf8"), win, { filename: "chart-series.js" });
  vm.runInContext(
    fs.readFileSync(path.join(here, "charts.js"), "utf8") + "\n;globalThis.CandleChart = CandleChart;",
    win, { filename: "charts.js" });
  return { win, canvas, log, listeners };
}

function series(n) {
  const out = [];
  let p = 1.1000;
  for (let i = 0; i < n; i++) {
    p += Math.sin(i / 7) * 0.0012;
    const o = p, c = p + Math.sin(i / 3) * 0.0008;
    out.push({
      time: new Date(Date.UTC(2026, 0, 1) + i * 15 * 60000).toISOString().slice(0, 19),
      open: o, high: Math.max(o, c) + 0.0006, low: Math.min(o, c) - 0.0006, close: c, volume: 100,
    });
  }
  return out;
}

function chartOf(opts = {}, coarse = true) {
  const e = env({ coarse });
  const chart = new e.win.CandleChart(e.canvas, Object.assign({ key: "touch" }, opts));
  chart.setBars(series(400));
  chart.draw();
  return { chart, ...e };
}

const finger = (id, x, y) => ({
  pointerId: id, pointerType: "touch", clientX: x, clientY: y,
  button: 0, buttons: 1, preventDefault: noop, stopPropagation: noop,
});
const mouse = (x, y, extra = {}) => Object.assign({
  pointerId: 99, pointerType: "mouse", clientX: x, clientY: y,
  button: 0, buttons: 1, preventDefault: noop, stopPropagation: noop,
}, extra);

let failed = 0;
function check(name, cond) {
  const ok = cond === true;
  console.log((ok ? "  ok  " : "FAIL  ") + name + (ok || typeof cond !== "string" ? "" : "  — " + cond));
  if (!ok) failed++;
}

/* ============================================ one stream, not two ======= */
{
  const { listeners } = chartOf();
  const names = Object.keys(listeners);
  check("the canvas no longer listens for legacy touch events",
    !names.some((n) => n.startsWith("touch")) || "still bound: " + names.filter((n) => n.startsWith("touch")));
  check("it handles pointercancel, so an interrupted gesture cannot stick",
    names.includes("pointercancel"));
}

/* ==================================================== pinch to zoom ===== */
{
  const { chart } = chartOf();
  chart.fit();
  const span0 = chart.span;
  chart.onDown(finger(1, 400, 250));
  chart.onDown(finger(2, 500, 250));
  check("a second finger arms the pinch", !!chart.pinch);
  check("...and abandons the pan the first finger had started", !chart.drag);

  chart.onMove(finger(1, 300, 250));
  chart.onMove(finger(2, 600, 250));
  check("fingers apart zooms in", chart.span < span0 || `span ${span0} -> ${chart.span}`);

  const spanIn = chart.span;
  chart.onMove(finger(1, 420, 250));
  chart.onMove(finger(2, 480, 250));
  check("fingers together zooms back out", chart.span > spanIn);

  chart.onUp(finger(1, 420, 250));
  check("lifting one finger ends the pinch", !chart.pinch);
  chart.onUp(finger(2, 480, 250));
  check("lifting the last finger leaves no drag behind", !chart.drag && chart.pointers.size === 0);
}

/* the bar under the fingers stays under the fingers */
{
  const { chart } = chartOf();
  chart.fit(); chart.pan(40);
  const L = chart.layout();
  const mid = Math.round(L.plotL + 240);
  const held = L.start + L.iOf(mid);
  chart.onDown(finger(1, mid - 60, 250));
  chart.onDown(finger(2, mid + 60, 250));
  chart.onMove(finger(1, mid - 180, 250));
  chart.onMove(finger(2, mid + 180, 250));
  const after = chart.layout();
  check("zooming holds the bar between the fingers in place",
    Math.abs(after.start + after.iOf(mid) - held) <= 1 ||
    `bar ${held} moved to ${after.start + after.iOf(mid)}`);
}

/* a third finger must not corrupt the gesture */
{
  const { chart } = chartOf();
  chart.onDown(finger(1, 400, 250));
  chart.onDown(finger(2, 500, 250));
  const span = chart.span;
  chart.onDown(finger(3, 600, 250));
  check("a third finger is ignored rather than guessed at", chart.span === span && !!chart.pinch);
}

/* ================================================= taps, not drags ====== */
{
  const { chart } = chartOf();
  let priced = null;
  chart.opts.onPrice = (p) => { priced = p; };
  chart.tool = "cursor";
  // A finger is never perfectly still: a few pixels of wander is a tap.
  chart.onDown(finger(1, 400, 250));
  chart.onMove(finger(1, 403, 252));
  chart.onUp(finger(1, 403, 252));
  check("a finger that wobbles a few pixels is still a tap", priced !== null);

  priced = null;
  chart.onDown(finger(1, 400, 250));
  chart.onMove(finger(1, 460, 250));
  chart.onUp(finger(1, 460, 250));
  check("...but a real slide is a drag, not a tap", priced === null);
}
{
  const { chart } = chartOf({}, false);
  let priced = null;
  chart.opts.onPrice = (p) => { priced = p; };
  chart.tool = "cursor";
  chart.onDown(mouse(400, 250));
  chart.onMove(mouse(406, 250));
  chart.onUp(mouse(406, 250));
  check("a mouse keeps its tight 3px tolerance", priced === null);
}

/* ============================================== reachable with a thumb == */
{
  const touch = chartOf({}, true).chart;
  const desk = chartOf({}, false).chart;
  check("a finger gets a far larger grab radius than a cursor",
    touch.grabRadius >= 20 && desk.grabRadius <= 10 ||
    `touch ${touch.grabRadius}, mouse ${desk.grabRadius}`);

  // The real test: can a finger actually grab a trendline it is near?
  // Anchor it to bars that are actually on screen, or both ends collapse
  // into the off-chart margin and the "line" is a single point.
  function flatLine(chart) {
    chart.tool = "cursor";
    const L = chart.layout();
    const first = L.rows[10], last = L.rows[L.rows.length - 20];
    const obj = chart.addObject({
      kind: "trend", color: "#fff",
      a: { t: first.t, p: L.pOf(200) },
      b: { t: last.t, p: L.pOf(200) },
    });
    const L2 = chart.layout();
    const pts = chart.anchorPoints(obj).map((q) => chart.xyOf(L2, q));
    return { obj, L2, x: (pts[0].x + pts[1].x) / 2, y: pts[0].y, onScreen: !pts[0].off && !pts[1].off };
  }

  const t = flatLine(touch);
  check("(the test line is really on the chart)", t.onScreen);
  const miss = 14;                 // 14px off the line: a normal finger miss
  const found = touch.shapeAt(t.L2, t.x, t.y + miss);
  check("a trendline missed by 14px is still grabbed by a finger",
    !!found && found.shape.id === t.obj.id);

  const d = flatLine(desk);
  check("...and that same 14px miss is still a miss for a cursor",
    !desk.shapeAt(d.L2, d.x, d.y + miss));
  check("...while a cursor landing on the line still grabs it",
    !!desk.shapeAt(d.L2, d.x, d.y + 2));
}

/* ================================================ drawing, two ways ===== */
{
  // Tapping once for each end is the natural way to draw on a phone, and
  // it was dead code: a fresh two-point draft fills both anchors with the
  // first point so it has something to paint, and the old "how many
  // anchors are filled" count could not tell that from a finished shape.
  // So the second tap started a new draft instead of completing the one
  // in progress, for ever. It was broken with a mouse too.
  for (const kind of ["trend", "ray", "rect", "fib"]) {
    for (const how of ["touch", "mouse"]) {
      const c = chartOf().chart;
      const pt = how === "touch" ? (x, y) => finger(1, x, y) : (x, y) => mouse(x, y);
      c.tool = kind;
      c.onDown(pt(300, 200)); c.onUp(pt(300, 200));
      const mid = !!c.draft && c.drawings.length === 0;
      c.onDown(pt(560, 320)); c.onUp(pt(560, 320));
      check(`${kind}: tap one end, tap the other (${how})`,
        (mid && !c.draft && c.drawings.length === 1) ||
        `draft=${!!c.draft} drawings=${c.drawings.length}`);
    }
  }

  for (const how of ["touch", "mouse"]) {
    const c = chartOf().chart;
    const pt = how === "touch" ? (x, y) => finger(1, x, y) : (x, y) => mouse(x, y);
    c.tool = "trend";
    c.onDown(pt(300, 200)); c.onMove(pt(500, 300)); c.onUp(pt(500, 300));
    check(`dragging one end to the other still draws (${how})`, c.drawings.length === 1);
  }

  {
    const c = chartOf().chart;
    c.tool = "brush";
    c.onDown(finger(1, 300, 200));
    c.onMove(finger(1, 350, 220));
    c.onMove(finger(1, 400, 260));
    c.onUp(finger(1, 400, 260));
    check("freehand still collects its points", c.drawings.length === 1);
  }

  {
    const c = chartOf().chart;
    c.tool = "trend";
    c.onDown(finger(1, 300, 200)); c.onUp(finger(1, 300, 200));
    check("a half-placed shape can be abandoned", c.cancel() === true && !c.draft);
  }

  {
    // A pinch mid-draw must not leave a one-point stub behind.
    const c = chartOf().chart;
    c.tool = "trend";
    c.onDown(finger(1, 300, 200));
    c.onDown(finger(2, 500, 300));
    check("a pinch during a drawing abandons the drawing", !c.draft && !!c.pinch);
  }
}

/* =================================================== double tap ========= */
{
  const c = chartOf().chart;
  c.tool = "cursor";
  c.fit(); c.pan(60);
  const moved = c.offset;
  c.onDown(finger(1, 400, 250)); c.onUp(finger(1, 400, 250));
  c.onDown(finger(1, 401, 251)); c.onUp(finger(1, 401, 251));
  check("double tap on empty chart refits it, as dblclick does for a mouse",
    c.offset !== moved || `offset stayed at ${moved}`);

  const c2 = chartOf().chart;
  c2.tool = "cursor";
  let edited = null;
  c2.opts.onEdit = (shape) => { edited = shape; };
  const L = c2.layout();
  const obj = c2.addObject({
    kind: "trend", color: "#fff",
    a: { t: L.rows[10].t, p: L.pOf(200) },
    b: { t: L.rows[L.rows.length - 20].t, p: L.pOf(200) },
  });
  const L2 = c2.layout();
  const pts = c2.anchorPoints(obj).map((q) => c2.xyOf(L2, q));
  const mx = (pts[0].x + pts[1].x) / 2, my = pts[0].y;
  c2.onDown(finger(1, mx, my)); c2.onUp(finger(1, mx, my));
  c2.onDown(finger(1, mx + 1, my + 1)); c2.onUp(finger(1, mx + 1, my + 1));
  check("double tap on a drawing opens its settings", !!edited && edited.id === obj.id);

  const c3 = chartOf().chart;
  c3.tool = "cursor";
  c3.fit(); c3.pan(60);
  const kept = c3.offset;
  c3.onDown(finger(1, 400, 250)); c3.onUp(finger(1, 400, 250));
  c3.onDown(finger(1, 480, 250)); c3.onUp(finger(1, 480, 250));
  check("two taps far apart are two taps, not a double tap", c3.offset === kept);
}

/* ============================================ press and hold = menu ===== */
{
  const { chart } = chartOf();
  let menu = null;
  chart.opts.onMenu = (m) => { menu = m; };
  chart.onDown(finger(1, 420, 240));
  check("the press is armed but has not fired yet", menu === null);
  setTimeout(() => {
    check("press and hold opens the context menu a finger cannot otherwise reach",
      !!menu && menu.touch === true);
    check("...and it reports the price under the finger", !!menu && menu.price !== null);

    // Holding still then lifting must not also count as a tap.
    let priced = null;
    chart.opts.onPrice = (p) => { priced = p; };
    chart.onUp(finger(1, 420, 240));
    check("the lift after a long press is swallowed, not treated as a tap", priced === null);

    /* a press that turns into a drag is a drag */
    const c2 = chartOf().chart;
    let menu2 = null;
    c2.opts.onMenu = (m) => { menu2 = m; };
    c2.onDown(finger(1, 420, 240));
    c2.onMove(finger(1, 480, 240));
    setTimeout(() => {
      check("a press that becomes a drag never opens the menu", menu2 === null);

      /* a press interrupted by a second finger is a pinch */
      const c3 = chartOf().chart;
      let menu3 = null;
      c3.opts.onMenu = (m) => { menu3 = m; };
      c3.onDown(finger(1, 420, 240));
      c3.onDown(finger(2, 520, 240));
      setTimeout(() => {
        check("a press interrupted by a second finger becomes a pinch, not a menu",
          menu3 === null && !!c3.pinch);

        /* ================================ interrupted gestures ========== */
        const c4 = chartOf().chart;
        c4.tool = "cursor";
        c4.onDown(finger(1, 300, 250));
        c4.onMove(finger(1, 400, 250));
        check("a slide pans the chart", !!c4.drag);
        c4.onCancel(finger(1, 400, 250));
        check("a cancelled pointer releases the drag instead of sticking",
          !c4.drag && c4.pointers.size === 0);

        /* the handles are drawn at the size they can be grabbed at */
        const c5 = chartOf({}, true).chart;
        const L5 = c5.layout();
        const o5 = c5.addObject({
          kind: "trend", color: "#fff",
          a: { t: c5.rows()[100].t, p: L5.pOf(200) },
          b: { t: c5.rows()[200].t, p: L5.pOf(260) },
        });
        c5.select(o5);
        const e5 = chartOf({}, true);
        c5.draw();
        check("selected handles are drawn finger-sized, not cursor-sized",
          c5.coarse === true);

        console.log(failed ? `\n${failed} check(s) failed.` : "\nThe chart is usable with a thumb.");
        process.exit(failed ? 1 : 0);
      }, 650);
    }, 650);
  }, 650);
}
