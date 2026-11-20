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

/* candlePreviewShapes is lifted out and run against made-up bars. The
   point is the arithmetic - a high at the top, a doji still visible,
   a one-sided wick staying one-sided - and booting the desk to check
   arithmetic would be testing the desk. */
function shapes(candles, focus) {
  const src = body("function candlePreviewShapes()", "function candlePreviewHtml()");
  const ctx = { S: { candles, chartFocus: focus || {} }, CANDLE_PREVIEW_BARS: 14 };
  vm.createContext(ctx);
  vm.runInContext(src + "\n", ctx);
  return vm.runInContext("candlePreviewShapes()", ctx);
}

const bar = (o, h, l, c) => ({ o, h, l, c });

check("the preview is built from the trader's own bars", () => {
  const out = shapes([bar(10, 12, 9, 11), bar(11, 13, 10, 10),
    bar(10, 14, 10, 13), bar(13, 15, 8, 9), bar(9, 11, 8, 10)]);
  if (out.length !== 5) throw new Error("got " + out.length + " shapes from 5 bars");
  const dirs = out.map((r) => r[0]);
  if (dirs.join(",") !== "up,down,up,down,up")
    throw new Error("the directions do not follow the closes: " + dirs.join(","));
  return dirs.join(",");
});

check("the highest high sits at the top of the strip and the lowest low at the bottom", () => {
  const rows = [bar(10, 12, 9, 11), bar(11, 20, 10, 12), bar(12, 13, 2, 5), bar(5, 7, 4, 6)];
  const out = shapes(rows);
  const wickTops = out.map((r) => r[3]);
  const wickBottoms = out.map((r) => r[3] + r[4]);
  if (Math.min(...wickTops) > 0.01)
    throw new Error("nothing reaches the top: highest wick at " + Math.min(...wickTops) + "%");
  if (Math.max(...wickBottoms) < 99.99)
    throw new Error("nothing reaches the bottom: lowest wick at " + Math.max(...wickBottoms) + "%");
  return "0% .. 100%";
});

check("a one-sided wick stays one-sided", () => {
  /* The old markup derived the wick from the body with one --w either
     side, which can only ever draw a symmetrical candle. A rejection
     is a long wick on ONE side, and that shape is most of what a
     trader is judging the colours against. */
  const out = shapes([bar(10, 10.1, 5, 10), bar(10, 10, 9, 9.5),
    bar(9.5, 10, 9, 9.8), bar(9.8, 10, 9.5, 9.9)]);
  const [, top, h, wickTop, wickH] = out[0];
  const above = top - wickTop;
  const below = (wickTop + wickH) - (top + h);
  if (!(below > above * 5))
    throw new Error(`a bar with a long lower wick drew ${above.toFixed(1)}% above and ${below.toFixed(1)}% below`);
  return "asymmetric";
});

check("the CSS draws the wick from those two numbers, not from the body", () => {
  const rule = /\.cndl::before\{([^}]*)\}/.exec(appCss);
  if (!rule) throw new Error("the wick rule is gone");
  if (!/top:var\(--wt\)/.test(rule[1]) || !/height:var\(--wh\)/.test(rule[1]))
    throw new Error("the wick is not positioned from --wt/--wh: " + rule[1]);
  if (/var\(--w\)/.test(rule[1]))
    throw new Error("the old symmetrical --w derivation is still there");
  return "--wt / --wh";
});

check("a doji is still visible", () => {
  /* Open equals close. A body of zero height renders as nothing, and
     a strip with a gap in it reads as a drawing bug rather than as a
     market that closed where it opened. */
  const out = shapes([bar(10, 11, 9, 10), bar(10, 12, 8, 11),
    bar(11, 12, 10, 10), bar(10, 13, 7, 12)]);
  if (!(out[0][2] >= 1)) throw new Error("the doji's body is " + out[0][2] + "% high");
  return out[0][2].toFixed(2) + "%";
});

check("nothing is ever drawn outside the strip", () => {
  /* Reported as "the candle preview is corrupted". The strip clips
     what leaves it, so a shape with a negative top or a bottom past
     100% comes out as a slab against the frame with a straight cut in
     it - and the two cases that produce one are both ordinary: a bar
     that closed on the low of the window (the doji floor used to be
     added BELOW the body) and a wick sized from the body rather than
     from the bar's own high and low. */
  const runs = [
    /* A down-trend ending on the low: every body sits at the bottom. */
    [bar(14, 14, 10, 10), bar(10, 10, 7, 7), bar(7, 7, 4, 4), bar(4, 4, 1, 1)],
    /* Flat closes on the extremes, which is where the floor bites. */
    [bar(10, 10, 10.0, 10), bar(10, 12, 10, 10), bar(10, 10, 8, 8), bar(8, 8.2, 8, 8)],
    /* One spike, so every other bar is a sliver. */
    [bar(10, 10.1, 9.9, 10), bar(10, 90, 10, 11), bar(11, 11.2, 10.8, 10.9), bar(10.9, 11, 10.7, 10.8)],
  ];
  for (const rows of runs) {
    for (const [dir, top, h, wickTop, wickH] of shapes(rows)) {
      for (const [name, v] of [["body top", top], ["body bottom", top + h],
        ["wick top", wickTop], ["wick bottom", wickTop + wickH]]) {
        if (!(v >= -0.001 && v <= 100.001)) {
          throw new Error(`a ${dir} bar's ${name} is at ${v.toFixed(2)}%, outside the strip`);
        }
      }
      if (wickTop > top + 0.001) throw new Error("the wick starts below the body it belongs to");
      if (wickTop + wickH < top + h - 0.001) throw new Error("the body hangs below its own wick");
    }
  }
  return "every shape inside 0..100";
});

check("too little to draw falls back rather than inventing a flat line", () => {
  if (shapes([]).length !== 0) throw new Error("no bars produced shapes");
  if (shapes([bar(1, 1, 1, 1), bar(1, 1, 1, 1)]).length !== 0)
    throw new Error("two bars produced shapes");
  // every price identical: the range is zero and every bar would be a line
  if (shapes([bar(5, 5, 5, 5), bar(5, 5, 5, 5), bar(5, 5, 5, 5), bar(5, 5, 5, 5)]).length !== 0)
    throw new Error("a flat series produced shapes");
  return "falls back";
});

check("both bar shapes the desk stores are understood", () => {
  /* S.candles is filled by two paths: the engine speaks {o,h,l,c} and
     the candles API speaks {open,high,low,close}. Reading only one
     leaves the preview blank half the time, which looks exactly like
     "there is no data". */
  const long = [{ open: 10, high: 12, low: 9, close: 11 }, { open: 11, high: 13, low: 10, close: 10 },
    { open: 10, high: 14, low: 10, close: 13 }, { open: 13, high: 15, low: 8, close: 9 }];
  if (shapes(long).length !== 4) throw new Error("{open,high,low,close} bars were not read");
  return "o/h/l/c and open/high/low/close";
});

check("only the most recent bars are drawn, however long the history is", () => {
  const many = Array.from({ length: 500 }, (_, i) => bar(10 + i, 12 + i, 9 + i, 11 + i));
  const out = shapes(many);
  if (out.length > 14) throw new Error(out.length + " bars drawn - the strip would be unreadable");
  return out.length + " bars";
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

check("the strip is repainted as bars arrive, and not on every poll", () => {
  /* Rebuilding it every second would restart the colour picker's
     hover and fight the drag that is choosing the colour. */
  const paint = body("function paintCandlePreview()", "\n/* The custom miniature");
  if (!/S\._cndlKey === key/.test(paint))
    throw new Error("the strip is rebuilt unconditionally");
  if (!/paintCandlePreview\(\);/.test(appJs.slice(appJs.indexOf('if (v === "settings")'),
    appJs.indexOf('if (v === "settings")') + 1200)))
    throw new Error("nothing repaints the strip while the settings page is open");
  return "keyed repaint";
});

console.log(fails ? `\nboot-and-candles: ${fails} FAILED` : "\nboot-and-candles: all checks passed");
process.exit(fails ? 1 : 0);
