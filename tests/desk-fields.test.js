/**
 * Two field complaints from the desk.
 *
 *   1. On the prop-risk page the "min time in trade" input sat lower
 *      than the inputs beside it. Not a stray margin: that label is the
 *      longest on the page in Persian -- the name plus its "0 = off"
 *      note comes to 49 characters, ten more than the next -- so it
 *      wrapped to an extra line, and because a grid item fills from the
 *      top, the extra line pushed its input down. The ask was that
 *      every control in a row sit on exactly one line, "not higher, not
 *      lower, not further left, not further right".
 *
 *   2. Every search box took "an ugly square shape" when clicked. There
 *      were seven of them and no two were built the same way; the ones
 *      left as a bare input[type=search] never had their native skin
 *      reset, so clicking one showed the browser's own square widget
 *      and focus ring.
 *
 * Both are layout, and jsdom cannot do layout -- it reports every box as
 * zero by zero. So these check the rules that decide the layout rather
 * than the pixels: that the label can no longer push the input down
 * whatever it contains, and that one shell owns the look of every
 * search box. The length of the Persian labels is measured from the
 * real language file, so the premise of (1) is re-checked rather than
 * assumed.
 *
 *     node tests/desk-fields.test.js
 */

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const WEB = path.join(ROOT, "apps", "web");
const read = (p) => fs.readFileSync(path.join(WEB, p), "utf8");

const appCss = read("css/app.css");
const skinsCss = read("css/skins.css");
const appJs = read("js/app.js");
const chartJs = read("js/chart-tools.js");
const fa = JSON.parse(fs.readFileSync(path.join(ROOT, "lang", "fa.json"), "utf8"));

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

/**
 * Every declaration that applies to exactly this selector, joined.
 *
 * Matching the selector as a substring is not good enough: ".num-wrap"
 * is inside ".pr-grid .field > .num-wrap", and ".pr-grid" is inside
 * both. A rule is only counted when the selector appears as a whole
 * entry in that rule's comma-separated selector list. Declarations are
 * joined because a selector is legitimately written more than once --
 * the base rule in one place and an override in another.
 */
function rule(css, selector) {
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(bare))) {
    const sels = m[1].split(",").map((s) => s.trim().replace(/\s+/g, " "));
    if (sels.includes(selector)) out.push(m[2].replace(/\s+/g, " ").trim());
  }
  return out.length ? out.join(" ") : null;
}

/* ---------------------------------------------------------------- 1 */

check("the premise still holds: min-hold really is the longest label", () => {
  // If this ever stops being true the fix is still right, but the
  // reported symptom would have moved, so it is worth knowing.
  const withNote = (key) =>
    (fa.risk[key] || "").length + (fa.risk.u_zero_off || "").length;
  const lens = {
    min_hold: withNote("min_hold"),
    max_hold: withNote("max_hold"),
    gap: (fa.risk.gap || "").length,
    hours_start: (fa.risk.hours_start || "").length,
  };
  if (!lens.min_hold) throw new Error("risk.min_hold is missing from fa.json");
  if (lens.min_hold <= lens.max_hold) {
    throw new Error("min_hold (" + lens.min_hold + ") is no longer the longest");
  }
  return "min_hold " + lens.min_hold + " chars vs max_hold " + lens.max_hold;
});

check("a field's input is pinned to the bottom, so a long label cannot push it", () => {
  const body = rule(appCss, ".pr-grid .field");
  if (!body) throw new Error("the prop grid does not lay its fields out at all");
  if (!/display:\s*grid/.test(body)) throw new Error("the field is not a grid");
  const rows = /grid-template-rows:([^;]+)/.exec(body);
  if (!rows) throw new Error("no explicit rows, so the label still dictates where the input lands");
  // The slack row is what does the work: it absorbs the difference
  // between a one-line and a three-line label.
  if (!/\d*fr\b/.test(rows[1])) {
    throw new Error("no flexible row to absorb a taller label: " + rows[1].trim());
  }
  const wrap = rule(appCss, ".pr-grid .field > .num-wrap");
  if (!wrap || !/grid-row:\s*3/.test(wrap)) {
    throw new Error("the input is not placed after the slack row");
  }
  return "rows " + rows[1].trim() + ", input on row 3";
});

check("the grid stretches its fields, or equal rows would never happen", () => {
  const body = rule(appCss, ".pr-grid");
  if (!/align-items:\s*stretch/.test(body || "")) {
    throw new Error("fields are not stretched to a common height: " + body);
  }
  // Each field must fill the cell it was stretched to, otherwise the
  // slack row has nothing to absorb.
  const f = rule(appCss, ".pr-grid .field");
  if (!/block-size:\s*100%/.test(f)) throw new Error("the field does not fill its cell");
  return "stretch + block-size:100%";
});

check("the trailing broker note cannot make a time field taller than a plain one", () => {
  // propTime appends <small class="prop-at-broker"> and propNum does
  // not. Without a reserved row that alone would offset the two kinds.
  if (!/\.pr-grid \.field::after\{[^}]*min-block-size/.test(appCss.replace(/\s*\n\s*/g, ""))) {
    throw new Error("no reserved row for the footnote");
  }
  const note = rule(appCss, ".pr-grid .field > .prop-at-broker");
  if (!note || !/grid-row:\s*4/.test(note)) {
    throw new Error("the broker note is not placed on the reserved row");
  }
  return "row 4 reserved on every field";
});

check("the unit sits inside the box, at the end of the number, without wrapping", () => {
  /* Retargeted, because this was testing a rule that never ran.
     It asserted a flex row on a bare `.num-wrap` in app.css. That rule
     existed, but `.num-field .num-wrap` in skins.css is (0,2,0) against
     its (0,1,0) and skins.css is loaded second, so every desk has always
     rendered the overlay instead: the wrapper is position:relative, the
     input reserves room at its end, and the unit is absolutely placed in
     that room. The flex rules have been deleted and this now checks the
     layout that actually applies.
     The seat itself - digits left, suffix right, in every language - is
     covered in tests/number-fields.test.js. */
  const wrap = rule(skinsCss, ".num-field .num-wrap");
  if (!wrap) throw new Error(".num-field .num-wrap has no rule at all");
  if (!/position:\s*relative/.test(wrap)) throw new Error("the wrapper is not a positioning context: " + wrap);
  const input = rule(skinsCss, ".num-field .num-wrap input");
  if (!/padding-right:\s*var\(--unit-gap/.test(input || "")) {
    throw new Error("no room reserved for the suffix at the end of the value: " + input);
  }
  const unit = rule(skinsCss, ".num-field .num-unit");
  if (!/position:\s*absolute/.test(unit || "")) throw new Error("the unit is not placed in that room");
  if (!/white-space:\s*nowrap/.test(unit || "")) throw new Error("the unit may still wrap");
  return "overlay suffix, room reserved, nowrap";
});

check("the field no longer carries the bottom margin the grid already spaces", () => {
  const body = rule(appCss, ".pr-grid .field");
  if (!/margin-block-end:\s*0/.test(body)) {
    throw new Error(".field's 14px bottom margin is still in play inside the grid");
  }
  return "margin-block-end:0";
});

/* ---------------------------------------------------------------- 2 */

// Every search box on the desk, and where it lives.
const SEARCHES = [
  ["ex-sym / bt-sym picker", appJs, "${id}-q"],
  ["markets picker", appJs, "${pick}-q"],
  ["prop allowed symbols", appJs, 'id="pr-syms-q"'],
  ["prop guide", appJs, 'id="prop-guide-q"'],
  ["EA chart grid", appJs, 'id="ch-q"'],
  ["terminal filter", appJs, 'id="log-q"'],
  ["chart symbol menu", chartJs, 'id="tv-sym-q"'],
  ["chart indicator menu", chartJs, 'id="tv-ind-q"'],
];

/** The class tokens used anywhere in a slice of markup. */
function classes(html) {
  const out = new Set();
  const re = /class="([^"]*)"/g;
  let m;
  while ((m = re.exec(html))) for (const c of m[1].split(/\s+/)) if (c) out.add(c);
  return out;
}

check("every search box on the desk uses the one shared field", () => {
  // Checked as whole class tokens. A substring test passes even with
  // the shell removed, because "dsk-search-i" on the input contains
  // "dsk-search" -- which is exactly the half-done state this is meant
  // to catch. Both halves have to be there: the shell that draws the
  // border and ring, and the stripped input inside it.
  const noShell = [];
  const noInput = [];
  for (const [name, src, needle] of SEARCHES) {
    const i = src.indexOf(needle);
    if (i < 0) throw new Error("cannot find the " + name + " box any more");
    // The input and the shell that wraps it are within a line or two.
    const seen = classes(src.slice(Math.max(0, i - 400), i + 200));
    if (!seen.has("dsk-search")) noShell.push(name);
    if (!seen.has("dsk-search-i")) noInput.push(name);
  }
  if (noShell.length) throw new Error("no shared shell around: " + noShell.join(", "));
  if (noInput.length) throw new Error("input not stripped in: " + noInput.join(", "));
  return SEARCHES.length + " boxes, shell + input on each";
});

check("every one of them is a real search input", () => {
  const bad = [];
  for (const [name, src, needle] of SEARCHES) {
    const i = src.indexOf(needle);
    const around = src.slice(Math.max(0, i - 400), i + 200);
    if (!/type="search"/.test(around)) bad.push(name);
  }
  if (bad.length) throw new Error("not type=search: " + bad.join(", "));
  return "all " + SEARCHES.length;
});

check("the native search skin is stripped, which is what drew the square", () => {
  const flat = appCss.replace(/\s*\n\s*/g, "");
  if (!/input\[type="search"\]\{[^}]*appearance:none/.test(flat)) {
    throw new Error("input[type=search] keeps its native appearance");
  }
  // WebKit's clear button is part of the same native widget and shows
  // as a second square once the field has text.
  if (!/::-webkit-search-cancel-button/.test(appCss)) {
    throw new Error("the native clear button is still drawn");
  }
  return "appearance:none + cancel button removed";
});

check("the shell draws the focus ring, not the input inside it", () => {
  // This is the actual fix for "it goes square when clicked": the ring
  // has to be on the rounded shell, because the input has no border.
  const ring = rule(appCss, ".dsk-search:focus-within");
  if (!ring) throw new Error("no focus-within rule on the shell");
  if (!/box-shadow/.test(ring)) throw new Error("the shell shows no ring when focused");
  if (!/border-color/.test(ring)) throw new Error("the shell's border does not respond");
  const inner = rule(appCss, ".dsk-search-i");
  if (!/outline:\s*none/.test(inner || "")) {
    throw new Error("the inner input can still draw its own outline");
  }
  return "ring on the shell, outline off the input";
});

check("the shell is rounded, so there is no square to see", () => {
  const body = rule(appCss, ".dsk-search");
  if (!/border-radius/.test(body || "")) throw new Error("no radius on the shell");
  const sm = rule(appCss, ".dsk-search.sm");
  if (!/border-radius/.test(sm || "")) throw new Error("the compact variant has no radius");
  return "radius on both sizes";
});

check("the one-off chrome it replaced was removed, not just bypassed", () => {
  // Leaving the old rules behind is how a second look creeps back in.
  for (const dead of [".ch-q{", ".ch-find-x{", ".sym-q{", ".sympick-q{"]) {
    if (appCss.includes(dead)) throw new Error("dead rule still present: " + dead);
  }
  const skins = read("css/skins.css");
  if (skins.includes(".sym-q{")) throw new Error("skins.css still styles the old .sym-q");
  if (appJs.includes("sympick-q") || appJs.includes('class="sym-q"')) {
    throw new Error("the markup still carries a class nothing styles");
  }
  return "4 one-off blocks gone";
});

check("the shared field is written for RTL", () => {
  const body = rule(appCss, ".dsk-search");
  if (/padding-left|padding-right/.test(body || "")) {
    throw new Error("physical padding would put the icon on the wrong side in Persian");
  }
  if (!/padding-inline/.test(body || "")) throw new Error("no logical padding");
  return "padding-inline";
});

/* ------------------------------------------------------------------ */

const passed = results.filter(Boolean).length;
const failed = results.length - passed;
console.log(
  "\ndesk-fields: " + (failed ? failed + " FAILED of " : "") +
  passed + " of " + results.length + " checks passed"
);
process.exit(failed ? 1 : 0);
