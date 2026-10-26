/**
 * The interface draws its own icons.
 *
 * The desk and the shop used to lean on emoji, and on a scattering of
 * typographic characters pressed into service as icons: a padlock in a
 * trust badge, a pushpin stamped on the chart, a heart written as U+2661,
 * a tick as U+2713, a search glass as U+2315, status shown as a green or
 * red circle emoji.
 *
 * They were never ours to style:
 *
 *   - every platform draws them differently, and several draw them in
 *     full colour in the middle of grey text, so they ignore the theme
 *     and the accent colour the trader chose;
 *   - they do not inherit weight or size from the text beside them, so
 *     they sit off the baseline and jump when the text scales;
 *   - the typographic ones are simply missing from a good many fonts and
 *     fall back to a box;
 *   - a red circle next to the word "armed" says the same thing twice in
 *     one culture and nothing at all in another.
 *
 * Everything user-facing is now a drawn SVG in currentColor, so it takes
 * the colour, size and weight of whatever surrounds it.
 *
 * This guards the result. A reviewer cannot reasonably spot a single
 * re-introduced emoji in forty-odd files, and the next person adding a
 * button will reach for one out of habit.
 *
 * Deliberately NOT covered, both by the owner's decision:
 *
 *   - engine/aurion/telegram/bot.py. Telegram renders no SVG; there the
 *     emoji IS the icon set, and the buttons use colour to show state.
 *   - markdown and other documentation. Those are text files, not an
 *     interface.
 *
 * Arrows in prose ("Settings -> Apps") are left alone too. They are
 * punctuation, not icons, and no icon would replace them.
 */

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const results = [];

function check(name, fn) {
  try {
    fn();
    results.push(true);
    console.log("PASS  " + name);
  } catch (err) {
    results.push(false);
    console.log("FAIL  " + name + "\n      " + String(err.message).replace(/\n/g, "\n      "));
  }
}

/* ------------------------------------------------------------ what counts */

/**
 * Pictographic emoji, plus the specific text characters this codebase had
 * been using as icons. Listed one at a time rather than as a sweeping
 * range, so that ordinary punctuation and the box-drawing used in README
 * diagrams keep working, and so each entry can be justified.
 */
const EMOJI_BLOCKS = [
  [0x1f000, 0x1faff], // pictographs, symbols, transport, flags, supplemental
  [0x1f1e6, 0x1f1ff], // regional indicators
  [0x2600, 0x27bf],   // miscellaneous symbols and dingbats
  [0x2b00, 0x2bff],   // arrows and stars block (the heavy decorative ones)
];

/** Text glyphs that were standing in for icons. */
const GLYPH_ICONS = {
  "\u2661": "white heart (wishlist)",
  "\u2665": "black heart (wishlist)",
  "\u2315": "telephone recorder, used as a search glass",
  "\u2304": "down arrowhead, used as a disclosure chevron",
  "\u2605": "black star",
  "\u2606": "white star",
  "\u25cf": "black circle, used as a status dot",
  "\u25cb": "white circle, used as a status dot",
};

/**
 * Characters that look like they belong to the blocks above but are plain
 * punctuation in running text. An arrow between two menu names is prose.
 */
const PROSE = new Set([
  "\u2192", "\u2190", "\u2191", "\u2193", // -> <- up down
  "\u2194", "\u21d2", "\u2026", "\u2014", "\u2013",
  "\u221e", // infinity, used for "unlimited uses"
  "\u2713", // see below: allowed only outside the surfaces we own
]);

function offenders(text, { allowTick } = {}) {
  const found = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const cp = text.codePointAt(i);
    if (cp > 0xffff) i++; // surrogate pair
    if (PROSE.has(ch)) continue;
    if (ch === "\ufe0f") { found.push({ ch, why: "emoji variation selector" }); continue; }
    if (ch === "\u2713" || ch === "\u2714") {
      if (allowTick) continue;
      found.push({ ch, why: "tick drawn as a text character" });
      continue;
    }
    if (GLYPH_ICONS[ch]) { found.push({ ch, why: GLYPH_ICONS[ch] }); continue; }
    for (const [lo, hi] of EMOJI_BLOCKS) {
      if (cp >= lo && cp <= hi) { found.push({ ch, why: "emoji" }); break; }
    }
  }
  return found;
}

function report(file, found) {
  const text = fs.readFileSync(path.join(ROOT, file), "utf8");
  const lines = text.split("\n");
  return found
    .map((f) => {
      const n = lines.findIndex((l) => l.includes(f.ch));
      return `${file}:${n + 1}  ${f.ch}  (${f.why})`;
    })
    .join("\n");
}

/* ------------------------------------------------------- the surfaces we own */

function walk(dir, out = []) {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return out;
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(rel, out);
    else if (/\.(js|cjs|mjs|html|css)$/.test(entry.name)) out.push(rel);
  }
  return out;
}

const DESK = walk("apps/web");
const SHOP = walk("store/keyserver/public");
const ADMIN = walk("admin/update-server/public");

check("the desk interface contains no emoji", () => {
  const bad = [];
  for (const f of DESK) {
    const found = offenders(fs.readFileSync(path.join(ROOT, f), "utf8"));
    if (found.length) bad.push(report(f, found));
  }
  if (bad.length) throw new Error(bad.join("\n"));
});

check("the shop interface contains no emoji", () => {
  const bad = [];
  for (const f of SHOP) {
    const found = offenders(fs.readFileSync(path.join(ROOT, f), "utf8"));
    if (found.length) bad.push(report(f, found));
  }
  if (bad.length) throw new Error(bad.join("\n"));
});

check("the admin panel contains no emoji", () => {
  const bad = [];
  for (const f of ADMIN) {
    const found = offenders(fs.readFileSync(path.join(ROOT, f), "utf8"));
    if (found.length) bad.push(report(f, found));
  }
  if (bad.length) throw new Error(bad.join("\n"));
});

check("no emoji reaches the interface through a language pack", () => {
  /* A translator adding a cheerful tick to a button would put an emoji
     back on screen without touching a single line of code. */
  const bad = [];
  for (const f of fs.readdirSync(path.join(ROOT, "lang"))) {
    if (!f.endsWith(".json")) continue;
    const raw = fs.readFileSync(path.join(ROOT, "lang", f), "utf8");
    const found = offenders(raw);
    if (found.length) bad.push(report(path.join("lang", f), found));
  }
  if (bad.length) throw new Error(bad.join("\n"));
});

/* --------------------------------------------- the replacements are real icons */

const appJs = fs.readFileSync(path.join(ROOT, "apps/web/js/app.js"), "utf8");
const shopJs = fs.readFileSync(path.join(ROOT, "store/keyserver/public/app.js"), "utf8");

check("every icon the desk asks for is one it actually has", () => {
  /* icon("typo") silently renders an empty <svg>: a button with no mark
     and no error. The names are literals, so they can all be checked. */
  const table = appJs.slice(appJs.indexOf("function icon(name)"), appJs.indexOf("function $(id)"));
  const defined = new Set([...table.matchAll(/^\s{4}([A-Za-z]\w*):/gm)].map((m) => m[1]));
  if (defined.size < 20) throw new Error("only found " + defined.size + " icon definitions; did the table move?");
  const used = new Set([...appJs.matchAll(/\bicon\("([^"]+)"\)/g)].map((m) => m[1]));
  const missing = [...used].filter((n) => !defined.has(n));
  if (missing.length) throw new Error("icon() called with undefined name(s): " + missing.join(", "));
  if (!used.size) throw new Error("nothing calls icon() any more");
});

check("every icon the shop asks for is one it actually has", () => {
  const table = shopJs.slice(shopJs.indexOf("const ICONS = {"), shopJs.indexOf("function ico(name"));
  const defined = new Set([...table.matchAll(/^\s{2}([A-Za-z]\w*):/gm)].map((m) => m[1]));
  if (defined.size < 10) throw new Error("only found " + defined.size + " icon definitions");
  const used = new Set([...shopJs.matchAll(/\bico\("([^"]+)"/g)].map((m) => m[1]));
  const missing = [...used].filter((n) => !defined.has(n));
  if (missing.length) throw new Error("ico() called with undefined name(s): " + missing.join(", "));
});

check("the icons are drawn shapes that inherit the surrounding colour", () => {
  /* Rendered, not grepped. Both helpers build their markup by joining
     strings, so reading the source tells you about the template and not
     about the icon a user ends up looking at. A hard-coded fill or stroke
     would survive a theme change and an accent change, which is most of
     what was wrong with emoji to begin with. */
  const deskIcon = new Function(
    appJs.slice(appJs.indexOf("function icon(name)"), appJs.indexOf("function $(id)")) +
    "; return icon;")();
  const shopIco = new Function(
    shopJs.slice(shopJs.indexOf("const ICONS = {"), shopJs.indexOf("\nfunction ico(name")) +
    shopJs.slice(shopJs.indexOf("function ico(name"), shopJs.indexOf("\nconst state = {")) +
    "; return { ico, ICONS };")();

  const deskNames = [...new Set([...appJs.matchAll(/\bicon\("([^"]+)"\)/g)].map((m) => m[1]))];
  const rendered = deskNames.map((n) => ["desk icon(\"" + n + "\")", deskIcon(n)]);
  for (const n of Object.keys(shopIco.ICONS)) {
    rendered.push(["shop ico(\"" + n + "\")", shopIco.ico(n)]);
    rendered.push(["shop ico(\"" + n + "\", filled)", shopIco.ico(n, { fill: 1 })]);
  }

  for (const [label, markup] of rendered) {
    const open = markup.slice(0, markup.indexOf(">") + 1);
    if (!/^<svg /.test(markup)) throw new Error(label + " did not render an svg: " + markup);
    if (!open.includes('stroke="currentColor"')) {
      throw new Error(label + " is not stroked in currentColor: " + open);
    }
    const fill = /fill="([^"]*)"/.exec(open);
    if (!fill || !["none", "currentColor"].includes(fill[1])) {
      throw new Error(label + " has a fixed fill: " + open);
    }
    if (/#[0-9a-fA-F]{3,6}|rgb\(/.test(open)) {
      throw new Error(label + " hard-codes a colour: " + open);
    }
    /* An empty icon is the failure that looks like success: a button with
       a blank space where the mark should be. */
    const body = markup.slice(markup.indexOf(">") + 1, markup.lastIndexOf("</svg>"));
    if (body.trim().length < 10) throw new Error(label + " renders an empty icon");
  }
});

check("an icon put inside a button is given a size", () => {
  /* An inline <svg> with no width collapses or balloons to the default
     300x150 replaced-element box, which is how an icon swap turns into a
     broken layout. */
  const css = fs.readFileSync(path.join(ROOT, "apps/web/css/app.css"), "utf8");
  if (!/\.btn\s*>\s*svg\s*\{[^}]*width/.test(css)) {
    throw new Error("app.css never sizes an svg inside .btn");
  }
  const shopCss = fs.readFileSync(path.join(ROOT, "store/keyserver/public/style.css"), "utf8");
  if (!/\.btn svg[^{]*\{[^}]*width/.test(shopCss)) {
    throw new Error("the shop stylesheet never sizes an svg inside .btn");
  }
});

check("status is shown with the desk's own dot, not a coloured circle", () => {
  const about = appJs.slice(appJs.indexOf('I18N.t("about.sys_name")'), appJs.indexOf('I18N.t("about.maker")'));
  const dots = (about.match(/class="dot (live|down)"/g) || []).length;
  if (dots < 8) throw new Error("expected the About rows to use .dot live/down, found " + dots);
});

/* An emoji written as a \uXXXX escape is still an emoji on the screen, but
   it is plain ASCII in the file, so every scan above walks straight past
   it. This is not hypothetical: the mute button in the sound settings was
   carrying "\\uD83D\\uDD07" (a speaker) through the whole emoji sweep
   undetected, because the sweep read the source rather than what the
   source produces. */
check("no emoji is smuggled in as a unicode escape", () => {
  const bad = [];
  for (const file of [...DESK, ...SHOP, ...ADMIN]) {
    const text = fs.readFileSync(file, "utf8");
    /* Surrogate pairs first - every pictograph outside the BMP is written
       as two escapes - then lone escapes in the symbol blocks. */
    const decoded = text
      .replace(/\\u(d8[0-9a-f]{2})\\u(d[c-f][0-9a-f]{2})/gi,
        (_, hi, lo) => String.fromCharCode(parseInt(hi, 16), parseInt(lo, 16)))
      .replace(/\\u(2[0-9a-f]{3}|f[0-9a-f]{3})/gi,
        (_, hex) => String.fromCharCode(parseInt(hex, 16)));
    if (decoded === text) continue;
    const found = offenders(decoded);
    if (found.length) bad.push(report(path.relative(ROOT, file), found));
  }
  if (bad.length) throw new Error(bad.join("\n"));
});

check("the chart marker tool ships no emoji of its own", () => {
  const charts = fs.readFileSync(path.join(ROOT, "apps/web/js/charts.js"), "utf8");
  if (/onText\(\s*kind === "emoji"/.test(charts)) {
    throw new Error("the marker tool still pre-fills an emoji");
  }
  if (!/kind === "emoji" && !text/.test(charts)) {
    throw new Error("an empty marker no longer falls back to a drawn pin");
  }
});

/* ------------------------------------------------------------------ result */

const failed = results.filter((r) => !r).length;
console.log(`\nno-emoji: ${results.length - failed} of ${results.length} checks passed`);
if (failed) process.exit(1);
