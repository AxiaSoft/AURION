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
function sheetFor(skin) {
  const dom = new JSDOM(
    `<!doctype html><html data-theme="dark"${skin ? ` data-skin="${skin}"` : ""}><head>` +
    css.map((c, i) => `<style data-src="${FILES[i]}">${c}</style>`).join("") +
    `</head><body>${MARKUP}</body></html>`);
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
    for (const raw of r.sel.split(",")) {
      const s = raw.trim();
      const states = (s.match(STATE) || []).join("");
      if (/hover|active/.test(states)) break;
      let base = s.replace(STATE, "").replace(/(^|[\s>+~])(?=$|[\s>+~])/g, "$1*").trim() || "*";
      let m = false;
      try { m = el.matches(base); } catch { break; }
      if (!m) break;
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
