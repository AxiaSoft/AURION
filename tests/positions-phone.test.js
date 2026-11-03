/**
 * The positions list must not hide the close button on a phone.
 *
 * The reported fault: the Command Centre's positions table was 900px
 * wide inside a 340px window, so the close button - the one control on
 * the screen that gets pressed in a hurry - rendered at x=857, roughly
 * 560px past the right edge, behind a horizontal scroll inside
 * .table-wrap. It was answered by folding the table below 760px: every
 * row became a small card and every cell a labelled line fed from
 * data-label, in CSS rather than injected, because paintPositions
 * rewrote cells with textContent on every tick.
 *
 * There is no table any more. The "open positions" cards draw the EA
 * chart's own .tvp-row list, from the one builder the chart desk and
 * the chart cards share, inside a .pos-pane that is capped and scrolls
 * DOWN. So this suite no longer guards the fold - it guards that the
 * fault it was written for cannot come back in the new shape:
 *
 *   - nothing in the positions pane scrolls sideways,
 *   - the list folds on its own width, with the figures labelled,
 *   - the close control is a 44px target at a coarse pointer,
 *   - and the table machinery is gone rather than lying dead.
 *
 * Measured after the change at 390px: page scrollWidth 390 = clientWidth
 * 390, pane 340 wide with its content scrolling vertically, close
 * target 44.0x44.0.
 *
 *     node tests/positions-phone.test.js
 */
const fs = require("node:fs");

const css = fs.readFileSync("apps/web/css/app.css", "utf8");
const app = fs.readFileSync("apps/web/js/app.js", "utf8");
const chartCss = fs.readFileSync("apps/web/css/chart.css", "utf8");
let fails = 0;
const ok = (c, m, d) => {
  if (!c) { fails++; console.log("FAIL " + m + (d ? "  — " + d : "")); }
  else console.log("ok   " + m + (d ? "  — " + d : "")); };

/* ---------- flatten, and select by whole selector ---------- */
const flat = css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, " ")
  .replace(/\s*([{};:,])\s*/g, "$1");
const chartFlat = chartCss.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, " ")
  .replace(/\s*([{};:,])\s*/g, "$1");

const ruleIn = (body, sel) => {
  const m = body.match(new RegExp("(?:^|[},;])" +
    sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\{([^}]*)\\}"));
  return m ? m[1] : "";
};

/* ---------- the 900px table that caused it is gone ---------- */
ok(!/\.pos-card table\{/.test(flat),
  "the positions card no longer lays out a table at all");
ok(!/min-width:900px/.test(ruleIn(flat, ".pos-card table")),
  "and the 900px floor went with it");
ok(!/\.pos-card tbody td::before\{/.test(flat),
  "the data-label fold is gone too - it was the workaround, not the fix");
ok(!/\.pos-card col\.c-/.test(flat),
  "and the eleven declared column widths are not left behind");

/* ---------- nothing scrolls sideways ---------- */
const pane = ruleIn(flat, ".pos-pane");
ok(pane !== "", "there is a pane around the positions list");
ok(/overflow-x:hidden/.test(pane),
  "the pane cannot scroll sideways, which is where the close button hid", pane);
ok(/overflow-y:auto/.test(pane),
  "it scrolls down instead", pane);
ok(/max-block-size:/.test(pane),
  "and it is capped, so thirty open trades cannot push the page apart", pane);

/* ---------- the list folds on its own width, labels and all ---------- */
const at = chartFlat.search(/@container tvp \(max-width:\d+px\)\{/);
ok(at >= 0, "the list has a narrow layout");
let fold = "";
if (at >= 0) {
  let depth = 0;
  const open = chartFlat.indexOf("{", at);
  for (let i = open; i < chartFlat.length; i++) {
    if (chartFlat[i] === "{") depth++;
    else if (chartFlat[i] === "}" && --depth === 0) { fold = chartFlat.slice(open + 1, i); break; }
  }
}
ok(/display:flex/.test(ruleIn(fold, ".tvp-row")) && /flex-wrap:wrap/.test(ruleIn(fold, ".tvp-row")),
  "a narrow pane stacks the row instead of leaving eight columns to overflow");
ok(/\.tvp-row\.tvp-head\{display:none\}/.test(fold),
  "the column headers go when there are no columns to head");
ok(/content:attr\(data-l\)/.test(fold),
  "and each figure says what it is, from CSS - never injected, because a repaint rewrites text");
ok(/container:tvp\/inline-size/.test(pane.replace(/\s/g, "")) ||
   /container:tvp \/ inline-size/.test(pane),
  "the pane is the container the list measures itself against", pane);

/* ---------- the close control is a thumb-sized target ---------- */
const coarse = chartFlat.split("@media (pointer:coarse){").slice(1).join(" ");
ok(/\.tv-pos-x\.tv-pos-x\{[^}]*width:30px/.test(coarse),
  "the close button is grown at a coarse pointer");
ok(/\.tv-pos-x\.tv-pos-x::after\{[^}]*inset:-7px/.test(coarse),
  "and carries a halo - 30 + 7 + 7 = 44");
ok(!/\.tv \.tv-pos-x/.test(coarse),
  "the sizing is not scoped back to the chart desk, which would leave the cards' copy at 22px");

/* ---------- the repaint still patches rather than rebuilds ---------- */
const paint = app.slice(app.indexOf("function paintPositions"),
  app.indexOf("function tickLabel"));
ok(/if \(el\.textContent !== text\) el\.textContent = text;/.test(paint),
  "paintPositions updates figures with textContent (the reason the label is CSS)");
const fast = paint.slice(paint.indexOf("box.dataset.sig === sig"),
  paint.indexOf("box.dataset.sig = sig;"));
ok(fast.length > 0 && !/innerHTML/.test(fast),
  "the per-tick path does not rebuild markup, so data-l is never lost");
ok(/positionsListHtml\(rows, \[\]\)/.test(paint),
  "a changed book is rebuilt through the one shared list builder");

/* ---------- every one of the three cards, not just the one ---------- */
/* The Command Centre's, the Markets page's and the Execution one's.
   Each was its own table with its own column list, which is how they
   drifted apart in the first place; a check that only looks at one of
   them would let the next one quietly go back. */
const appFlat = app.replace(/\s+/g, " ");
for (const id of ["live-pos", "mk-pos", "live-exec-pos"]) {
  const at = appFlat.indexOf(`id="${id}"`);
  const seg = at < 0 ? "" : appFlat.slice(at, at + 300);
  ok(at >= 0 && /pos-pane/.test(seg) && /positionsListHtml\(/.test(seg),
    `#${id} draws the shared list inside a capped pane`);
  ok(at >= 0 && !/\btable\(/.test(seg),
    `#${id} is not a table any more`);
}

/* ---------- the markets copy gets the same treatment ---------- */
ok(/id="mk-pos">\$\{allPositions\(\)\.length/.test(app.replace(/\s+/g, " ")) &&
   /pos-pane/.test(app.slice(app.indexOf('id="mk-pos"'), app.indexOf('id="mk-pos"') + 260)),
  "the markets view's copy is the same pane, not a leftover table");

console.log(fails ? `\npositions phone: ${fails} FAILED` : "\npositions phone: all checks passed");
process.exit(fails ? 1 : 0);
