/**
 * Changing the candle colours actually recolours the candles.
 *
 * The reported bug: pick a new candle colour in the theme editor, go to
 * a chart, and nothing has changed.
 *
 * It was not the picker, not storage and not the CSS. charts.js reads
 * the desk's colour variables ONCE and caches the result against
 * window.__aurionThemeRev, because calling getComputedStyle per frame is
 * expensive. That revision counter was bumped in exactly one place: the
 * light/dark toggle. The theme editor called repaintChartsForTheme(),
 * which faithfully redrew every bar using the SAME cached palette - so
 * the redraw happened and the colours could not possibly change.
 *
 * These run the real chartTheme() from apps/web/js/charts.js against a
 * jsdom document, so they fail if the cache stops being invalidated.
 *
 *     node tests/candle-colours.test.js
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log("FAIL " + m); } else console.log("ok   " + m); };

const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const appJs = read("apps/web/js/app.js");
const chartsJs = read("apps/web/js/charts.js");

/* ------------------------------------------------------- the real thing */

const dom = new JSDOM(`<!doctype html><html><head><style>
  :root{ --candle-up:#26d07c; --candle-down:#f4475b; }
</style></head><body></body></html>`,
  { pretendToBeVisual: true, runScripts: "outside-only" });
const win = dom.window;
win.__aurionThemeRev = 0;

/* charts.js is a plain script that defines chartTheme in module scope;
   evaluate it and hand the function back out. */
win.eval(chartsJs + ";window.__chartTheme = chartTheme;");
const chartTheme = win.__chartTheme;

const setVar = (name, value) => win.document.documentElement.style.setProperty(name, value);

{
  const first = chartTheme();
  ok(typeof first.up === "string" && first.up.length > 0, "chartTheme resolves a candle-up colour");

  /* Change the variable the way the theme editor does, WITHOUT touching
     the revision. The cache is allowed to be stale here - that is the
     whole point of having one. */
  setVar("--candle-up", "#0000ff");
  const stale = chartTheme();
  ok(stale.up === first.up, "without a revision bump the palette is cached (by design)");

  /* Now do what the desk must do when a colour changes. */
  win.__aurionThemeRev = (win.__aurionThemeRev | 0) + 1;
  const fresh = chartTheme();
  ok(fresh.up !== first.up, "bumping the revision re-reads the variables");
  ok(/0000ff/i.test(fresh.up), `and picks up the new colour (got ${fresh.up})`);
  ok(fresh.upT === "0,0,255", `the rgb triplet follows too (got ${fresh.upT})`);
}

{
  /* The down colour is a separate variable and must not be forgotten. */
  setVar("--candle-down", "#ffaa00");
  win.__aurionThemeRev = (win.__aurionThemeRev | 0) + 1;
  const t = chartTheme();
  ok(/ffaa00/i.test(t.down), `candle-down follows a revision bump too (got ${t.down})`);
}

/* ------------------------------------------- the desk bumps the counter */

{
  /* The mechanism above only helps if something actually increments the
     counter when a colour changes. Checked against the source because
     driving the real picker needs the whole settings page. */

  const body = /function refreshChartPalette\(\)[\s\S]*?\n}/.exec(appJs);
  ok(body, "refreshChartPalette exists");
  ok(body && /__aurionThemeRev/.test(body[0]),
    "refreshChartPalette bumps the theme revision");
  ok(body && /setBars/.test(body[0]),
    "and redraws the main chart with it");

  const repaint = /function repaintChartsForTheme\(\)[\s\S]*?\n}/.exec(appJs);
  ok(repaint, "repaintChartsForTheme still exists for its callers");
  ok(repaint && /refreshChartPalette\(\)/.test(repaint[0]),
    "and it goes through refreshChartPalette rather than redrawing blind");

  /* The regression in one line: a repaint that never invalidates. */
  ok(!(repaint && /setBars/.test(repaint[0]) && !/refreshChartPalette/.test(repaint[0])),
    "repaintChartsForTheme does not redraw without invalidating the palette");

  ok(/addEventListener\("aurion:theme"/.test(appJs),
    "the desk listens for AurionTheme's own change event");

  /* Every committing path in the colour editor must end up repainting. */
  const commit = /onCommit\(hex\)\s*\{[\s\S]*?\n        \}/.exec(appJs);
  ok(commit && /repaintChartsForTheme\(\)/.test(commit[0]),
    "committing a colour repaints the charts");

  const clear = /closest\("\[data-colclear\]"\)[\s\S]{0,400}?\n    \}\);/.exec(appJs);
  ok(clear, "the clear-colour handler is findable");
  ok(clear && /repaintChartsForTheme\(\)/.test(clear[0]),
    "clearing a colour back to the theme default repaints too");
}

/* ------------------------------------------------- the theme module tells */

{
  const themesJs = read("apps/web/js/themes.js");
  ok(/dispatchEvent\(new CustomEvent\("aurion:theme"/.test(themesJs),
    "AurionTheme announces a theme change");
  const edit = /function editTheme\([\s\S]*?\n  \}/.exec(themesJs);
  ok(edit && /apply\(\)/.test(edit[0]),
    "editing a colour applies, which is what fires that event");
}

console.log(fails ? `\n${fails} failed` : "\nall good");
process.exit(fails ? 1 : 0);
