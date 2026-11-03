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

/* A lazy [\s\S]*?\} cannot slice a block that contains blocks, so
   brace-match the at-rule out by hand. */
const atRule = (body, prelude, needle) => {
  /* The sheet has three (pointer: coarse) blocks and flattening
     normalises the spelling of all of them, so "the first one" is the
     wrong one. Take the block that actually contains the rule under
     test, and say so when none does. */
  for (let i = body.indexOf(prelude + "{"); i >= 0; i = body.indexOf(prelude + "{", i + 1)) {
    let d = 0;
    for (let j = i + prelude.length; j < body.length; j++) {
      if (body[j] === "{") d++;
      else if (body[j] === "}" && --d === 0) {
        const block = body.slice(i, j + 1);
        if (!needle || block.includes(needle)) return block;
        break;
      }
    }
  }
  return "";
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
  /* And each card carries the same "Flatten all", from the same
     builder. Closing a book one row at a time is the thing a trader
     can least afford to do slowly, and a control that is on two of
     the three cards is worse than one that is on none - it teaches
     that the page you are on decides whether you can go flat. */
  const cardAt = appFlat.lastIndexOf("posCardHead(", at);
  ok(cardAt >= 0 && at - cardAt < 220,
    `#${id} sits under the shared card header`);
}

/* The header puts the title and the button on one line, with the
   button at the far end - not stacked, which would push the list
   down by a row's worth on the one card whose whole point is that it
   does not grow. */
{
  const head = ruleIn(flat, ".pos-head");
  ok(/display:flex/.test(head) && /align-items:center/.test(head),
    "the card header is a row, not a stack", head);
  ok(/flex:1 1 auto/.test(ruleIn(flat, ".pos-head h3")),
    "the title takes the slack, so the button sits at the far end");
}

/* A destructive button pressed in a hurry, on a phone. 26px is the
   desk size; touch gets the full target, and the halo is what pays
   for it without changing the header's rhythm. */
{
  const coarse = atRule(flat, "@media (pointer:coarse)", ".pos-flat{");
  ok(coarse !== "", "there is a touch block to grow it in");
  const btn = ruleIn(coarse, ".pos-flat");
  ok(/height:34px/.test(btn), "touch grows the flatten button", btn);
  ok(/position:relative/.test(btn),
    "the halo has something to be positioned against", btn);
  ok(/inset:-5px -4px/.test(ruleIn(coarse, ".pos-flat::after")),
    "and a halo carries it the rest of the way to 44px (measured 87x44 at 390)");
}

/* The header is one builder, not three copies of a button. */
ok(/function posCardHead\(/.test(app), "there is one card-header builder");
{
  const b = app.slice(app.indexOf("function posCardHead("));
  const body = b.slice(0, b.indexOf("\n}"));
  ok(/data-flatten/.test(body), "the header emits the flatten control");
  ok(/\bdisabled\b/.test(body),
    "it renders disabled, so it cannot be pressed before the book is known");
  ok(/I18N\.t\("exec\.close_all"\)/.test(body),
    "its label is translated, not hard-coded English");
}

/* Armed by the one function that already knows the row count, wired
   once, and going through the same flattenAll() as the header's
   emergency button and the chart dock's. */
{
  const i = app.indexOf("function armCardFlatten(");
  ok(i >= 0, "the flatten control is armed from the repaint");
  const body = app.slice(i, app.indexOf("\n}", i));
  ok(/\[data-flatten\]/.test(body), "it finds the control on the card");
  ok(/btn\.disabled = n === 0/.test(body),
    "an empty book disables it rather than leaving it live over nothing");
  ok(/dataset\.bound === "1"/.test(body) && /dataset\.bound = "1"/.test(body),
    "it binds once, so a repaint per tick cannot stack handlers");
  ok(/flattenAll\(/.test(body) && !/API\.post\(/.test(body),
    "it goes through flattenAll, so there is one confirmation and one endpoint");
  /* Order matters, and indexOf returns -1 for a line that is not
     there at all - which is smaller than any real index, so a naive
     comparison passes loudest exactly when the call has been
     deleted. Assert it exists first. */
  const armAt = app.indexOf("armCardFlatten(box, rows.length)");
  const emptyAt = app.indexOf("if (!rows.length) {", app.indexOf("function paintPositions("));
  ok(armAt >= 0, "the repaint arms the control");
  ok(armAt >= 0 && emptyAt >= 0 && armAt < emptyAt,
    "armed before the empty-book early return, or an emptied book leaves it live");
}

/* ---------- the markets copy gets the same treatment ---------- */
ok(/id="mk-pos">\$\{allPositions\(\)\.length/.test(app.replace(/\s+/g, " ")) &&
   /pos-pane/.test(app.slice(app.indexOf('id="mk-pos"'), app.indexOf('id="mk-pos"') + 260)),
  "the markets view's copy is the same pane, not a leftover table");

console.log(fails ? `\npositions phone: ${fails} FAILED` : "\npositions phone: all checks passed");
process.exit(fails ? 1 : 0);
