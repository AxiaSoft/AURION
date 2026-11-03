/**
 * Mobile sheet gestures.
 *
 * Two sheets - the settings jump list and the EA chart's drawing tools
 * - are opened and closed with the thumb. This pins the behaviour that
 * was asked for and, more importantly, the conditions that stop each
 * gesture from stealing somebody else's:
 *
 *   - a pull on the sheet's own surface only dismisses once its
 *     scrolling has run out, so a scroll is never hijacked;
 *   - an edge swipe only opens where the sheet exists, so it cannot
 *     quietly take over the bottom of a desktop chart;
 *   - a tool's menu is anchored to the tool, and goes when the sheet
 *     that owns it goes.
 *
 * The drag helper is lifted out of app.js and run for real against a
 * fake element, rather than grepped for: a check that looks for an
 * identifier passes just as happily when the logic behind it has been
 * deleted.
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const APP = fs.readFileSync(path.join(ROOT, "apps/web/js/app.js"), "utf8");
const TOOLS = fs.readFileSync(path.join(ROOT, "apps/web/js/chart-tools.js"), "utf8");
const CSS = fs.readFileSync(path.join(ROOT, "apps/web/css/chart.css"), "utf8");

let pass = 0;
const fails = [];
function check(name, fn) {
  try {
    const r = fn();
    if (r === false) throw new Error("returned false");
    pass++;
  } catch (e) {
    fails.push(name + ": " + e.message);
  }
}

/* ---------------------------------------------------------------- lift -- */

function liftFn(src, name) {
  let i = src.indexOf("function " + name + "(");
  if (i < 0) throw new Error("no function " + name);
  if (src.slice(Math.max(0, i - 6), i) === "async ") i -= 6;
  let d = 0, started = false, j = src.indexOf("{", i);
  for (let k = j; k < src.length; k++) {
    if (src[k] === "{") { d++; started = true; }
    else if (src[k] === "}") { d--; if (started && d === 0) return src.slice(i, k + 1); }
  }
  throw new Error("unbalanced " + name);
}

function constOf(src, name) {
  const m = new RegExp("const " + name + "\\s*=\\s*([^;]+);").exec(src);
  if (!m) throw new Error("no const " + name);
  return m[1].trim();
}

/* A DOM element with just enough behaviour for the helpers. */
function el(extra) {
  const o = Object.assign({
    style: {}, dataset: {}, scrollTop: 0, offsetHeight: 400,
    classList: {
      _s: new Set(),
      add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); },
      contains(c) { return this._s.has(c); },
      toggle(c, v) { v ? this.add(c) : this.remove(c); },
    },
    _h: {},
    addEventListener(t, fn) { (this._h[t] = this._h[t] || []).push(fn); },
    setPointerCapture() {}, releasePointerCapture() {},
    getBoundingClientRect() { return { top: 0, bottom: 800, left: 0, right: 390, width: 390, height: 800 }; },
    fire(t, e) { (this._h[t] || []).forEach((fn) => fn(e)); },
  }, extra || {});
  return o;
}

function sandbox(src, names) {
  const ctx = {
    window: { matchMedia: () => ({ matches: true }), innerHeight: 800 },
    document: { documentElement: { dir: "ltr" } },
    setTimeout() {}, Math, Date, String, Object, Number, console,
  };
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  return names.map((n) => ctx[n]);
}

const DRAG_SRC =
  "const SHEET_PULL_UP_MAX = " + constOf(APP, "SHEET_PULL_UP_MAX") + ";\n" +
  "const SHEET_DRAG_ARM = " + constOf(APP, "SHEET_DRAG_ARM") + ";\n" +
  "const SHEET_EDGE_BAND = " + constOf(APP, "SHEET_EDGE_BAND") + ";\n" +
  "const SHEET_EDGE_PULL = " + constOf(APP, "SHEET_EDGE_PULL") + ";\n" +
  liftFn(APP, "attachSheetDrag") + "\n" +
  liftFn(APP, "attachSheetEdgeOpen") + "\n";

const [attachSheetDrag, attachSheetEdgeOpen] =
  sandbox(DRAG_SRC, ["attachSheetDrag", "attachSheetEdgeOpen"]);

/* ------------------------------------------------- one implementation -- */

check("the drag helper is shared, not copied into each sheet", () => {
  const bodies = (APP.match(/dy > h \* 0\.25/g) || []).length;
  if (bodies !== 1) throw new Error(bodies + " copies of the dismissal test in app.js");
  if (/dy > h \* 0\.25/.test(TOOLS)) throw new Error("chart-tools.js has its own copy");
});

check("the chart tool sheet uses the shared helper", () => {
  if (!/attachSheetDrag\(\{/.test(TOOLS)) throw new Error("tool sheet never attaches a drag");
  if (!/handle: \$\("tv-rail-grab"\)/.test(TOOLS)) throw new Error("no grab handle passed");
  if (!/sheet: \$\("tv-rail"\)/.test(TOOLS)) throw new Error("the rail is not the sheet");
});

/* ------------------------------------------------------- the handle ---- */

check("the grab bar is a real element, not a ::before", () => {
  if (/\.tv-rail::before\s*\{/.test(CSS)) throw new Error("still a pseudo-element");
  if (!/<div class="tvr-grab" id="tv-rail-grab"/.test(TOOLS)) throw new Error("no handle in the markup");
});

check("the handle does not let the browser claim the gesture as a scroll", () => {
  /* There are two .tvr-grab rules - the base one that hides it on a
     desktop and the sheet one that makes it draggable - so every rule
     is examined, not just the first the regex happens to reach. */
  const rules = CSS.match(/\.tvr-grab\s*\{[^}]*\}/g) || [];
  if (!rules.length) throw new Error("no .tvr-grab rule at all");
  if (!rules.some((r) => /touch-action:\s*none/.test(r))) {
    throw new Error("no touch-action:none in any of the " + rules.length + " rules");
  }
});

check("the handle is hidden where the rail is a column, not a sheet", () => {
  if (!/\.tvr-grab \{ display: none \}/.test(CSS)) throw new Error("visible on the desktop rail");
});

/* --------------------------------------------------- dismissal rules --- */

function rig(opts) {
  const handle = el(), sheet = el(), scrim = el(), body = opts && opts.body ? el() : null;
  let closed = 0;
  const target = body || sheet;
  attachSheetDrag({
    handle, sheet: body ? target : sheet, scrim, body: body || undefined,
    isOpen: () => true, close: () => { closed++; },
  });
  return { handle, sheet: body ? target : sheet, body, scrim, closed: () => closed };
}

function drag(r, from, to, ms) {
  r.handle.fire("pointerdown", { clientY: from, pointerId: 1, timeStamp: 0 });
  r.handle.fire("pointermove", { clientY: to, pointerId: 1, timeStamp: ms });
  r.handle.fire("pointerup", { clientY: to, pointerId: 1, timeStamp: ms });
}

check("a long slow pull closes the sheet", () => {
  const r = rig();
  drag(r, 0, 300, 2000);          /* 300 > 400*0.25, no flick */
  if (r.closed() !== 1) throw new Error("did not close");
});

check("a short pull springs back instead of closing", () => {
  const r = rig();
  drag(r, 0, 40, 2000);           /* 40 < 400*0.25, slow */
  if (r.closed() !== 0) throw new Error("closed on a 40px nudge");
});

check("a fast flick closes even though it is short", () => {
  const r = rig();
  drag(r, 0, 60, 50);             /* 60px in 50ms */
  if (r.closed() !== 1) throw new Error("a flick did not close it");
});

check("the sheet follows the finger while it is held", () => {
  const r = rig();
  r.handle.fire("pointerdown", { clientY: 0, pointerId: 1, timeStamp: 0 });
  r.handle.fire("pointermove", { clientY: 90, pointerId: 1, timeStamp: 20 });
  if (!/translateY\(90/.test(r.sheet.style.transform || "")) {
    throw new Error("transform was " + r.sheet.style.transform);
  }
  if (!r.sheet.classList.contains("is-dragging")) throw new Error("not marked as dragging");
});

check("dragging upwards resists instead of doing nothing", () => {
  const r = rig();
  r.handle.fire("pointerdown", { clientY: 100, pointerId: 1, timeStamp: 0 });
  r.handle.fire("pointermove", { clientY: 0, pointerId: 1, timeStamp: 20 });
  const t = r.sheet.style.transform || "";
  const v = parseFloat(/translateY\((-?[\d.]+)/.exec(t)[1]);
  if (v >= 0) throw new Error("did not move upwards at all");
  if (v < -40) throw new Error("moved " + v + "px - that is not resistance");
});

check("and the resistance has an end to it", () => {
  /* "Resists" was checked at one distance, 100px, where the old
     unbounded rubber band happened to give 22px and looked fine. It
     was -sqrt(-raw) * 2.2 with no ceiling, so it never stopped
     giving: a 240px pull lifted the sheet 34px, a 1000px pull more
     again. Reported from a real phone as the sheet "coming further up
     the harder you drag". The distances below are the ones that show
     it. */
  const cap = Number(constOf(APP, "SHEET_PULL_UP_MAX"));
  if (!Number.isFinite(cap)) throw new Error("SHEET_PULL_UP_MAX is not a number");
  for (const pull of [240, 1000, 100000]) {
    const r = rig();
    r.handle.fire("pointerdown", { clientY: pull, pointerId: 1, timeStamp: 0 });
    r.handle.fire("pointermove", { clientY: 0, pointerId: 1, timeStamp: 20 });
    const v = parseFloat(/translateY\((-?[\d.]+)/.exec(r.sheet.style.transform || "")[1]);
    if (v < -cap - 0.5) throw new Error(`a ${pull}px pull lifted it ${-v}px, past the ${cap}px stop`);
  }
  /* Downwards is the direction that closes the sheet and must be
     left alone entirely. */
  const r = rig();
  r.handle.fire("pointerdown", { clientY: 0, pointerId: 1, timeStamp: 0 });
  r.handle.fire("pointermove", { clientY: 300, pointerId: 1, timeStamp: 20 });
  if (!/translateY\(300/.test(r.sheet.style.transform || "")) {
    throw new Error("the downward drag was clamped too: " + r.sheet.style.transform);
  }
});

/* ------------------------------------------- scroll must finish first -- */

/* Touch events, because that is what the code listens for: the browser
   cancels a pointer stream the moment it decides the body is being
   scrolled, so a pointer-based dismissal never fired on a real phone. */
function touch(y) {
  return { touches: [{ clientY: y, identifier: 2 }],
           changedTouches: [{ clientY: y, identifier: 2 }],
           timeStamp: 0, preventDefault() { this.defaulted = true; } };
}
function fireTouch(r, type, y, ts) {
  const e = touch(y);
  e.timeStamp = ts === undefined ? 0 : ts;
  r.body.fire(type, e);
  return e;
}
function pull(r, dy, scrollTop) {
  r.body.scrollTop = scrollTop === undefined ? 0 : scrollTop;
  fireTouch(r, "touchstart", 0, 0);
  fireTouch(r, "touchmove", dy, 1500);
  fireTouch(r, "touchend", dy, 1500);
}

check("pulling the sheet's own surface down dismisses it", () => {
  const r = rig({ body: true });
  pull(r, 300, 0);
  if (r.closed() !== 1) throw new Error("a pull on the body did nothing");
});

check("a pull is ignored while the body still has somewhere to scroll", () => {
  const r = rig({ body: true });
  pull(r, 300, 120);
  if (r.closed() !== 0) throw new Error("stole a scroll that had not finished");
});

check("scrolling away from the top mid-gesture cancels the dismissal", () => {
  const r = rig({ body: true });
  r.body.scrollTop = 0;
  fireTouch(r, "touchstart", 0, 0);
  r.body.scrollTop = 80;                       /* the list moved under the finger */
  fireTouch(r, "touchmove", 300, 1500);
  fireTouch(r, "touchend", 300, 1500);
  if (r.closed() !== 0) throw new Error("dismissed a sheet that was being scrolled");
});

check("a list scrolled to the top under the finger is still a scroll", () => {
  /* The distinguishing case for the test taken when the finger lands.
     The sheet was scrolled down, the finger dragged it back to the top,
     and kept going. The list reached 0 - but this finger has been
     scrolling since it touched down, so the rest of its travel is more
     scrolling, not a dismissal. */
  const r = rig({ body: true });
  r.body.scrollTop = 150;
  fireTouch(r, "touchstart", 0, 0);
  r.body.scrollTop = 0;
  fireTouch(r, "touchmove", 300, 1500);
  fireTouch(r, "touchend", 300, 1500);
  if (r.closed() !== 0) throw new Error("dismissed on a gesture that began as a scroll");
});

check("a pull that starts upwards stays a scroll even if it comes back down", () => {
  /* Up first, then down past the dismissal distance. The upward part
     disarms the gesture: the finger has declared itself a scroll, and
     reversing does not undeclare it. */
  const r = rig({ body: true });
  r.body.scrollTop = 0;
  fireTouch(r, "touchstart", 200, 0);
  fireTouch(r, "touchmove", 160, 200);
  fireTouch(r, "touchmove", 500, 1500);
  fireTouch(r, "touchend", 500, 1500);
  if (r.closed() !== 0) throw new Error("a reversed scroll closed the sheet");
});

check("the body gesture can actually stop the browser scrolling", () => {
  /* Found on a real phone, not in this harness. The first version
     listened for pointer events; a scrollable body makes the browser
     claim the gesture and fire pointercancel, so the dismissal never
     ran. It has to be a non-passive touchmove that calls
     preventDefault, or the scroll wins every time. */
  const h = APP.slice(APP.indexOf("function attachSheetDrag("),
                      APP.indexOf("function attachSheetEdgeOpen("));
  if (!/body\.addEventListener\("touchmove"/.test(h)) {
    throw new Error("the body never listens for touchmove");
  }
  const mv = h.slice(h.indexOf('body.addEventListener("touchmove"'));
  if (!/\{ passive: false \}/.test(mv.slice(0, mv.indexOf("});") + 200))) {
    throw new Error("the touchmove listener is passive and cannot block the scroll");
  }
  if (!/e\.preventDefault\(\)/.test(mv.slice(0, mv.indexOf("});")))) {
    throw new Error("the scroll is never actually prevented");
  }
});

check("the sheet contains its own overscroll", () => {
  if (!/overscroll-behavior:\s*contain/.test(CSS)) {
    throw new Error("a pull past the top rubber-bands the page instead");
  }
});

check("an upward flick on the body is a scroll, never a dismissal", () => {
  const r = rig({ body: true });
  pull(r, -200, 0);
  if (r.closed() !== 0) throw new Error("an upward swipe closed the sheet");
});

/* ------------------------------------------------- edge swipe to open -- */

/* Touch events, for the same reason the dismissal uses them: a page
   that scrolls answers a pointer stream with pointercancel, so the
   pointer version armed and then never heard anything again. */
function tev(y, x) {
  const t = [{ clientY: y, clientX: x === undefined ? 100 : x, identifier: 1 }];
  return { touches: t, changedTouches: t, timeStamp: 0 };
}

function edge(o) {
  const stage = (o && o.stage) || el();
  let opened = 0;
  attachSheetEdgeOpen({
    stage,
    isOpen: () => false,
    open: () => { opened++; },
    when: () => (o && "when" in o ? o.when : true),
  });
  return { stage, opened: () => opened };
}

check("a swipe up from the bottom edge opens the sheet", () => {
  const e = edge();
  e.stage.fire("touchstart", tev(790));
  e.stage.fire("touchmove", tev(700));
  if (e.opened() !== 1) throw new Error("did not open");
});

check("the gesture survives a page that is scrolling", () => {
  /* The bug this cost a browser run to find: pointer events are
     cancelled the moment the browser decides the page is scrolling, so
     the settings sheet - which lives on a long scrolling page - could
     never be summoned. Touch events keep arriving. */
  const h = APP.slice(APP.indexOf("function attachSheetEdgeOpen("));
  const fn = h.slice(0, h.indexOf("\n}\n") + 2);
  if (/addEventListener\("pointer/.test(fn)) {
    throw new Error("still listening for pointer events, which a scroll cancels");
  }
  if (!/addEventListener\("touchmove"/.test(fn)) throw new Error("no touchmove listener");
  /* And it must not fight the scroll it is riding on. */
  if (/preventDefault/.test(fn)) throw new Error("the summons blocks scrolling");
});

check("the band is measured from the visible edge, not the element's", () => {
  /* A real-browser finding. The settings desk is a tall scrolling page:
     its bounding box ends thousands of pixels below the screen, so a
     band measured against it sat off-screen and never fired once. */
  const stage = el();
  stage.getBoundingClientRect = () => ({ top: 0, bottom: 3700, left: 0, right: 390, width: 390, height: 3700 });
  const e = edge({ stage });
  e.stage.fire("touchstart", tev(790));
  e.stage.fire("touchmove", tev(700));
  if (e.opened() !== 1) throw new Error("a swipe at the bottom of the screen did nothing");
});

check("a stage with no box of its own falls back to the viewport", () => {
  /* The settings sheet listens on the document, which has no rect. */
  const stage = el();
  delete stage.getBoundingClientRect;
  const e = edge({ stage });
  e.stage.fire("touchstart", tev(790));
  e.stage.fire("touchmove", tev(700));
  if (e.opened() !== 1) throw new Error("a document stage never arms");
});

check("a swipe starting away from the edge does not open it", () => {
  const e = edge();
  e.stage.fire("touchstart", tev(400));
  e.stage.fire("touchmove", tev(300));
  if (e.opened() !== 0) throw new Error("opened from the middle of the screen");
});

check("a mostly sideways drag along the edge is left alone", () => {
  const e = edge();
  e.stage.fire("touchstart", tev(790, 100));
  e.stage.fire("touchmove", tev(730, 300));
  if (e.opened() !== 0) throw new Error("hijacked a horizontal pan");
});

check("a second finger cancels the summons", () => {
  const e = edge();
  const two = tev(790);
  two.touches = [two.touches[0], { clientY: 700, clientX: 200, identifier: 2 }];
  e.stage.fire("touchstart", two);
  e.stage.fire("touchmove", tev(700));
  if (e.opened() !== 0) throw new Error("a pinch opened the sheet");
});

check("the edge swipe is off where the sheet does not exist", () => {
  const e = edge({ when: false });
  e.stage.fire("touchstart", tev(790));
  e.stage.fire("touchmove", tev(700));
  if (e.opened() !== 0) throw new Error("fired above the breakpoint");
});

check("both sheets gate the edge swipe on their own breakpoint", () => {
  /* Read the settings call itself, not the whole file: `S.view ===
     "settings"` appears elsewhere in app.js, so a global grep passed
     happily after the gate had been deleted from the gesture. */
  const i = APP.indexOf("attachSheetEdgeOpen({");
  if (i < 0) throw new Error("the settings sheet never attaches an edge swipe");
  const call = APP.slice(i, APP.indexOf("\n  });", i));
  if (!/stage: document/.test(call)) throw new Error("the settings swipe is not on the document");
  if (!/when:/.test(call)) throw new Error("settings sheet is ungated");
  if (!/S\.view === "settings"/.test(call)) {
    throw new Error("the document stage answers on every view");
  }
  if (!/SET_SHEET_MQ/.test(call)) throw new Error("the settings swipe ignores its breakpoint");
  if (!/when: \(\) => window\.matchMedia\("\(max-width: 760px\)"\)\.matches/.test(TOOLS)) {
    throw new Error("the chart sheet is ungated");
  }
});

/* -------------------------------------------------- the tool flyout ---- */

check("the tool menu is positioned against its own button on a phone", () => {
  const fn = liftFn(TOOLS, "openFlyout");
  if (!/matchMedia\("\(max-width: 760px\)"\)/.test(fn)) {
    throw new Error("openFlyout does not know it is on a phone");
  }
  if (!/insetInlineStart = start/.test(fn)) throw new Error("the inline edge is never set");
  if (!/r\.left - box\.left \+ r\.width \/ 2/.test(fn)) {
    throw new Error("the menu is not centred on the button");
  }
});

check("the tool menu is placed in logical, not physical, coordinates", () => {
  const fn = liftFn(TOOLS, "openFlyout");
  if (/\.style\.left\s*=/.test(fn)) throw new Error("writes `left`, which is wrong in RTL");
  if (!/documentElement\.dir === "rtl"/.test(fn)) throw new Error("no RTL branch");
});

check("the tool menu opens above its button, clear of the sheet", () => {
  const fn = liftFn(TOOLS, "openFlyout");
  if (!/r\.top - box\.top - fly\.offsetHeight/.test(fn)) {
    throw new Error("not placed above the button");
  }
});

check("the stylesheet does not pin the tool menu to a corner", () => {
  /* The real cause of the reported bug, and the one a browser had to
     find: the phone rules carried
       .tv-flyout { inset-block-end: 8px; inset-block-start: auto !important }
     so every menu sat in the bottom-left corner and `!important` meant
     openFlyout's placement was discarded. Fixing the script alone
     changed nothing on screen. */
  const rules = CSS.match(/\.tv-flyout\s*\{[^}]*\}/g) || [];
  rules.forEach((r) => {
    if (/inset-block-start:\s*auto\s*!important/.test(r)) {
      throw new Error("the script cannot place the menu: " + r.trim());
    }
    if (/inset-block-end:\s*\d/.test(r)) {
      throw new Error("the menu is pinned to the bottom edge: " + r.trim());
    }
  });
  if (!rules.length) throw new Error("no .tv-flyout rule found at all");
});

check("closing the tool sheet also closes the tool menu", () => {
  const fn = liftFn(TOOLS, "toggleTools");
  if (!/if \(!next\) closeFlyout\(\);/.test(fn)) {
    throw new Error("the menu survives the sheet it belongs to");
  }
});

/* ----------------------------------------------------------- report ---- */

if (fails.length) {
  console.log("\nsheet-gestures: " + fails.length + " check(s) failed");
  fails.forEach((f) => console.log("  x " + f));
  process.exitCode = 1;
} else {
  console.log("\nsheet-gestures: " + pass + " checks passed");
}
