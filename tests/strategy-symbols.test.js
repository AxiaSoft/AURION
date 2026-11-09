/**
 * The per-symbol chips were removed from the strategy card.
 *
 * ---------------------------------------------------------------------
 * What this file used to be, and why that matters
 *
 * This suite was written to guard a strip of chips under every strategy
 * card - one per symbol the strategy watched, each saying buy / sell /
 * hold. It existed for a real reason, reported as "the robot only trades
 * one symbol": the engine keeps one verdict per strategy per symbol, but
 * the card showed whichever symbol had closed a candle most recently,
 * with no label on it. A buy on EURUSD read as a buy on whatever chart
 * the trader was looking at.
 *
 * The chips fixed that and introduced a different problem. On a desk
 * watching six symbols, every card grew six tags that mostly said
 * "GBPUSD hold" - six lines of noise around the one line being read.
 * Removal was asked for by name.
 *
 * So this file is not deleted. A guard that pinned a deliberate decision
 * is worth more as a record of the reversal than as an empty file: it
 * says what was there, why it went, and - most importantly - what must
 * still be true now that it is gone. The per-symbol data is still in the
 * snapshot and still shown on the positions and market views; nothing
 * was taken off the wire, and the ambiguity the chips were built for is
 * answered there instead.
 *
 *     node tests/strategy-symbols.test.js
 * ---------------------------------------------------------------------
 */
const fs = require("node:fs");

const app = fs.readFileSync("apps/web/js/app.js", "utf8");
const css = fs.readFileSync("apps/web/css/app.css", "utf8");
let fails = 0;
const ok = (c, m, d) => {
  if (!c) { fails++; console.log("FAIL " + m + (d ? "  — " + d : "")); }
  else console.log("ok   " + m + (d ? "  — " + d : "")); 
};

/* ---------- gone, and gone completely ---------- */

ok(!/function stSymbolRows\b/.test(app),
  "stSymbolRows is gone",
  "the builder, not just its call site");

ok(!/data-st-syms/.test(app),
  "no card carries a per-symbol strip any more");

ok(!/class="st-sym[ "]/.test(app),
  "no per-symbol chip is rendered");

/* A half-removal is the failure mode worth guarding. The live patch path
   updated the strip by querying data-st-syms on every snapshot; left
   behind, it would be a selector that matches nothing, called a few
   times a second, quietly forever. */
ok(!/stSymbolRows\(/.test(app),
  "nothing still calls it",
  "including the live-patch path that refreshed the strip per snapshot");

/* ---------- what must still be true ---------- */

ok(/data-st-act="\$\{esc\(it\.name\)\}"/.test(app),
  "the card still shows the strategy's own verdict");

ok(/data-st-eval="\$\{esc\(it\.name\)\}"/.test(app),
  "...and still says why, in words");

/* The reason the chips existed. The engine still sends per-symbol
   verdicts and the desk still has somewhere to read them, so removing
   the chips removed a display, not an answer. */
ok(/\bsymbols\b/.test(app),
  "the per-symbol data is still consumed somewhere in the desk",
  "the chips were a view of it, not the source of it");

/* The stale CSS is worth catching too: a rule for an element nothing
   emits is dead weight that the next person has to prove is dead. */
ok(!/\.st-syms\b/.test(css) && !/\.st-sym\b/.test(css),
  "the chip styles went with the chips",
  "a rule for an element nothing emits is read as evidence the element exists");

console.log("");
console.log(fails ? `strategy-symbols: ${fails} FAILED` : "strategy-symbols: all checks passed");
process.exitCode = fails ? 1 : 0;
