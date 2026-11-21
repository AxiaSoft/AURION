/**
 * Two more reported personalisation faults.
 *
 * 11. The loading screen flashed. The welcome clip finished, the
 *     overlay faded out and hid itself, and only THEN did boot start
 *     building the next screen - beginning with a network call. So the
 *     fade revealed the bare shell for as long as the engine took to
 *     answer, and the desk appeared on top of it afterwards. A loading
 *     screen that ends before the thing it is covering exists is not a
 *     loading screen.
 *
 * 13. The candle preview in the theme builder was eight invented
 *     rectangles. The question it is there to answer - "will I be able
 *     to read my chart in these two colours" - depends on the
 *     instrument: a pair that separates cleanly on EURUSD's small even
 *     bodies can collapse on gold's long wicks. It draws the trader's
 *     own last bars now, and says so; the invented sequence survives
 *     only as the no-data fallback, labelled as an example.
 *
 *     Then it was reported broken, and it was: percentage-positioned
 *     boxes cannot draw a doji without inflating it, and fourteen
 *     fixed-width bodies overlap on a narrow card. It is a canvas
 *     now, drawn the way the chart draws, and the checks below run
 *     the painter and read back what it put on the context.
 *
 *     node tests/boot-and-candles.test.js
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
let fails = 0;
const check = (name, fn) => {
  try {
    const note = fn();
    console.log("ok   " + name + (note ? "  (" + note + ")" : ""));
  } catch (e) {
    fails++;
    console.log("FAIL " + name + "\n       " + (e && e.message ? e.message : e));
  }
};

const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const appJs = read("apps/web/js/app.js");
const appCss = read("apps/web/css/app.css");
const en = JSON.parse(read("lang/en.json"));
const fa = JSON.parse(read("lang/fa.json"));
const ar = JSON.parse(read("lang/ar.json"));

/** The body of a top-level function, sliced by its own bounds. */
function body(name, endsAt) {
  const start = appJs.indexOf(name);
  if (start === -1) throw new Error(name + " is gone from app.js");
  const end = appJs.indexOf(endsAt, start);
  if (end === -1) throw new Error("cannot find the end of " + name);
  return appJs.slice(start, end);
}

/* ------------------------------------------- 11. the loading screen ----- */

check("the welcome clip finishing does not hide the overlay", () => {
  /* The exact line that caused the flash. done() is reached when the
     clip ends, is skipped, stalls or times out - all four left the
     trader looking at an unpainted desk. */
  const src = body("const done = () => {", "if (skip) {");
  if (/wrap\.hidden\s*=\s*true/.test(src))
    throw new Error("done() still hides the overlay before anything has been built");
  if (/classList\.add\("out"\)/.test(src))
    throw new Error("done() still starts the fade");
  if (!/resolve\(\)/.test(src)) throw new Error("done() no longer resolves, so boot would hang");
  return "the curtain stays up";
});

check("the last frame is held, not blanked", () => {
  /* Clearing src makes the <video> element blank, and the overlay
     drops to a flat colour - a second, smaller flash inside the one
     being fixed. */
  const src = body("const done = () => {", "if (skip) {");
  if (/removeAttribute\("src"\)/.test(src))
    throw new Error("the video is torn down while it is still on screen");
  const lift = body("async function dismissWelcome", "\n/* ---");
  if (!/removeAttribute\("src"\)/.test(lift))
    throw new Error("the video is never released, so a decoded clip is kept for the session");
  return "released after the fade";
});

check("the curtain is lifted only after the next screen is painted", () => {
  const boot = body("async function boot()", "\nboot();");
  const gate = boot.indexOf("showGate(lic)");
  const enter = boot.indexOf('licenseSessionEnter("auto", lic)');
  const lift = boot.indexOf("dismissWelcome()");
  if (gate === -1 || enter === -1) throw new Error("boot no longer paints a gate or a desk");
  if (lift === -1) throw new Error("boot never lifts the curtain - the desk would stay hidden");
  if (!/finally\s*\{[^}]*dismissWelcome\(\)/s.test(boot))
    throw new Error("the lift is not in a finally, so a failed boot would hide the desk forever");
  return "painted, then lifted";
});

check("a boot that never finishes still gives the desk back", () => {
  /* The failure mode this fix could introduce is far worse than the
     flash it removes: an overlay waiting for a desk that is not
     coming hides everything, with no way out. */
  const boot = body("async function boot()", "\nboot();");
  if (!/setTimeout\(\(\) => \{ dismissWelcome\(\); \}, WELCOME_HOLD_MS\)/.test(boot))
    throw new Error("there is no absolute backstop on the curtain");
  const held = /const WELCOME_HOLD_MS = (\d+)/.exec(appJs);
  if (!held) throw new Error("WELCOME_HOLD_MS is not a named constant");
  if (Number(held[1]) > 15000)
    throw new Error("the backstop is " + held[1] + "ms - long enough to read as a frozen desk");
  return held[1] + "ms";
});

check("two frames pass before the fade, so the painted desk is really there", () => {
  /* Setting .hidden in the same task as the render is not enough: the
     browser has the markup but has not painted it. */
  const lift = body("async function dismissWelcome", "\n/* ---");
  const frames = (lift.match(/requestAnimationFrame/g) || []).length;
  if (frames < 2) throw new Error("only " + frames + " animation frame(s) are awaited");
  return frames + " frames";
});

check("lifting twice is harmless", () => {
  /* It is called from a timer and from a finally, and both can win. */
  const lift = body("let welcomeLifted = false;", "\n/* ---");
  if (!/if \(welcomeLifted\) return;/.test(lift))
    throw new Error("dismissWelcome is not idempotent, so the fade could restart mid-flight");
  return "guarded";
});

/* --------------------------------------------- 13. the candle preview --- */

/* The preview is CSS bars again, and the trader's verdict is the
   reason: "the preview candles are wrong, put back the fat ones".

   The canvas version in between drew arithmetically perfect shapes
   that were, at the size this strip is actually displayed, one-pixel
   wicks and slivers of body. What is being protected now is the thing
   that was asked for - bars that FILL their track - plus the
   geometry faults that were reported before the canvas existed and
   would come straight back if the arithmetic were wrong: a body that
   leaves the strip, a wick derived from the body instead of from the
   bar's own high and low, a doji drawn as nothing.

   The shapes are read out of candlePreviewShapes() rather than out of
   a drawing context. Each one is [dir, bodyTop, bodyHeight, wickTop,
   wickHeight], all four as percentages of the strip, and the CSS
   places them with no further arithmetic - so these five numbers are
   the whole of what can be wrong. */
function shapes(candles) {
  const src = body("const CANDLE_SAMPLE = [", "\nfunction paintCandlePreview()");
  const ctx = {
    S: { candles, chartFocus: { symbol: "EURUSD", timeframe: "M15" } },
    I18N: { t: (k) => k },
    esc: (x) => String(x),
  };
  vm.createContext(ctx);
  vm.runInContext(src + "\nthis.out = candlePreviewShapes();\nthis.html = candlePreviewHtml();\n", ctx);
  const out = ctx.out.map(([dir, t, h, wt, wh]) => ({ dir, t, h, wt, wh }));
  return { bars: out, html: ctx.html };
}

const bar = (o, h, l, c) => ({ o, h, l, c });

check("the preview is built from the trader's own bars", () => {
  const rows = [bar(10, 12, 9, 11), bar(11, 13, 10, 10),
    bar(10, 14, 10, 13), bar(13, 15, 8, 9), bar(9, 11, 8, 10)];
  const { bars } = shapes(rows);
  if (bars.length !== 5) throw new Error("got " + bars.length + " bars from 5");
  const dirs = bars.map((b) => b.dir).join(",");
  if (dirs !== "up,down,up,down,up")
    throw new Error("the directions do not follow the closes: " + dirs);
  return dirs;
});

check("the highest high sits at the top of the strip and the lowest low at the bottom", () => {
  const rows = [bar(10, 12, 9, 11), bar(11, 20, 10, 12), bar(12, 13, 2, 5), bar(5, 7, 4, 6)];
  const { bars } = shapes(rows);
  const tops = bars.map((b) => b.wt);
  const bottoms = bars.map((b) => b.wt + b.wh);
  if (Math.min(...tops) > 0.01)
    throw new Error("the highest wick starts at " + Math.min(...tops) + "%, not at the top");
  if (Math.max(...bottoms) < 99.99)
    throw new Error("the lowest wick ends at " + Math.max(...bottoms) + "%, not at the bottom");
  return "0% .. 100%";
});

check("a one-sided wick stays one-sided", () => {
  /* The markup before all of this derived the wick from the body with
     one width either side, which can only ever draw a symmetrical
     candle. A rejection is a long wick on ONE side, and that shape is
     most of what a trader is judging the colours against. */
  const { bars } = shapes([bar(10, 10.1, 5, 10), bar(10, 10, 9, 9.5),
    bar(9.5, 10, 9, 9.8), bar(9.8, 10, 9.5, 9.9)]);
  const b = bars[0];
  const above = b.t - b.wt;
  const below = (b.wt + b.wh) - (b.t + b.h);
  if (!(below > above * 5))
    throw new Error(`a bar with a long lower wick drew ${above.toFixed(1)}% above and ${below.toFixed(1)}% below`);
  return "asymmetric";
});

check("the wick runs high to low and always contains its body", () => {
  const rows = [bar(10, 18, 2, 12), bar(12, 13, 11, 11.5), bar(11.5, 20, 11, 19), bar(19, 19.5, 6, 7)];
  const { bars } = shapes(rows);
  for (const b of bars) {
    if (b.wt > b.t + 0.01) throw new Error("the wick starts below the body it belongs to");
    if (b.wt + b.wh < b.t + b.h - 0.01) throw new Error("the body hangs below its own wick");
  }
  return bars.length + " bars checked";
});

check("a doji is still visible, and is not inflated to make it so", () => {
  /* Open equals close. A body of zero height renders as nothing, so it
     is given a floor - and that floor has to be small enough that the
     bar still reads as a doji beside the real bodies next to it. */
  const { bars } = shapes([bar(10, 11, 9, 10), bar(10, 12, 8, 11),
    bar(11, 12, 10, 10), bar(10, 13, 7, 12)]);
  const flat = bars.filter((b) => b.h <= 2.001);
  if (!flat.length) throw new Error("the doji was inflated into an ordinary body");
  for (const b of bars) {
    if (!(b.h > 0)) throw new Error("a body of zero height would render as nothing");
  }
  return flat.length + " flat bar(s) kept flat";
});

check("nothing is ever drawn outside the strip", () => {
  /* Reported as "the candle preview is corrupted". The box clips what
     leaves it, so a shape above the top or below the bottom came out
     as a slab against the frame with a straight cut in it. Both of the
     cases that produced one are ordinary: a bar that closed on the low
     of the window, and a spike that makes every other bar a sliver. */
  const runs = [
    [bar(14, 14, 10, 10), bar(10, 10, 7, 7), bar(7, 7, 4, 4), bar(4, 4, 1, 1)],
    [bar(10, 10, 10.0, 10), bar(10, 12, 10, 10), bar(10, 10, 8, 8), bar(8, 8.2, 8, 8)],
    [bar(10, 10.1, 9.9, 10), bar(10, 90, 10, 11), bar(11, 11.2, 10.8, 10.9), bar(10.9, 11, 10.7, 10.8)],
  ];
  for (const rows of runs) {
    const { bars } = shapes(rows);
    for (const b of bars) {
      for (const [name, v] of [["body top", b.t], ["body bottom", b.t + b.h],
        ["wick top", b.wt], ["wick bottom", b.wt + b.wh]]) {
        if (!(v >= -0.001 && v <= 100.001))
          throw new Error(`a ${name} is at ${v.toFixed(2)}%, outside the strip`);
      }
    }
  }
  return "every shape inside the box";
});

check("the bars are chunky: each one fills its own track", () => {
  /* This is the complaint itself, asserted as CSS rather than as
     arithmetic. The strip is a flex row, every bar is an equal share
     of it, and the body spans its whole share - no fixed width, no
     sliver in the middle of an empty column. */
  const block = appCss.slice(appCss.indexOf(".cndl-prev{"), appCss.indexOf(".cndl-cap"));
  if (!/display:flex/.test(block)) throw new Error("the strip is not a flex row of tracks");
  if (!/\.cndl\{[^}]*flex:1 1 0/.test(block)) throw new Error("the bars do not share the strip evenly");
  if (!/\.cndl::after\{[^}]*inset-inline:0/.test(block))
    throw new Error("the body does not fill its track");
  if (/--cndl-w/.test(block)) throw new Error("a fixed body width is back");
  if (!/\.cndl::before\{[^}]*var\(--wt\)/.test(block) || !/\.cndl::before\{[^}]*var\(--wh\)/.test(block))
    throw new Error("the wick is not placed from its own properties");
  return "flex tracks, full-width bodies";
});

check("too little to draw falls back rather than inventing a flat line", () => {
  /* The fallback is a worked example and is labelled as one; what must
     not happen is a strip of nothing or a straight line. */
  for (const rows of [[], [bar(1, 1, 1, 1), bar(1, 1, 1, 1)],
    [bar(5, 5, 5, 5), bar(5, 5, 5, 5), bar(5, 5, 5, 5), bar(5, 5, 5, 5)]]) {
    const { bars, html } = shapes(rows);
    if (bars.length !== 0) throw new Error("bars that say nothing were drawn as if they did");
    if (!/data-real="0"/.test(html)) throw new Error("invented bars are marked as the market");
    if ((html.match(/class="cndl /g) || []).length < 8)
      throw new Error("the example was not drawn");
    if (!/themes\.candles_sample/.test(html))
      throw new Error("the example is not labelled");
  }
  return "falls back, labelled";
});

check("both bar shapes the desk stores are understood", () => {
  /* S.candles is filled by two paths: the engine speaks {o,h,l,c} and
     the candles API speaks {open,high,low,close}. Reading only one
     leaves the preview on the example half the time, which looks
     exactly like "there is no data". */
  const long = [{ open: 10, high: 12, low: 9, close: 11 }, { open: 11, high: 13, low: 10, close: 10 },
    { open: 10, high: 14, low: 10, close: 13 }, { open: 13, high: 15, low: 8, close: 9 }];
  const { bars, html } = shapes(long);
  if (bars.length !== 4) throw new Error("{open,high,low,close} bars were not read");
  if (!/data-real="1"/.test(html)) throw new Error("real bars were not recognised as real");
  return "o/h/l/c and open/high/low/close";
});

check("only the most recent bars are drawn, however long the history is", () => {
  const many = Array.from({ length: 500 }, (_, i) => bar(10 + i, 12 + i, 9 + i, 11 + i));
  const { bars } = shapes(many);
  if (bars.length > 14) throw new Error(bars.length + " bars drawn - the strip would be unreadable");
  return bars.length + " bars";
});

check("the strip says whether it is the market or an example", () => {
  const html = body("function candlePreviewHtml()", "/** Redraw the strip");
  if (!/themes\.candles_live/.test(html) || !/themes\.candles_sample/.test(html))
    throw new Error("the strip is unlabelled, so invented bars pass as the market");
  if (!/data-real=/.test(html))
    throw new Error("nothing marks which of the two is on screen");
  for (const [code, pack] of [["en", en], ["fa", fa], ["ar", ar]]) {
    for (const k of ["candles_live", "candles_sample"]) {
      if (!pack.themes[k]) throw new Error("missing " + code + ".themes." + k);
    }
    if (!pack.themes.candles_live.includes("{symbol}"))
      throw new Error(code + " does not name the symbol");
  }
  return "labelled in three languages";
});

check("the strip is replaced only when the bars change", () => {
  /* Rebuilding it every second would restart the colour picker's hover
     and fight the drag that is choosing the colour. The COLOURS need
     no repaint at all - the bars are painted from --candle-up and
     --candle-down, which previewColour writes onto <html> on every
     frame of a drag. That is why the four repaint calls the canvas
     needed are gone. */
  const paint = body("function paintCandlePreview()", "\n/* The custom miniature");
  if (!/S\._cndlKey === key\) return;/.test(paint))
    throw new Error("the strip is rebuilt unconditionally");
  const calls = (appJs.match(/paintCandlePreview\(\)/g) || []).length;
  if (calls > 3)
    throw new Error(calls + " mentions of paintCandlePreview - the canvas-era repaints are back");
  return "keyed on the bars, colours follow the variables";
});

check("the canvas preview is gone from the sheet as well as from the script", () => {
  if (/\.cndl-prev canvas\{/.test(appCss)) throw new Error("a canvas rule is still in the sheet");
  if (!/\.cndl\{/.test(appCss)) throw new Error("the CSS candles have no rule at all");
  return "bars only";
});

console.log(fails ? `\nboot-and-candles: ${fails} FAILED` : "\nboot-and-candles: all checks passed");
process.exit(fails ? 1 : 0);
