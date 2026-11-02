/**
 * Six faults reported from the chart desk, pinned so they cannot come
 * back.
 *
 * Five of them were reproduced in a real browser before anything was
 * changed, and the numbers in the comments below are the measurements
 * that were taken then, not estimates. The sixth - the head gap - has
 * its own checks in ea-chart-ux.test.js, where the guards that used to
 * approve of the bug live.
 *
 * What is checked here is deliberately structural: these are CSS and
 * geometry faults, and the thing that makes them regress is someone
 * restating a rule rather than re-reading it.
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "apps", "web");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");

const chartCss = read("css/chart.css");
const toolsJs = read("js/chart-tools.js");
const chartsJs = read("js/charts.js");
const appJs = read("js/app.js");

const results = [];
function check(name, fn) {
  try {
    const note = fn();
    results.push(true);
    console.log("PASS  " + name + (note ? "  (" + note + ")" : ""));
  } catch (e) {
    results.push(false);
    console.log("FAIL  " + name + "\n      " + e.message.replace(/\n/g, "\n      "));
  }
}

/* ---------------------------------------------------------------- helpers */

/* Comments stripped and whitespace flattened, so a reformat cannot
   fail a check and a commented-out rule cannot pass one. Note that
   @media keeps the space after it: the flattener only strips space
   around punctuation, and a needle written without that space finds
   nothing at all rather than failing honestly. */
const flat = (css) => css
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/\s+/g, " ")
  .replace(/\s*([{};:,])\s*/g, "$1")
  .trim();

const CSS = flat(chartCss);

/* The body of a rule, matched on the WHOLE selector list. Searching for
   ".tv-rail{" would also match ".tv.pos-open .tv-rail{", which is how a
   check ends up reading a rule it was not looking at. */
function ruleBody(css, selector) {
  const sel = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp("(?:^|[}])" + sel + "\\{([^}]*)\\}");
  const m = re.exec(css);
  return m ? m[1] : null;
}

/* A declaration, anchored so that `width:28px` cannot be satisfied by
   `min-width:28px` - which is exactly how one of these guards passed
   against an unfixed control once already. */
function has(body, decl) {
  if (body == null) return false;
  const d = decl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp("(?:^|;)" + d + "(?:;|$)").test(body);
}

/* ================================= 1. the right-margin slider is gone ==== */

check("the bars-wide right-margin slider is gone from the chart", () => {
  /* A labelled range from 0 to 60 sitting on the chart itself, asking
     the trader to choose a number of bars - a unit whose meaning
     changes every time they zoom. One switch replaced it. */
  for (const dead of ["tv-margin", "tv-margin-r", "tv-margin-v"]) {
    if (toolsJs.includes(dead)) throw new Error(dead + " is still in the markup or the wiring");
  }
  if (/setRightMargin|rightMargin\(/.test(toolsJs + chartsJs)) {
    throw new Error("the bars-wide margin API survived the slider");
  }
  if (/\.tv-margin[\s{,]/.test(chartCss)) throw new Error("the slider's stylesheet rule is still here");
  return "markup, wiring, API and CSS";
});

check("the switch that replaced it is reachable and says what it is", () => {
  if (!/id="tv-headgap"/.test(toolsJs)) throw new Error("there is no head-gap control at all");
  const btn = /<button[^>]*id="tv-headgap"[\s\S]*?>/.exec(toolsJs);
  if (!btn) throw new Error("the control is not a button");
  if (!/aria-pressed=/.test(btn[0])) throw new Error("a toggle that never says whether it is on");
  if (!/aria-label=/.test(btn[0])) throw new Error("the button has no accessible name");

  /* Bound where it lives. It is in the header, and the chart's own
     delegated handler is attached to #tv-chartbox, which does not
     contain it - a click there would never arrive. */
  const top = toolsJs.slice(toolsJs.indexOf("/* ---- navigation"));
  if (/closest\("#tv-headgap"\)[\s\S]{0,80}setHeadGap/.test(top)) {
    throw new Error("the toggle is wired onto the chart box, which does not contain it");
  }
  if (!/closest\("#tv-headgap"\)/.test(toolsJs)) throw new Error("the toggle is never wired");
  return "button, pressed state, named, wired to the header";
});

check("the head gap is a fraction of the window, not a count of bars", () => {
  if (/RIGHT_MARGIN/.test(chartsJs)) throw new Error("the bars-wide constant is still there");
  if (!/static HEAD_GAP = 0\.15/.test(chartsJs)) throw new Error("the 15% constant is missing");
  if (!/Math\.round\(this\.span \* CandleChart\.HEAD_GAP\)/.test(chartsJs)) {
    throw new Error("the gap is not derived from the visible span");
  }
  /* And it is anchored to the newest bar: the offset is subtracted, so
     the gap is given back bar for bar as the chart is pulled into
     history. Without this line the gap follows the viewport, which is
     the fault that was reported. */
  if (!/want - Math\.max\(0, this\.offset\)/.test(chartsJs)) {
    throw new Error("the gap is not anchored to the newest bar");
  }
  return "0.15 of the span, minus the offset";
});

/* =============================== 2. the Positions tab left the panel ===== */

check("the side panel no longer carries a copy of the open book", () => {
  if (/data-pane="positions"/.test(toolsJs)) throw new Error("the pane is back");
  if (/id="tvd-pos"/.test(toolsJs)) throw new Error("the pane element is back");
  if (/tvd-pos-n/.test(toolsJs + appJs)) throw new Error("the tab's badge is back");
  const fn = appJs.slice(appJs.indexOf("function paintChartPositions"), appJs.indexOf("function bindCancelButtons"));
  if (/\$\("tvd-pos"\)/.test(fn)) throw new Error("the painter still writes into the removed pane");
  return "pane, badge and painter";
});

check("the book is still one tap from the chart", () => {
  /* Removing the duplicate must not remove the only route. */
  if (!/id="tv-pos-toggle"/.test(toolsJs)) throw new Error("nothing opens the dock");
  if (!/id="tv-posdock-body"/.test(toolsJs)) throw new Error("the dock has no body to paint into");
  if (!/closest\("#tv-pos-toggle"\)[\s\S]{0,60}togglePosDock/.test(toolsJs)) {
    throw new Error("the toolbar button is not wired to the dock");
  }
  return "toolbar button -> bottom dock";
});

check("the count on the toolbar button can actually be read", () => {
  /* It was a 14px square inside the 30px button, overlapping the glyph
     it annotated, with 3px of padding for a number that reaches two
     digits. It is a chip on the corner now, outside the button's box
     and ringed so it separates from whatever is behind it. */
  const chip = ruleBody(CSS, ".tv-icon-n");
  if (!chip) throw new Error(".tv-icon-n has no rule");
  const px = (d) => { const m = new RegExp("(?:^|;)" + d + ":(-?[\\d.]+)px").exec(chip); return m ? parseFloat(m[1]) : null; };
  if (!(px("min-width") >= 16)) throw new Error("the chip is too narrow for two digits: " + px("min-width"));
  if (!(px("height") >= 16)) throw new Error("the chip is shorter than it is wide");
  if (!(px("inset-block-start") < 0) || !(px("inset-inline-end") < 0)) {
    throw new Error("the chip still sits inside the button, on top of the icon");
  }
  if (!/border:2px solid/.test(chip)) throw new Error("the chip has no ring to separate it from the icon");
  if (!has(chip, "pointer-events:none")) throw new Error("the chip can swallow taps meant for the button");

  /* A chip that hangs outside its button needs the button not to clip
     it - the same rule that silently killed seven touch expanders. */
  const host = ruleBody(CSS, ".tv-icon");
  if (!has(host, "overflow:visible")) throw new Error(".tv-icon clips the chip that hangs off its corner");
  if (!has(host, "position:relative")) throw new Error(".tv-icon is not the chip's containing block");
  return "17px, on the corner, ringed, unclipped";
});

check("the count is capped and spoken", () => {
  const fn = appJs.slice(appJs.indexOf("function paintChartPositions"), appJs.indexOf("function bindCancelButtons"));
  if (!/n > 9 \? "9\+"/.test(fn)) throw new Error("a two-digit count is drawn into a 17px circle");
  if (!/setAttribute\("aria-label"/.test(fn)) throw new Error('a screen reader is told "9+"');
  /* The name is taken from the button, not looked up again. I18N.t()
     has no fallback and returns the key when it misses, and the key
     the markup uses for this button is not in the packs - so building
     the label here made a screen reader announce
     "chart.positions_dock (3)". Caught in a browser, pinned here. */
  if (/I18N\.t\("chart\.positions_dock"\)/.test(fn)) {
    throw new Error("the label is looked up by a key that is not in the packs");
  }
  if (!/toggle\.dataset\.name/.test(fn)) throw new Error("the base name is not taken from the button itself");
  if (!/chip\.hidden = n === 0/.test(fn)) throw new Error("the chip sits at zero instead of disappearing");
  return '9+ drawn, exact count announced';
});

/* ========== 3. the tools sheet and the positions dock are unrelated ====== */

check("opening the positions dock does not move the tools sheet", () => {
  /* Measured at 390px before the fix: with the tools sheet open the
     rail's bottom edge was at y=785. Opening the positions dock moved
     it to y=609 - the sheet the trader was reading jumped 176px up
     the screen, because it is anchored to the bottom of .tv-body and
     the dock is a grid row of .tv that shortens it.
     
     Pushing the sheet's own bottom down by exactly the dock's height
     cancels that out. */
  const body = ruleBody(CSS, ".tv.pos-open .tv-rail,.tv.pos-open .tv-toolscrim");
  if (!body) throw new Error("nothing compensates the sheet for the dock's row");
  if (!/inset-block-end:calc\(-1 \* var\(--tv-posdock/.test(body)) {
    throw new Error("the compensation is not the dock's own height: " + body);
  }
  /* The scrim has to move with it, or the dock sits above the scrim
     and takes taps that were meant to dismiss the sheet. */
  if (!/\.tv\.pos-open \.tv-toolscrim/.test(CSS)) throw new Error("the scrim does not cover the dock");
  return "sheet and scrim both offset by --tv-posdock";
});

check("nothing is left behind from the dock's resize", () => {
  /* This check used to require .tv.pos-sizing on the sheet, so it
     would not lag behind a dock being dragged taller. The dock is a
     fixed section now and nothing sets that class, so the rule it
     asked for would be dead CSS - and a stylesheet full of rules for
     behaviour that no longer exists is how the next person reads the
     wrong design out of it. */
  if (/pos-sizing/.test(CSS)) throw new Error("the resize-only rules outlived the resize");
  if (/tv-posdock-grip/.test(CSS)) throw new Error("the grip is still styled");
  /* The compensation that keeps the two independent is still needed:
     the dock still occupies a grid row, it just cannot be dragged. */
  if (!/\.tv\.pos-open \.tv-rail/.test(CSS)) throw new Error("the sheet no longer clears the dock at all");
  return "grip and sizing rules gone, offset kept";
});

check("the compensation is inside the phone block, where the sheet exists", () => {
  /* On a desktop the rail is a column, not a bottom sheet, and
     giving it a negative bottom offset there would push a static
     column off the bottom of the chart. */
  const i = CSS.indexOf(".tv.pos-open .tv-rail");
  if (i < 0) throw new Error("the rule is gone");
  const before = CSS.slice(0, i);
  const opens = (before.match(/@media /g) || []).length;
  if (opens === 0) throw new Error("the rule is not inside any media query");
  return "inside a media block";
});

/* ===================== 4. the tools sheet cannot be dragged off the top == */

check("an upward drag on a sheet is bounded, not merely resisted", () => {
  /* Measured before the fix: dragging the grab handle 240px up moved
     the sheet 34px up and it snapped back on release. The rubber band
     was -sqrt(-raw) * 2.2 with no ceiling, so pulling further always
     moved it further - which does not read as an edge, it reads as a
     sheet that can be dragged anywhere and then springs back for no
     reason. */
  if (!/const SHEET_PULL_UP_MAX = \d+;/.test(appJs)) throw new Error("there is no limit on the upward pull");
  const cap = parseInt(/const SHEET_PULL_UP_MAX = (\d+);/.exec(appJs)[1], 10);
  if (cap > 24) throw new Error("a " + cap + "px overshoot is not an edge, it is slack");
  if (cap < 4) throw new Error("no give at all reads as a dead control");
  if (!/dy = raw >= 0 \? raw : -Math\.min\(SHEET_PULL_UP_MAX, Math\.sqrt\(-raw\) \* 2\.2\)/.test(appJs)) {
    throw new Error("the limit is declared but not applied to the drag");
  }
  return cap + "px ceiling on the rubber band";
});

check("the limit holds however hard the sheet is pulled", () => {
  /* The formula, exercised directly: the old one is unbounded and
     the new one is not, and the difference only shows at distances a
     spot check at 50px would miss entirely. */
  const cap = parseInt(/const SHEET_PULL_UP_MAX = (\d+);/.exec(appJs)[1], 10);
  const dyOf = (raw) => (raw >= 0 ? raw : -Math.min(cap, Math.sqrt(-raw) * 2.2));
  for (const raw of [-10, -50, -240, -1000, -100000]) {
    const dy = dyOf(raw);
    if (dy < -cap) throw new Error(`a ${-raw}px pull lifted the sheet ${-dy.toFixed(1)}px, past the ${cap}px limit`);
  }
  /* Small pulls still give, or the edge feels dead rather than firm. */
  if (dyOf(-4) >= 0) throw new Error("a gentle pull does not move the sheet at all");
  if (dyOf(-4) <= -cap) throw new Error("a 4px pull already hits the stop");
  /* Downwards is untouched: that is the direction that closes it. */
  if (dyOf(300) !== 300) throw new Error("the downward drag was clamped too");
  return "bounded upwards at " + cap + "px, free downwards";
});

check("flatten is a thumb-sized target, and takes it from its own panel", () => {
  /* Measured, not assumed. An expander alone could not do this:
     .tv-posdock is overflow:hidden and the header is its first row,
     so a halo tall enough to reach 44px from a 26px button extended
     past the dock's top edge and was clipped - a hit test 8px above
     the button did not reach it while getComputedStyle reported the
     halo present and 44px tall.

     The header was given the room instead and the dock was given it
     back, so the list is no shorter than it was. */
  const coarse = CSS.slice(CSS.indexOf("@media (pointer:coarse){"));
  if (!coarse) throw new Error("there is no coarse-pointer block");
  const btn = ruleBody(coarse, ".tv-flatten");
  if (!btn) throw new Error(".tv-flatten is not grown for a thumb at all");
  const h = parseFloat(/(?:^|;)height:(\d+)px/.exec(btn)?.[1] || "0");
  const halo = ruleBody(coarse, ".tv-flatten::after");
  const ins = /(?:^|;)inset:(-?\d+)px (-?\d+)px/.exec(halo || "");
  if (!ins) throw new Error("the halo has no inset");
  const v = -parseFloat(ins[1]);
  /* inset resolves against the PADDING box, so a 1px border on each
     edge comes off the total - the reason -4px gave 42px and not 44. */
  const reach = h - 2 + 2 * v;
  if (reach < 44) throw new Error(`the target is ${reach}px tall, not 44`);
  /* And the dock is given back exactly what the header took, or the
     list is shorter on a phone than on a desktop. */
  const tv = ruleBody(coarse, ".tv");
  if (!/--tv-posdock:\s*\d+px/.test(tv || "")) throw new Error("the dock was not given the room back");
  const head = ruleBody(coarse, ".tv-posdock-head");
  const hh = parseFloat(/min-height:(\d+)px/.exec(head || "")?.[1] || "0");
  if (hh < h + 4) throw new Error(`a ${h}px button does not fit a ${hh}px header`);
  const base = parseFloat(/--tv-posdock:\s*(\d+)px/.exec(ruleBody(CSS, ".tv") || "")?.[1] || "0");
  const grown = parseFloat(/--tv-posdock:\s*(\d+)px/.exec(tv)[1]);
  if (grown - base < hh - 38) throw new Error("the dock grew by less than the header did");
  return `${reach}px tall, dock ${base} -> ${grown}`;
});

/* ============================ 5. the symbol button's label is centred ==== */

check("the symbol button centres its label both ways", () => {
  /* It was align-items:baseline with no justification: the caret is an
     SVG with no baseline of its own so it was placed by its bottom
     edge and rode low, and the whole group hugged the leading edge of
     a 121px button. */
  const body = ruleBody(CSS, ".tv-sym");
  if (!body) throw new Error(".tv-sym has no rule");
  if (has(body, "align-items:baseline")) throw new Error("the row is still aligned on a text baseline");
  if (!has(body, "align-items:center")) throw new Error("the row is not centred vertically");
  if (!has(body, "justify-content:center")) throw new Error("the label is not centred horizontally");
  return "align-items + justify-content: center";
});

check("nothing in the button opts out of that centring", () => {
  /* This check used to REQUIRE align-self:baseline on the text, so a
     14px instrument and an 11px timeframe would sit on one line. It
     was wrong, and it was wrong in the direction that hid the fault
     it was written alongside: in flexbox, baseline-aligned items are
     aligned to each other and the group is placed at the START of
     the cross axis. The text sat 1px from the top of a 32px button
     while the caret, centred, sat in the middle - measured at 8px
     off-centre and reported as "the text is at the top and looks
     bad".

     align-items:center on the row only centres children that have
     not opted out, so what has to be true is that none of them do. */
  if (/align-self:baseline/.test(ruleBody(CSS, ".tv-sym b") || "")) {
    throw new Error("the instrument is baseline-aligned, which pins it to the top of the button");
  }
  for (const sel of [".tv-sym b", ".tv-sym span", ".tv-sym b,.tv-sym span"]) {
    const body = ruleBody(CSS, sel);
    if (body && /align-self:(?!center)/.test(body)) {
      throw new Error(sel + " opts out of the row's centring: " + body);
    }
  }
  const caret = ruleBody(CSS, ".tv-sym-caret");
  if (!has(caret, "align-self:center")) throw new Error("the caret is not centred");
  if (!has(caret, "flex:none")) throw new Error("the caret can be squeezed when the symbol is long");
  return "no align-self overrides, caret centred";
});

check("the button carries the instrument and not the timeframe", () => {
  /* A third copy of the timeframe, inside the instrument button and
     unpressable, beside the segmented strip and the More menu that
     are both the timeframe and both work. */
  const btn = /<button[^>]*class="tv-sym"[\s\S]*?<\/button>/.exec(toolsJs);
  if (!btn) throw new Error("the symbol button is gone");
  if (/tv-tf-label/.test(btn[0])) throw new Error("the timeframe is back inside the symbol button");
  if (!/o\.symbol/.test(btn[0])) throw new Error("the button no longer shows the instrument");
  /* And the real timeframe controls are still there. */
  if (!/data-menu="tf"/.test(toolsJs)) throw new Error("the timeframe menu went with it");
  if (!/aria-label="\$\{esc\(tt\("markets\.timeframe"/.test(toolsJs)) {
    throw new Error("the timeframe strip went with it");
  }
  return "instrument only";
});

/* ------------------------------------------------------------------ result */

const failed = results.filter((x) => !x).length;
console.log("\nchart-desk-fixes: " + (failed ? failed + " FAILED of " : results.length + " of ") + results.length + " checks passed");
process.exit(failed ? 1 : 0);
