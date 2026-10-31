/**
 * The settings navigation as a bottom sheet on a phone.
 *
 * Source regexes can say the handlers exist; they cannot say the sheet
 * opens. This boots the real desk in jsdom with matchMedia reporting a
 * phone, renders Settings, and then drives it the way a thumb would -
 * tap the bar, press Escape, tap the scrim, pick a section - checking
 * the document after each one.
 *
 * The three structural bugs it exists to keep fixed:
 *
 *   1. the sheet, its scrim and its bar were rendered inside .stage,
 *      which animates a transform for 480ms on every view change; a
 *      transformed ancestor becomes the containing block for its fixed
 *      descendants, so all three were positioned against the stage
 *      instead of the viewport - and clipped by its overflow:auto;
 *   2. they were z-index 60/61, under the mobile header at 90, so the
 *      sheet slid behind it and the scrim left it lit and clickable;
 *   3. the opener sat at the top of the page, furthest from the thumb.
 *
 *     node tests/settings-sheet.test.js
 */

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const WEB = path.join(ROOT, "apps", "web");
const read = (p) => fs.readFileSync(path.join(WEB, p), "utf8");

const results = [];
function check(name, fn) {
  try {
    const note = fn();
    results.push(true);
    console.log("PASS  " + name + (note ? "  — " + note : ""));
  } catch (e) {
    results.push(false);
    console.log("FAIL  " + name + "\n      " + e.message);
  }
}
const eq = (a, b, what) => { if (a !== b) throw new Error(what + ": got " + JSON.stringify(a) + ", wanted " + JSON.stringify(b)); };
const ok = (v, what) => { if (!v) throw new Error(what); };

let jsdom = null;
try { jsdom = require(require.resolve("jsdom")); } catch { /* optional */ }

if (!jsdom) {
  console.log("SKIP  settings sheet (jsdom not installed)");
  process.exit(0);
}

const { JSDOM, VirtualConsole } = jsdom;

/* A phone, as far as the desk can tell. Everything the sheet decides
   hangs off this one query. */
function boot(phone) {
  const dom = new JSDOM(read("index.html"), {
    url: "http://localhost/", runScripts: "outside-only",
    pretendToBeVisual: true, virtualConsole: new VirtualConsole(),
  });
  const win = dom.window;
  win.fetch = async () => ({ ok: true, json: async () => ({ ok: true, data: {} }) });
  win.matchMedia = (q) => ({
    media: q, matches: phone && /max-width: ?1000px/.test(q),
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
  });
  win.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  win.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
  win.URL.createObjectURL = () => "blob:stub";
  win.AudioContext = class { createGain() { return { connect() {}, gain: {} }; } };
  win.HTMLCanvasElement.prototype.getContext = () => null;

  const bundle = ["js/themes.js", "js/skins.js", "js/i18n.js", "js/api.js",
                  "js/calendar.js", "js/charts.js", "js/app.js"].map(read).join("\n;\n");
  win.eval(bundle + "\n;window.__T = { S, views, I18N, bindView, sweepSetSheet, showSetTab };");
  const T = win.__T;
  T.I18N.pack = JSON.parse(fs.readFileSync(path.join(ROOT, "lang", "en.json"), "utf8"));
  const doc = win.document;
  const stage = doc.getElementById("stage");
  const render = () => { stage.innerHTML = T.views.settings(); T.bindView("settings"); };
  const click = (el) => el.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
  const key = (el, k) => el.dispatchEvent(new win.KeyboardEvent("keydown", { key: k, bubbles: true }));
  render();
  return { win, doc, stage, T, render, click, key, $: (id) => doc.getElementById(id) };
}

/* ------------------------------------------------- 1. where it lives */

check("the sheet, the scrim and the bar are parented into #desk", () => {
  /* Out of the stage, because the stage animates a transform and so
     becomes the containing block for its fixed children - but NOT all
     the way out to <body>. #app is `position:relative; z-index:1`, so
     it is a stacking context: from <body> the sheet is compared
     against #app's z-index of 1 rather than against the drawer's 210,
     and any positive value puts it over the whole application. That is
     why the bar sat on top of the side menu. #desk is the drawer's own
     parent, inside that stacking context, and carries no transform. */
  const { doc, stage, $ } = boot(true);
  const desk = doc.getElementById("desk");
  ok(desk, "there is no #desk to host it");
  for (const id of ["set-jump", "set-sheet-scrim", "set-sheet-bar"]) {
    const el = $(id);
    ok(el, id + " does not exist");
    eq(el.parentElement, desk, id + " is not a child of #desk");
    ok(!stage.contains(el), id + " is still inside the animating stage");
    eq(el.dataset.sheetPortal, "1", id + " is not marked as portaled");
  }
  /* And the drawer it must slide under is a sibling, so the two are
     finally measured against each other. */
  ok(desk.querySelector(".nav"), "the side menu is not in the same stacking context");
  return "3 nodes";
});

check("the sheet goes under the side menu, not over it", () => {
  const app = fs.readFileSync(path.join(WEB, "css/app.css"), "utf8");
  const num = (re) => { const m = re.exec(app); return m ? Number(m[1]) : NaN; };
  const drawer = num(/\.nav\{z-index:(\d+) !important\}/);
  const drawerScrim = num(/\.nav-scrim\{z-index:(\d+) !important\}/);
  const sheet = num(/\.set-jump\.is-sheet\{[^}]*?z-index:(\d+)/s);
  const scrim = num(/\.sj-scrim\{[^}]*?z-index:(\d+)/s);
  const bar = num(/\.sj-bar\{[^}]*?z-index:(\d+)/s);
  const header = num(/\.top\{z-index:(\d+)\}/);
  for (const [n, v] of Object.entries({ drawer, drawerScrim, sheet, scrim, bar, header })) {
    if (!Number.isFinite(v)) throw new Error("could not read the " + n + " z-index");
  }
  if (!(sheet < drawerScrim && sheet < drawer)) throw new Error("the sheet (" + sheet + ") is not under the side menu (" + drawer + ")");
  if (!(bar < drawerScrim)) throw new Error("the bar (" + bar + ") is not under the side menu scrim (" + drawerScrim + ")");
  if (!(sheet > header && scrim > header)) throw new Error("the sheet slides behind the header (" + header + ")");
  return "bar " + bar + " < scrim " + scrim + " < sheet " + sheet + " < menu " + drawerScrim + "/" + drawer;
});

check("the portaled nav is marked so the sheet rules can still reach it", () => {
  /* The rules were .set-rail .set-jump. Out of the desk there is no
     .set-rail above it, so a descendant selector finds nothing and the
     sheet would render as an unstyled block. */
  const { $ } = boot(true);
  ok($("set-jump").classList.contains("is-sheet"), "the nav is not marked");
});

check("on a desktop it stays in the rail, untouched", () => {
  const { doc, stage, $ } = boot(false);
  const nav = $("set-jump");
  ok(stage.contains(nav), "the rail was portaled out of the page on a desktop");
  ok(!nav.classList.contains("is-sheet"), "the desktop rail is wearing the sheet's rules");
  ok(!doc.body.classList.contains("has-set-bar"), "the desktop reserves room for a bar it does not show");
  ok(nav.closest(".set-desk"), "the rail left its grid");
  ok(!nav.classList.contains("is-sheet"), "the rail carries the sheet marker");
});

/* ------------------------------------------------- 2. opening it */

check("tapping the bar opens the sheet and says so", () => {
  const { doc, click, $ } = boot(true);
  eq($("set-sheet-open").getAttribute("aria-expanded"), "false", "it starts open");
  ok($("set-sheet-scrim").hidden, "the scrim is up before anything happened");
  click($("set-sheet-open"));
  ok(doc.documentElement.classList.contains("set-sheet-open"), "the sheet did not open");
  eq($("set-sheet-open").getAttribute("aria-expanded"), "true", "the trigger does not report it");
  ok(!$("set-sheet-scrim").hidden, "nothing dims the page behind it");
});

check("the sheet opens on the section you are already in", () => {
  /* It opens so you can leave here, so here is where arrowing should
     start - not the top of a list of eight. */
  const { doc, click, $ } = boot(true);
  click($("set-sheet-open"));
  const on = $("set-jump").querySelector("button[data-jump].on");
  ok(on, "nothing is marked current");
  eq(doc.activeElement, on, "focus did not land on the current section");
});

check("tapping it again closes it", () => {
  const { doc, click, $ } = boot(true);
  click($("set-sheet-open"));
  click($("set-sheet-open"));
  ok(!doc.documentElement.classList.contains("set-sheet-open"), "the toggle only toggles one way");
});

/* ------------------------------------------------- 3. closing it */

check("every way out of the sheet works", () => {
  const { doc, click, key, $ } = boot(true);
  const open = () => click($("set-sheet-open"));
  const isOpen = () => doc.documentElement.classList.contains("set-sheet-open");

  open();
  key($("set-jump"), "Escape");
  ok(!isOpen(), "Escape does not close it");

  open();
  click($("set-sheet-scrim"));
  ok(!isOpen(), "tapping outside does not close it");

  open();
  click($("set-sheet-close"));
  ok(!isOpen(), "the close button does not close it");

  open();
  click($("set-jump").querySelector('[data-jump="set-notify"]'));
  ok(!isOpen(), "picking a section leaves the sheet covering the answer");
  return "escape, scrim, button, pick";
});

check("Escape in the search box clears the filter before it closes the sheet", () => {
  /* Two things answer to Escape in the same subtree. The inner one
     wins while it still has something to clear, or a typo costs you
     the whole sheet. */
  const { doc, click, key, $ } = boot(true);
  click($("set-sheet-open"));
  const q = $("set-q");
  q.focus();
  q.value = "noti";
  q.dispatchEvent(new (q.ownerDocument.defaultView.Event)("input", { bubbles: true }));
  key(q, "Escape");
  eq(q.value, "", "the filter was not cleared");
  ok(doc.documentElement.classList.contains("set-sheet-open"), "the sheet closed instead of clearing the box");
  key(q, "Escape");
  ok(!doc.documentElement.classList.contains("set-sheet-open"), "a second Escape does not close it");
});

check("picking a section switches it and relabels the closed bar", () => {
  const { click, $ } = boot(true);
  click($("set-sheet-open"));
  click($("set-jump").querySelector('[data-jump="set-notify"]'));
  ok(!$("set-notify").hidden, "the section did not open");
  ok($("set-robot").hidden, "the old section is still showing");
  const label = $("set-sheet-now").textContent.trim();
  ok(label && label !== "Robot", "the bar still names the section you left: " + JSON.stringify(label));
  return label;
});

/* ------------------------------------------------- 4. leaving and returning */

check("leaving settings takes the sheet with it", () => {
  /* Portaled out of the stage, so the stage being rebuilt does not
     remove them - which is the whole point, and also the whole
     hazard. */
  const { doc, T } = boot(true);
  T.sweepSetSheet();
  eq(doc.querySelectorAll("[data-sheet-portal]").length, 0, "something was left on screen");
  ok(!doc.body.classList.contains("has-set-bar"), "toasts still dodge a bar that is gone");
});

check("re-rendering settings in place does not leave two of everything", () => {
  /* Settings re-renders itself without a view change when the light
     cut or the breakpoint changes. A sweep guarded on `changing` would
     leave the portaled copy behind and give the document two
     #set-jump - and getElementById does not reliably pick the live
     one. */
  const { doc, render } = boot(true);
  render();
  render();
  for (const id of ["set-jump", "set-sheet-bar", "set-sheet-scrim", "set-sheet-open"]) {
    eq(doc.querySelectorAll("[id='" + id + "']").length, 1, "there are several " + id);
  }
});

/* ------------------------------------------------- 5. what it holds */

check("the sheet holds the whole rail, headings and descriptions included", () => {
  /* The strip it replaced dropped both to make room, which is
     backwards: they are what the rail is for. */
  const { doc, $ } = boot(true);
  const list = $("set-jump").querySelector(".sj-list");
  ok(list, "the entries are not in a scrolling region of their own");
  eq(list.querySelectorAll("button[data-jump]").length, 8, "the list lost entries");
  ok(list.querySelectorAll(".sj-grp").length >= 3, "the group headings are gone");
  const withDesc = [...list.querySelectorAll("button[data-jump]")]
    .filter((b) => b.querySelector(".sj-txt small"));
  eq(withDesc.length, 8, "entries without a description");
  ok(!doc.querySelector("#set-jump > button[data-jump]"), "an entry sits outside the scrolling region");
  return "8 entries, 3 groups";
});

check("the closed bar is a pill, not a slab", () => {
  /* It was a 56px full-width row carrying an icon, a title, a caption
     reading "All settings" and a chevron - next to a chevron that
     already said it opens. One line, one target, 44px: the touch
     minimum rather than a quarter of a phone screen. */
  const { $ } = boot(true);
  const open = $("set-sheet-open");
  ok(open, "no opener");
  ok(!open.querySelector("small"), "the redundant caption is back");
  ok(open.querySelector("#set-sheet-now"), "the bar does not name the section");
  ok(open.getAttribute("aria-label"), "losing the caption lost the accessible name too");
  const app = fs.readFileSync(path.join(WEB, "css/app.css"), "utf8");
  const tight = app.replace(/\s+/g, "");
  const h = /\.sj-open\{[^}]*?min-block-size:(\d+)px/.exec(tight);
  if (!h) throw new Error("the opener has no height");
  const px = Number(h[1]);
  if (px < 44) throw new Error("the target is only " + px + "px, under the 44px minimum");
  if (px > 48) throw new Error("the opener is " + px + "px, still a slab");
  if (!/\.sj-open\{[^}]*?inline-size:auto/.test(tight)) throw new Error("the pill still spans the full width");
  return px + "px";
});

check("the bar and the sheet wear the theme, not colours of their own", () => {
  /* The first cut painted rgb(var(--s2) / .86) with a blur. It matched
     no skin, ignored the neumorphic and clay treatments completely,
     and - because the global data-glass rule strips backdrop-filter
     but not alpha - went see-through the moment liquid glass was
     switched off. The surface is the theme's to decide; the bar is
     listed in the same selectors as the rail it stands in for, so the
     two cannot drift apart. */
  const themes = fs.readFileSync(path.join(WEB, "css/themes.css"), "utf8");
  const skins = fs.readFileSync(path.join(WEB, "css/skins.css"), "utf8");
  const app = fs.readFileSync(path.join(WEB, "css/app.css"), "utf8");

  if (!/html\[data-skin\] \.sj-open,/.test(themes)) throw new Error("no skin dresses the bar");
  if (!/html\[data-skin="neu"\] \.sj-open,/.test(themes)) throw new Error("the neumorphic skin skips the bar");
  if (!/^\.sj-open,$/m.test(skins)) throw new Error("the bar has no base surface");
  /* Both grounding rules - dark and light - must name it, or glass-off
     leaves it translucent with nothing behind to blur. */
  const ground = skins.match(/\[data-glass="off"\] \.sj-open/g) || [];
  if (ground.length < 2) throw new Error("the bar is grounded in " + ground.length + " of the 2 glass-off rules");
  const perf = skins.match(/\[data-perf="fast"\] \.sj-open/g) || [];
  if (perf.length < 2) throw new Error("the bar is grounded in " + perf.length + " of the 2 perf rules");

  /* And app.css must not hand it a colour behind the theme's back. */
  const own = /\.sj-open\{([^}]*)\}/.exec(app.replace(/\s+/g, ""));
  if (own && /background:(?!none)/.test(own[1])) {
    throw new Error("app.css still paints the bar: " + own[1]);
  }
  /* The frosting is structural and stays, so data-glass has something
     to switch off. */
  if (!/backdrop-filter:blur/.test(app.slice(app.indexOf(".sj-bar > .sj-open"), app.indexOf(".sj-now")))) {
    throw new Error("the bar has no blur, so liquid glass does nothing to it");
  }
  return ground.length + " glass-off + " + perf.length + " perf rules";
});

check("every section opens at its top, not wherever you last were", () => {
  /* Sections are swapped by toggling `hidden`, which says nothing
     about where the page is scrolled to. Read halfway down a long
     section, pick another one, and it opened already scrolled into its
     own middle with its heading above the fold - and nothing on screen
     to say you were not at the beginning of it. */
  const { doc, stage, T, render } = boot(false);
  render();
  /* jsdom has no layout, so the scroller needs a scrollTop that can be
     written and read back. */
  let top = 0;
  Object.defineProperty(stage, "scrollTop", {
    get: () => top, set: (v) => { top = v; }, configurable: true,
  });
  for (const id of ["set-prop", "set-mt5", "set-system", "set-robot", "set-notify"]) {
    top = 640;
    const btn = doc.querySelector(`#set-jump [data-jump="${id}"]`);
    ok(btn, "no entry for " + id);
    btn.click();
    const shown = doc.querySelector(".set-block:not([hidden])");
    eq(shown && shown.id, id, "picking " + id + " did not open it");
    eq(top, 0, "opening " + id + " left the page scrolled to " + top);
  }
  return "5 sections";
});

check("saving something does not throw you back to the top", () => {
  /* The other half of the same rule. showSetTab also runs on every
     re-render of the view - a setting saved, a licence arriving, the
     light cut flipping - and reloadSettings deliberately restores the
     scroll offset across those, so that saving a field does not move
     the page you are working on. Only a real change of section may
     scroll. */
  const { stage, T, render } = boot(false);
  render();
  let top = 0;
  Object.defineProperty(stage, "scrollTop", {
    get: () => top, set: (v) => { top = v; }, configurable: true,
  });
  top = 640;
  T.showSetTab(T.S.setTab);
  eq(top, 640, "re-rendering the same section moved the page to " + top);

  const src = fs.readFileSync(path.join(WEB, "js/app.js"), "utf8");
  const fn = src.slice(src.indexOf("function showSetTab("), src.indexOf("function bindView("));
  if (!/\bmoved\b/.test(fn)) throw new Error("showSetTab scrolls unconditionally");
  if (!/if \(moved\)/.test(fn)) throw new Error("the scroll is not guarded on a real change");
  return "preserved at 640";
});

check("the bar comes after the sections, as it does on screen", () => {
  const { doc, $ } = boot(false);
  const bar = doc.querySelector("#set-sheet-bar");
  const main = doc.querySelector(".set-main");
  ok(bar && main, "the page is missing a piece");
  ok(bar.compareDocumentPosition(main) & 4, "the bar still reads before the sections");
});

const bad = results.filter((r) => !r).length;
console.log("\nsettings-sheet: " + (bad ? bad + " FAILED of " : "") + results.length + (bad ? "" : " checks passed"));
process.exit(bad ? 1 : 0);
