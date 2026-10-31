/**
 * Every dropdown on the desk is the same control.
 *
 * The desk had two dropdowns that were never meant to be two: the
 * symbol picker (.sympick) and the enhanced <select> (.dd-wrap). They
 * were built at different times, styled in separate blocks, and placed
 * by two separate copies of the same geometry - so they drifted into
 * visibly different controls sitting side by side on the markets
 * toolbar, one with a glass popover and a chevron, the other with a
 * squarer menu and a CSS caret.
 *
 * Three defects came out of that split, and this suite is the cover for
 * all three:
 *
 *  1. Two styles. The look is now declared once, by naming both
 *     components in the same rule. A future edit that gives .dd-* its
 *     own background, radius or caret again is the regression.
 *
 *  2. A menu wider than its trigger. The two placement routines clamped
 *     width up to a 240px and a 168px floor respectively, so a narrow
 *     control opened a menu that was visibly not its own. There is one
 *     routine now, it takes the trigger's width, and it may only ever
 *     reduce it.
 *
 *  3. A label resizing its neighbour. With no EA attached the symbol
 *     button rendered a 55-character sentence; inside .mk-pick, where
 *     both controls had a content-sized flex basis, that took 403px of
 *     a 411px row and left the timeframe button a 30px stub with its
 *     label clipped. The sentence is now a short label plus a tooltip,
 *     and the row no longer depends on the text being short.
 *
 * The height rule is checked too: a menu is a short list that scrolls,
 * not a column that runs off the page.
 *
 *     node tests/dropdown-unity.test.js
 */
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");

const appJs = read("apps/web/js/app.js");
const appCss = read("apps/web/css/app.css");
const themesCss = read("apps/web/css/themes.css");

let failed = 0;
const ok = (cond, label) => {
  if (!cond) failed++;
  console.log(`${cond ? "ok  " : "  x "} ${label}`);
};

/* A rule block for the first selector list that contains `needle`. */
function ruleFor(css, needle) {
  const i = css.indexOf(needle);
  if (i < 0) return null;
  const open = css.indexOf("{", i);
  if (open < 0) return null;
  return { selector: css.slice(css.lastIndexOf("}", i) + 1, open), body: css.slice(open, css.indexOf("}", open)) };
}

console.log("\n-- one component, one implementation --------------------");

/* The look is shared by naming both in one rule, not by two blocks that
   happen to agree today. */
for (const [a, b, what] of [
  [".sympick-btn", ".dd-btn", "the button shell"],
  [".sympick-pop", ".dd-menu", "the popover surface"],
  [".sympick-row", ".dd-opt", "the option row"],
]) {
  const r = ruleFor(appCss, `${a},${b}{`) || ruleFor(appCss, `${a},${b}`);
  ok(!!r, `${what}: ${a} and ${b} are styled by one rule`);
}

/* The caret is the same chevron icon, not a rotated CSS square. */
ok(!/\.dd-caret\s*\{/.test(appCss), "the bespoke .dd-caret square is gone from the stylesheet");
ok(!appJs.includes('class="dd-caret"'), "the dropdown no longer builds a .dd-caret");
ok(/btn\.innerHTML = `<span class="dd-label">\$\{esc\(label\)\}<\/span>\$\{icon\("chevron"\)\}`/.test(appJs),
  "the dropdown button renders the shared chevron icon");

/* .ctrl is what carries the field shell both controls stand on. */
ok(/btn\.className = "ctrl dd-btn"/.test(appJs), "the dropdown button wears .ctrl, like the symbol button");

/* Every skin that dresses the floating menu has to dress both of them,
   or the two are identical in the default theme only. */
const skinFloating = themesCss.split("\n").filter((l) => /\.dd-menu\b/.test(l)).length;
const skinSym = themesCss.split("\n").filter((l) => /\.sympick-pop\b/.test(l)).length;
ok(skinSym >= skinFloating,
  `each themed .dd-menu rule also names .sympick-pop (${skinSym} >= ${skinFloating})`);

console.log("\n-- one placement routine --------------------------------");

ok(/function placePopover\(btn, pop, opts\)/.test(appJs), "placePopover exists");
ok(/function placeDropdownMenu\(btn, menu\) \{\s*placePopover\(btn, menu\);\s*\}/.test(appJs),
  "the <select> menu is placed by placePopover");
ok(/placePopover\(btn, pop, \{ minW: \d+ \}\)/.test(appJs),
  "the symbol popover is placed by placePopover");

/* The second copy of the geometry is what allowed them to disagree. */
ok(!/MIN_W|MAX_W/.test(appJs), "no second width clamp survives in app.js");
ok(appJs.match(/getBoundingClientRect\(\)/g) !== null, "sanity: the source still measures rectangles");

console.log("\n-- a menu is as wide as the control that opened it -------");

const pop = appJs.slice(appJs.indexOf("function placePopover"), appJs.indexOf("function placeDropdownMenu"));
/* Math.max(minW, Math.min(r.width, viewport)) - the trigger's width may
   be reduced to fit the screen and raised only by the readability
   floor, never inflated to a design number. */
ok(/Math\.max\(minW, Math\.min\(r\.width, vw - POP_EDGE \* 2\)\)/.test(pop),
  "width is the trigger's width, clamped to the viewport");
const floor = (pop.match(/o\.minW \|\| (\d+)/) || [])[1];
ok(floor && Number(floor) <= 112, `the readability floor is small (${floor}px), so it rarely binds`);
ok(/pop\.style\.inlineSize = w \+ "px"/.test(pop), "the width is written, not left to the stylesheet");

/* Logical properties only. A physical `left` joins the stylesheet's
   inset-inline-start rather than replacing it, and in RTL `left` is the
   one dropped - which welds the menu to the window edge. */
ok(!/pop\.style\.left\b|pop\.style\.right\b/.test(pop), "no physical left/right is written");
ok(/insetInlineStart/.test(pop), "the inline offset is logical");

console.log("\n-- short, and scrolling ---------------------------------");

const maxH = (appJs.match(/const POP_MAX_H = (\d+)/) || [])[1];
ok(maxH && Number(maxH) <= 320, `a menu is capped at ${maxH}px, not left to grow down the page`);
ok(/pop\.style\.maxBlockSize = Math\.max\(POP_MIN_H, Math\.min\(maxH,/.test(pop),
  "the cap is applied to the measured space");

const menuRule = ruleFor(appCss, ".dd-menu{padding");
ok(menuRule && /overflow:auto/.test(menuRule.body), "the generic menu scrolls its overflow");
ok(menuRule && /overscroll-behavior:contain/.test(menuRule.body),
  "scrolling the menu does not scroll the desk behind it");
const listRule = ruleFor(appCss, ".sympick-list{");
ok(listRule && /overflow:auto/.test(listRule.body), "the symbol list scrolls its overflow");

/* The stylesheet fallback must agree with the script's cap, or a menu
   painted before placement flashes at a different size. */
const popRule = ruleFor(appCss, ".sympick-pop,.dd-menu{");
const cssMax = popRule && (popRule.body.match(/max-block-size:min\(60vh, (\d+)px\)/) || [])[1];
ok(cssMax && Number(cssMax) === Number(maxH),
  `the stylesheet fallback height matches POP_MAX_H (${cssMax} === ${maxH})`);

console.log("\n-- a label may not resize its neighbour ------------------");

/* The empty state is a label, not a sentence. */
ok(/sympick-cur">\$\{esc\(I18N\.t\("exec\.no_ea_symbol_short"\)\)\}/.test(appJs),
  "the empty symbol button shows the short label");
ok(!/sympick-cur">\$\{esc\(I18N\.t\("exec\.no_ea_symbol"\)\)\}/.test(appJs),
  "the full sentence is no longer rendered inside a dropdown button");
ok(/title="\$\{esc\(I18N\.t\("exec\.no_ea_symbol"\)\)\}"/.test(appJs),
  "the explanation survives as the button's tooltip");

for (const lang of ["en", "fa", "ar"]) {
  const pack = JSON.parse(read(`lang/${lang}.json`));
  const short = pack.exec && pack.exec.no_ea_symbol_short;
  ok(typeof short === "string" && short.length > 0, `${lang}: exec.no_ea_symbol_short exists`);
  ok(short && short.length <= 18, `${lang}: the short label is short (${short && short.length} chars)`);
}

/* Even with a short label, neither control may take its width from its
   text: the next long string would reopen the same bug. */
const symInPick = ruleFor(appCss, ".mk-pick > .sympick{");
ok(symInPick && /flex:1 1 0/.test(symInPick.body),
  "the symbol picker takes the row's slack, not its own content width");
const ddInPick = ruleFor(appCss, ".mk-pick > .dd-wrap{");
ok(ddInPick && /flex:0 0 auto/.test(ddInPick.body),
  "the timeframe control keeps a fixed seat and cannot be squeezed out");
ok(ddInPick && /inline-size:clamp\(/.test(ddInPick.body),
  "the timeframe seat is a clamp, so it is bounded on both sides");
ok(!/\.mk-pick \.ctrl\{flex:1 1 auto\}/.test(appCss),
  "the content-sized flex basis that caused the squeeze is gone");

console.log("\n-- glass survives the opening ---------------------------");

/* An opacity animation on a backdrop-filter element - or any ancestor -
   makes it a backdrop root, so the blur samples nothing and the menu
   opens as a flat grey card. The same defect was fixed in the view
   transitions; it must not be reintroduced here. */
const dd = themesCss.slice(themesCss.indexOf("@keyframes ddIn"));
const frames = dd.slice(0, dd.indexOf("}", dd.indexOf("{", 15)) + 1);
ok(!/opacity/.test(frames), "ddIn animates transform only, never opacity");
ok(/html\[data-skin\] \.sympick-pop\{ animation:ddIn/.test(themesCss)
  || /html\[data-skin\] \.dd-menu,\s*\nhtml\[data-skin\] \.sympick-pop\{ animation:ddIn/.test(themesCss),
  "both popovers share the one entrance");

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
