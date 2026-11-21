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

/* The preview was rewritten as a canvas, so the thing worth checking
   moved with it: it is no longer "does the arithmetic produce sane
   percentages" but "what does the painter actually draw". The whole
   block below runs paintCandlePreview() against a recording 2d
   context and then reads the rectangles and lines back.

   That is the only way to catch the faults that were reported. A
   doji inflated into a block, a body wider than the space one bar
   gets, a wick drawn from the body instead of from the bar's own high
   and low - all three are invisible in the source and obvious in the
   output. */
function draw(candles, box) {
  /* From the fallback data down to the painter: the sample sequence
     is part of what is being tested. */
  const src = body("const CANDLE_SAMPLE = [", "\n/* The custom miniature");
  const ops = [];
  const g = {
    setTransform() {}, clearRect() {}, beginPath() { ops.push(["begin"]); },
    moveTo(x, y) { ops.push(["move", x, y]); },
    lineTo(x, y) { ops.push(["line", x, y]); },
    stroke() { ops.push(["stroke", g.strokeStyle, g.lineWidth]); },
    fillRect(x, y, w, h) { ops.push(["fill", x, y, w, h, g.fillStyle]); },
    strokeRect(x, y, w, h) { ops.push(["rect", x, y, w, h, g.strokeStyle, g.lineWidth]); },
    strokeStyle: "", fillStyle: "", lineWidth: 1,
  };
  const W = (box && box.w) || 420;
  const H = (box && box.h) || 92;
  const prev = { clientWidth: W, clientHeight: H, dataset: {} };
  const canvas = { style: {}, width: 0, height: 0, getContext: () => g };
  const cap = { textContent: "" };
  const ctx = {
    S: { candles, chartFocus: { symbol: "EURUSD", timeframe: "M15" } },
    CANDLE_PREVIEW_BARS: 14,
    I18N: { t: (k) => k },
    window: { devicePixelRatio: 1 },
    getComputedStyle: () => ({ getPropertyValue: (n) => (n === "--candle-up" ? "#00ff00" : "#ff0000") }),
    document: { documentElement: {} },
    $: (id) => (id === "cndl-prev" ? prev : id === "cndl-canvas" ? canvas : cap),
    esc: (x) => String(x),
  };
  vm.createContext(ctx);
  vm.runInContext(src + "\npaintCandlePreview();\n", ctx);
  /* Bodies and wicks, separated. A wick is a stroked move/line pair;
     a body is a fillRect or a strokeRect (or, for a flat bar, the
     horizontal line that follows one). */
  const bodies = ops.filter((o) => o[0] === "fill" || o[0] === "rect")
    .map(([kind, x, y, w, h, colour]) => ({ kind, x, y, w, h, colour }));
  const wicks = [];
  for (let i = 0; i < ops.length; i += 1) {
    if (ops[i][0] === "move" && ops[i + 1] && ops[i + 1][0] === "line") {
      wicks.push({ x: ops[i][1], y1: ops[i][2], x2: ops[i + 1][1], y2: ops[i + 1][2] });
    }
  }
  return { ops, bodies, wicks, canvas, cap, prev, W, H };
}

const bar = (o, h, l, c) => ({ o, h, l, c });

check("the preview is built from the trader's own bars", () => {
  const rows = [bar(10, 12, 9, 11), bar(11, 13, 10, 10),
    bar(10, 14, 10, 13), bar(13, 15, 8, 9), bar(9, 11, 8, 10)];
  const { bodies } = draw(rows);
  if (bodies.length !== 5) throw new Error("got " + bodies.length + " bodies from 5 bars");
  /* Hollow rising, filled falling - so the direction is readable even
     when the two colours chosen are nearly the same. */
  const dirs = bodies.map((b) => (b.kind === "rect" ? "up" : "down")).join(",");
  if (dirs !== "up,down,up,down,up")
    throw new Error("the directions do not follow the closes: " + dirs);
  return dirs;
});

check("the highest high sits at the top of the strip and the lowest low at the bottom", () => {
  const rows = [bar(10, 12, 9, 11), bar(11, 20, 10, 12), bar(12, 13, 2, 5), bar(5, 7, 4, 6)];
  const { wicks, H } = draw(rows);
  const tops = wicks.map((w) => w.y1);
  const bottoms = wicks.map((w) => w.y2);
  /* 10px of padding at each end, so the extremes land on it rather
     than on the frame itself. */
  if (Math.abs(Math.min(...tops) - 10) > 0.6)
    throw new Error("the highest wick is at " + Math.min(...tops) + "px, not the top");
  if (Math.abs(Math.max(...bottoms) - (H - 10)) > 0.6)
    throw new Error("the lowest wick is at " + Math.max(...bottoms) + "px, not the bottom");
  return "10px .. " + (H - 10) + "px";
});

check("a one-sided wick stays one-sided", () => {
  /* The old markup derived the wick from the body with one --w either
     side, which can only ever draw a symmetrical candle. A rejection
     is a long wick on ONE side, and that shape is most of what a
     trader is judging the colours against. */
  const { wicks, bodies } = draw([bar(10, 10.1, 5, 10), bar(10, 10, 9, 9.5),
    bar(9.5, 10, 9, 9.8), bar(9.8, 10, 9.5, 9.9)]);
  const w = wicks[0];
  const b = bodies[0];
  const above = b.y - w.y1;
  const below = w.y2 - (b.y + b.h);
  if (!(below > above * 5))
    throw new Error(`a bar with a long lower wick drew ${above.toFixed(1)}px above and ${below.toFixed(1)}px below`);
  return "asymmetric";
});

check("the wick runs high to low and always contains its body", () => {
  const rows = [bar(10, 18, 2, 12), bar(12, 13, 11, 11.5), bar(11.5, 20, 11, 19), bar(19, 19.5, 6, 7)];
  const { wicks, bodies } = draw(rows);
  for (let i = 0; i < bodies.length; i += 1) {
    const w = wicks[i];
    const b = bodies[i];
    if (w.y1 > b.y + 0.01) throw new Error("the wick starts below the body it belongs to");
    if (w.y2 < b.y + b.h - 0.01) throw new Error("the body hangs below its own wick");
    if (Math.abs(w.x - w.x2) > 0.001) throw new Error("the wick is not vertical");
  }
  return bodies.length + " bars checked";
});

check("a doji is still visible, and is not inflated to make it so", () => {
  /* Open equals close. A body of zero height renders as nothing - but
     the old fix gave it a minimum height and then a border on top of
     that, which drew a smear taller and wider than the real bodies
     beside it. It is drawn as the line it actually is. */
  const { ops, bodies } = draw([bar(10, 11, 9, 10), bar(10, 12, 8, 11),
    bar(11, 12, 10, 10), bar(10, 13, 7, 12)]);
  const flats = ops.filter((o, i) => o[0] === "move" && ops[i + 1] && ops[i + 1][0] === "line"
    && Math.abs(ops[i + 1][2] - o[2]) < 0.001 && Math.abs(ops[i + 1][1] - o[1]) > 1);
  if (!flats.length) throw new Error("the doji was not drawn at all");
  for (const b of bodies) {
    if (b.h < 1) throw new Error("a body of " + b.h + "px was drawn as a rectangle");
  }
  return flats.length + " flat bar(s) drawn as a line";
});

check("nothing is ever drawn outside the strip", () => {
  /* Reported as "the candle preview is corrupted". The box clips what
     leaves it, so a shape above the top or below the bottom came out
     as a slab against the frame with a straight cut in it. Both of
     the cases that produced one are ordinary: a bar that closed on
     the low of the window, and a spike that makes every other bar a
     sliver. */
  const runs = [
    [bar(14, 14, 10, 10), bar(10, 10, 7, 7), bar(7, 7, 4, 4), bar(4, 4, 1, 1)],
    [bar(10, 10, 10.0, 10), bar(10, 12, 10, 10), bar(10, 10, 8, 8), bar(8, 8.2, 8, 8)],
    [bar(10, 10.1, 9.9, 10), bar(10, 90, 10, 11), bar(11, 11.2, 10.8, 10.9), bar(10.9, 11, 10.7, 10.8)],
  ];
  for (const rows of runs) {
    const { bodies, wicks, W, H } = draw(rows);
    for (const b of bodies) {
      for (const [name, v] of [["top", b.y], ["bottom", b.y + b.h]]) {
        if (!(v >= -0.001 && v <= H + 0.001))
          throw new Error(`a body's ${name} is at ${v.toFixed(2)}px, outside a ${H}px strip`);
      }
      if (b.x < -0.001 || b.x + b.w > W + 0.001)
        throw new Error("a body runs off the side of the strip");
    }
    for (const w of wicks) {
      if (w.y1 < -0.001 || w.y2 > H + 0.001) throw new Error("a wick leaves the strip");
    }
  }
  return "every shape inside the box";
});

check("bodies never overlap, however narrow the card", () => {
  /* Fourteen bars with a fixed 8px body is wider than a phone can
     give them, and the neighbours ran into each other. The body is a
     share of its slot now, so this holds at any width. */
  const rows = Array.from({ length: 14 }, (_, i) => bar(10 + i, 12 + i, 9 + i, 11 + i));
  for (const w of [320, 420, 900]) {
    const { bodies } = draw(rows, { w, h: 76 });
    const sorted = bodies.slice().sort((a, b) => a.x - b.x);
    for (let i = 1; i < sorted.length; i += 1) {
      if (sorted[i].x < sorted[i - 1].x + sorted[i - 1].w - 0.001)
        throw new Error("two bodies overlap at " + w + "px");
    }
    if (bodies.some((b) => b.w < 1)) throw new Error("a body vanished at " + w + "px");
  }
  return "320, 420 and 900px";
});

check("too little to draw falls back rather than inventing a flat line", () => {
  /* The fallback is a worked example and is labelled as one; what
     must not happen is a strip of nothing or a straight line. */
  for (const rows of [[], [bar(1, 1, 1, 1), bar(1, 1, 1, 1)],
    [bar(5, 5, 5, 5), bar(5, 5, 5, 5), bar(5, 5, 5, 5), bar(5, 5, 5, 5)]]) {
    const { bodies, cap, prev } = draw(rows);
    if (bodies.length < 8) throw new Error("the example was not drawn");
    if (prev.dataset.real !== "0") throw new Error("invented bars are marked as the market");
    if (cap.textContent !== "themes.candles_sample")
      throw new Error("the example is not labelled: " + cap.textContent);
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
  const { bodies, prev } = draw(long);
  if (bodies.length !== 4) throw new Error("{open,high,low,close} bars were not read");
  if (prev.dataset.real !== "1") throw new Error("real bars were not recognised as real");
  return "o/h/l/c and open/high/low/close";
});

check("only the most recent bars are drawn, however long the history is", () => {
  const many = Array.from({ length: 500 }, (_, i) => bar(10 + i, 12 + i, 9 + i, 11 + i));
  const { bodies } = draw(many);
  if (bodies.length > 14) throw new Error(bodies.length + " bars drawn - the strip would be unreadable");
  return bodies.length + " bars";
});

check("the canvas is sized for the screen it is on", () => {
  /* A canvas sized in CSS alone is drawn at one device pixel per CSS
     pixel and every one-pixel wick turns into two grey ones. */
  const { canvas, W, H } = draw([bar(10, 12, 9, 11), bar(11, 13, 10, 10),
    bar(10, 14, 10, 13), bar(13, 15, 8, 9)]);
  if (canvas.width !== W || canvas.height !== H)
    throw new Error("the backing store is " + canvas.width + "x" + canvas.height);
  if (canvas.style.width !== W + "px") throw new Error("the CSS size was not set");
  return W + "x" + H + " at dpr 1";
});

check("the strip says whether it is the market or an example", () => {
  const html = body("function candlePreviewHtml()", "/** The two colours");
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

check("the caption is replaced only when the bars change", () => {
  /* Rebuilding it every second would restart the colour picker's
     hover and fight the drag that is choosing the colour. The canvas
     itself is cheap and is repainted every time, which is what makes
     the live colour preview work. */
  const paint = body("function paintCandlePreview()", "\n/* The custom miniature");
  if (!/S\._cndlKey !== key/.test(paint))
    throw new Error("the caption is rebuilt unconditionally");
  if (!/paintCandlePreview\(\);/.test(appJs.slice(appJs.indexOf('if (v === "settings")'),
    appJs.indexOf('if (v === "settings")') + 1200)))
    throw new Error("nothing repaints the strip while the settings page is open");
  return "keyed caption, repainted canvas";
});

check("the frame is still CSS, and the old bar rules are gone", () => {
  if (!/\.cndl-prev canvas\{/.test(appCss)) throw new Error("the canvas has no box to fill");
  if (/\.cndl\{/.test(appCss) || /\.cndl::before\{/.test(appCss))
    throw new Error("the old CSS candles are still in the sheet and will fight the canvas");
  return "frame only";
});

console.log(fails ? `\nboot-and-candles: ${fails} FAILED` : "\nboot-and-candles: all checks passed");
process.exit(fails ? 1 : 0);
