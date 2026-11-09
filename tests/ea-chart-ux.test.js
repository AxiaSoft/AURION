/**
 * The EA chart: navigation, indicators, the price axis, and the two panels
 * that were redesigned around them.
 *
 * Six things were reported from the desk, and every one of them is the kind
 * of defect a reading of the source does not catch, because in each case the
 * code did exactly what it said - it just said the wrong thing:
 *
 *   1. a finger could only push the chart sideways;
 *   2. indicators were drawn half-length, and stayed half-length after
 *      scrolling back;
 *   3. the chart could be pushed off its own data into empty space;
 *   4. the price axis printed five numbers and none of them were round;
 *   5. the markets view wasted its space;
 *   6. the trade panel gave the order buttons no more weight than "clear TP".
 *
 * The first four are measured here against the real engine rather than
 * asserted from the markup, because "the indicator is complete" is a claim
 * about values and "the axis is readable" is a claim about how many labels
 * land on round numbers. The last two are rendered in jsdom and checked for
 * the structure and the stylesheet rules they depend on.
 *
 *     node tests/ea-chart-ux.test.js
 */

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const WEB = path.join(ROOT, "apps", "web");
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

/* ================================================= the engine, head-less == */

/* Re-use the recording-canvas harness that already exists for the engine
   rather than building a second one that can drift away from it. */
const engSrc = fs.readFileSync(path.join(WEB, "js", "chart-engine.test.cjs"), "utf8");
const harness = engSrc.slice(0, engSrc.indexOf("const { win, canvas, log } = makeChartEnv();"));
const { makeChartEnv, series } = new Function(
  "require", "__dirname", harness + "; return { makeChartEnv, series };",
)(require, path.join(WEB, "js"));

function freshChart(n = 600, rect) {
  const { win, canvas, log } = makeChartEnv();
  if (rect) canvas.getBoundingClientRect = () => Object.assign({ left: 0, top: 0 }, rect);
  const chart = new win.CandleChart(canvas, { key: "ux" });
  chart.setBars(series(n));
  return { win, canvas, chart, log };
}

/* ---- 1. a finger moves the chart in every direction --------------------- */

function dragWith(kind) {
  const { chart } = freshChart();
  chart.pan(60);
  chart.draw();
  const before = { off: chart.offset, mn: chart.layout().mn };
  chart.onDown({ button: 0, clientX: 400, clientY: 200, pointerId: 1, pointerType: kind });
  chart.onMove({ clientX: 320, clientY: 280, pointerId: 1, pointerType: kind });
  chart.onUp({ button: 0, clientX: 320, clientY: 280, pointerId: 1, pointerType: kind });
  return { dx: chart.offset - before.off, dy: chart.layout().mn - before.mn };
}

check("a finger drags the chart sideways", () => {
  const r = dragWith("touch");
  if (r.dx === 0) throw new Error("the chart did not move in time");
});

check("a finger drags the chart up and down too", () => {
  /* The whole of the reported complaint: the price axis was reachable only
     by right-dragging or by grabbing the axis, and a touchscreen can do
     neither, so on a phone the chart simply would not move vertically. */
  const r = dragWith("touch");
  if (Math.abs(r.dy) < 1e-6) throw new Error("the price window did not move");
});

check("a stylus counts as a finger", () => {
  const r = dragWith("pen");
  if (Math.abs(r.dy) < 1e-6) throw new Error("pen did not move the price window");
});

check("a left mouse drag still only moves time", () => {
  /* Deliberate: the right button already does the two-axis drag on a
     desktop, and silently changing what the left one does would move the
     chart under people who did not ask for it. A touchscreen laptop
     reports a coarse pointer even while a mouse is in use, so this has to
     follow the pointer that started the drag, not the device. */
  const touch = dragWith("touch");
  const mouse = dragWith("mouse");
  if (Math.abs(mouse.dy) >= Math.abs(touch.dy) * 0.5) {
    throw new Error("a mouse drag moved the price axis as much as a finger did");
  }
});

/* ---- 2. indicators are drawn whole ------------------------------------- */

check("every indicator is complete across the visible window", () => {
  const { win, chart } = freshChart(600);
  const bad = [];
  for (const def of win.AurionSeries.INDICATORS) {
    for (const off of [0, 60, 150, 300]) {
      chart.indicators = [];
      chart._indCache = null;
      const ind = chart.addIndicator(def.id);
      if (!ind) continue;
      chart.offset = off;
      chart.clampOffset();
      const L = chart.layout();
      if (!L) continue;
      const out = chart.indicatorValues(ind, L.rows, L.start);
      for (const plot of def.plots) {
        const vals = out[plot.key] || [];
        const blank = vals.filter((v) => v === null || !Number.isFinite(v)).length;
        if (blank) bad.push(`${def.id}.${plot.key} @offset ${off}: ${blank}/${vals.length} blank`);
      }
    }
  }
  if (bad.length) {
    throw new Error("indicators still arrive half-drawn:\n" + bad.join("\n"));
  }
});

check("an indicator covers exactly the bars on screen", () => {
  /* Computing over the whole series is only half the fix. The slice handed
     to the painter has to line up with L.rows index for index, or the line
     is complete but drawn against the wrong candles - a subtler and much
     worse bug than the one being fixed. */
  const { chart } = freshChart(600);
  chart.indicators = [];
  const ind = chart.addIndicator("sma");
  chart.offset = 90;
  const L = chart.layout();
  const out = chart.indicatorValues(ind, L.rows, L.start);
  if (out.line.length !== L.rows.length) {
    throw new Error(`${out.line.length} values for ${L.rows.length} bars`);
  }
  /* The last visible SMA must equal the mean of the last `period` closes of
     the full series up to that bar - proving the window was cut from a
     full-history calculation and not recomputed from the window. */
  const period = ind.params.period;
  const all = chart.rows();
  const endIx = L.start + L.rows.length - 1;
  let sum = 0;
  for (let i = endIx - period + 1; i <= endIx; i++) sum += all[i].c;
  const want = sum / period;
  const got = out.line[out.line.length - 1];
  if (Math.abs(got - want) > 1e-9) {
    throw new Error(`last SMA is ${got}, full-history value is ${want}`);
  }
});

check("a genuinely missing warm-up is still shown as missing", () => {
  /* Honesty check: at the very start of recorded history there is nothing
     to average, and the chart must leave a gap rather than invent one. */
  const { chart } = freshChart(60);
  chart.indicators = [];
  const ind = chart.addIndicator("ema");            // period 50
  chart.offset = chart.maxOffset();
  const L = chart.layout();
  const out = chart.indicatorValues(ind, L.rows, L.start);
  const blank = (out.line || []).filter((v) => v === null || !Number.isFinite(v)).length;
  if (blank === 0) throw new Error("an EMA(50) over 60 bars should start with a gap");
});

/* ---- 3. the chart stops where its data stops ---------------------------- */

/* These used to read "empty space must be EXACTLY the margin asked
   for", at every offset in a swept range. That is precisely the bug
   that has now been fixed, and it was the guard that made it look
   correct: the margin was subtracted from every window, so scrolling
   two hundred bars into history still blanked out thirty cells where
   real candles existed, and the sweep approved of it at every single
   offset because the blank matched the setting everywhere.

   The intent underneath was never "blank space everywhere". It was
   "the newest candle is held clear of the price column, and the blank
   is exactly what was asked for - one cell more is a gap nobody
   ordered, one fewer means the setting is being ignored". That intent
   is what these check now, with the part that was wrong corrected:
   the gap belongs to the newest BAR, not to the right-hand edge of
   the viewport, so it is only on screen while the newest bar is. */

const gapOn = (chart) => { chart.setHeadGap(true); return chart; };

check("the chart cannot be pushed past the newest bar", () => {
  const { chart } = freshChart();
  gapOn(chart);
  chart.pan(-99999);
  if (chart.offset !== 0) throw new Error("offset ran to " + chart.offset);
  const L = chart.layout();
  const blank = L.cells - L.rows.length;
  if (blank !== chart.headGapCells()) {
    throw new Error(`${blank} empty cells at the live edge, gap asks for ${chart.headGapCells()}`);
  }
  if (blank <= 0) throw new Error("the live edge has no room at all");
});

check("the head gap is a share of the window, so a zoom cannot change it", () => {
  /* The reason the bars-wide slider is gone. At 60 bars across, eight
     bars of margin is an eighth of the screen; at 400 it is a sliver.
     A fraction means the same thing at every zoom. */
  const { chart } = freshChart(2000);
  gapOn(chart);
  for (const span of [40, 120, 400]) {
    chart.span = span;
    chart.offset = 0;
    const want = Math.round(span * 0.15);
    if (Math.abs(chart.headGapCells() - want) > 1) {
      throw new Error(`span ${span}: gap is ${chart.headGapCells()} cells, expected about ${want}`);
    }
  }
});

check("scrolling into history gives back the gap one bar at a time", () => {
  /* The fix, stated as a measurement. Pull back by one bar and exactly
     one more real candle appears where blank used to be, so nothing
     jumps, and once the newest bar is off-screen the window is candles
     all the way across. */
  const { chart } = freshChart(2000);
  gapOn(chart);
  chart.span = 160;
  const full = chart.headGapCells();
  if (full < 10) throw new Error("the fixture is too small to show the effect");

  const bad = [];
  for (const off of [0, 1, 5, full - 1, full, full + 1, 50, 200, 900]) {
    chart.offset = off;
    chart.clampOffset();
    const L = chart.layout();
    const blank = L.cells - L.rows.length;
    const want = Math.max(0, full - chart.offset);
    if (blank !== want) bad.push(`offset ${chart.offset}: ${blank} blank, expected ${want}`);
  }
  if (bad.length) throw new Error(bad.join("\n"));
});

check("no window deep in history is part empty", () => {
  /* The complaint in its original form: half the chart missing because
     the live-edge gap followed the viewport back through the data.
     Swept, and at several zoom levels, because the bound involves the
     span and one sample would miss an off-by-one. */
  const { chart } = freshChart(2000);
  gapOn(chart);
  const bad = [];
  for (const span of [20, 60, 120, 240]) {
    chart.span = span;
    const gap = Math.max(1, Math.round(span * 0.15));
    for (let want = gap + 1; want <= 900; want += 7) {
      chart.offset = want;
      chart.clampOffset();
      if (chart.offset <= gap) continue;
      const L = chart.layout();
      if (!L) continue;
      const blank = L.cells - L.rows.length;
      if (blank !== 0) bad.push(`span ${span}, offset ${chart.offset}: ${blank} blank cells in history`);
    }
  }
  if (bad.length) throw new Error(bad.slice(0, 5).join("\n"));
});

check("the gap is off until it is asked for, and the setting survives", () => {
  const { chart } = freshChart(400);
  chart.setHeadGap(false);
  if (chart.headGapOn()) throw new Error("the gap stayed on");
  chart.offset = 0;
  let L = chart.layout();
  if (L.cells - L.rows.length !== 0) throw new Error("the gap is off but the space is still there");

  chart.setHeadGap(true);
  if (!chart.headGapOn()) throw new Error("the gap would not turn on");
  L = chart.layout();
  if (L.cells - L.rows.length !== chart.headGapCells()) throw new Error("turning it on changed nothing");
  chart.setHeadGap(false);
});

check("a chart with less history than fits on screen cannot scroll at all", () => {
  const { chart } = freshChart(40);
  chart.span = 120;
  if (chart.maxOffset() !== 0 || chart.minOffset() !== 0) {
    throw new Error(`bounds are ${chart.minOffset()}..${chart.maxOffset()}, expected 0..0`);
  }
});

/* ---- 4. the price axis prints real, readable prices --------------------- */

function tickTexts(chart) {
  const L = chart.layout();
  return chart.priceTicks(L).map((t) => t.text);
}

check("the price axis prints many more levels than it used to", () => {
  const { chart } = freshChart(400, { width: 900, height: 500 });
  const n = tickTexts(chart).length;
  if (n < 6) throw new Error("only " + n + " labels; the old fixed axis already managed 5");
});

check("the labels land on round numbers", () => {
  /* The old axis sliced the plot into quarters and printed whatever price
     fell there: 1.10374, 1.10521, 1.10668. The step is chosen from the
     1-2-5 series now, so the gap between labels is a round number.
     
     Read from `value`, not from the printed text. Prices are rounded
     to two decimals on their way to the screen, which on this series
     collapses several labels onto the same string - the axis is still
     on a round ladder, the display just cannot show the difference.
     Judging roundness from the rounded text measured the rounding. */
  const { chart } = freshChart(400, { width: 900, height: 500 });
  const L0 = chart.layout();
  const vals = chart.priceTicks(L0).map((t) => t.value).filter(Number.isFinite);
  if (vals.length < 3) throw new Error("not enough numeric labels to judge");
  const gaps = [];
  for (let i = 1; i < vals.length; i++) gaps.push(Math.abs(vals[i] - vals[i - 1]));
  const step = gaps[0];
  if (!gaps.every((g) => Math.abs(g - step) < step * 1e-6)) {
    throw new Error("labels are not evenly spaced: " + gaps.join(", "));
  }
  const m = step / Math.pow(10, Math.floor(Math.log10(step)));
  if (![1, 2, 5, 10].some((x) => Math.abs(m - x) < 1e-6)) {
    throw new Error("step " + step + " is not from the 1-2-5 series");
  }
});

check("the axis prints prices to two decimals", () => {
  /* Asked for on every instrument. The series here sits near 1.10,
     which is the case that costs the most: the labels repeat rather
     than resolve. That is the accepted trade, and pinning it here is
     what stops the old widening table coming back by accident. */
  const { chart } = freshChart(400, { width: 900, height: 500 });
  const bad = tickTexts(chart).filter((t) => !/^-?\d+\.\d{2}$/.test(t));
  if (bad.length) throw new Error("not two decimals: " + bad.slice(0, 4).join(", "));
});

check("a taller chart gets more labels, a shorter one fewer", () => {
  const tall = freshChart(400, { width: 900, height: 900 });
  const short = freshChart(400, { width: 900, height: 240 });
  const a = tickTexts(tall.chart).length, b = tickTexts(short.chart).length;
  if (!(a > b)) throw new Error(`900px tall gave ${a} labels, 240px gave ${b}`);
});

check("labels never overlap, at any height", () => {
  const bad = [];
  for (const h of [160, 220, 320, 500, 760, 1000]) {
    const { chart } = freshChart(400, { width: 900, height: h });
    const L = chart.layout();
    const ys = chart.priceTicks(L).map((t) => t.y);
    for (let i = 1; i < ys.length; i++) {
      if (ys[i] - ys[i - 1] < 18) bad.push(`${h}px: two labels ${(ys[i] - ys[i - 1]).toFixed(1)}px apart`);
    }
  }
  if (bad.length) throw new Error(bad.join("\n"));
});

check("the axis still works in percent, log and inverted modes", () => {
  const { chart } = freshChart(400, { width: 900, height: 500 });
  for (const mode of ["percent", "log", "invert"]) {
    chart.scale.percent = chart.scale.log = chart.scale.invert = false;
    chart.scale[mode] = true;
    const t = tickTexts(chart);
    if (t.length < 3) throw new Error(mode + " produced only " + t.length + " labels");
    if (mode === "percent" && !t.some((x) => x.endsWith("%"))) {
      throw new Error("percent mode did not print percentages");
    }
  }
});

check("the grid rules and the axis numbers are the same lines", () => {
  /* They used to be computed independently - five even lines and five even
     labels - and agreed only by coincidence. */
  const src = fs.readFileSync(path.join(WEB, "js", "charts.js"), "utf8");
  const from = src.indexOf("paintGrid(L) {");
  /* Index forward from paintGrid: "paintSeries(L" also matches its call
     site up in draw(), which sits above paintGrid and yields an empty
     slice that passes or fails for the wrong reason. */
  const grid = src.slice(from, src.indexOf("paintSeries(L) {", from));
  if (from < 0 || grid.length < 50) throw new Error("could not isolate paintGrid");
  if (!/priceTicks\(L\)/.test(grid)) {
    throw new Error("paintGrid does not draw the ticks the axis prints");
  }
});

/* =============================================== the two redesigned panels == */

let jsdom = null;
try { jsdom = require(require.resolve("jsdom")); } catch { /* optional */ }

if (!jsdom) {
  console.log("SKIP  markup checks (jsdom not installed)");
} else {
  const { JSDOM, VirtualConsole } = jsdom;
  const css = fs.readFileSync(path.join(WEB, "css", "app.css"), "utf8");
  const appJs = fs.readFileSync(path.join(WEB, "js", "app.js"), "utf8");

  const vc = new VirtualConsole();
  const dom = new JSDOM(fs.readFileSync(path.join(WEB, "index.html"), "utf8"), {
    url: "http://localhost/", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole: vc,
  });
  const win = dom.window;
  win.fetch = async () => ({ ok: true, json: async () => ({ ok: true, data: {} }) });
  win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  win.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  win.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
  win.URL.createObjectURL = () => "blob:stub";

  const bundle = ["js/themes.js", "js/skins.js", "js/i18n.js", "js/api.js", "js/calendar.js", "js/charts.js", "js/app.js"]
    .map((f) => fs.readFileSync(path.join(WEB, f), "utf8")).join("\n;\n");
  let T = null;
  try {
    win.eval(bundle + "\n;window.__T = { S, views, chartTicketHtml, watchlistHtml, I18N };");
    T = win.__T;
  } catch (e) {
    console.log("FAIL  the desk bundle loads\n      " + e.message);
    results.push(false);
  }

  if (T) {
    /* A realistic snapshot: three attached EA charts, all quoting. */
    T.S.snap = {
      engine: "online",
      ticks: {
        EURUSD: { bid: 1.08542, ask: 1.08555 },
        XAUUSD: { bid: 2412.31, ask: 2412.68 },
        GBPJPY: { bid: 198.221, ask: 198.254 },
      },
      agents: [
        { symbol: "EURUSD", timeframe: "M15", alive: true, online: true, last_seen: Date.now() },
        { symbol: "XAUUSD", timeframe: "H1", alive: true, online: true, last_seen: Date.now() },
        { symbol: "GBPJPY", timeframe: "M5", alive: true, online: true, last_seen: Date.now() },
      ],
      strategy: { manual_volume: 0.2 },
      positions: [],
    };
    T.S.symbol = "XAUUSD";
    T.S.timeframe = "H1";

    const classesIn = (html) => {
      const out = new Set();
      for (const m of html.matchAll(/class="([^"]+)"/g)) {
        for (const c of m[1].split(/\s+/)) if (c && !c.includes("${")) out.add(c);
      }
      return [...out];
    };

    /* ---- 5. markets ---------------------------------------------------- */

    const wl = T.watchlistHtml();

    check("the watchlist lists every quoting symbol", () => {
      for (const s of ["EURUSD", "XAUUSD", "GBPJPY"]) {
        if (!wl.includes(s)) throw new Error(s + " is missing");
      }
    });

    check("the watchlist marks the symbol the chart is showing", () => {
      const rows = [...wl.matchAll(/data-wl="([^"]+)"[\s\S]*?aria-current="(true|false)"/g)];
      const on = rows.filter((r) => r[2] === "true").map((r) => r[1]);
      if (on.length !== 1 || on[0] !== "XAUUSD") {
        throw new Error("marked: " + JSON.stringify(on) + ", expected exactly XAUUSD");
      }
    });

    check("each symbol can be pressed to put it on the chart", () => {
      const n = (wl.match(/data-wl="/g) || []).length;
      if (n !== 3) throw new Error(n + " pressable rows for 3 symbols");
      if (!/<button[^>]*class="wl-row/.test(wl)) throw new Error("rows are not buttons");
    });

    check("the watchlist shows the spread, which the old table did not", () => {
      if (!/wl-sp/.test(wl)) throw new Error("no spread column rendered");
      /* XAUUSD: 2412.68 - 2412.31 = 0.37, and it must be computed, not
         copied from one side of the quote. */
      if (!wl.includes("0.37")) throw new Error("the gold spread of 0.37 is not shown");
    });

    check("tick direction is only claimed once there is a previous tick", () => {
      /* First paint has nothing to compare against, so no row may claim a
         direction. Inventing one would be a made-up number on screen. */
      if (/wl-bid (up|down)/.test(wl)) throw new Error("a direction was shown on the very first paint");
      T.S.snap.ticks.EURUSD.bid = 1.08600;      // now it really has moved
      const second = T.watchlistHtml();
      if (!/wl-bid up/.test(second)) throw new Error("a genuine rise was not marked");
    });

    check("the markets view renders and keeps the chart canvas", () => {
      const html = T.views.markets();
      if (html.includes("[object")) throw new Error("the view returned a Promise");
      if (!html.includes('id="cv"')) throw new Error("the chart canvas is gone");
      if (!html.includes('id="live-ticks"')) throw new Error("the watchlist host is gone");
    });

    check("the markets toolbar is one row, not two stacked ones", () => {
      const html = T.views.markets();
      if (!html.includes('class="mk-bar"')) throw new Error("no single toolbar");
      /* This used to assert the two groups sat within 600 characters of
         each other in the source, as a stand-in for "same bar". That
         broke the moment the instrument <select> became a searchable
         combobox, which is more markup but no more rows. Ask the DOM
         where the elements actually are. */
      const box = win.document.createElement("div");
      box.innerHTML = html;
      const bar = box.querySelector(".mk-bar");
      if (!bar) throw new Error("no single toolbar");
      if (!bar.querySelector(".mk-pick")) throw new Error("the instrument controls are outside the bar");
      if (!bar.querySelector(".mk-sig")) throw new Error("the signal switches are outside the bar");
      if (box.querySelectorAll(".mk-bar").length !== 1) {
        throw new Error("the toolbar was split into " + box.querySelectorAll(".mk-bar").length + " rows");
      }
    });

    check("every class the markets view uses has a rule in the stylesheet", () => {
      const missing = classesIn(T.views.markets() + wl)
        .filter((c) => /^(mk|wl)-|^mk$|^wl$/.test(c))
        .filter((c) => !css.includes("." + c));
      if (missing.length) throw new Error("no CSS for: " + missing.join(", "));
    });

    check("the markets layout is told what to do on a phone", () => {
      /* A desktop-only redesign is half the request. */
      if (!/@media \(max-width:560px\)\{[\s\S]*?\.mk-pick/.test(css.replace(/\s*\n\s*/g, ""))) {
        const narrow = css.split("@media").filter((b) => /max-width:\s*560px/.test(b)).join("");
        if (!narrow.includes(".mk-")) throw new Error("no phone rules for the markets toolbar");
      }
      const narrow = css.split("@media").filter((b) => /max-width:\s*560px/.test(b)).join("");
      if (!narrow.includes(".wl-row")) throw new Error("no phone rules for the watchlist rows");
    });

    /* ---- 6. the trade panel -------------------------------------------- */

    const ticket = T.chartTicketHtml();

    check("the trade panel keeps every control the wiring binds to", () => {
      /* This was a redesign, not a rewrite: breaking an id here would
         silently disconnect the order path. */
      for (const id of ["ct-vol", "ct-sl", "ct-tp", "ct-pick-sl", "ct-pick-tp",
        "ct-clear-sl", "ct-clear-tp", "ct-buy", "ct-sell", "ct-msg"]) {
        if (!ticket.includes(`id="${id}"`)) throw new Error("lost " + id);
      }
    });

    check("buy and sell carry the price they would cross", () => {
      /* Prices go through the desk's own number formatter, which groups
         thousands, so gold reads 2,412.31 and not 2412.31. */
      if (!/id="ct-bid"[^>]*>2,?412\.31</.test(ticket)) throw new Error("sell does not show the bid");
      if (!/id="ct-ask"[^>]*>2,?412\.68</.test(ticket)) throw new Error("buy does not show the ask");
      const sell = ticket.indexOf('id="ct-sell"'), bid = ticket.indexOf('id="ct-bid"');
      const buy = ticket.indexOf('id="ct-buy"'), ask = ticket.indexOf('id="ct-ask"');
      if (!(sell < bid && bid < buy)) throw new Error("the bid is not inside the sell button");
      if (!(buy < ask)) throw new Error("the ask is not inside the buy button");
    });

    check("the order buttons no longer look like the housekeeping ones", () => {
      /* The complaint: six ghost buttons of identical weight, two of which
         send money. Buy and sell have their own class now and the four
         level verbs are small icon buttons. */
      if (!/class="ct-side sell"/.test(ticket) || !/class="ct-side buy"/.test(ticket)) {
        throw new Error("buy/sell are not their own control");
      }
      /* Six, not four: the entry price is a level like the stop and the
         target, and it got the same pick-on-chart and clear pair. The
         point of the count is that these stayed small icon buttons
         instead of growing into more pills beside buy and sell. */
      const ics = (ticket.match(/class="ct-ic"/g) || []).length;
      if (ics !== 6) throw new Error(ics + " icon buttons for the 6 level verbs");
      if (/class="btn tiny ghost"/.test(ticket)) throw new Error("ghost pills are still there");
    });

    check("the lot can be nudged as well as typed", () => {
      const pm = (ticket.match(/data-vol="/g) || []).length;
      if (pm !== 2) throw new Error(pm + " steppers, expected 2");
    });

    check("the lot starts from the one setting that owns it", () => {
      if (!/id="ct-vol"[\s\S]{0,160}value="0\.2"/.test(ticket)) {
        throw new Error("the ticket did not start from manual_volume");
      }
    });

    check("every class the trade panel uses has a rule in the stylesheet", () => {
      const missing = classesIn(ticket)
        .filter((c) => c.startsWith("ct-"))
        .filter((c) => !css.includes("." + c));
      if (missing.length) throw new Error("no CSS for: " + missing.join(", "));
    });

    check("the trade panel is told what to do on a phone", () => {
      const narrow = css.split("@media").filter((b) => /max-width:\s*560px/.test(b)).join("");
      for (const c of [".ct-side", ".ct-pm", ".ct-ic"]) {
        if (!narrow.includes(c)) throw new Error("no phone rule for " + c);
      }
    });

    check("the order buttons are big enough for a thumb", () => {
      /* 44px is the usual floor for a touch target; an order button should
         not be the thing that misses it. */
      const m = /\.ct-side\{[^}]*min-height:(\d+)px/.exec(css.replace(/\s*\n\s*/g, ""));
      if (!m) throw new Error("no min-height on .ct-side");
      if (Number(m[1]) < 44) throw new Error("order buttons are only " + m[1] + "px tall");
    });

    check("the ticket prices are kept live, not frozen at build time", () => {
      if (!/function paintTicketPrices\(/.test(appJs)) throw new Error("no refresh for the prices");
      if (!/paintTicketPrices\(\)/.test(appJs.replace("function paintTicketPrices()", ""))) {
        throw new Error("paintTicketPrices is defined but never called");
      }
    });
  }
}

/* ------------------------------------------------------------------ *
 * A drawing tool lets go of the pointer when it is done
 *
 * Reported: after using a tool once, the pointer has to come back to
 * normal. It did not - the tool stayed armed, which is genuinely better
 * for marking up a session with twenty lines and genuinely worse for
 * everything else, because on this chart the next click usually moves a
 * stop or a target rather than drawing again. Finishing a line and
 * reaching for a level drew a second line on top of it.
 *
 * The pin on the rail still exists for the twenty-line case and is
 * remembered. What changed is which way it points when nobody has
 * touched it.
 * ------------------------------------------------------------------ */

check("the tool returns to the cursor after one shape, by default", () => {
  const src = fs.readFileSync(path.join(WEB, "js", "chart-tools.js"), "utf8");
  const m = src.match(/function toolLocked\(\)\s*\{[^}]*\}/);
  if (!m) throw new Error("toolLocked() is gone");
  if (!/read\(LS_TOOLLOCK,\s*"0"\)/.test(m[0])) {
    throw new Error("the default is back to staying armed: " + m[0]);
  }
  if (!/LS_TOOLLOCK/.test(src) || !/function setToolLock/.test(src)) {
    throw new Error("the pin that overrides the default was removed with it");
  }
});

check("every finished tool says so, the eraser included", () => {
  const src = fs.readFileSync(path.join(WEB, "js", "charts.js"), "utf8");
  // commitDraft, the one-point tools, the text prompts - and the eraser,
  // which was the one tool that deleted a shape and stayed armed.
  const hits = (src.match(/onToolDone/g) || []).length;
  if (hits < 5) throw new Error("only " + hits + " onToolDone sites; the eraser is probably not one of them");
  /* lastIndexOf, not indexOf: cursorFor() tests the same string a
     couple of thousand lines earlier, and a window opened there says
     nothing about the branch that does the deleting. */
  const i = src.lastIndexOf('if (this.tool === "eraser")');
  if (i < 0 || !/removeObject/.test(src.slice(i, i + 900))) {
    throw new Error("the eraser branch that deletes a shape moved");
  }
  if (!/onToolDone/.test(src.slice(i, i + 900))) {
    throw new Error("the eraser deletes a shape and stays in erase mode");
  }
});

check("the desk listens for it and disarms", () => {
  const src = fs.readFileSync(path.join(WEB, "js", "chart-tools.js"), "utf8");
  const i = src.indexOf("chart.opts.onToolDone");
  if (i < 0) throw new Error("nothing is wired to onToolDone - the chart reports into a void");
  const body = src.slice(i, i + 400);
  if (!/pickTool\("cursor"\)/.test(body)) throw new Error("the handler no longer returns to the cursor");
  if (!/toolLocked\(\)/.test(body)) throw new Error("the pin is ignored, so it cannot be pinned on");
});

check("the rail button does not draw itself as pinned", () => {
  const src = fs.readFileSync(path.join(WEB, "js", "chart-tools.js"), "utf8");
  const i = src.indexOf('id="tv-toollock"');
  if (i < 0) throw new Error("the pin button is gone");
  if (/aria-pressed="true"/.test(src.slice(i, i + 400))) {
    throw new Error("the pin renders as pressed while the behaviour is off by default");
  }
  /* The template cannot read the setting - it is in a different scope
     from toolLocked() - so markRailState is what has to put the real
     answer on screen, and it runs when the rail is bound. */
  const j = src.indexOf("const tlock = $(\"tv-toollock\")");
  if (j < 0) throw new Error("markRailState stopped painting the pin");
  if (!/toolLocked\(\)/.test(src.slice(j, j + 400))) {
    throw new Error("the pin is painted from something other than the stored setting");
  }
});

/* ------------------------------------------------------------------ result */

const failed = results.filter((r) => !r).length;
console.log(`\nea-chart-ux: ${results.length - failed} of ${results.length} checks passed`);
/* Explicit, because booting the desk in jsdom starts its polling timers and
   the process would otherwise sit there for as long as the runner allows -
   a suite that passes but never returns still breaks the build. */
process.exit(failed ? 1 : 0);
