/**
 * What actually wins on a search box, in every skin, in every state.
 *
 * The prop-risk search boxes were reported twice as drawing "a
 * rectangle over the box with blue around it" on click. Both times the
 * source read as though it were fixed: app.css carries a reset for
 * `.field .dsk-search-i` covering :focus and :focus-visible, and
 * themes.css carries a skin-aware one. Reading them, nothing is wrong.
 *
 * The fault was arithmetic. `html[data-skin] .field input:focus` is
 * (0,3,2); the themed reset next to it was written for the resting
 * state only, and app.css's focus reset is (0,3,0). So the moment the
 * box was clicked the skin painted the inner input a `--field-hi`
 * background, a border colour and `box-shadow:0 0 0 4px accent/.14` -
 * a hard-cornered filled rectangle with an accent halo, inside the
 * shell's rounded box, on whatever colour that skin's accent was.
 *
 * No regex over the source can see that, because every rule involved
 * is individually correct. So this resolves the cascade: it collects
 * every declaration that matches the element, sorts by importance,
 * specificity and order the way a browser does, and asserts on the
 * winner.
 *
 *     node tests/search-box-cascade.test.js
 */

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const WEB = path.join(ROOT, "apps", "web");
const FILES = ["css/app.css", "css/themes.css", "css/skins.css", "css/chart.css"];

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

let jsdom = null;
try { jsdom = require(require.resolve("jsdom")); } catch { /* optional */ }
if (!jsdom) { console.log("SKIP  search box cascade (jsdom not installed)"); process.exit(0); }
const { JSDOM } = jsdom;

const css = FILES.map((f) => fs.readFileSync(path.join(WEB, f), "utf8"));

/* Every place the desk puts a search box. The shell is what should own
   the box; the input inside it must declare nothing in any state. */
const MARKUP_EXTRA = `
<section id="desk">
  <div class="sj-bar"><button class="sj-open"><span class="sj-ic"></span><b class="sj-now">x</b></button></div>
  <nav class="set-jump is-sheet"><div class="sj-list"><button data-jump="a"></button></div></nav>
  <aside class="nav"></aside>
</section>`;

const MARKUP = `
<div class="card prop-risk">
  <div class="sym-panel">
    <span class="dsk-search sm"><svg></svg><input id="in-panel" type="search" class="dsk-search-i" /></span>
  </div>
  <div class="field"><label for="in-field">x</label>
    <span class="dsk-search"><svg></svg><input id="in-field" type="search" class="dsk-search-i" /></span>
  </div>
  <div class="field"><label for="in-field-sm">x</label>
    <span class="dsk-search sm"><svg></svg><input id="in-field-sm" type="search" class="dsk-search-i" /></span>
  </div>
</div>
<nav class="set-jump"><div class="sj-find">
  <span class="dsk-search sm"><svg></svg><input id="in-rail" type="search" class="dsk-search-i" /></span>
</div></nav>
<div class="sympick-pop"><div class="sympick-search">
  <span class="dsk-search sm"><svg></svg><input id="in-pop" type="search" class="dsk-search-i" /></span>
</div></div>`;

const SKINS = ["", "aurora", "clay", "cyber", "frost", "glass", "midnight",
               "minimal", "mono", "neu", "ocean", "sunset", "custom"];
const BOXES = ["in-panel", "in-field", "in-field-sm", "in-rail", "in-pop"];

const STATE = /:(focus-visible|focus-within|focus|hover|active)(?![-\w])/g;

function specificity(sel) {
  const s = sel.replace(/\*/g, " ");
  const id = (s.match(/#[-\w]+/g) || []).length;
  const cl = (s.match(/\.[-\w]+|\[[^\]]+\]|:(?!:)[-\w]+(\([^)]*\))?/g) || []).length;
  const el = (s.match(/(^|[\s>+~(])[a-zA-Z][-\w]*/g) || []).length;
  return id * 10000 + cl * 100 + el;
}

/* One document per skin; the stylesheets are parsed by jsdom's own
   CSSOM, so the selectors and declarations are the real ones. */
function sheetFor(skin, opts) {
  const o = opts || {};
  const attrs = ` data-theme="${o.theme || "dark"}" data-glass="${o.glass || "on"}"` +
    ` data-perf="${o.perf || "rich"}" data-bg="x" data-motion="on"`;
  const dom = new JSDOM(
    `<!doctype html><html${attrs}${skin ? ` data-skin="${skin}"` : ""}><head>` +
    css.map((c, i) => `<style data-src="${FILES[i]}">${c}</style>`).join("") +
    `</head><body>${MARKUP}${MARKUP_EXTRA}</body></html>`);
  const doc = dom.window.document;
  const flat = [];
  let order = 0;
  for (const sh of doc.styleSheets) {
    const src = sh.ownerNode ? sh.ownerNode.getAttribute("data-src") : "?";
    const walk = (list) => {
      for (const r of list) {
        if (r.cssRules && r.conditionText !== undefined) { walk(r.cssRules); continue; }
        if (!r.selectorText) continue;
        flat.push({ src, sel: r.selectorText, style: r.style, order: order++ });
      }
    };
    try { walk(sh.cssRules); } catch { /* unparsable at-rule */ }
  }
  return { doc, flat };
}

/* The declaration a browser would use for `prop` on `el`, counting only
   rules that apply when the control is at rest or focused. */
function winner(flat, el, prop) {
  const cands = [];
  for (const r of flat) {
    const v = r.style.getPropertyValue(prop);
    if (!v) continue;
    /* `continue`, not `break`. A rule's selector list is a set of
       alternatives, so giving up at the first one that does not match
       silently drops every rule whose matching selector is not written
       first - and the grouped rules in skins.css put .set-jump ahead of
       .sj-open, and [data-glass="off"] ahead of [data-perf="fast"]. */
    for (const raw of r.sel.split(",")) {
      const s = raw.trim();
      const states = (s.match(STATE) || []).join("");
      if (/hover|active/.test(states)) continue;
      let base = s.replace(STATE, "").replace(/(^|[\s>+~])(?=$|[\s>+~])/g, "$1*").trim() || "*";
      let m = false;
      try { m = el.matches(base); } catch { continue; }
      if (!m) continue;
      cands.push({
        imp: r.style.getPropertyPriority(prop) === "important" ? 1 : 0,
        sp: specificity(s), order: r.order, sel: s, src: r.src, v,
      });
      break;
    }
  }
  if (!cands.length) return null;
  cands.sort((a, b) => (a.imp - b.imp) || (a.sp - b.sp) || (a.order - b.order));
  return cands[cands.length - 1];
}

const BLANK = {
  "box-shadow": /^none$/,
  "background": /^none$/,
  "border": /^0$/,
  "outline": /^none$/,
};

check("the input inside a search shell draws no box, in any skin", () => {
  /* It is the shell that has the height, the padding, the border, the
     radius and the focus ring. An input that declares any of them as
     well is a second box inside the first, and the two always drift. */
  const bad = [];
  for (const skin of SKINS) {
    const { doc, flat } = sheetFor(skin);
    for (const id of BOXES) {
      const el = doc.getElementById(id);
      for (const [prop, wanted] of Object.entries(BLANK)) {
        const w = winner(flat, el, prop);
        if (!w) continue;
        if (!wanted.test(w.v.trim())) {
          bad.push(`[skin=${skin || "none"}] #${id} ${prop}: ${w.v}  <= ${w.sel} (${w.src})`);
        }
      }
    }
  }
  if (bad.length) throw new Error(bad.length + " wrong:\n      " + bad.join("\n      "));
  return SKINS.length + " skins x " + BOXES.length + " boxes";
});

check("the skin's focus treatment never reaches the inner input", () => {
  /* The specific regression: html[data-skin] .field input:focus is
     (0,3,2) and out-ranked a reset written for the resting state. */
  const themes = fs.readFileSync(path.join(WEB, "css/themes.css"), "utf8");
  const rest = themes.indexOf("html[data-skin] .field .dsk-search-i,");
  if (rest < 0) throw new Error("the resting exemption is gone");
  const foc = themes.indexOf("html[data-skin] .field .dsk-search-i:focus");
  if (foc < 0) throw new Error("there is no focus twin for the themed exemption");
  if (foc < rest) throw new Error("the focus twin is declared before the rule it has to beat");
  const block = themes.slice(foc, themes.indexOf("}", foc));
  for (const p of ["background", "border", "box-shadow", "outline"]) {
    if (!block.includes(p + ":")) throw new Error("the focus twin does not reset " + p);
  }
});

/* ------------------------------------------------------------------
   The settings sheet, same technique.

   The bar painted a colour of its own - rgb(var(--s2) / .86) with a
   blur - rather than the one every other panel uses. So it matched no
   skin, ignored the neumorphic and clay treatments completely, and
   went see-through whenever liquid glass was switched off, because the
   global data-glass rule removes backdrop-filter but cannot remove an
   alpha the component wrote itself.
   ------------------------------------------------------------------ */

const SKIN_LIST = ["aurora", "clay", "cyber", "frost", "glass", "midnight",
                   "minimal", "mono", "neu", "ocean", "sunset", "custom"];

check("every skin dresses the bottom bar and the sheet", () => {
  const bad = [];
  for (const skin of SKIN_LIST) {
    const { doc, flat } = sheetFor(skin);
    for (const [what, sel] of [["bar", ".sj-open"], ["sheet", ".set-jump.is-sheet"]]) {
      const w = winner(flat, doc.querySelector(sel), "background");
      if (!w) { bad.push(skin + " " + what + ": nothing paints it"); continue; }
      if (!/data-skin/.test(w.sel)) bad.push(skin + " " + what + ": falls back to " + w.sel);
    }
  }
  if (bad.length) throw new Error(bad.join("\n      "));
  return SKIN_LIST.length + " skins";
});

check("with liquid glass off, neither of them is see-through", () => {
  /* Translucency without a blur behind it is not frosting, it is a
     hole - and this is the one surface the trader is looking through
     to read the page under it. */
  const bad = [];
  for (const mode of [{ glass: "off" }, { perf: "fast" }]) {
    for (const theme of ["dark", "light"]) {
      const { doc, flat } = sheetFor("aurora", { ...mode, theme });
      for (const [what, sel] of [["bar", ".sj-open"], ["sheet", ".set-jump.is-sheet"]]) {
        const w = winner(flat, doc.querySelector(sel), "background");
        const v = w ? w.v.trim() : "";
        /* An opaque colour: rgb() with no slash alpha, or a hex. */
        if (!/^(rgb\(var\(--s\d\)\)|#[0-9a-f]{3,8})$/i.test(v)) {
          bad.push(JSON.stringify({ ...mode, theme }) + " " + what + " = " + (v || "(nothing)"));
        }
      }
    }
  }
  if (bad.length) throw new Error("still translucent:\n      " + bad.join("\n      "));
  return "4 combinations";
});

check("the sheet keeps its own shape on top of the theme's colour", () => {
  /* html[data-skin] .set-jump sets border-radius:var(--radius-lg),
     which rounds the bottom corners of a panel that is sitting ON the
     bottom edge. Shape belongs to the component, colour to the theme,
     so the geometry is written to out-specify it. */
  const bad = [];
  for (const skin of SKIN_LIST) {
    const { doc, flat } = sheetFor(skin);
    const el = doc.querySelector(".set-jump.is-sheet");
    const want = {
      "border-start-start-radius": "20px",
      "border-end-start-radius": "0",
      "border-end-end-radius": "0",
      "position": "fixed",
      "z-index": "151",
    };
    for (const [prop, v] of Object.entries(want)) {
      const w = winner(flat, el, prop);
      if (!w || w.v.trim() !== v) bad.push(skin + " " + prop + " = " + (w ? w.v : "(none)"));
    }
  }
  if (bad.length) throw new Error(bad.join("\n      "));
  return SKIN_LIST.length + " skins";
});

check("the shell is what lights up on focus", () => {
  /* Removing the inner ring is only right because the outer one
     exists. If this ever goes, the box stops answering the keyboard. */
  const app = fs.readFileSync(path.join(WEB, "css/app.css"), "utf8");
  const i = app.indexOf(".dsk-search:focus-within{");
  if (i < 0) throw new Error("the shell has no focus ring");
  const block = app.slice(i, app.indexOf("}", i));
  if (!/box-shadow/.test(block) || !/accent/.test(block)) {
    throw new Error("the shell's focus ring is not an accent ring");
  }
  if (!/border-color/.test(block)) throw new Error("the shell's border does not respond");
});

const bad = results.filter((r) => !r).length;
console.log("\nsearch-box-cascade: " + (bad ? bad + " FAILED of " : "") + results.length + (bad ? "" : " checks passed"));
process.exit(bad ? 1 : 0);
