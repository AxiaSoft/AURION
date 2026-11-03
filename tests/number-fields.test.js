/**
 * Every numeric box on the desk seats its value the same way: the digits
 * at the left-hand end, the unit suffix at the right-hand end, in English
 * and in Persian and in Arabic alike.
 *
 * A quantity reads left to right in all three languages - 2.5 is 2.5 - so
 * the seat is PHYSICAL and does not follow the page. Three separate
 * mistakes had put the number somewhere else, and every one of them reads
 * as correct in the source:
 *
 *   1. `direction:ltr` paired with `text-align:end`. Inside an element
 *      already forced to LTR, `end` is RIGHT. Intended as "LTR digits,
 *      seated at the start", it parked all seventeen prop numbers hard
 *      against the right edge on a Persian desk.
 *
 *   2. `unicode-bidi:plaintext` inherited from the base input rule. It
 *      takes a box's direction from its first strong character, so the
 *      same field aligned differently depending on what was typed in it.
 *      That is right for a free-text field and wrong for a quantity -
 *      which is why this file also checks that text fields KEPT it.
 *
 *   3. `padding-inline-end` reserving room for the suffix. It flips to
 *      the left on an RTL page, so the gap opened on the side with
 *      nothing in it and pushed the digits into the middle of the box,
 *      into the unit text. Same for the suffix's own `inset-inline-end`.
 *
 * And one scope mistake behind all three: the rules applied only under
 * `.prop-fields`, so nine other numeric boxes in settings and on the
 * execution ticket were seated by the base rule alone.
 *
 * The test renders the real views with the real stylesheets and resolves
 * the cascade, rather than reading the CSS, because every one of these
 * faults was a rule that existed and lost - or won and meant the
 * opposite of what it looked like.
 *
 *     node tests/number-fields.test.js
 */

const fs = require("node:fs");
const path = require("node:path");

let jsdom = null;
try { jsdom = require(require.resolve("jsdom")); } catch { /* optional */ }
if (!jsdom) { console.log("SKIP  number fields (jsdom not installed)"); process.exit(0); }
const { JSDOM, VirtualConsole } = jsdom;

const ROOT = path.resolve(__dirname, "..");
const WEB = path.join(ROOT, "apps", "web");
const JS = (f) => fs.readFileSync(path.join(WEB, "js", f), "utf8");
const FILES = ["themes.js", "skins.js", "i18n.js", "api.js", "calendar.js",
  "chart-series.js", "charts.js", "chart-tools.js", "pnl-charts.js", "app.js"];
const CSSF = ["css/app.css", "css/skins.css", "css/chart.css", "css/themes.css"];
const css = CSSF.map((f) => fs.readFileSync(path.join(WEB, f), "utf8"));

const results = [];
const say = (ok, m) => { results.push(Boolean(ok)); console.log((ok ? "ok   " : "FAIL ") + m); };

/* ---- cascade resolver ---------------------------------------------------
   Specificity sort over the four stylesheets, with an opt-in width filter.
   `continue` across a selector list, never `break` out of it. */
const STATE = /:(focus-visible|focus-within|focus|hover|active)(?![-\w])/g;
function spec(sel) {
  const s = sel.replace(/\*/g, " ");
  const id = (s.match(/#[-\w]+/g) || []).length;
  const cl = (s.match(/\.[-\w]+|\[[^\]]+\]|:(?!:)[-\w]+(\([^)]*\))?/g) || []).length;
  const el = (s.match(/(^|[\s>+~(])[a-zA-Z][-\w]*/g) || []).length;
  return id * 10000 + cl * 100 + el;
}

function boot(dir) {
  const html = `<!doctype html><html dir="${dir}" lang="${dir === "rtl" ? "fa" : "en"}"`
    + ` data-skin="aurora" data-theme="dark" data-glass="on" data-perf="rich"><head>`
    + css.map((c, i) => `<style data-src="${CSSF[i]}">${c}</style>`).join("")
    + `</head><body><div id="app"><section id="desk"><div class="stage" id="stage"></div></section></div></body></html>`;
  const dom = new JSDOM(html, {
    url: "http://localhost/", runScripts: "outside-only",
    pretendToBeVisual: true, virtualConsole: new VirtualConsole(),
  });
  const win = dom.window, doc = win.document;
  win.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, data: [] }) });
  win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  win.ResizeObserver = class { observe() {} disconnect() {} unobserve() {} };
  win.IntersectionObserver = class { observe() {} disconnect() {} unobserve() {} };
  win.URL.createObjectURL = () => "blob:x";
  win.AudioContext = class {};
  win.confirm = () => true;
  win.HTMLCanvasElement.prototype.getContext = () => null;
  win.eval(FILES.map(JS).join("\n;\n") + ";window.__T={I18N,views};");
  const T = win.__T;
  T.I18N.pack = JSON.parse(fs.readFileSync(path.join(ROOT, "lang", dir === "rtl" ? "fa" : "en") + ".json", "utf8"));

  const flat = []; let o = 0;
  for (const sh of doc.styleSheets) {
    const src = (sh.ownerNode && sh.ownerNode.getAttribute("data-src")) || "?";
    const walk = (L, mq) => {
      for (const r of L) {
        if (r.cssRules && r.conditionText !== undefined) { walk(r.cssRules, (mq ? mq + " and " : "") + r.conditionText); continue; }
        if (!r.selectorText) continue;
        flat.push({ src, mq, sel: r.selectorText, style: r.style, order: o++ });
      }
    };
    try { walk(sh.cssRules, ""); } catch (e) { /* unparsed */ }
  }
  return { win, doc, T, flat };
}

function winner(flat, el, prop, W) {
  const c = [];
  for (const r of flat) {
    const v = r.style.getPropertyValue(prop);
    if (!v) continue;
    if (r.mq) {
      if (/prefers-reduced-motion|forced-colors|print/.test(r.mq)) continue;
      const mx = /max-width:\s*(\d+)px/.exec(r.mq), mn = /min-width:\s*(\d+)px/.exec(r.mq);
      if (mx && W > Number(mx[1])) continue;
      if (mn && W < Number(mn[1])) continue;
    }
    for (const raw of r.sel.split(",")) {
      const s = raw.trim();
      const st = (s.match(STATE) || []).join("");
      if (/hover|active|focus/.test(st)) continue;
      const b = s.replace(STATE, "").replace(/(^|[\s>+~])(?=$|[\s>+~])/g, "$1*").trim() || "*";
      let m = false;
      try { m = el.matches(b); } catch (e) { continue; }
      if (!m) continue;
      c.push({ sp: spec(s), order: r.order, sel: s, v: v.trim() });
      break;
    }
  }
  if (!c.length) return null;
  c.sort((a, b) => (a.sp - b.sp) || (a.order - b.order));
  return c[c.length - 1];
}

/* ===================================== every numeric box, both ways === */

const VIEWS = ["settings", "execution", "command", "markets", "strategies", "backtest", "profile"];

for (const dir of ["ltr", "rtl"]) {
  const { doc, T, flat } = boot(dir);
  const stage = doc.getElementById("stage");
  console.log(`\n=== dir=${dir} ===`);

  const boxes = [];
  for (const v of VIEWS) {
    try { stage.innerHTML = T.views[v](); } catch (e) { continue; }
    for (const el of stage.querySelectorAll('input[type="number"], input[type="time"]')) {
      boxes.push({ view: v, id: el.id || "(none)", el });
    }
  }
  say(boxes.length >= 24, `found the numeric boxes to check (${boxes.length})`);

  for (const W of [1440, 390]) {
    const wrong = [];
    for (const b of boxes) {
      const ta = winner(flat, b.el, "text-align", W);
      const di = winner(flat, b.el, "direction", W);
      const ub = winner(flat, b.el, "unicode-bidi", W);
      if (!ta || ta.v !== "left") wrong.push(`${b.id} text-align=${ta ? ta.v : "none"}`);
      else if (!di || di.v !== "ltr") wrong.push(`${b.id} direction=${di ? di.v : "none"}`);
      else if (!ub || ub.v !== "normal") wrong.push(`${b.id} unicode-bidi=${ub ? ub.v : "none"}`);
    }
    say(wrong.length === 0,
      `${W}px: every numeric box seats its digits left, LTR, bidi-normal`
      + (wrong.length ? ` - ${wrong.slice(0, 4).join("; ")}` : ""));
  }

  /* ---- the suffix: reserved and pinned on the PHYSICAL right ---------- */
  stage.innerHTML = T.views.settings();
  const inp = doc.getElementById("pr-dday");
  const unit = inp.closest(".num-wrap").querySelector(".num-unit");
  say(Boolean(unit), "the unit suffix is rendered inside the box");

  for (const W of [1440, 390]) {
    const pr = winner(flat, inp, "padding-right", W);
    const pie = winner(flat, inp, "padding-inline-end", W);
    const pb = winner(flat, inp, "padding-bottom", W);
    const ri = winner(flat, unit, "right", W);
    const iie = winner(flat, unit, "inset-inline-end", W);
    const iis = winner(flat, unit, "inset-inline-start", W);

    say(pr && /unit-gap/.test(pr.v), `${W}px: the gap for the suffix is reserved on the right (${pr && pr.v})`);
    say(!pie, `${W}px: no logical inline-end padding left to flip sides (${pie ? pie.v + " <= " + pie.sel : "none"})`);
    say(ri && ri.v === "12px", `${W}px: the suffix is pinned to the physical right (${ri && ri.v})`);
    say(!iie && !iis, `${W}px: and not to either logical edge`);
    /* The 22px that made every numeric field on a phone taller than its
       neighbours, to clear a suffix that had been moved underneath. */
    say(!pb, `${W}px: no padding-bottom reserving a second line (${pb ? pb.v : "none"})`);
  }

  /* ---- what must NOT have changed ------------------------------------- */
  const text = doc.getElementById("s-path") || doc.querySelector('.field input:not([type])');
  if (text) {
    const ub = winner(flat, text, "unicode-bidi", 1440);
    const ta = winner(flat, text, "text-align", 1440);
    say(ub && ub.v === "plaintext",
      `a free-text field keeps plaintext bidi, so a Persian value still reads right (${ub && ub.v})`);
    say(ta && ta.v === "start",
      `...and still follows the page rather than being forced left (${ta && ta.v})`);
  } else {
    say(false, "could not find a free-text field to guard");
  }

  /* A chart property box is numeric too, and is styled in a different
     file - it must not have been missed, and chart.css must still win
     the compact height it sets for itself. */
  const row = doc.createElement("div");
  row.className = "tvp-row";
  row.innerHTML = '<input type="number" />';
  stage.appendChild(row);
  const tvp = row.firstElementChild;
  const cta = winner(flat, tvp, "text-align", 1440);
  const ch = winner(flat, tvp, "height", 1440);
  say(cta && cta.v === "left", `a chart property number is seated the same way (${cta && cta.v})`);
  say(ch && ch.v === "26px", `...while chart.css keeps its own compact height (${ch && ch.v})`);
}

/* ======================================= one owner for the component == */

console.log("\n=== one description of the component ===");
const appCss = fs.readFileSync(path.join(WEB, "css/app.css"), "utf8");
const strip = appCss.replace(/\/\*[\s\S]*?\*\//g, "");
say(!/\.num-wrap\s*\{[^}]*display:\s*flex/.test(strip),
  "the dead flex layout for .num-wrap is gone from app.css");
say(!/\.num-unit\s*\{[^}]*flex:\s*none/.test(strip),
  "...and so is its unit rule, which never applied either");
const skins = fs.readFileSync(path.join(WEB, "css/skins.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
say(/\.num-field \.num-wrap\s*\{[^}]*position:\s*relative/.test(skins),
  "skins.css is the single owner of the overlay");
say(!/padding-inline-end:\s*var\(--unit-gap/.test(skins),
  "no logical suffix gap survives anywhere in skins.css");

/* The seat is keyed on the input type, not on one page's wrapper, so a
   numeric box added anywhere is seated without a new rule. */
say(/^input\[type="number"\],\s*$/m.test(appCss.replace(/\r/g, "")),
  "the seat is keyed on the input type rather than on .prop-fields");
say(!/html\[dir="rtl"\][^{]*input\[type="number"\]/.test(strip),
  "no RTL-specific override is left to contradict it");

const bad = results.filter((r) => !r).length;
console.log("\nnumber-fields: " + (bad ? bad + " FAILED of " + results.length : results.length + " checks passed"));
process.exit(bad ? 1 : 0);
