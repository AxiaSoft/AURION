/**
 * Container alignment in the strategy section.
 *
 * Reported as "one of the containers has moved up and down". It had: the
 * generic spacing rules give any container following another a top margin,
 * but .grid already spaces its children with gap. Inside a two-column grid
 * the two do not add up the way they do in a plain block -
 *
 *     .grid.g-2 > .card:nth-child(1)   first child, no margin
 *     .grid.g-2 > .card:nth-child(2)   matches .card + .card, so 14px on top
 *
 * - and those two cards are in the SAME ROW. The second one hung 14px below
 * its neighbour and the row stopped lining up.
 *
 * The checks resolve the real cascade rather than grepping for text,
 * because the first attempt at the fix was written ".grid > * + *" (0,1,0),
 * which loses to ".card + .card" (0,2,0) and would have changed nothing
 * while looking entirely correct in the diff.
 */
const fs = require("node:fs");

const css = fs.readFileSync("apps/web/css/app.css", "utf8");
let fails = 0;
const ok = (c, m, d) => { if (!c) { fails++; console.log("FAIL " + m + (d ? "  — " + d : "")); } else console.log("ok   " + m + (d ? "  — " + d : "")); };

/* ---- a small cascade model, enough for margin-block-start ---- */
function stripComments(t) { return t.replace(/\/\*[\s\S]*?\*\//g, ""); }

/** Split a selector group on depth-0 commas only, so :is(a, b) survives. */
function splitGroup(sel) {
  const out = [];
  let depth = 0, cur = "";
  for (const ch of sel) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === "," && depth === 0) { out.push(cur.trim()); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Classes count 1 each; :is()/:not() contribute their most specific branch. */
function specificity(sel) {
  let n = 0;
  let s = sel;
  const fn = /:(is|not|has)\(([^()]*)\)/;
  let m;
  while ((m = fn.exec(s))) {
    n += Math.max(0, ...splitGroup(m[2]).map(specificity));
    s = s.slice(0, m.index) + " " + s.slice(m.index + m[0].length);
  }
  s = s.replace(/:where\([^()]*\)/g, " ");
  n += (s.match(/\.[a-zA-Z_-][\w-]*/g) || []).length;
  n += (s.match(/\[[^\]]+\]/g) || []).length;
  return n;
}

/** Every rule that declares `prop`, in source order. */
function declaring(prop) {
  const out = [];
  const body = stripComments(css);
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m, i = 0;
  while ((m = re.exec(body))) {
    i++;
    const decls = m[2];
    const hit = new RegExp("(?:^|;)\\s*" + prop + "\\s*:\\s*([^;]+)").exec(decls);
    if (!hit) continue;
    for (const sel of splitGroup(m[1].trim())) {
      out.push({ sel, value: hit[1].trim(), spec: specificity(sel), order: i });
    }
  }
  return out;
}

/** Which rule wins for a selector that a candidate must match exactly. */
function winner(prop, matches) {
  const cands = declaring(prop).filter((r) => matches(r.sel));
  if (!cands.length) return null;
  cands.sort((a, b) => (a.spec - b.spec) || (a.order - b.order));
  return cands[cands.length - 1];
}

/* ---- the second card in a grid row ---- */
/* The neutraliser used to be three rules, one per container, each of them
   literally `.grid > …`, `.cmd > …`, `.set-desk > …`. It is now one rule
   whose parent half is an :is() list, because the list had grown: every
   gap-owning container built after it (.ccx-pair, .ai-read, .exx-cols,
   .pfx-cols, .snd-wrap) was missing and had quietly taken the margin
   back - which is what made the account card shorter than the risk card
   beside it and the market-regime card taller than its neighbours.

   These matchers are retargeted, not relaxed: they still demand a rule
   that names the container, names .card and uses a sibling combinator,
   and they still demand it beat `.card + .card` on specificity. They
   just no longer insist the container is spelled at the very start of
   the selector. */
const flatSel = (sel) => sel.replace(/\s+/g, " ").trim();
const parentHalf = (sel) => flatSel(sel).split(">")[0];
const cancelsFor = (box) => (sel) =>
  flatSel(sel).includes(">") && /\+/.test(sel) && parentHalf(sel).includes("." + box);

// An element that is: a .card, inside .grid, preceded by a .card sibling.
const gridCardSecond = (sel) =>
  /^\.card \+ \.card$/.test(flatSel(sel)) ||
  (cancelsFor("grid")(sel) && /\.card/.test(sel));

const w = winner("margin-block-start", gridCardSecond);
ok(w !== null, "something sets the top margin of a card following a card");
ok(w && w.value === "0",
  "a card beside another card in a grid gets NO extra top margin — the row lines up",
  w ? `"${w.sel}" -> ${w.value} (specificity ${w.spec})` : "no rule at all");

/* The neutraliser must win on specificity, not on being written last:
   source order is the thing a later edit silently reorders. */
const neutral = declaring("margin-block-start").filter((r) => cancelsFor("grid")(r.sel));
const adder = declaring("margin-block-start").filter((r) => flatSel(r.sel) === ".card + .card");
ok(neutral.length && adder.length, "both rules are present to compare");
ok(neutral.length && adder.length && neutral[0].spec > adder[0].spec,
  "it wins on specificity rather than on source order",
  neutral.length && adder.length ? `${neutral[0].spec} vs ${adder[0].spec}` : "");

/* ---- the same doubling in the vertical stacks ---- */
for (const box of ["cmd", "set-desk"]) {
  const r = declaring("margin-block-start").filter((x) => cancelsFor(box)(x.sel));
  ok(r.length && r[0].value === "0" && r[0].spec > 2,
    `.${box} spaces its own children, so the sibling margin is cancelled there too`,
    r.length ? `${r[0].value}, specificity ${r[0].spec}` : "missing");
}

/* Every gap-owning container, not just the three that existed first.
   tests/card-stacking.test.js proves this against the rendered views;
   this is the cheap source-level twin that runs next to the rule. */
for (const box of ["ccx-pair", "ai-read", "exx-cols", "pfx-cols", "snd-wrap"]) {
  const r = declaring("margin-block-start").filter((x) => cancelsFor(box)(x.sel));
  ok(r.length && r[0].value === "0" && r[0].spec > 2,
    `.${box} is a gap-owning grid, so the sibling margin is cancelled there too`,
    r.length ? `${r[0].value}, specificity ${r[0].spec}` : "missing");
}

/* ---- containers that genuinely need the margin keep it ---- */
const sb = declaring("margin-block-start").filter((r) => r.sel === ".set-block > * + *");
ok(sb.length && sb[0].value !== "0",
  ".set-block has no gap of its own, so it keeps the sibling margin",
  sb.length ? sb[0].value : "missing");

/* ---- the banner no longer leaks an outer margin ---- */
const mb = winner("margin-bottom", (sel) => sel === ".auto-banner" || sel === ".card.auto-banner");
ok(mb && mb.sel === ".card.auto-banner" && mb.value === "0",
  "a banner that IS the card does not add its own gap underneath",
  mb ? `"${mb.sel}" -> ${mb.value}` : "no rule");
ok(declaring("margin-bottom").some((r) => r.sel === ".auto-banner" && r.value !== "0"),
  "a banner INSIDE a card keeps its internal spacing");

/* ---- the view is a normal card stack like every other ---- */
const app = fs.readFileSync("apps/web/js/app.js", "utf8");
const view = app.slice(app.indexOf("  strategies() {"), app.indexOf("  execution() {"));
ok(/return `<div class="cmd">/.test(view),
  "the strategy view is a .cmd stack, the same as the other views");
const opens = (view.match(/<div/g) || []).length;
const closes = (view.match(/<\/div>/g) || []).length;
ok(opens === closes, "its markup is balanced", `${opens} <div> vs ${closes} </div>`);

console.log(fails ? `\nstrategy layout: ${fails} FAILED` : "\nstrategy layout: all checks passed");
process.exit(fails ? 1 : 0);
