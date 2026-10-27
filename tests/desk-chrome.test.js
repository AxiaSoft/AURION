/**
 * Desk chrome: glass, header buttons, overflow, and the positions strip.
 *
 * Seven faults were reported together, and all seven are the kind that a
 * textual grep "passes" forever:
 *
 *  1. Settings looked see-through rather than frosted. The panel had the
 *     alpha but no backdrop-filter, which is not glass - it is a hole.
 *     Grepping for `.set-block` found the rule and proved nothing.
 *  2. The MT5 expert row pushed its Save button out through the card on a
 *     phone, because an unbreakable 20-character file name sat in a column
 *     with min-width:auto next to a column that cannot shrink.
 *  3. The custom accent took three gestures to re-apply.
 *  6. The refresh key was a different size from its neighbours below
 *     560px, and the three header glyphs were hand-drawn at three
 *     different stroke widths.
 *  7. Open positions were only reachable from a tab inside the drawing
 *     dock, so the page a trader watches during a trade never mentioned
 *     it.
 *
 * These checks resolve the cascade at real viewport widths and read the
 * actual markup, rather than asserting that some text appears somewhere.
 *
 *     node tests/desk-chrome.test.js
 */
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "apps/web");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
/* A checker that does not strip comments will lie: a selector named inside
   a /* *​/ block is not a rule, and every one of these files documents the
   bug it fixes in prose directly above the fix. */
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "");

let failed = 0;
const ok = (c, m) => { if (!c) { failed++; console.log("FAIL " + m); } else console.log("ok   " + m); };

/* ------------------------------------------------- a small cascade model */

/** Flatten a stylesheet to rules in source order, descending into @media. */
function blocks(src, cond, out) {
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
      blocks(body, (cond ? cond + " and " : "") + head.replace("@media", "").trim(), out);
    } else if (!head.startsWith("@")) {
      out.push({ sel: head, body, cond: cond || "" });
    }
    i = j;
  }
  return out;
}

function holds(cond, w) {
  if (!cond) return true;
  if (/pointer|hover|prefers|orientation|print/.test(cond)) return false;
  for (const m of cond.matchAll(/max-width:\s*(\d+)px/g)) if (!(w <= Number(m[1]))) return false;
  for (const m of cond.matchAll(/min-width:\s*(\d+)px/g)) if (!(w >= Number(m[1]))) return false;
  return true;
}

/** Specificity of a simple selector: [ids, classes+attrs, types]. */
function spec(sel) {
  const ids = (sel.match(/#[\w-]+/g) || []).length;
  const cls = (sel.match(/\.[\w-]+|\[[^\]]+\]|:not\(/g) || []).length;
  const typ = (sel.match(/(^|[\s>])[a-z][\w-]*/gi) || []).length;
  return [ids, cls, typ];
}
const cmp = (a, b) => (a[0] - b[0]) || (a[1] - b[1]) || (a[2] - b[2]);

/**
 * Does `sel` match the element at the end of `pathEls`?
 * `pathEls` is an ancestor-to-self list of { tag, id, classes }.
 * Only descendant and child combinators are modelled, which is all these
 * stylesheets use for the surfaces under test.
 */
function matches(sel, pathEls) {
  const parts = sel.trim().split(/\s+(?![^(]*\))/).filter(Boolean);
  if (parts.some((p) => p === ">")) {
    // normalise "a > b" into tokens carrying a child flag
    const toks = [];
    let child = false;
    for (const p of parts) {
      if (p === ">") { child = true; continue; }
      toks.push({ sel: p, child });
      child = false;
    }
    return walk(toks, pathEls);
  }
  return walk(parts.map((p) => ({ sel: p, child: false })), pathEls);
}

function simple(sel, el) {
  if (!el) return false;
  for (const m of sel.matchAll(/#([\w-]+)/g)) if (el.id !== m[1]) return false;
  for (const m of sel.matchAll(/\.([\w-]+)/g)) if (!el.classes.includes(m[1])) return false;
  for (const m of sel.matchAll(/\[([\w-]+)(?:[~|^$*]?=)?("?)([^\]"]*)\2\]/g)) {
    const have = el.attrs && Object.prototype.hasOwnProperty.call(el.attrs, m[1]);
    if (!have) return false;
    if (m[3] && el.attrs[m[1]] !== m[3]) return false;
  }
  const t = /^([a-z][\w-]*)/i.exec(sel);
  if (t && el.tag && el.tag !== t[1]) return false;
  if (/::?[a-z-]+\(?/i.test(sel.replace(/:not\([^)]*\)/g, ""))) {
    // pseudo-elements/classes beyond :not are out of scope
    if (!/^[^:]*(:not\([^)]*\))?$/.test(sel)) return false;
  }
  return true;
}

function walk(toks, els) {
  let ti = toks.length - 1;
  let ei = els.length - 1;
  if (!simple(toks[ti].sel, els[ei])) return false;
  ti--; ei--;
  while (ti >= 0) {
    if (toks[ti + 1].child) {
      if (ei < 0 || !simple(toks[ti].sel, els[ei])) return false;
      ti--; ei--;
    } else {
      let found = false;
      while (ei >= 0) {
        if (simple(toks[ti].sel, els[ei])) { found = true; break; }
        ei--;
      }
      if (!found) return false;
      ti--; ei--;
    }
  }
  return true;
}

/** Resolve one property for an element path at a viewport width. */
function resolve(rules, pathEls, prop, w) {
  let win = null;
  rules.forEach((r, idx) => {
    if (!holds(r.cond, w)) return;
    const sels = r.sel.split(",").map((x) => x.trim()).filter(Boolean);
    let best = null;
    for (const s of sels) {
      let m = false;
      try { m = matches(s, pathEls); } catch (e) { m = false; }
      if (m) { const sp = spec(s); if (!best || cmp(sp, best) > 0) best = sp; }
    }
    if (!best) return;
    const d = [...r.body.matchAll(new RegExp("(?:^|;)\\s*" + prop + "\\s*:([^;]+)", "g"))].pop();
    if (!d) return;
    const bang = /!important/.test(d[1]);
    const rank = [bang ? 1 : 0, ...best, idx];
    if (!win || cmpRank(rank, win.rank) >= 0) win = { val: d[1].replace("!important", "").trim(), rank, cond: r.cond };
  });
  return win;
}
function cmpRank(a, b) {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

const el = (tag, id, classes, attrs) => ({ tag, id, classes: classes || [], attrs: attrs || {} });

const appRules = blocks(strip(read("css/app.css")));
const skinRules = blocks(strip(read("css/skins.css")));
const html = read("index.html");
const appJs = read("js/app.js");
const appJsNC = strip(appJs);
const themesJs = strip(read("js/themes.js"));

ok(appRules.length > 300, `app.css parsed into rules (${appRules.length})`);
ok(skinRules.length > 50, `skins.css parsed into rules (${skinRules.length})`);

/* =======================================================================
   1 - Settings is glass, in both glass modes
   ======================================================================= */

const setBlockPath = [
  el("html", "", [], { "data-skin": "glass", "data-theme": "dark" }),
  el("div", "", ["set-desk", "set-rail"]),
  el("div", "", ["set-main"]),
  el("section", "set-robot", ["set-block"]),
];

const bf = resolve(appRules, setBlockPath, "backdrop-filter", 1200);
ok(bf && /blur\(\s*\d/.test(bf.val),
  `the settings panel is frosted, not merely translucent (backdrop-filter: ${bf ? bf.val : "none"})`);
const wbf = resolve(appRules, setBlockPath, "-webkit-backdrop-filter", 1200);
ok(wbf && /blur\(/.test(wbf.val), "the settings panel carries the -webkit- prefix too");

const setBg = resolve(appRules, setBlockPath, "background", 1200);
ok(setBg && /\/\s*\.?\d/.test(setBg.val),
  `and it is still translucent, or there is nothing for the blur to show (${setBg ? setBg.val : "none"})`);

/* Glass off must ground it. Without this the one surface that is nothing
   but glass stays see-through in the mode whose entire purpose is to stop
   that - which is what the dead `.set-panel` rule was failing to do. */
const offPath = [
  el("html", "", [], { "data-skin": "glass", "data-theme": "dark", "data-glass": "off" }),
  el("div", "", ["set-desk", "set-rail"]),
  el("div", "", ["set-main"]),
  el("section", "set-robot", ["set-block"]),
];
const offBg = resolve(skinRules, offPath, "background", 1200);
ok(offBg && !/\/\s*\.?\d/.test(offBg.val),
  `with glass off the settings panel is opaque (${offBg ? offBg.val : "no rule at all"})`);

const fastPath = [
  el("html", "", [], { "data-skin": "glass", "data-theme": "dark", "data-perf": "fast" }),
  el("div", "", ["set-desk", "set-rail"]),
  el("div", "", ["set-main"]),
  el("section", "set-robot", ["set-block"]),
];
const fastBg = resolve(skinRules, fastPath, "background", 1200);
ok(fastBg && !/\/\s*\.?\d/.test(fastBg.val),
  `and in fast-performance mode too (${fastBg ? fastBg.val : "no rule at all"})`);

const lightOff = [
  el("html", "", [], { "data-skin": "glass", "data-theme": "light", "data-glass": "off" }),
  el("div", "", ["set-desk", "set-rail"]),
  el("div", "", ["set-main"]),
  el("section", "set-robot", ["set-block"]),
];
const lightBg = resolve(skinRules, lightOff, "background", 1200);
ok(lightBg && !/\/\s*\.?\d/.test(lightBg.val),
  `and the light theme grounds it too (${lightBg ? lightBg.val : "no rule at all"})`);

/* The rule that used to stand here named a class no view renders. */
ok(!/\.set-panel\b/.test(strip(read("css/skins.css"))),
  "the dead .set-panel selector is gone, so the real one cannot hide behind it");
ok(!/set-panel/.test(appJsNC) && !/set-panel/.test(html),
  "and nothing renders a .set-panel, which is why it was dead");

/* =======================================================================
   6b - the status drawer can actually frost
   ======================================================================= */

/* An element with a backdrop-filter is the backdrop root for its subtree:
   a descendant's own blur sees only the ancestor's composited pixels,
   which below the header's edge is nothing. So the drawer being inside
   .top made its blur inert no matter what the rule said. */
const header = /<header class="top">([\s\S]*?)<\/header>/.exec(html);
ok(header, "the header block was found in index.html");
ok(header && !/<div[^>]*class="hdr-drawer"/.test(header[1]),
  "the status drawer is not inside the frosted header, so its own blur has something to blur");
ok(/<div class="hdr-drawer" id="hdr-drawer"/.test(html), "the status drawer is still in the page");

const drawerPath = [
  el("html", "", [], { "data-skin": "glass", "data-theme": "dark" }),
  el("section", "desk", []),
  el("div", "hdr-drawer", ["hdr-drawer"]),
];
const dbf = resolve(appRules, drawerPath, "backdrop-filter", 390);
ok(dbf && /blur\(/.test(dbf.val), "the drawer asks to be frosted");
const dArea = resolve(appRules, drawerPath, "grid-area", 390);
ok(dArea && dArea.val === "stage",
  `and it is positioned into the stage's grid area instead of hung off the header (${dArea ? dArea.val : "none"})`);
const deskPos = resolve(appRules, [el("section", "desk", [])], "position", 390);
ok(deskPos && deskPos.val === "relative",
  "#desk is the containing block it needs, or it would escape to the viewport");

/* =======================================================================
   6a - every header button is the same size at every width
   ======================================================================= */

const ICON_BTNS = ["btn-hdr-drawer", "btn-refresh", "btn-theme"];
for (const w of [1200, 820, 560, 390]) {
  const sizes = ICON_BTNS.map((id) => {
    const p = [
      el("header", "", ["top"]),
      el("div", "", ["top-actions"]),
      el("button", id, id === "btn-hdr-drawer" ? ["icon-btn", "hdr-drawer-btn"] : ["icon-btn"]),
    ];
    return {
      id,
      width: (resolve(appRules, p, "width", w) || {}).val,
      height: (resolve(appRules, p, "height", w) || {}).val,
      min: (resolve(appRules, p, "min-width", w) || {}).val,
    };
  });
  const same = sizes.every((s) =>
    s.width === sizes[0].width && s.height === sizes[0].height && s.min === sizes[0].min);
  ok(same, `at ${w}px the three header buttons are one size (` +
    sizes.map((s) => `${s.id}=${s.width}/${s.height}`).join(" ") + ")");
  ok(sizes[0].width && /\d/.test(sizes[0].width),
    `at ${w}px that size is a real number (${sizes[0].width})`);
}

/* A flex row will shrink a fixed-width button when the header runs out of
   room, and refresh was first in line for it. */
const shrink = resolve(appRules, [
  el("header", "", ["top"]), el("div", "", ["top-actions"]), el("button", "btn-refresh", ["icon-btn"]),
], "flex", 1200);
ok(shrink && /^0\s+0/.test(shrink.val),
  `header buttons opt out of flex shrinking (${shrink ? shrink.val : "none"})`);

/* The glyphs themselves. Three hand-drawn SVGs at stroke widths 1.8, 1.7
   and 2.0 do not look like one set however equal their boxes are. */
const svgs = ICON_BTNS.map((id) => {
  const m = new RegExp(`<button[^>]*id="${id}"[^>]*>\\s*(<svg[\\s\\S]*?</svg>)`).exec(html);
  return { id, svg: m && m[1] };
});
ok(svgs.every((s) => s.svg), "each header button still has an inline glyph");
const widths = svgs.map((s) => (/stroke-width="([\d.]+)"/.exec(s.svg) || [])[1]);
ok(new Set(widths).size === 1, `all header glyphs share one stroke width (${widths.join(", ")})`);
const boxes = svgs.map((s) => (/viewBox="([^"]+)"/.exec(s.svg) || [])[1]);
ok(new Set(boxes).size === 1 && boxes[0] === "0 0 24 24",
  `and one viewBox, so equal rendered sizes mean equal drawn sizes (${boxes.join(" | ")})`);

/* The markup is drawn before app.js runs, so it cannot be repainted from
   icon() at boot without a visible flash. It must therefore agree with
   icon()'s table by hand - and that agreement is what this asserts. */
const iconTable = {};
for (const m of appJs.matchAll(/^\s{4}([a-zA-Z][\w]*):\s*'([^']*)',$/gm)) iconTable[m[1]] = m[2];
ok(Object.keys(iconTable).length > 30, `icon() table read (${Object.keys(iconTable).length} names)`);
const PAIRS = { "btn-hdr-drawer": "chevron", "btn-refresh": "refresh", "btn-theme": "sun" };
for (const [id, name] of Object.entries(PAIRS)) {
  const inline = svgs.find((s) => s.id === id).svg;
  const body = inline.replace(/^<svg[^>]*>/, "").replace(/<\/svg>$/, "").trim();
  ok(iconTable[name] !== undefined, `icon() still defines "${name}"`);
  ok(body === iconTable[name],
    `#${id}'s markup is icon("${name}") verbatim, so the two can never drift`);
}
/* icon() itself draws at one stroke width; the markup must use the same. */
const iconStroke = /stroke-width="([\d.]+)"/.exec(appJs.slice(appJs.indexOf("function icon("), appJs.indexOf("function icon(") + 9000));
ok(iconStroke && iconStroke[1] === widths[0],
  `and at icon()'s own stroke width (${iconStroke ? iconStroke[1] : "?"} vs ${widths[0]})`);

/* =======================================================================
   2 - the MT5 expert row keeps its button inside the card
   ======================================================================= */

const eaLeft = [el("div", "", ["ea-row"]), el("div", "", ["ea-row-main"])];
const mw = resolve(appRules, eaLeft, "min-width", 390);
ok(mw && mw.val === "0",
  `the expert row's text column may shrink (${mw ? mw.val : "min-width:auto - it cannot"})`);

const eaEnd = [el("div", "", ["ea-row"]), el("div", "", ["ea-row-end"])];
const endFlex = resolve(appRules, eaEnd, "flex", 390);
const wrap = resolve(appRules, [el("div", "", ["ea-row"])], "flex-wrap", 390);
ok(wrap && wrap.val === "wrap",
  `and on a phone the row may wrap rather than overflow (${wrap ? wrap.val : "nowrap"})`);
const mainFlex = resolve(appRules, eaLeft, "flex", 390);
ok(mainFlex && /100%/.test(mainFlex.val),
  `the text column takes a full line (${mainFlex ? mainFlex.val : "none"})`);
ok(endFlex === null || /0 0/.test(endFlex.val) || /100%/.test(endFlex.val),
  `so the version and Save button take their own line (${endFlex ? endFlex.val : "none"})`);
ok(resolve(appRules, [el("div", "", ["ea-row"])], "flex-wrap", 1200) === null ||
   resolve(appRules, [el("div", "", ["ea-row"])], "flex-wrap", 1200).val !== "wrap",
  "while a desktop keeps the two columns side by side");

/* The name that overflowed is the long one; both are still shipped. */
ok(fs.existsSync(path.join(__dirname, "..", "engine/ea/AurionChartAgent.mq5")),
  "AurionChartAgent.mq5 - the file whose name overflowed - is still shipped");
const breakAny = resolve(appRules, [
  el("div", "", ["ea-row"]), el("div", "", ["ea-row-main"]),
  el("b", "", ["mono", "ea-row-file"]),
], "overflow-wrap", 390);
ok(breakAny && breakAny.val === "anywhere",
  "the monospaced file name may break, since it has no spaces to break at");

/* =======================================================================
   5 - the backtest form is compact on a phone
   ======================================================================= */

const btField = [
  el("div", "bt-card", ["card"]),
  el("div", "", ["ct-grid", "ct-grid-3"]),
  el("label", "", ["field"]),
];
const dir390 = resolve(appRules, btField, "flex-direction", 390);
ok(dir390 && dir390.val === "row",
  `at 390px each backtest option is one line, label beside control (${dir390 ? dir390.val : "column"})`);
const dir1200 = resolve(appRules, btField, "flex-direction", 1200);
ok(dir1200 && dir1200.val === "column",
  "while a desktop keeps the label above its control");
/* It must not have leaked into the other grid that shares these classes. */
const ticket = [el("div", "", ["ct-grid", "ct-grid-3"]), el("label", "", ["field"])];
const tDir = resolve(appRules, ticket, "flex-direction", 390);
ok(tDir && tDir.val === "column",
  "and the change is scoped to the backtest, leaving the manual ticket alone");

/* The point of the change: three options in noticeably less height. */
const LABEL = 16, CTRL = 44, INNER = 8;
const before = 3 * (LABEL + INNER + CTRL) + 2 * 8;
const after = 3 * CTRL + 2 * 6;
ok(after < before * 0.75,
  `the three options take ${after}px instead of ${before}px`);

/* =======================================================================
   7 - open positions sit beside both charts, outside the chart
   ======================================================================= */

ok(/function positionsStripHtml\(/.test(appJsNC), "there is a positions strip to render");
ok(/function paintPositionStrips\(/.test(appJsNC), "and it is repainted in place rather than by re-rendering");

/* Re-rendering a chart card would tear down the canvas being watched. */
const painter = /function paintPositionStrips\([\s\S]*?\n\}/.exec(appJsNC)[0];
ok(/innerHTML/.test(painter) && !/outerHTML/.test(painter),
  "the repaint replaces the list, not the strip, so it cannot loop on its own signature");
ok(/dataset\.sig/.test(painter), "and it is guarded by a signature, so an unchanged snapshot touches nothing");

/* Driven by the same trigger as the chart's own levels. */
const levels = /function applyChartLevels\([\s\S]*?\n\}/.exec(appJsNC)[0];
ok(/paintPositionStrips\(\)/.test(levels),
  "whatever moves the lines on the canvas also moves the strip above it");

/* Both charts, and in both cases before the chart box - never over it. */
const markets = /markets\(\) \{[\s\S]*?\n  \},/.exec(appJsNC)[0];
ok(/positionsStripHtml\(/.test(markets), "the Markets chart shows open positions");
ok(markets.indexOf("positionsStripHtml(") < markets.indexOf('class="chart-box"'),
  "and the strip is above the chart box, so it cannot cover price");
ok(markets.indexOf('class="mk-bar"') < markets.indexOf("positionsStripHtml("),
  "and below the toolbar, so it cannot cover the buttons");

const chartCard = /const chartCard = \([\s\S]*?\n    \};/.exec(appJsNC)[0];
ok(/positionsStripHtml\(/.test(chartCard), "each EA chart card shows open positions");
ok(chartCard.indexOf("positionsStripHtml(") < chartCard.indexOf('class="chart-box"'),
  "in the same defined place, above its chart box");

/* In the flow, not floating over anything. */
const stripPos = resolve(appRules, [el("div", "", ["pos-strip"])], "position", 1200);
ok(stripPos === null, `the strip is in the normal flow (${stripPos ? stripPos.val : "static"})`);
const minH = resolve(appRules, [el("div", "", ["pos-strip"])], "min-height", 1200);
ok(minH && /\d/.test(minH.val),
  `and holds its height when nothing is open, so the chart never jumps (${minH ? minH.val : "none"})`);
const listOv = resolve(appRules, [el("div", "", ["pos-strip"]), el("div", "", ["pos-strip-list"])], "overflow-x", 1200);
ok(listOv && listOv.val === "auto",
  "more positions than fit scroll sideways rather than growing the strip");
ok(/pos-none/.test(appJsNC), "and an empty strip says so rather than collapsing");

/* Every class it uses must have a rule, or the strip ships unstyled. */
const stripHtml = /function positionsStripHtml\([\s\S]*?\n\}/.exec(appJsNC)[0]
  + /function positionsStripBody\([\s\S]*?\n\}/.exec(appJsNC)[0];
const used = new Set();
for (const m of stripHtml.matchAll(/class="([^"$]*)"/g)) m[1].split(/\s+/).filter(Boolean).forEach((c) => used.add(c));
for (const m of stripHtml.matchAll(/is-\$\{dir\}/g)) { used.add("is-buy"); used.add("is-sell"); }
const allCss = strip(read("css/app.css"));
const missing = [...used].filter((c) => !new RegExp("\\." + c + "[^\\w-]").test(allCss));
ok(missing.length === 0, `every class the strip uses has a rule (missing: ${missing.join(", ") || "none"})`);

/* =======================================================================
   4 - candle colours are editable, and previewable
   ======================================================================= */

ok(/COLOR_KEYS = \[[^\]]*"candle_up"[^\]]*"candle_down"/.test(themesJs),
  "the theme engine accepts a candle pair");
const colourCss = /function colourCss\([\s\S]*?\n  \}/.exec(themesJs)[0];
ok(/--candle-up:/.test(colourCss) && /--candle-down:/.test(colourCss),
  "and publishes them as the variables the chart already reads");

const builder = /const colourRow = \([\s\S]*?return `\s*<div class="card tc-custom"[\s\S]*?\n  \}/.exec(appJsNC);
ok(builder, "the theme builder markup was found");
ok(/colourRow\("candle_up"/.test(appJsNC) && /colourRow\("candle_down"/.test(appJsNC),
  "the builder offers a row for each direction");

/* The picker titles each row with themes.c_<key>, so the keys must exist
   in all three languages or the dialog opens showing its own key. */
const NEEDED = ["candles_title", "candles_hint", "c_candle_up", "c_candle_up_hint",
  "c_candle_down", "c_candle_down_hint"];
for (const lang of ["en", "fa", "ar"]) {
  const d = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "lang", lang + ".json"), "utf8"));
  const gone = NEEDED.filter((k) => !d.themes || !d.themes[k]);
  ok(gone.length === 0, `${lang} has every new theme string (missing: ${gone.join(", ") || "none"})`);
}

/* The preview. A canvas would need telling to repaint and there is no
   chart on the settings page anyway; drawn in CSS from the same two
   variables, it restyles on the frame the picker writes them. */
ok(/class="cndl-prev"/.test(appJsNC), "there is a candle preview in the builder");
const up = resolve(appRules, [el("div", "", ["cndl-prev"]), el("i", "", ["cndl", "is-up"])], "color", 1200);
const down = resolve(appRules, [el("div", "", ["cndl-prev"]), el("i", "", ["cndl", "is-down"])], "color", 1200);
ok(up && up.val === "var(--candle-up)", `the preview's rising bars read --candle-up (${up ? up.val : "none"})`);
ok(down && down.val === "var(--candle-down)", `and its falling bars read --candle-down (${down ? down.val : "none"})`);

/* previewColour writes whatever colourCss emits straight onto <html>, so
   the preview is live only because the pair goes through that same path. */
const preview = /function previewColour\([\s\S]*?\n\}/.exec(appJsNC)[0];
ok(/AurionTheme\.colourCss\(/.test(preview),
  "the drag preview goes through colourCss, which is what makes the candle pair live");

/* And the row must read back the colour in force when nothing is chosen,
   or the trader edits blind. */
ok(/candle_up:\s*"--candle-up"/.test(appJsNC) && /candle_down:\s*"--candle-down"/.test(appJsNC),
  "an unset candle row shows the colour the active theme is really drawing with");

/* ----------------------------------------------------------------- report */
console.log("");
console.log(failed ? `desk-chrome: ${failed} FAILED` : "desk-chrome: all checks passed");
process.exit(failed ? 1 : 0);
