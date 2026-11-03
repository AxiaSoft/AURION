/**
 * Relief and Velvet have to reach the nav, the settings page and the
 * candles.
 *
 * The complaint was that those two themes left three surfaces looking
 * like no theme at all: the main nav side panel, the settings page, and
 * the candles. That turned out to be literally true - `.nav-tab`,
 * `.set-block` and `.set-main` had zero rules in either family, and the
 * canvas carried no material at all - and it is the kind of gap the
 * other suites cannot see, because a theme file that styles the wrong
 * components still parses, still differs from its neighbours, and still
 * passes every existing check.
 *
 * Worse, the first attempt at the fix was written against `.nav-item`
 * and `.set-jump a`, neither of which this desk has ever rendered. The
 * whole suite stayed green with those dead selectors in the file. So
 * the first thing checked here is not what the CSS says but whether the
 * elements it names are ones app.js actually builds.
 *
 * Four things have to hold:
 *
 *  - The selectors are real. Every class the two families newly claim is
 *    one the app emits.
 *  - The rules win. app.css styles the nav tab as `.nav button.nav-tab`,
 *    which outranks a bare `.nav-tab` on source order, so a correct
 *    rule at too low a specificity is also inert.
 *  - The material contract exists. themes.css publishes --candle-style,
 *    charts.js reads it into T.material, and nobody sniffs data-skin.
 *  - The renderer draws it. candleBody() is called for real against a
 *    recording context, because a regex over a drawing routine proves
 *    nothing about what lands on the canvas. In particular the relief
 *    emboss must stay inside the body bounds: the top and bottom edges
 *    of a candle body are the open and the close, and a decoration that
 *    moves them is a wrong price.
 *
 *     node tests/theme-materials.test.js
 */
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "apps/web");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
/* A selector named inside a comment is not a rule, and these files
   document in prose the bug each block fixes. */
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "");

let failed = 0;
const ok = (c, m) => { if (!c) { failed++; console.log("FAIL " + m); } else console.log("ok   " + m); };

const themes = strip(read("css/themes.css"));
const appJs = read("js/app.js");
const chartsJs = read("js/charts.js");

/* ------------------------------------------------ 1. the selectors exist */

/* Each of these is a class one of the two families now styles. If app.js
   never emits it, the rule is decoration on a component that does not
   exist - exactly the failure this file was written after. */
const CLAIMED = [
  "nav-tab",
  "set-block",
  "set-main",
  "set-desk",
  "set-jump",
  "sj-bar",
  "sym-panel",
  "sympick-pop",
];

for (const cls of CLAIMED) {
  /* Emitted as class="... x ..." or via a template/classList. Accept any
     occurrence of the bare token in the markup builder. */
  const inApp = new RegExp(`[\\s"'\`.]${cls}[\\s"'\`]`).test(appJs);
  ok(inApp, `app.js emits .${cls}`);
}

/* The state class on a nav tab is .on, not [aria-current]. A rule keyed
   to the wrong one highlights nothing. */
ok(/nav-tab[^"'`]*\bon\b|classList[^\n]*\bon\b/.test(appJs),
  "the nav tab's selected state is the class .on");

for (const fam of ["neu", "clay"]) {
  const block = new RegExp(`html\\[data-skin="${fam}"\\][^{]*\\.nav-tab`, "g");
  const hits = themes.match(block) || [];
  ok(hits.length > 0, `${fam} styles the nav tab at all`);
  /* app.css owns `.nav button.nav-tab{...}`. A bare `.nav-tab` ties on
     specificity and loses on source order, so the background never
     lands and an inset shadow presses into nothing. */
  ok(hits.every((h) => /\.nav\s+button\.nav-tab/.test(h)),
    `${fam}'s nav-tab rules outrank app.css's .nav button.nav-tab`);
  ok(new RegExp(`html\\[data-skin="${fam}"\\][^{]*\\.set-main\\s+\\.set-block`).test(themes),
    `${fam} styles the settings blocks`);
  ok(new RegExp(`html\\[data-skin="${fam}"\\][^{]*\\.set-jump\\s+button`).test(themes),
    `${fam} styles the settings jump list`);
}

/* The jump list is buttons. `.set-jump a` matches nothing here. */
ok(!/\.set-jump\s+a[\s,{]/.test(themes), "no rule targets .set-jump a (the markup uses buttons)");
ok(!/\.nav-item[\s,.:{]/.test(themes), "no rule targets .nav-item (the markup uses .nav-tab)");

/* Selection must not be colour alone. Both families press the tab in,
   and both also move the ink.

   One family writes the press inline and the other reaches for its
   `--neu-in` token, so the value has to be resolved before it is read -
   grepping the declaration for "inset" would only ever find one of
   them. */
const resolve = (val, depth = 0) => {
  if (depth > 4) return val;
  return val.replace(/var\(\s*(--[\w-]+)[^)]*\)/g, (whole, name) => {
    const def = themes.match(new RegExp(`${name}\\s*:\\s*([^;}]+)`));
    return def ? resolve(def[1], depth + 1) : whole;
  });
};

for (const fam of ["neu", "clay"]) {
  const rules = [...themes.matchAll(
    new RegExp(`html\\[data-skin="${fam}"\\][^{}]*\\.nav-tab\\.on[^{}]*\\{([^}]*)\\}`, "g"))];
  ok(rules.length > 0, `${fam} has a selected-state rule for the nav tab`);
  const decls = resolve(rules.map((r) => r[1]).join(" "));
  ok(/inset/.test(decls), `${fam}'s selected nav tab is pressed in, not just tinted`);
  ok(/color\s*:/.test(rules.map((r) => r[1]).join(" ")),
    `${fam}'s selected nav tab also moves its ink, so the state is not depth alone`);
}

/* --------------------------------------------- 2. the material contract */

const MATERIAL = { neu: "relief", clay: "velvet" };
for (const [fam, want] of Object.entries(MATERIAL)) {
  /* Read the whole data-skin block, not just a nearby line. */
  const re = new RegExp(`html\\[data-skin="${fam}"\\]\\s*\\{([^}]*)\\}`, "g");
  const all = [...themes.matchAll(re)].map((m) => m[1]).join("\n");
  const m = all.match(/--candle-style\s*:\s*([a-z]+)/);
  ok(m && m[1] === want, `${fam} publishes --candle-style:${want}` + (m ? ` (got ${m[1]})` : " (absent)"));
}

ok(/--candle-style/.test(chartsJs), "charts.js reads --candle-style");
ok(/material\s*:/.test(chartsJs), "chartTheme() carries the material on T");
/* The theme layer decides what a material looks like; the renderer only
   draws it. A renderer that sniffs data-skin has taken over that job and
   every new theme then needs a code change. */
ok(!/data-skin|dataset\s*\.\s*skin/.test(strip(chartsJs)), "charts.js does not sniff the skin id");

/* --------------------------------------------- 3. the renderer draws it */

const { CandleChart } = require(path.join(ROOT, "js/charts.js"));

/** A 2d context that records every call and paint rectangle. */
function recorder() {
  const calls = [];
  const rects = [];
  const ctx = {
    globalAlpha: 1, fillStyle: "#000",
    fillRect(x, y, w, h) {
      calls.push("fillRect");
      rects.push({ x, y, w, h, fill: ctx.fillStyle, alpha: ctx.globalAlpha });
    },
    roundRect(x, y, w, h, r) { calls.push("roundRect"); rects.push({ x, y, w, h, r, round: true, fill: ctx.fillStyle }); },
    rect() { calls.push("rect"); },
    beginPath() { calls.push("beginPath"); },
    fill() { calls.push("fill"); },
    clip() { calls.push("clip"); },
    save() { calls.push("save"); },
    restore() { calls.push("restore"); },
  };
  return { ctx, calls, rects };
}

const chart = Object.create(CandleChart.prototype);
const BX = 10, BY = 20, BW = 8, BH = 40;
const draw = (material, bw = BW, bh = BH) => {
  const r = recorder();
  chart.candleBody(r.ctx, { material }, BX, BY, bw, bh, "#26d07c");
  return r;
};

const flat = draw("flat");
ok(flat.rects.length === 1, "flat draws one rectangle");
ok(flat.calls.indexOf("roundRect") < 0, "flat is not rounded");

const velvet = draw("velvet");
ok(velvet.calls.indexOf("roundRect") >= 0, "velvet rounds the body");
ok(velvet.calls.indexOf("clip") >= 0, "velvet clips its highlight to the rounded body");
ok(velvet.calls.indexOf("restore") > velvet.calls.indexOf("clip"), "velvet restores the clip it set");
const sheen = velvet.rects.filter((p) => p.fill === "#ffffff");
ok(sheen.length === 1, "velvet adds one highlight");
ok(sheen[0] && sheen[0].h < BH * 0.5, "velvet's highlight is a top sheen, not a wash over the body");

const relief = draw("relief");
ok(relief.rects.some((p) => p.fill === "#ffffff" && p.h === 1), "relief has a lit top edge");
ok(relief.rects.some((p) => p.fill === "#000000" && p.h === 1), "relief has a shaded bottom edge");

/* The body's top edge is the open or the close, and its bottom edge the
   other. Decoration is drawn inside those bounds or it is a wrong
   price on screen. */
for (const material of ["flat", "relief", "velvet"]) {
  const r = draw(material);
  const out = r.rects.filter((p) => p.y < BY - 0.001 || p.y + p.h > BY + BH + 0.001
    || p.x < BX - 0.001 || p.x + p.w > BX + BW + 0.001);
  ok(out.length === 0, `${material} paints nothing outside the body bounds`);
}

/* At a zoomed-out bar width the ornament is sub-pixel noise and costs a
   clip per candle, so both materials step back to the flat rectangle. */
for (const material of ["relief", "velvet"]) {
  const tiny = draw(material, 2, 2);
  ok(tiny.rects.length === 1 && !tiny.rects[0].round,
    `${material} falls back to a flat body on a thin candle`);
}

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
