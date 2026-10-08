/**
 * Layout defects that only show up on a real screen.
 *
 * Everything asserted here was reported by a trader using the desk, and none
 * of it throws, logs or fails a render test - a grid column that is hidden
 * but still reserves its width, a selector that names an element the page
 * does not have, a table that re-measures itself under the pointer. They are
 * caught by reading the rules, because the alternative is catching them in
 * production again.
 *
 *     node tests/desk-layout.test.js
 */
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");

const appCss = read("apps/web/css/app.css");
const chartCss = read("apps/web/css/chart.css");
const appJs = read("apps/web/js/app.js");
const indexHtml = read("apps/web/index.html");

let failed = 0;
function check(name, cond) {
  if (cond === true) console.log("PASS  " + name);
  else { console.log("FAIL  " + name + (typeof cond === "string" ? "  — " + cond : "")); failed++; }
}

/* ================================================= the AI summary is gone == */

check("the command centre no longer prints a bias with no symbol", (() => {
  const view = appJs.slice(appJs.indexOf("  command() {"), appJs.indexOf("  markets() {"));
  return (view.indexOf("live-ai") < 0 && view.indexOf("ai.title") < 0) ||
    "the AI card is still rendered in the command view";
})());

check("the dead renderer went with it", appJs.indexOf("function aiBlock(") < 0);

check("nothing still tries to fill the card that was removed",
  appJs.indexOf('$("live-ai")') < 0);

check("the per-chart version survives, because that one says which symbol", (() => {
  const view = appJs.slice(appJs.indexOf("  intelligence() {"), appJs.indexOf("  calendar() {"));
  return view.indexOf("ai-feat-sym") > 0 && view.indexOf("ai.direction") > 0;
})());

/* ====================================================== positions, wider == */

check("positions get a full-width card of their own", (() => {
  const view = appJs.slice(appJs.indexOf("  command() {"), appJs.indexOf("  markets() {"));
  const card = view.indexOf('class="card pos-card"');
  if (card < 0) return "no pos-card in the command view";
  // It must not be back inside a two-column grid with the side panel.
  const before = view.slice(0, card);
  const opens = (before.match(/<div class="grid g-2">/g) || []).length;
  const closes = (before.match(/<\/div>/g) || []).length;
  return opens <= closes || "the positions card is nested in a g-2 grid again";
})());

check("the close button cannot scroll out of reach", (() => {
  const flat = appCss.replace(/\s+/g, "");
  return /\.pos-cardcol\.c-close\{width:\d+px\}/.test(flat) ||
    "no fixed width reserved for the close column";
})());

/* =============================================== positions, without jumping ==

   The reported symptom was rows moving sideways while prices updated. The
   cause is auto table layout: a profit going from "8.40" to "-124.65"
   widens its column and shifts every column after it. Three things have to
   hold together, so all three are checked.                                   */

check("the table's geometry is decided once, not per repaint",
  /\.pos-card table\{[^}]*table-layout:fixed/.test(appCss.replace(/\s*\n\s*/g, "")) ||
  "pos-card table is not table-layout:fixed");

check("fixed layout is given widths to use", (() => {
  const keys = ["symbol", "type", "volume", "strategy", "price_open",
    "price_current", "sl", "tp", "profit", "profit_pct", "close"];
  const missing = keys.filter((k) => appCss.indexOf(`.pos-card col.c-${k}{`) < 0);
  return missing.length === 0 || "no width for: " + missing.join(", ");
})());

check("the markup carries the colgroup those widths attach to", (() => {
  const fn = appJs.slice(appJs.indexOf("function table(rows, keys, closable)"),
    appJs.indexOf("function paintPositions"));
  return fn.indexOf("<colgroup>") > 0 && fn.indexOf('c-${esc(k)}') > 0;
})());

check("digits are the same width as each other",
  /\.pos-card th,\.pos-card td\{[^}]*font-variant-numeric:tabular-nums/
    .test(appCss.replace(/\s*\n\s*/g, "")));

check("rows are patched in place rather than rebuilt", (() => {
  const fn = appJs.slice(appJs.indexOf("function paintPositions"), appJs.indexOf("function tickLabel"));
  // A full innerHTML rewrite on every tick would destroy the row the user
  // is about to click, whatever the CSS says.
  return fn.indexOf("if (td.textContent !== text) td.textContent = text;") > 0;
})());

/* ==================================================== the slider slides ==== */

check("the slide no longer fades", (() => {
  const block = chartSliceOf(appCss, "@keyframes slideFromRight");
  return block.indexOf("opacity") < 0 || "slideFromRight still animates opacity";
})());

check("it travels far enough to read as movement", (() => {
  const block = chartSliceOf(appCss, "@keyframes slideFromRight");
  return block.indexOf("translate3d(100%") > 0 || "the slide is still a nudge";
})());

check("the right-to-left selectors are valid CSS", (() => {
  // They carried escaped quotes - html[dir=\"rtl\"] - which matches nothing,
  // so every Persian and Arabic user saw the deck slide the wrong way.
  return appCss.indexOf('html[dir=\\"rtl\\"]') < 0 ||
    "an escaped-quote attribute selector is back";
})());

check("RTL still reverses the direction", (() => {
  return appCss.indexOf('html[dir="rtl"] .chart-stage.sw-next{animation-name:slideFromLeft}') > 0;
})());

check("a system that asks for no motion gets none",
  /@media \(prefers-reduced-motion:reduce\)\{\s*\.chart-stage/.test(appCss.replace(/\s*\n\s*/g, "")));

/* ================================================ fullscreen, both sizes === */

check("fullscreen hides the header the page actually has", (() => {
  // index.html has <header class="top">. The old rule named .topbar, which
  // does not exist, so the header stayed and the chart was asked to be a
  // full viewport tall inside what was left of one.
  if (indexHtml.indexOf('<header class="top">') < 0) return "the header class changed; update this rule";
  return chartCss.indexOf("body.chart-full .top,") > 0 || "body.chart-full does not hide .top";
})());

check("fullscreen reclaims the sidebar's grid column", (() => {
  // #desk is "nav stage" with a fixed first track; display:none on the rail
  // leaves the track behind and the chart renders into the remainder.
  const block = chartSliceOf(chartCss, "body.chart-full #desk");
  return (block.indexOf("grid-template-areas") > 0 && block.indexOf('"stage"') > 0) ||
    "the nav column is still reserved in fullscreen";
})());

check("the chart is measured against the visible viewport, not the tall one", (() => {
  const block = chartSliceOf(chartCss, "body.chart-full .tv");
  return block.indexOf("100dvh") > 0 || "fullscreen height is still vh only";
})());

check("vh is kept underneath dvh as a fallback", (() => {
  const block = chartSliceOf(chartCss, "body.chart-full .tv");
  return block.indexOf("height: 100vh") > 0 && block.indexOf("height: 100dvh") >
    block.indexOf("height: 100vh");
})());

check("the desktop floor cannot exceed a phone's screen", (() => {
  const block = chartSliceOf(chartCss, "body.chart-full .tv");
  return block.indexOf("min-height: 0") > 0 ||
    "min-height: 460px still applies in fullscreen";
})());

check("the windowed chart uses dvh too", (() => {
  const block = chartSliceOf(chartCss, ".tv {");
  return block.indexOf("100dvh") > 0;
})());

check("every breakpoint's floor is capped by the viewport", (() => {
  const floors = chartCss.match(/min-height: min\([^)]*\)[^;]*;/g) || [];
  return floors.length >= 3 || `only ${floors.length} capped floors found`;
})());

check("the page itself cannot scroll behind a fullscreen chart",
  /body\.chart-full\{overflow:hidden\}/.test(chartCss.replace(/\s+/g, "")));

check("the stage stops clipping the chart it is holding", (() => {
  const block = chartSliceOf(chartCss, "body.chart-full .stage,");
  return block.indexOf("padding: 0") > 0 && block.indexOf("overflow: hidden") > 0;
})());

check("a notch does not eat the status bar",
  chartCss.indexOf("body.chart-full .tv-status { padding-bottom: var(--safe-b") > 0);

check("a viewport change is repainted more than once", (() => {
  const js = read("apps/web/js/chart-tools.js");
  return js.indexOf("function redrawSoon()") > 0 &&
    js.indexOf('window.addEventListener("orientationchange", redrawSoon)') > 0;
})());

/* ------------------------------------------------------------------------- */

/** The declaration block that follows a selector or at-rule, braces balanced. */
function chartSliceOf(css, needle) {
  const at = css.indexOf(needle);
  if (at < 0) return "";
  const open = css.indexOf("{", at);
  if (open < 0) return "";
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") { depth--; if (!depth) return css.slice(at, i + 1); }
  }
  return css.slice(at);
}

console.log(failed === 0 ? "\ndesk layout: all checks passed" : `\n${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
