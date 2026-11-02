/**
 * The positions table must not hide the close button on a phone.
 *
 * The card's own note in app.css records this fault being fixed once:
 * the table was squeezed into half a row, so the close button - the one
 * control on the screen that gets pressed in a hurry - sat behind a
 * horizontal scroll. It was fixed for the desk and left broken at phone
 * width. Measured on a 390px viewport before the change: the table was
 * 900px wide inside a 340px window and the close button rendered at
 * x=857, about 560px past the right edge.
 *
 * Worth being exact about the symptom, because the first description of
 * it was wrong: the page itself did not scroll sideways. The overflow
 * was contained inside .table-wrap, which is tidier and no more usable.
 *
 * Below 760 the row becomes a card and the cell becomes a labelled
 * line. That means the header row goes away, so the column names have
 * to come back per cell - and they come back from data-label through
 * CSS, never as an injected element, because paintPositions rewrites
 * cells with textContent on every tick.
 *
 *     node tests/positions-phone.test.js
 */
const fs = require("node:fs");

const css = fs.readFileSync("apps/web/css/app.css", "utf8");
const app = fs.readFileSync("apps/web/js/app.js", "utf8");
let fails = 0;
const ok = (c, m, d) => {
  if (!c) { fails++; console.log("FAIL " + m + (d ? "  — " + d : "")); }
  else console.log("ok   " + m + (d ? "  — " + d : "")); };

/* ---------- flatten, and select by whole selector ---------- */
const flat = css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, " ")
  .replace(/\s*([{};:,])\s*/g, "$1");

/** Everything inside the LAST @media (max-width:760px) that mentions .pos-card. */
function phoneBlock() {
  const re = /@media\s*\(max-width:760px\)\{/g;
  let m, best = "";
  while ((m = re.exec(flat))) {
    let i = m.index + m[0].length, depth = 1;
    const start = i;
    for (; i < flat.length && depth; i++) {
      if (flat[i] === "{") depth++;
      else if (flat[i] === "}") depth--;
    }
    const body = flat.slice(start, i - 1);
    if (body.includes(".pos-card") && body.length > best.length) best = body;
  }
  return best;
}
const phone = phoneBlock();
ok(phone !== "", "there is a phone block that styles .pos-card");

const ruleIn = (body, sel) => {
  const m = body.match(new RegExp("(?:^|[}])" +
    sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\{([^}]*)\\}"));
  return m ? m[1] : "";
};

/* ---------- the 900px grid is gone at phone width ---------- */
ok(/\.pos-card table\{[^}]*min-width:900px/.test(flat),
  "the desk table still declares its 900px floor (the desk is not the fault)");
const tbl = ruleIn(phone, ".pos-card table");
ok(/min-width:0/.test(tbl), "the 900px floor is lifted on a phone", tbl);
ok(/display:block/.test(tbl), "the table stops laying out as a table", tbl);
ok(/table-layout:auto/.test(tbl),
  "fixed layout with percentage columns would re-impose the wide grid", tbl);

/* ---------- rows become cards, header goes, labels come back ---------- */
ok(/display:none/.test(ruleIn(phone, ".pos-card colgroup,.pos-card thead")),
  "the header row and the column widths are both dropped");
const tr = ruleIn(phone, ".pos-card tbody tr");
ok(/display:block/.test(tr), "each row is its own block");
ok(/border-radius/.test(tr) && /border:/.test(tr),
  "a row reads as a card, so three positions do not run together");

const before = ruleIn(phone, '.pos-card tbody td::before');
ok(/content:attr\(data-label\)/.test(before),
  "the column name comes back on every cell — a nameless column of numbers is not a smaller table");
ok(/font-family:var\(--font\)/.test(before),
  "the label is set in the UI face, not inherited from the cell's monospace");
ok(/color:var\(--muted\)/.test(before),
  "the label is quieter than its value");

/* ---------- and the label survives a price tick ---------- */
ok(/data-label="\$\{esc\(label\(k\)\)\}"/.test(app),
  "the label travels on the cell as an attribute");
const paint = app.slice(app.indexOf("function paintPositions"),
  app.indexOf("function paintPositions") + 1600);
ok(/td\.textContent = text/.test(paint),
  "paintPositions still updates cells with textContent (the reason the label is CSS)");
/* The fast path only: from the signature match to the full rebuild.
   An earlier version of this check sliced everything after the match,
   swallowed the legitimate rebuild below it and failed on correct
   code - the guard was the bug, not the renderer. */
const fast = paint.slice(paint.indexOf("box.dataset.sig === sig"),
  paint.indexOf("box.dataset.sig = sig;"));
ok(fast.length > 0 && !/innerHTML/.test(fast),
  "the per-tick path does not rebuild cell markup, so data-label is never lost");
ok(/box\.innerHTML = table\(rows, keys, closable\)/.test(paint),
  "a changed book is rebuilt through table(), which is what puts the labels there");

/* ---------- the close button is reachable and big enough ---------- */
const act = ruleIn(phone, ".pos-card tbody td.c-act .btn");
ok(/width:100%/.test(act), "the close button spans the row card", act);
ok(/min-height:44px/.test(act),
  "the close button clears the 44px touch target", act);
ok(/class="c-act"/.test(app) || /c-act/.test(app),
  "the action cell is marked so it can be styled without relying on :last-child");

/* ---------- the overflow it was hiding behind is gone ---------- */
ok(/overflow-x:visible/.test(ruleIn(phone, ".pos-card .table-wrap")),
  "nothing scrolls sideways any more");
ok(/max-height:none/.test(ruleIn(phone, ".pos-card .table-wrap")),
  "the 560px cap is lifted — a stacked row card is much taller than a table row");

/* ---------- the instrument titles its card ---------- */
const sym = ruleIn(phone, '.pos-card tbody td[data-k="symbol"]');
ok(/font-weight:6/.test(sym), "the instrument reads as the row's title");
ok(/content:none/.test(ruleIn(phone, '.pos-card tbody td[data-k="symbol"]::before')),
  "the title is not labelled 'Symbol' — it is self-evident");

/* ---------- the markets copy of the card gets it too ---------- */
ok(!/\.pos-card:not\(\.mk-pos\)/.test(phone),
  "the rules are not narrowed away from the markets view's copy of the table");

console.log(fails ? `\npositions phone: ${fails} FAILED` : "\npositions phone: all checks passed");
process.exit(fails ? 1 : 0);
