/**
 * Every control on a phone has to answer a thumb.
 *
 * The desk had a pointer:coarse block already - it raised --ctl-h to
 * 48px and expanded the switch - but a sweep of all twelve views at
 * 390px found a long tail it never reached: carousel dots at 8x8,
 * segmented controls at 28-33px tall, the order ticket's pick and
 * clear buttons at 38px, the terminal and history buttons at 32px,
 * the calendar's arrows and Today at 34px.
 *
 * Three things that measuring taught, all of them pinned below:
 *
 *  1. .btn carries overflow:hidden (app.css:376, for the ellipsis), so
 *     an ::after expander drawn outside a button is clipped away by
 *     the button itself. Every computed style said the rule applied;
 *     hit-testing said it had done nothing, and hit-testing was right.
 *     Anything built on .btn is given real height instead.
 *
 *  2. .ct-ic and .ct-pm declare their own size LATER in the file at
 *     equal weight, and at equal weight the later rule wins however
 *     many media queries are wrapped around the earlier one. The
 *     coarse rules have to out-specify, not restate.
 *
 *  3. One limit is real and is written down rather than rounded
 *     away: the header stays 34px by deliberate design with only 6px
 *     between controls, so it reaches 40x44 and not 44x44.
 *
 *     There used to be a second. .pos-x, the close control on a chart
 *     card's position chip, sat in a strip that scrolled sideways and
 *     clipped vertically, so no expander could escape it and it was
 *     capped at 28px - short of 44. The chips are gone: the cards
 *     draw the chart desk's own .tvp-list, whose rows have 8px of
 *     padding round the button, and the -7px expander .tv-pos-x
 *     already carries fits inside that. Measured 44.0x44.0 in a card
 *     at 390. So the exception is retired rather than restated, and
 *     what is checked here is that it has not crept back.
 *
 *     node tests/touch-targets.test.js
 */
const fs = require("node:fs");

const css = fs.readFileSync("apps/web/css/app.css", "utf8");
let fails = 0;
const ok = (c, m, d) => {
  if (!c) { fails++; console.log("FAIL " + m + (d ? "  — " + d : "")); }
  else console.log("ok   " + m + (d ? "  — " + d : "")); };

const flat = css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, " ")
  .replace(/\s*([{};:,])\s*/g, "$1");

/** The body of the one @media (pointer: coarse) block in this file. */
function coarseBlock() {
  const re = /@media\s*\(pointer:coarse\)\{/g;
  let m, out = "";
  while ((m = re.exec(flat))) {
    let i = m.index + m[0].length, depth = 1;
    const start = i;
    for (; i < flat.length && depth; i++) {
      if (flat[i] === "{") depth++;
      else if (flat[i] === "}") depth--;
    }
    const body = flat.slice(start, i - 1);
    if (body.length > out.length) out = body;
  }
  return out;
}
const coarse = coarseBlock();
ok(coarse !== "", "there is a pointer:coarse block");

/** Match a rule by its WHOLE selector, so .ct-ic does not match .ct-row .ct-ic. */
function ruleIn(body, sel) {
  const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = body.match(new RegExp("(?:^|[}])" + esc + "\\{([^}]*)\\}"));
  return m ? m[1] : "";
}
const has44 = (decl) => /(?:min-height|height):44px/.test(decl);

/* ---------- grown for real, because .btn clips its own ::after ---------- */
ok(has44(ruleIn(coarse, ".pc-seg>button,.cal-seg>button,.tabs>button")),
  "the segmented controls are 44px tall for real");
ok(has44(ruleIn(coarse, ".cmd .btn.tiny,.stage .row>.btn.tiny")),
  "export, reset, clear log and restart are 44px tall");
ok(has44(ruleIn(coarse, ".cal-arrow,.cal-now")),
  "the calendar's arrows and Today are 44px tall");
ok(has44(ruleIn(coarse, ".mk-sig .btn.tiny")),
  "the signal toggles are 44px tall");

/* ---------- and these had to out-specify their own base ---------- */
const ic = ruleIn(coarse, ".ct-row .ct-ic,.ct-lv .ct-ic");
ok(/width:44px/.test(ic) && /height:44px/.test(ic),
  "the ticket's pick and clear buttons are a 44px square", ic);
ok(ic !== "", "they are written with an ancestor, not as a bare .ct-ic");
ok(!/(?:^|[}])\.ct-ic\{/.test(coarse),
  "a bare .ct-ic in here would lose to the later rule at line ~4065 and do nothing");
ok(/width:44px/.test(ruleIn(coarse, ".ct-step .ct-pm")),
  "the volume stepper's minus and plus are 44px");

/* ---------- kept visually small, target grown around them ---------- */
const dots = ruleIn(coarse, ".chart-dots");
ok(/gap:36px/.test(dots),
  "the dots are spaced so each owns a 44px share of the row", dots);
ok(/padding-block:18px/.test(dots),
  "the row has real height, because the card clips what hangs below it", dots);
ok(/inset:-18px/.test(ruleIn(coarse, ".chart-dot::after")),
  "the dot itself stays 8px and the target is grown around it");
ok(/position:relative/.test(ruleIn(coarse, ".chart-dot")),
  "an absolutely positioned expander needs its control to be a containing block");

const top = ruleIn(coarse, ".top .icon-btn,.top .menu-btn,.top .btn.tiny");
ok(/overflow:visible/.test(top),
  "the header buttons open their overflow, or .btn's overflow:hidden eats the expander", top);
ok(/position:relative/.test(top), "and they are containing blocks", top);
ok(/inset:-5px -3px/.test(ruleIn(coarse, ".top .icon-btn::after,.top .menu-btn::after,.top .btn.tiny::after")),
  "3px each side is half the measured 6px gap — no expander reaches into its neighbour");

/* ---------- the limits are stated, not rounded away ---------- */
const raw = css.slice(css.indexOf("@media (pointer: coarse){"));
ok(/40x44, not 44x44/.test(raw),
  "the header's residual shortfall is written down rather than quietly rounded up");
/* The retired exception. A chip strip that clips its own expanders is
   a thing to notice coming back, and the old 28px cap is the
   fingerprint: it was the largest a 44px target could not be. */
ok(!/\.pos-chip/.test(css) && !/(?:^|[,{};])\.pos-x[{,:]/.test(css),
  "the position chips and their undersized close control are gone, not merely unused");
ok(!/overflow:auto hidden/.test(raw),
  "and the note explaining why they could not reach 44px went with them");

/* ---------- none of this touches a mouse ---------- */
/* Everything that is NOT inside a coarse block.
   Written as a subtraction because indexOf("@media(pointer:coarse){")
   found nothing - the flattener keeps the space after @media - so
   "outside" silently became the whole file and the check failed
   against correct CSS. The guard was the bug. */
const outside = flat.split(coarse).join("|COARSE|");
ok(!/\.chart-dots\{gap:36px/.test(outside),
  "the 36px dot gap is touch-only — on a mouse it would just look wrong");
ok(/\.chart-dots\{[^}]*gap:8px/.test(outside),
  "the mouse keeps the original 8px dot gap");

console.log(fails ? `\ntouch targets: ${fails} FAILED` : "\ntouch targets: all checks passed");
process.exit(fails ? 1 : 0);
