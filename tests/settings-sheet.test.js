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

check("the sheet, the scrim and the bar are parented to the body", () => {
  const { doc, stage, $ } = boot(true);
  for (const id of ["set-jump", "set-sheet-scrim", "set-sheet-bar"]) {
    const el = $(id);
    ok(el, id + " does not exist");
    eq(el.parentElement, doc.body, id + " is not a child of <body>");
    ok(!stage.contains(el), id + " is still inside the animating stage");
    eq(el.dataset.sheetPortal, "1", id + " is not marked as portaled");
  }
  return "3 nodes";
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
  /* Portaled to <body>, so the stage being rebuilt does not remove
     them - which is the whole point, and also the whole hazard. */
  const { doc, T } = boot(true);
  T.sweepSetSheet();
  eq(doc.querySelectorAll("body > [data-sheet-portal]").length, 0, "something was left on screen");
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
