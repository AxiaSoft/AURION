/**
 * Per-theme candle colours.
 *
 * Until now the two direction colours were one hard-coded pair in
 * app.css - bright green and bright red - used by all twelve themes.
 * They were chosen against the glass desk's near-black panel, and the
 * other eleven panels are not that colour: sunset's is warm maroon,
 * clay's is violet, mono's is neutral graphite. Each theme now names its
 * own pair, in both cuts, and the default theme keeps exactly the pair
 * that was hard-coded before so a desk already in use does not change
 * colour underneath its owner.
 *
 * Two different things have to be true, and this file checks both.
 *
 *  - The right pair reaches the page. Resolved by booting themes.js in
 *    jsdom, applying each theme in each cut, and reading what it
 *    actually published - not by grepping the table it was read from.
 *
 *  - The pairs are legible. Every candle colour is measured against the
 *    --chart-panel it is really drawn on, taken from css/themes.css, and
 *    up and down are measured against each other. "It looked nice in the
 *    editor" is not a result.
 *
 *     node tests/theme-candles.test.js
 */
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

const ROOT = path.join(__dirname, "..");
const W = path.join(ROOT, "apps/web");
const read = (p) => fs.readFileSync(path.join(W, p), "utf8");

let failed = 0;
const ok = (c, m) => { if (!c) { failed++; console.log("FAIL " + m); } else console.log("ok   " + m); };

/* ----------------------------------------------------------- colour maths */

const hex2rgb = (h) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(h).trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const chan = (v) => (v / 255 <= 0.03928 ? v / 255 / 12.92 : Math.pow((v / 255 + 0.055) / 1.055, 2.4));
const lum = (c) => 0.2126 * chan(c[0]) + 0.7152 * chan(c[1]) + 0.0722 * chan(c[2]);
const contrast = (a, b) => {
  const la = lum(a), lb = lum(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
};
/** Flatten an rgba() over a backdrop, because --chart-panel is translucent. */
function over(fg, alpha, bg) {
  return fg.map((v, i) => Math.round(v * alpha + bg[i] * (1 - alpha)));
}
function hue(c) {
  const r = c[0] / 255, g = c[1] / 255, b = c[2] / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  if (!d) return 0;
  let h;
  if (mx === r) h = ((g - b) / d) % 6;
  else if (mx === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  return h < 0 ? h + 360 : h;
}
const hueGap = (a, b) => { const d = Math.abs(hue(a) - hue(b)); return Math.min(d, 360 - d); };

/* ------------------------------------- the surface candles are drawn on */

const themeCss = read("css/themes.css").replace(/\/\*[\s\S]*?\*\//g, "");
const PANEL = {};
for (const m of themeCss.matchAll(/html\[data-skin="(\w+)"\](\[data-theme="light"\])?\s*\{([^}]*)\}/g)) {
  const cp = /--chart-panel:\s*([^;]+);/.exec(m[3]);
  if (!cp) continue;
  const rgba = /rgba?\(([^)]+)\)/.exec(cp[1]);
  if (!rgba) continue;
  const n = rgba[1].split(",").map((x) => Number(x.trim()));
  // over the page behind it; dark panels sit on near-black, light on white
  const behind = m[2] ? [255, 255, 255] : [0, 0, 0];
  PANEL[m[1] + (m[2] ? ":light" : ":dark")] = over(n.slice(0, 3), n.length > 3 ? n[3] : 1, behind);
}
ok(Object.keys(PANEL).length >= 24,
  `read --chart-panel for every theme and cut (${Object.keys(PANEL).length})`);

/* ------------------------------------------- what the engine really emits */

const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>",
  { url: "http://localhost/", runScripts: "outside-only" });
const win = dom.window;
win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
win.eval(read("js/themes.js"));
const T = win.AurionTheme;
ok(T && Array.isArray(T.THEMES), "themes.js booted");
T.setPaid(true);

function published() {
  const st = [...win.document.querySelectorAll("style")].map((s) => s.textContent).join("\n");
  const up = /--candle-up:(#[0-9a-f]{6})/i.exec(st);
  const dn = /--candle-down:(#[0-9a-f]{6})/i.exec(st);
  return [up && up[1], dn && dn[1]];
}
function applyIn(id, cut) {
  win.document.documentElement.dataset.theme = cut;
  T.set(id);
  T.apply();
  return published();
}

/* Every theme ships one. A theme added later without a pair would fall
   back to the global default and quietly look wrong on its own panel. */
const missing = T.THEMES.filter((t) => !t.candles || !t.candles.dark || !t.candles.light);
ok(missing.length === 0,
  `every theme names a candle pair for both cuts (missing: ${missing.map((t) => t.id).join(", ") || "none"})`);

/* ---------------------------------------------------- the default is kept */

/* The pair that was hard-coded in app.css before any of this existed.
   Read from the stylesheet rather than repeated here, so the two cannot
   drift apart silently. */
const appCss = read("css/app.css").replace(/\/\*[\s\S]*?\*\//g, "");
const rootBlock = /:root\s*\{([\s\S]*?)\}/.exec(appCss)[1];
const lightBlock = /html\[data-theme="light"\]\s*\{([\s\S]*?)\}/.exec(appCss)[1];
const was = {
  dark: [/--candle-up:\s*(#[0-9a-f]{6})/i.exec(rootBlock)[1], /--candle-down:\s*(#[0-9a-f]{6})/i.exec(rootBlock)[1]],
  light: [/--candle-up:\s*(#[0-9a-f]{6})/i.exec(lightBlock)[1], /--candle-down:\s*(#[0-9a-f]{6})/i.exec(lightBlock)[1]],
};
ok(was.dark[0] && was.light[0], `the previous hard-coded pairs were found (${was.dark.join("/")} and ${was.light.join("/")})`);

const def = T.DEFAULT;
for (const cut of ["dark", "light"]) {
  const got = applyIn(def, cut);
  ok(got[0] === was[cut][0] && got[1] === was[cut][1],
    `the default theme's ${cut} candles are unchanged (${got.join("/")})`);
}
/* The stylesheet values stay as the pre-boot fallback: themes.js runs in
   <head>, but a stylesheet that disagreed would flash the wrong colour. */
ok(was.dark[0] === T.BY_ID[def].candles.dark[0] && was.light[0] === T.BY_ID[def].candles.light[0],
  "and the stylesheet fallback agrees with the table, so there is no boot flash");

/* ------------------------------------------- each theme publishes its own */

let wrong = 0;
for (const t of T.THEMES) {
  for (const cut of ["dark", "light"]) {
    const got = applyIn(t.id, cut);
    const want = t.candles[cut];
    if (got[0] !== want[0] || got[1] !== want[1]) {
      wrong++;
      console.log(`     ${t.id}/${cut}: published ${got.join("/")}, table says ${want.join("/")}`);
    }
  }
}
ok(wrong === 0, `all ${T.THEMES.length * 2} theme/cut combinations publish their own pair`);

/* Two themes must not be issued the same pair in the same cut, or the
   table is decoration. */
for (const cut of ["dark", "light"]) {
  const seen = new Map();
  const dupes = [];
  for (const t of T.THEMES) {
    const k = t.candles[cut].join("/");
    // custom deliberately mirrors the default; it is the builder's start point
    if (t.id === "custom") continue;
    if (seen.has(k)) dupes.push(`${seen.get(k)}+${t.id}`);
    seen.set(k, t.id);
  }
  ok(dupes.length === 0, `no two themes share a ${cut} pair (${dupes.join(", ") || "none"})`);
}
ok(T.BY_ID.custom.candles.dark.join() === T.BY_ID[def].candles.dark.join(),
  "the custom builder starts from the default pair, which is its documented base");

/* ------------------------------------------------------------- legibility */

const MIN_ON_PANEL = 3.0;   /* WCAG 1.4.11, non-text contrast */
const MIN_HUE_GAP = 60;     /* two chromatic colours must not read alike */
const MIN_PAIR_K = 2.2;     /* ...and an achromatic pair separates by light */

/* "Unmistakable" is the requirement; hue is only one way to achieve it.

   Relief is a steel theme and Mono is a graphite one, and a green/red
   pair on either is a sticker from another product. They now rise in
   near-white and fall in grey, which is what the theme is made of -- and
   a luminance split is, if anything, the more robust signal, because it
   survives every form of colour blindness. A hue-gap rule applied to
   those pairs measures nothing: the hue of #8a95a5 is noise.

   So the rule is: a pair must be separated by hue OR by luminance.
   Chroma here is absolute (max-min over 255), not HSV saturation, which
   divides by the maximum channel and so calls the dark slate #1f2733
   "39% saturated" when it is visually neutral. */
const chroma = (c) => (Math.max(...c) - Math.min(...c)) / 255;
const ACHROMATIC = 0.12;

let worstPanel = { v: Infinity }, worstSep = { v: Infinity };
for (const t of T.THEMES) {
  for (const cut of ["dark", "light"]) {
    const panel = PANEL[t.id + ":" + cut];
    if (!panel) { ok(false, `no panel colour known for ${t.id}/${cut}`); continue; }
    const up = hex2rgb(t.candles[cut][0]), dn = hex2rgb(t.candles[cut][1]);
    const cu = contrast(up, panel), cd = contrast(dn, panel);
    if (cu < worstPanel.v) worstPanel = { v: cu, who: `${t.id}/${cut} up` };
    if (cd < worstPanel.v) worstPanel = { v: cd, who: `${t.id}/${cut} down` };
    if (cu < MIN_ON_PANEL || cd < MIN_ON_PANEL) {
      ok(false, `${t.id}/${cut} is hard to see on its own panel (up ${cu.toFixed(2)}, down ${cd.toFixed(2)})`);
    }

    const mono = chroma(up) < ACHROMATIC && chroma(dn) < ACHROMATIC;
    if (mono) {
      const k = contrast(up, dn);
      if (k < worstSep.v) worstSep = { v: k, who: `${t.id}/${cut} (luminance)`, unit: ":1" };
      if (k < MIN_PAIR_K) {
        ok(false, `${t.id}/${cut} is an achromatic pair that does not separate by light (${k.toFixed(2)}:1)`);
      }
    } else {
      const g = hueGap(up, dn);
      if (g / 60 * 2.2 < worstSep.v) worstSep = { v: g / 60 * 2.2, who: `${t.id}/${cut} (hue ${g.toFixed(0)} deg)`, unit: "" };
      if (g < MIN_HUE_GAP) {
        ok(false, `${t.id}/${cut} up and down are too close in hue (${g.toFixed(0)} deg)`);
      }
      /* A chromatic pair must not ALSO be a luminance trap: two colours
         60 degrees apart that render as the same grey are the pair a
         colour-blind trader cannot read at all. */
      const k = contrast(up, dn);
      if (k < 1.25) {
        ok(false, `${t.id}/${cut} differs only in hue -- identical in luminance (${k.toFixed(2)}:1)`);
      }
    }
  }
}
ok(worstPanel.v >= MIN_ON_PANEL,
  `every candle clears ${MIN_ON_PANEL}:1 on its own chart panel (worst ${worstPanel.v.toFixed(2)} at ${worstPanel.who})`);
ok(worstSep.v >= MIN_PAIR_K,
  `up and down stay unmistakable in every theme (worst ${worstSep.who})`);

/* The pairs have to be visibly different FROM EACH OTHER, not merely
   unequal.

   "No two themes share a pair" passed happily on a table where every up
   colour sat between hue 146 and 168 -- twelve shades of the same green,
   differing in the last digit of a hex code and in nothing a person could
   see. Each theme is supposed to draw its candles out of its own palette,
   so the spread across the table is the thing to measure: cyber's acid
   lime, sunset's warm olive and ocean's aqua are the same direction in
   three genuinely different greens.

   Still inside the family rule below -- this widens the range the greens
   and reds are drawn from, it does not let a theme pick a blue. */
/* As a fraction of the window each family is allowed, not as a flat
   number of degrees: the rising rule below permits hue 80-200 (120 deg)
   and the falling rule permits 320-30 (70 deg), so demanding the same
   absolute spread of both would quietly require the reds to use their
   entire legal range and leave no room to tune one. */
const FAMILY_WINDOW = { rising: 120, falling: 70 };
const MIN_WINDOW_USE = 0.45;
for (const cut of ["dark", "light"]) {
  for (const [slot, which] of [[0, "rising"], [1, "falling"]]) {
    const need = FAMILY_WINDOW[which] * MIN_WINDOW_USE;
    // Measured on a circle, relative to the family's own mean, so the reds
    // straddling 0 degrees are not read as a 350-degree spread.
    const hs = T.THEMES
      .filter((t) => t.id !== "custom")
      /* Achromatic themes contribute a hue the eye cannot see. Counting
         it inflates the spread: with Relief and Mono included this read
         127% of the window, which would let a genuinely monotonous
         chromatic table hide behind two greys. */
      .filter((t) => chroma(hex2rgb(t.candles[cut][slot])) >= ACHROMATIC)
      .map((t) => hue(hex2rgb(t.candles[cut][slot])));
    const rad = hs.map((h) => (h * Math.PI) / 180);
    const mean = Math.atan2(
      rad.reduce((a, r) => a + Math.sin(r), 0) / rad.length,
      rad.reduce((a, r) => a + Math.cos(r), 0) / rad.length);
    const off = hs.map((h) => {
      let d = h - (mean * 180) / Math.PI;
      while (d > 180) d -= 360;
      while (d < -180) d += 360;
      return d;
    });
    const spread = Math.max(...off) - Math.min(...off);
    ok(spread >= need,
      `the ${cut} ${which} colours span ${spread.toFixed(0)} deg of hue across the themes, ` +
      `${((spread / FAMILY_WINDOW[which]) * 100).toFixed(0)}% of the family's window ` +
      `(>= ${(MIN_WINDOW_USE * 100).toFixed(0)}%, or the table is one colour twelve times)`);
  }
}

/* Direction has to keep meaning the same thing. Whatever the theme, the
   rising colour is the greener of the two and the falling one the redder
   - a theme that swapped them would be a trap, not a style. */
let swapped = [];
for (const t of T.THEMES) {
  for (const cut of ["dark", "light"]) {
    const upc = hex2rgb(t.candles[cut][0]), dnc = hex2rgb(t.candles[cut][1]);
    /* An achromatic theme has no green and no red to be on the wrong
       side of; for those the direction cue is light, and it is checked
       above. Asking for the hue of #8b8b91 gets an answer, which is the
       trap: it is 240, and that means nothing. */
    if (chroma(upc) < ACHROMATIC && chroma(dnc) < ACHROMATIC) {
      /* The rising candle must still be the emphatic one. "Brighter" is
         the wrong test: on a light panel the colour that asserts itself
         is the dark one, which is why Relief rises near-white on the
         dark cut and near-black on the light one. What holds in both is
         that the rise stands further off the panel than the fall. */
      const p2 = PANEL[t.id + ":" + cut];
      if (p2 && contrast(upc, p2) <= contrast(dnc, p2)) {
        swapped.push(`${t.id}/${cut} (achromatic, but the fall stands out more than the rise)`);
      }
      continue;
    }
    const up = hue(upc);
    const dn = hue(dnc);
    const isGreen = up > 80 && up < 200;
    const isRed = dn < 30 || dn > 320;
    if (!isGreen || !isRed) swapped.push(`${t.id}/${cut} (up ${up.toFixed(0)}, down ${dn.toFixed(0)})`);
  }
}
ok(swapped.length === 0,
  `up is always the green family and down the red family (${swapped.join(", ") || "all 24 correct"})`);

/* --------------------------------------------------- the trader still wins */

applyIn("ocean", "dark");
T.edit({ candle_up: "#123456" }, { silent: true });
T.apply();
let e = published();
ok(e[0] === "#123456", `a chosen colour beats the theme's own (${e[0]})`);
ok(e[1] === T.BY_ID.ocean.candles.dark[1],
  `and the half that was not chosen still comes from the theme (${e[1]})`);

T.edit({ candle_up: "" }, { silent: true });
T.apply();
e = published();
ok(e[0] === T.BY_ID.ocean.candles.dark[0],
  `clearing the choice returns the theme's own pair (${e[0]})`);

/* The settings rows must still be able to tell "the theme ships this"
   from "the trader chose this", or Clear appears on an unedited row and
   does nothing. */
ok(Object.keys(T.colours("ocean")).length === 0,
  "an unedited theme reports no chosen colours, so no Clear button is offered");
T.edit({ candle_up: "#123456" }, { silent: true });
ok(T.colours("ocean").candle_up === "#123456", "and an edited one reports the choice");
T.edit({ candle_up: "" }, { silent: true });

/* Switching cut has to re-publish: the pair is per-cut, so a desk going
   light with no wallpaper used to keep painting the dark pair on white. */
applyIn("sunset", "dark");
win.document.documentElement.dataset.theme = "light";
const settle = () => new Promise((r) => setTimeout(r, 30));
settle().then(() => {
  const now = published();
  ok(now[0] === T.BY_ID.sunset.candles.light[0],
    `changing cut re-publishes without a theme change (${now[0]})`);
  console.log("");
  console.log(failed ? `theme-candles: ${failed} FAILED` : "theme-candles: all checks passed");
  process.exit(failed ? 1 : 0);
});
