/**
 * The three-up form grids, resolved at real viewport widths.
 *
 * Reported on a phone: the symbol / timeframe / strategy controls on the
 * backtest ran into each other. The markup was fine and the media query
 * that should have fixed it was present - but `.ct-grid-3` was declared
 * again, unconditionally, ~90 lines AFTER that media query. Same
 * selector, same specificity, so the later rule won at every width and
 * the responsive rule had never once applied.
 *
 * Grepping for the media query would therefore have "passed" for the
 * entire life of the bug. These checks resolve the cascade for concrete
 * widths instead, and separately forbid the source-order trap that
 * caused it.
 *
 *     node tests/form-grid.test.js
 */
const fs = require("node:fs");
const path = require("node:path");

const cssPath = path.join(__dirname, "..", "apps/web/css/app.css");
const raw = fs.readFileSync(cssPath, "utf8");
// A checker that does not strip comments will lie: a selector mentioned
// inside a /* */ block is not a rule.
const css = raw.replace(/\/\*[\s\S]*?\*\//g, "");

let failed = 0;
const ok = (c, m) => { if (!c) { failed++; console.log("FAIL " + m); } else console.log("ok   " + m); };

/* ------------------------------------------------- a small cascade model */

/** Flatten to rules in source order, descending into @media. */
function blocks(src, cond, out, depth) {
  out = out || [];
  let i = 0;
  while (i < src.length) {
    const b = src.indexOf("{", i);
    if (b < 0) break;
    let d = 1;
    let j = b + 1;
    for (; j < src.length && d; j++) {
      if (src[j] === "{") d++;
      else if (src[j] === "}") d--;
    }
    const head = src.slice(i, b).trim();
    const body = src.slice(b + 1, j - 1);
    if (head.startsWith("@media")) {
      blocks(body, (cond ? cond + " and " : "") + head.replace("@media", "").trim(), out, (depth || 0) + 1);
    } else if (!head.startsWith("@")) {
      out.push({ sel: head, body, cond: cond || "" });
    }
    i = j;
  }
  return out;
}

/** Does a media condition hold at this viewport width? */
function holds(cond, w) {
  if (!cond) return true;
  for (const m of cond.matchAll(/max-width:\s*(\d+)px/g)) if (!(w <= Number(m[1]))) return false;
  for (const m of cond.matchAll(/min-width:\s*(\d+)px/g)) if (!(w >= Number(m[1]))) return false;
  return true;
}

const rules = blocks(css);
ok(rules.length > 300, `the stylesheet parsed into rules (${rules.length})`);

/**
 * Resolve `prop` for an element carrying every class in `classes`.
 * All the selectors involved are single classes, so specificity ties and
 * source order decides - which is exactly what went wrong.
 */
function resolve(classes, prop, w) {
  let win = null;
  rules.forEach((r, idx) => {
    const sels = r.sel.split(",").map((x) => x.trim());
    const hit = sels.some((sel) => {
      const parts = sel.split(/(?=\.)/).map((x) => x.trim()).filter(Boolean);
      // only plain ".a" or ".a.b" selectors are modelled here
      if (!parts.length || !parts.every((x) => /^\.[\w-]+$/.test(x))) return false;
      return parts.every((x) => classes.includes(x.slice(1)));
    });
    if (!hit || !holds(r.cond, w)) return;
    const m = [...r.body.matchAll(new RegExp("(?:^|;)\\s*" + prop + "\\s*:([^;]+)", "g"))].pop();
    if (m) win = { val: m[1].trim(), cond: r.cond || "(unconditional)", order: idx };
  });
  return win;
}

const cols = (w) => {
  const r = resolve(["ct-grid", "ct-grid-3"], "grid-template-columns", w);
  if (!r) return 0;
  const m = /repeat\((\d+)/.exec(r.val);
  if (m) return Number(m[1]);
  return r.val.includes("minmax") ? 1 : 0;
};

/* --------------------------------------------- the reported fault, gone */
const PHONE = 390;
ok(cols(PHONE) === 1, `at ${PHONE}px the three controls are one per row (got ${cols(PHONE)})`);
ok(cols(360) === 1, `at 360px the three controls are one per row (got ${cols(360)})`);
ok(cols(560) === 1, `at 560px the three controls are one per row (got ${cols(560)})`);

/* a column at 390px must be wide enough for a symbol name and an arrow */
const CARD_PAD = 16 * 2;
const GAP = 8;
const track = (w, n) => (w - CARD_PAD - GAP * (n - 1)) / n;
ok(track(PHONE, cols(PHONE)) >= 280,
  `a control gets ${Math.round(track(PHONE, cols(PHONE)))}px on a ${PHONE}px screen`);
// what it used to be, for the record
ok(Math.round(track(PHONE, 3)) < 120,
  `the old 3-column layout gave each control only ${Math.round(track(PHONE, 3))}px`);

/* ------------------------------------------- the rest of the ladder */
/* The ladder moved when the sheet's twenty-three ad-hoc breakpoints
   were collapsed onto seven. This grid used to go three-across above
   820 while the page header around it collapsed at 900, so a tablet
   between the two had a stacked header over a three-column form. Both
   flip at 900 now, and the width-by-width behaviour below is the
   consequence, not an accident:

     <= 560   one across
     <= 900   two across     (was three between 821 and 900)
     >  900   three across

   max-width:900px matches AT 900, so 900 itself is the tablet. */
ok(cols(760) === 2, `at 760px it is two across (got ${cols(760)})`);
ok(cols(820) === 2, `at 820px it is two across (got ${cols(820)})`);
ok(cols(900) === 2, `at 900px it is two across (got ${cols(900)})`);
ok(cols(901) === 3, `one pixel above the breakpoint it is three across (got ${cols(901)})`);
ok(cols(1400) === 3, `on a desktop it is three across (got ${cols(1400)})`);

/* the 4-up grid is unaffected except where it should be */
const c4 = (w) => {
  const r = resolve(["ct-grid"], "grid-template-columns", w);
  const m = r && /repeat\((\d+)/.exec(r.val);
  return m ? Number(m[1]) : (r && r.val.includes("minmax") ? 1 : 0);
};
ok(c4(1400) === 4, "the plain 4-up grid keeps four columns on a desktop");
ok(c4(900) === 2, "the plain 4-up grid drops to two on a tablet");
ok(c4(PHONE) === 1, "the plain 4-up grid stacks on a phone");

/* ------------------------------------- the source-order trap, forbidden */
function lastIndexFor(sel, conditional) {
  let last = -1;
  rules.forEach((r, i) => {
    const hit = r.sel.split(",").map((x) => x.trim()).includes(sel);
    if (hit && Boolean(r.cond) === conditional) last = i;
  });
  return last;
}
for (const sel of [".ct-grid", ".ct-grid-3"]) {
  const uncond = lastIndexFor(sel, false);
  const inMedia = lastIndexFor(sel, true);
  ok(inMedia === -1 || uncond < inMedia,
    `${sel}: no unconditional rule sits after its media queries (base ${uncond}, media ${inMedia})`);
}

/* ------------------------------------------------ the squeeze, prevented */
ok(/\.ct-grid>\*\{[^}]*min-width:0/.test(css),
  "grid items may shrink, so one long option cannot squeeze the others");
ok(/\.ct-grid>\.field\{[^}]*margin-bottom:0/.test(css),
  "the gap owns row spacing, so wrapped rows are evenly spaced");
ok(/\.field\{[^}]*margin-bottom:14px/.test(css),
  "a field outside these grids keeps its own spacing");

/* controls still fill their track and can shrink inside it */
ok(/\.field input,\.field select,\.ctrl\{[\s\S]*?width:100%/.test(css), "controls fill their column");
ok(/\.field input,\.field select,\.ctrl\{[\s\S]*?min-width:0/.test(css), "controls may shrink to their column");

/* ------------------------------------------------- the markup is as modelled */
const app = fs.readFileSync(path.join(__dirname, "..", "apps/web/js/app.js"), "utf8");
/* One, not two. The manual ticket used to be the second three-up grid -
   volume, stop and target as three identical columns. It is laid out by
   job now (a stepper for the lot, a row each for the levels), so the
   backtest form is the only three-up grid left. The ticket's own layout
   is covered by tests/ea-chart-ux.test.js. */
const uses = [...app.matchAll(/class="ct-grid ct-grid-3"/g)].length;
ok(uses === 1, `the backtest form is the remaining three-up grid (${uses})`);
ok(/id="bt-card"[\s\S]{0,600}class="ct-grid ct-grid-3"/.test(app),
  "and it is the backtest form that has it");
const btView = app.slice(app.indexOf("backtest() {"), app.indexOf("\n  history() {"));
ok(btView.includes('class="ct-grid ct-grid-3"'), "the backtest form uses the three-up grid");
const fields = [...btView.matchAll(/<label class="field">/g)].length;
ok(fields === 3, `the backtest form has exactly three fields (${fields}), as the grid assumes`);
for (const id of ["bt-sym", "bt-tf", "bt-st"]) {
  ok(btView.includes(id), `${id} is one of them`);
}

console.log(failed ? `\n${failed} failed` : "\nall good");
process.exit(failed ? 1 : 0);
