/**
 * The positions dock on the EA chart.
 *
 * The requirement was that open positions slide up from the bottom and
 * that the CHART RESIZES to make room, rather than a panel being
 * parked over it - the one part of a chart a position list would cover
 * is the most recent candles, which is the part the list is about. The
 * side panel keeps its own copy and is not touched.
 *
 * Most of what is pinned here is the difference between those two
 * things, because they look identical in a screenshot and only differ
 * in whether the canvas was given a new size.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const TOOLS = read("apps/web/js/chart-tools.js");
const APP = read("apps/web/js/app.js");
const CSS = read("apps/web/css/chart.css");
/* Comments name the classes they removed and the mistakes they record,
   so anything looking for a rule has to read the sheet without them. */
const BARE = CSS.replace(/\/\*[\s\S]*?\*\//g, "");
/* Collapsed hard: whitespace around every brace, colon, semicolon and
   comma goes too. Flattening only the newlines left `.tv {` with its
   space and `grid-template-rows: var(...)` with its, so every pattern
   below had to guess which spaces had survived - and the ones that
   guessed wrong reported missing rules that were plainly there. */
const FLAT = BARE
  .replace(/\s+/g, " ")
  .replace(/\s*([{};:,])\s*/g, "$1");


/**
 * Every rule body whose selector ends in `sel`.
 *
 * A plain /\.tvp-list\{([^}]*)\}/ matched `.tv .tvp-list{...}` - the
 * phone override, which comes first in the sheet - and reported that
 * the base rule declared no columns. There is more than one rule for
 * most of these selectors and the checks have to say which one they
 * mean.
 */
function rules(sel) {
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(FLAT))) {
    const sels = m[1].split(",").map((x) => x.trim());
    if (sels.some((x) => x === sel)) out.push(m[2]);
  }
  return out;
}
const ruleOf = (sel) => {
  const r = rules(sel);
  if (!r.length) throw new Error("no rule for " + sel);
  return r.join(";");
};

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

/* ------------------------------------------- a row, not an overlay -- */

check("the dock is a row of the grid, so opening it resizes the chart", () => {
  /* The whole of the requirement. An absolutely positioned panel would
     have been less code and would have covered the candles. */
  const base = [, ruleOf(".tv")];
  if (!/grid-template-rows:var\(--tv-bar\) 1fr 0 26px/.test(base[1])) {
    throw new Error("the dock's row is not part of the base grid: " + base[1].slice(0, 140));
  }
  if (!/\.tv\.pos-open\{grid-template-rows:var\(--tv-bar\) 1fr var\(--tv-posdock\) 26px\}/.test(FLAT)) {
    throw new Error("opening the dock does not give it a row");
  }
});

check("the dock is not positioned over the chart", () => {
  const rule = ruleOf(".tv-posdock");
  if (/position:(absolute|fixed)/.test(rule)) {
    throw new Error("the dock floats over the chart instead of taking room from it");
  }
});

check("the chart is repainted when the row changes size", () => {
  /* A canvas only re-measures when it paints, and the row animates, so
     the size at the end of the transition is not the size at the
     start. Without this the chart keeps the geometry it had when the
     dock opened and the candles are drawn at the wrong scale. */
  const fn = TOOLS.slice(TOOLS.indexOf("function togglePosDock("),
                         TOOLS.indexOf("function toggleDock("));
  if (!/redrawSoon\(\)/.test(fn)) throw new Error("opening the dock never repaints the chart");
});

check("the row animates, and stops animating while it is being dragged", () => {
  const base = ruleOf(".tv");
  if (!/transition:grid-template-rows/.test(base)) throw new Error("the dock snaps instead of sliding");
  if (!/\.tv\.pos-sizing\{transition:none\}/.test(FLAT)) {
    throw new Error("the row eases towards the finger instead of tracking it");
  }
});

check("a shut dock is not reachable by tab or by a screen reader", () => {
  /* Its row is 0px, which hides it visually and nothing else. */
  if (!/\.tv:not\(\.pos-open\) \.tv-posdock\{visibility:hidden\}/.test(FLAT)) {
    throw new Error("the contents of a closed dock are still focusable");
  }
});

/* ------------------------------------------- the side panel is kept -- */

check("the side panel still has its own positions tab", () => {
  if (!/"tvd-pos"/.test(TOOLS)) throw new Error("the side panel's container is gone");
  if (!/\["positions", tt\("chart\.positions"/.test(TOOLS)) {
    throw new Error("the side panel lost its positions tab");
  }
});

check("one renderer fills both, so the two cannot drift apart", () => {
  const fn = APP.slice(APP.indexOf("function paintChartPositions("),
                       APP.indexOf("/** Cancel a resting order"));
  if (!/const side = \$\("tvd-pos"\)/.test(fn)) throw new Error("the side panel is not filled");
  if (/const bottom = \$\("tv-posdock-body"\)/.test(fn) === false) {
    throw new Error("the bottom dock is not filled");
  }
  if (!/\[side, bottom\]\.forEach/.test(fn)) {
    throw new Error("the two containers are filled by separate code paths");
  }
  /* The old renderer had two row templates. One is the point. */
  if ((fn.match(/const row = /g) || []).length !== 1) throw new Error("more than one row template");
});

check("each container keeps its own signature, so one filling does not block the other", () => {
  /* Shared state here was a real hazard: a single `dock.dataset.sig`
     short-circuit meant that once the side panel had been painted, the
     bottom dock - opened later, still empty - was skipped as
     unchanged. */
  const fn = APP.slice(APP.indexOf("function paintChartPositions("),
                       APP.indexOf("/** Cancel a resting order"));
  if (!/if \(!el \|\| el\.dataset\.sig === sig\) return;/.test(fn)) {
    throw new Error("the containers do not each check their own signature");
  }
});

/* ----------------------------------------------- counters and total -- */

check("three counters, because the list can be out of sight three ways", () => {
  const fn = APP.slice(APP.indexOf("function paintChartPositions("),
                       APP.indexOf("/** Cancel a resting order"));
  ["tvd-pos-n", "tv-pos-toggle-n", "tv-posdock-n"].forEach((id) => {
    if (!fn.includes(id)) throw new Error("no counter for " + id);
  });
  if (!/e\.hidden = n === 0/.test(fn)) throw new Error("a counter sits at zero instead of going away");
});

check("the running total leaves out orders that have not filled", () => {
  /* A resting order has no profit. Counting it as zero would drag the
     total towards zero and read as a position that is doing nothing,
     rather than one that does not exist yet. */
  const fn = APP.slice(APP.indexOf("function paintChartPositions("),
                       APP.indexOf("/** Cancel a resting order"));
  const sum = fn.slice(fn.indexOf("const sumEl"), fn.indexOf("if (!n)"));
  if (!/pos\.map\(\(r\) => Number\(r\.profit\)\)/.test(sum)) throw new Error("the total is not built from positions");
  if (/ord/.test(sum)) throw new Error("resting orders are counted in the floating total");
  if (!/filter\(Number\.isFinite\)/.test(sum)) throw new Error("a missing profit becomes NaN in the total");
});

/* ------------------------------------------------- the list, redone -- */

check("the columns are declared once on the list, not on each row", () => {
  /* The old row carried its own `grid-template-columns: auto auto ...`,
     so every line sized its cells to its own content and no two
     numbers down a column were comparable. */
  const list = ruleOf(".tvp-list");
  if (!/grid-template-columns:/.test(list)) throw new Error("the list declares no columns");
  const row = ruleOf(".tvp-row");
  if (!/grid-template-columns:subgrid/.test(row)) {
    throw new Error("the row does not take its columns from the list: " + row.slice(0, 120));
  }
  if (!/grid-column:1 \/ -1|grid-column:1\/-1/.test(row)) throw new Error("the row does not span the list");
});

check("there is a header, and the per-cell prefixes it replaces are gone", () => {
  const fn = APP.slice(APP.indexOf("function paintChartPositions("),
                       APP.indexOf("/** Cancel a resting order"));
  if (!/tvp-head/.test(fn)) throw new Error("the list has no column headers");
  if (/<em class="sl">SL<\/em>/.test(fn) || /<em class="tp">TP<\/em>/.test(fn)) {
    throw new Error("the old per-line SL/TP prefixes are still printed on every row");
  }
  /* Headers come from the language packs, not from literals. */
  if (!/I18N\.t\("table\.symbol"\)/.test(fn)) throw new Error("the headers are not translated");
});

check("the header is sticky, so it survives scrolling the list", () => {
  const h = ruleOf(".tvp-head");
  if (!/position:sticky/.test(h)) throw new Error("the header scrolls away from its columns");
  if (!/background:/.test(h)) throw new Error("the rows scroll through the header");
});

check("figures are tabular, so digits line up down a column", () => {
  if (!/font-variant-numeric:tabular-nums/.test(FLAT)) {
    throw new Error("proportional digits make the column ragged");
  }
});

check("direction and profit are not told apart by colour alone", () => {
  const fn = APP.slice(APP.indexOf("function paintChartPositions("),
                       APP.indexOf("/** Cancel a resting order"));
  /* BUY/SELL is written out, and the profit carries its own sign. */
  if (!/String\(r\.type \|\| dir\)\.toUpperCase\(\)/.test(fn)) {
    throw new Error("the direction is not stated in words");
  }
  if (!/\(x > 0 \? "\+" : ""\)/.test(fn)) throw new Error("a gain is not signed");
});

/* --------------------------------------------------------- the fold -- */

check("the list folds into labelled cards rather than overflowing a phone", () => {
  const phone = /@media\s*\(max-width:\s*760px\)\s*\{[\s\S]*?\.tv \.tvp-row\{([^}]*)\}/.exec(FLAT);
  if (!phone) throw new Error("no phone layout");
  if (!/display:flex/.test(phone[1]) || !/flex-wrap:wrap/.test(phone[1])) {
    throw new Error("eight columns are left to overflow");
  }
  if (!/content:attr\(data-l\)/.test(FLAT)) throw new Error("the figures lose their names with the header");
});

check("the header is hidden by a selector that can actually beat the row", () => {
  /* Measured in a browser. The header carries BOTH classes, so
     `.tv .tvp-head{display:none}` tied with `.tv .tvp-row{display:flex}`
     below it and lost on source order - the stylesheet read correctly
     and the header stayed on screen. */
  if (!/\.tv \.tvp-row\.tvp-head\{display:none\}/.test(FLAT)) {
    throw new Error("the header is hidden at a weight that loses to the row rule");
  }
});

check("the phone rules outweigh the base rules they sit above", () => {
  /* The 760px block is near the top of the sheet, far above the .tvp-*
     base rules. A media query adds nothing to specificity, so a bare
     selector there does nothing at all. */
  const block = /@media\s*\(max-width:\s*760px\)\s*\{([\s\S]*?)\n\}/.exec(BARE);
  if (!block) throw new Error("no 760px block");
  /* A selector is "bare" when .tvp-… is the FIRST thing in it - i.e.
     it follows a brace or a comma, not an ancestor. Matching on any
     preceding whitespace counted `.tv .tvp-row` as bare, which is the
     weighted form this check exists to require. */
  const bare = [...block[1].matchAll(/(?:^|[{}])\s*(\.tvp-[\w-]+)[^{};]*\{/gm)]
    .map((m) => m[1]);
  if (bare.length) throw new Error("unweighted phone selectors: " + [...new Set(bare)].join(", "));
});

check("there is still exactly one 760px block in this sheet", () => {
  /* desk-layout slices the first one it finds; a second block is
     invisible to it and to anyone reading. */
  const n = (CSS.match(/@media\s*\(max-width:\s*760px\)/g) || []).length;
  if (n !== 1) throw new Error(n + " blocks at 760px");
});

/* ------------------------------------------------------------ touch -- */

check("the close button is a thumb-sized target where the pointer is coarse", () => {
  const coarse = BARE.split("@media (pointer: coarse) {").slice(1).join("\n");
  if (!/\.tv \.tv-pos-x \{[^}]*width: 30px/.test(coarse)) {
    throw new Error("the close button stays at 22px on a phone");
  }
  if (!/\.tv \.tv-pos-x::after \{[^}]*inset: -7px/.test(coarse)) {
    throw new Error("no halo, so the target is 30px and not 44");
  }
  /* 30 + 7 + 7 = 44. And the rows have to be far enough apart that two
     halos do not overlap and close the wrong trade. */
  if (!/\.tv \.tvp-row:not\(\.tvp-head\) \{ padding-block: 9px \}/.test(coarse)) {
    throw new Error("neighbouring halos can overlap");
  }
});

check("the coarse rules carry an ancestor, because the base rules are below them", () => {
  const i = BARE.indexOf("@media (pointer: coarse) {", BARE.indexOf(".tvp-list"));
  const j = BARE.indexOf(".tv-pos-x{");
  /* The base .tv-pos-x rule really is further down the sheet; that is
     why the override needs the weight. If it ever moves above, this
     check should be revisited rather than silently relaxed. */
  if (j > 0 && i > 0 && j < i) return "base rule now precedes the override";
  if (/\n  \.tv-pos-x \{/.test(BARE)) {
    throw new Error("an unweighted .tv-pos-x override cannot beat the base rule below it");
  }
});

check("the resize grip can be used without a pointing device", () => {
  const bind = TOOLS.slice(TOOLS.indexOf('const grip = $("tv-posdock-grip")'),
                           TOOLS.indexOf("the tool sheet is dragged shut"));
  if (!/keydown/.test(bind)) throw new Error("the grip is drag-only");
  if (!/ArrowUp/.test(bind) || !/ArrowDown/.test(bind)) throw new Error("the arrows do not resize it");
  if (!/role="separator"/.test(TOOLS)) throw new Error("the grip is not announced as a separator");
  if (!/tabindex="0"/.test(TOOLS)) throw new Error("the grip cannot be focused");
});

check("the height is clamped and remembered", () => {
  const fn = TOOLS.slice(TOOLS.indexOf("function posDockHeight("),
                         TOOLS.indexOf("function togglePosDock("));
  if (!/Math\.max\(POSDOCK_MIN, Math\.min\(POSDOCK_MAX/.test(fn)) {
    throw new Error("the dock can be dragged to any height, including over the whole chart");
  }
  if (!/write\(LS_POS_H/.test(fn)) throw new Error("the height is forgotten on reload");
  if (!/Number\.isFinite\(n\)/.test(fn)) throw new Error("a corrupt stored height becomes NaN");
});

check("the dock starts shut on a phone, and at the width where it folds", () => {
  if (!/togglePosDock\(posNarrow\(\) \? false : read\(LS_POS, "0"\) === "1"\)/.test(TOOLS)) {
    throw new Error("the dock opens by default on a small screen");
  }
  /* posNarrow exists because narrow() belongs to the other IIFE in
     this file and is not in scope in the controller. */
  const fn = TOOLS.slice(TOOLS.indexOf("function posNarrow("));
  if (!/max-width: 760px/.test(fn.slice(0, 220))) {
    throw new Error("the default disagrees with the width the list folds at");
  }
});

/* ----------------------------------------------------------- report -- */

if (fails.length) {
  console.log("\npositions-dock: " + fails.length + " check(s) failed");
  fails.forEach((f) => console.log("  x " + f));
  process.exitCode = 1;
} else {
  console.log("\npositions-dock: " + pass + " checks passed");
}
