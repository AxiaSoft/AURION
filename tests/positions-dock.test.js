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
/* The one row builder, shared by the dock and by each chart card's
   position strip. It used to live inside paintChartPositions; the
   checks that read the markup read it here now. */
const BUILD = APP.slice(APP.indexOf("function positionsListHtml("),
                        APP.indexOf("function positionsStripBody("));
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
     have been less code and would have covered the candles.

     The row belongs to .tv-body, not to .tv. As a row of .tv it ran
     the width of the desk and took its height off the side panel as
     well as the chart. */
  const body = ruleOf(".tv-body");
  if (!/grid-template-rows:1fr 0/.test(body)) {
    throw new Error("the dock's row is not part of the base grid: " + body.slice(0, 140));
  }
  if (!/\.tv\.pos-open \.tv-body\{grid-template-rows:1fr var\(--tv-posdock\)\}/.test(FLAT)) {
    throw new Error("opening the dock does not give it a row");
  }
  if (/\.tv\.pos-open\{grid-template-rows:/.test(FLAT)) {
    throw new Error("the dock is back to being a row of the whole desk");
  }
});

check("the dock takes its height from the chart alone", () => {
  /* Issue 2 as reported: with positions open, the bottom quarter of
     the side panel was behind the dock and the panel stopped 203px
     short of the desk floor. The dock is placed in the chart's column
     and the panel spans both rows, so neither can reach the other.
     Placement has to be explicit: a second row makes auto-placement
     put these wherever they happen to fall. */
  const want = {
    ".tv-rail": /grid-row:1 \/ -1/,
    ".tv-stage": /grid-column:2/,
    ".tv-posdock": /grid-column:2/,
    ".tv-dock": /grid-row:1 \/ -1/,
  };
  for (const [sel, re] of Object.entries(want)) {
    const rule = FLAT.match(new RegExp("(?:^|[}])" + sel.replace(".", "\\.") + "\\{([^}]*)\\}"));
    if (!rule || !re.test(rule[1])) {
      throw new Error(sel + " is not placed on the grid explicitly: " + (rule ? rule[1] : "no such rule"));
    }
  }
});

check("the dock is written inside .tv-body, in the chart's column", () => {
  /* The CSS places it in column 2, and that only means the chart's
     column while the dock is a child of .tv-body. As a sibling of
     .tv-body - which is where it used to be written - the same
     declaration would place it in a column of .tv instead, and the
     side panel would be cut short again. */
  const i = TOOLS.indexOf('<div class="tv-body">');
  if (i < 0) throw new Error("the body wrapper is gone, so this check cannot mean anything");
  const j = TOOLS.indexOf('<footer class="tv-status"', i);
  const body = TOOLS.slice(i, j);
  const dock = body.indexOf('class="tv-posdock"');
  if (dock < 0) throw new Error("the positions dock is not inside .tv-body");
  if (dock > body.indexOf("${dockHtml(o)}")) {
    throw new Error("the dock is written after the side panel, so the two can swap columns");
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

check("the row animates open and shut, and nothing is left of the drag", () => {
  /* The second half of this used to require .tv.pos-sizing, which
     suppressed the row transition while the grip was held. There is
     no grip and no drag, so that rule would now be dead CSS matching
     a class nothing ever sets - and dead rules are how a stylesheet
     stops describing the thing it styles. */
  const body = ruleOf(".tv-body");
  const t = /transition:([^;}]*)/.exec(body || "");
  const gt = t && /grid-template-rows\s+([^,;}]+)/.exec(t[1]);
  if (!gt) throw new Error("the dock snaps instead of sliding");
  if (!/var\(--dur|\d*\.?\d+m?s/.test(gt[1]) || /^0s$/.test(gt[1].trim())) {
    throw new Error("the row has a transition with no duration, so it still snaps: " + gt[1]);
  }
  if (/pos-sizing/.test(FLAT)) throw new Error("the resize-only rule outlived the resize");
});

check("a shut dock is not reachable by tab or by a screen reader", () => {
  /* Its row is 0px, which hides it visually and nothing else. */
  if (!/\.tv:not\(\.pos-open\) \.tv-posdock\{visibility:hidden\}/.test(FLAT)) {
    throw new Error("the contents of a closed dock are still focusable");
  }
});

/* ------------------------------------------- the side panel is kept -- */

check("the side panel's copy of the book is gone, and gone cleanly", () => {
  /* The inverse of what this used to assert. The side panel's
     positions tab was removed on request: at phone width that panel
     is a 300px overlay on a 390px screen, so reading the book in it
     hid the chart the book belongs to, while this dock resizes the
     chart instead of covering it.

     Half a removal is the thing to guard against - a tab left
     pointing at a pane that no longer exists shows blank. */
  if (/"tvd-pos"/.test(TOOLS)) throw new Error("the side panel's container is back");
  if (/\["positions", tt\("chart\.positions"/.test(TOOLS)) {
    throw new Error("the side panel's positions tab is back");
  }
  if (/tvd-pos-n/.test(TOOLS)) throw new Error("the tab's badge outlived the tab");
  /* And this dock is still the one place it lives. */
  if (!/id="tv-posdock-body"/.test(TOOLS)) throw new Error("the dock's own container went too");
});

check("one renderer, one container", () => {
  /* There were two containers and this check existed to stop them
     drifting apart. There is one now, which is a stronger form of the
     same guarantee - but the renderer must not keep writing into the
     one that was removed, or it silently does half its work. */
  const fn = APP.slice(APP.indexOf("function paintChartPositions("),
                       APP.indexOf("/** Cancel a resting order"));
  if (/\$\("tvd-pos"\)/.test(fn)) throw new Error("the renderer still writes into the removed pane");
  if (!/const bottom = \$\("tv-posdock-body"\)/.test(fn)) {
    throw new Error("the bottom dock is not filled");
  }
  if (/\[side, bottom\]\.forEach/.test(fn)) throw new Error("the two-container loop survived the second container");
  /* The old renderer had two row templates. One is the point - and it
     now lives in positionsListHtml(), which the chart cards' strip
     draws from as well, so there is one row template for the whole
     desk rather than one per place a position is shown. */
  if ((BUILD.match(/const row = /g) || []).length !== 1) throw new Error("more than one row template");
  if (/const row = /.test(fn)) throw new Error("the dock kept a private copy of the row");
  if (!/positionsListHtml\(pos, ord\)/.test(fn)) throw new Error("the dock does not use the shared builder");
});

check("a row can be found again by its ticket", () => {
  /* The cards repaint a moving price by locating the row and
     rewriting its figures, rather than rebuilding the list and
     throwing away the close buttons' handlers and the trader's scroll
     position. That lookup is .tvp-row[data-ticket=...], so without
     the attribute the repaint silently matches nothing and the
     prices simply stop moving - which looks like a dead feed, not
     like a missing attribute. */
  if (!/data-ticket="\$\{esc\(String\(r\.ticket \|\| ""\)\)\}"/.test(BUILD)) {
    throw new Error("the row does not carry its ticket, so a repaint cannot find it");
  }
  if (!/\.tvp-row\[data-ticket=/.test(APP)) {
    throw new Error("nothing looks a row up by ticket, so the attribute is unused");
  }
});

check("the repaint is still signature-gated, and the gate still opens", () => {
  /* With two containers this guarded against one shared signature
     letting a painted panel suppress an empty dock. With one
     container the hazard that remains is the gate sticking: going
     empty must clear the signature, or refilling is swallowed. */
  const fn = APP.slice(APP.indexOf("function paintChartPositions("),
                       APP.indexOf("/** Cancel a resting order"));
  if (!/bottom\.dataset\.sig !== sig/.test(fn)) throw new Error("the repaint is not gated at all");
  if (!/bottom\.dataset\.sig = ""/.test(fn)) {
    throw new Error("an empty book leaves a stale signature that swallows the refill");
  }
});

/* ----------------------------------------------- counters and total -- */

check("two counters, because the list can be out of sight two ways", () => {
  /* It was three while the side panel carried a copy. The tab badge
     went with the tab, which makes the toolbar chip the only sign of
     an open trade while the dock is shut - so it matters more than it
     did, not less. */
  const fn = APP.slice(APP.indexOf("function paintChartPositions("),
                       APP.indexOf("/** Cancel a resting order"));
  ["tv-pos-toggle-n", "tv-posdock-n"].forEach((id) => {
    if (!fn.includes(id)) throw new Error("no counter for " + id);
  });
  if (fn.includes("tvd-pos-n")) throw new Error("the removed tab's counter is still being set");
  if (!/chip\.hidden = n === 0/.test(fn)) throw new Error("the chip sits at zero instead of going away");
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
  const fn = BUILD;
  if (!/tvp-head/.test(fn)) throw new Error("the list has no column headers");
  /* Defined is not emitted. The header was built and then left out of
     the list that gets returned, which reads as "there is a header"
     to anything that only greps for the class. */
  if (!/<div class="tvp-list">\$\{head\}/.test(fn)) {
    throw new Error("the header is built but never put in the list");
  }
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
  const fn = BUILD;
  /* BUY/SELL is written out, and the profit carries its own sign. */
  if (!/String\(r\.type \|\| dir\)\.toUpperCase\(\)/.test(fn)) {
    throw new Error("the direction is not stated in words");
  }
  if (!/\(x > 0 \? "\+" : ""\)/.test(fn)) throw new Error("a gain is not signed");
});

/* --------------------------------------------------------- the fold -- */

check("the list folds into labelled cards rather than overflowing a narrow container", () => {
  /* Keyed on the list's own width rather than the window's. The dock
     is 830px wide at 1440 and 540px with the side panel open at the
     same viewport, and a chart card holding the same list is 428px
     at 1440 but 725px at 900 - so the window never answered the
     question being asked, which is whether eight columns fit. */
  const fold = /@container tvp \(max-width:\s*\d+px\)\{([\s\S]*?)\}\s*(?:@|\.|$)/.exec(FLAT + "@");
  if (!fold) throw new Error("no narrow layout");
  const block = FLAT.slice(FLAT.indexOf("@container tvp"));
  const rowRule = /[{;}]\.tvp-row\{([^}]*)\}/.exec(block);
  if (!rowRule) throw new Error("the row is not restyled when the list is narrow");
  if (!/display:flex/.test(rowRule[1]) || !/flex-wrap:wrap/.test(rowRule[1])) {
    throw new Error("eight columns are left to overflow");
  }
  if (!/content:attr\(data-l\)/.test(FLAT)) throw new Error("the figures lose their names with the header");
  /* A list can only fold if something above it is measurable. */
  if (!/\.tv-posdock-body\s*\{[^}]*container:\s*tvp/.test(FLAT)) {
    throw new Error("the dock's body is not a query container, so its list never folds");
  }
});

check("the header is hidden by a selector that can actually beat the row", () => {
  /* Measured in a browser. The header carries BOTH classes, so
     `.tvp-head{display:none}` ties with `.tvp-row{display:flex}`
     beside it and loses on source order - the stylesheet read
     correctly and the header stayed on screen. */
  if (!/\.tvp-row\.tvp-head\{display:none\}/.test(FLAT)) {
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
  /* The class is doubled rather than hung off a .tv ancestor. The
     weight is the same (0,2,0) and it was only ever there for weight,
     but the ancestor also scoped these to the chart desk - and the
     same button is now in every chart card's position strip, where it
     was stuck at 22px. Measured 44.0x44.0 in a card at 390. */
  if (!/\.tv-pos-x\.tv-pos-x \{[^}]*width: 30px/.test(coarse)) {
    throw new Error("the close button stays at 22px on a phone");
  }
  if (!/\.tv-pos-x\.tv-pos-x::after \{[^}]*inset: -7px/.test(coarse)) {
    throw new Error("no halo, so the target is 30px and not 44");
  }
  if (/\.tv \.tv-pos-x/.test(coarse)) {
    throw new Error("the sizing is scoped to the chart desk again, leaving the cards' copy small");
  }
  /* 30 + 7 + 7 = 44. And the rows have to be far enough apart that two
     halos do not overlap and close the wrong trade. */
  if (!/\.tvp-row\.tvp-row:not\(\.tvp-head\) \{ padding-block: 9px \}/.test(coarse)) {
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

check("the dock is a section, not a drawer", () => {
  /* These two checks used to defend the resize: that the grip had
     keyboard arrows as well as a drag, and that the height was
     clamped between 96 and 420 and remembered.

     The dock is a fixed section now, by request. That removes the
     feature and with it every edge it had - a height restored from
     storage that no longer suits the window, a grip that is a 10px
     drag target, a separator role to explain a control that only
     existed to resize. What has to be true instead is that none of
     it is left half-removed. */
  if (/tv-posdock-grip/.test(TOOLS)) throw new Error("the grip is still in the markup");
  if (/posDockHeight|setPosDockHeight/.test(TOOLS)) throw new Error("the height setter survived the grip");
  if (/POSDOCK_MIN|POSDOCK_MAX/.test(TOOLS)) throw new Error("the clamp survived the thing it clamped");
  if (/aurion\.chart\.posdock\.h/.test(TOOLS)) throw new Error("the stored height is still being written");
  if (/tv-posdock-grip/.test(CSS)) throw new Error("the grip's stylesheet outlived the grip");
  /* And the one height it does open to is the stylesheet's, so there
     is not a constant in the script to be kept in step with it. */
  if (!/--tv-posdock:\s*\d+px/.test(CSS)) throw new Error("the dock has no declared height at all");
});

check("the dock can be flattened from the panel that shows the book", () => {
  if (!/id="tv-posdock-flat"/.test(TOOLS)) throw new Error("there is no close-all button");
  /* Disabled in the markup: it is painted enabled only once something
     is actually open, so the first frame cannot offer a destructive
     action against an empty book. */
  const btn = /<button[^>]*id="tv-posdock-flat"[\s\S]*?>/.exec(TOOLS);
  if (!btn || !/\bdisabled\b/.test(btn[0])) throw new Error("it starts live, before anything is known");

  const fn = APP.slice(APP.indexOf("function paintChartPositions("),
                       APP.indexOf("function bindCancelButtons"));
  if (!/flat\.disabled = pos\.length === 0/.test(fn)) {
    throw new Error("it is not armed and disarmed by what is actually open");
  }
  if (/flat\.disabled = n === 0/.test(fn)) {
    throw new Error("a resting order arms it, but flattening is not what cancels one");
  }
  if (!/flattenAll\("chart"\)/.test(fn)) throw new Error("it does not go through the shared flatten path");
});

check("there is one flatten path, not three", () => {
  /* The header's emergency button and the Execution page's had two
     copies of this between them and had already drifted - one
     reported a failure with a fallback message, the other showed
     `undefined` when the engine sent no error string. The chart's
     button would have been a third. */
  if (!/async function flattenAll\(reason\)/.test(APP)) throw new Error("there is no shared flatten");
  const posts = APP.match(/API\.post\("\/api\/flatten"/g) || [];
  if (posts.length !== 1) throw new Error(posts.length + " places post to /api/flatten");
  const fn = APP.slice(APP.indexOf("async function flattenAll(reason)"), APP.indexOf("function bindCloseButtons"));
  if (!/askConfirm\(/.test(fn)) throw new Error("flattening the account is not confirmed");
  if (!/danger: true/.test(fn)) throw new Error("the confirmation is not marked destructive");
  /* Asking is not the same as waiting for the answer. The first
     version of this check only required that askConfirm appeared,
     and a mutation that ignored its result - leaving the dialog on
     screen while the account was flattened behind it - went straight
     through. The answer has to gate the request. */
  if (!/const ok = await askConfirm\(/.test(fn)) throw new Error("the answer is not captured");
  if (!/if \(!ok\) return false;/.test(fn)) throw new Error("the confirmation's answer does not stop the flatten");
  if (fn.indexOf("if (!ok) return false;") > fn.indexOf('API.post("/api/flatten"')) {
    throw new Error("the account is flattened before the answer is checked");
  }
  if (!/catch \(err\)/.test(fn)) throw new Error("a failed flatten throws into the void");
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
