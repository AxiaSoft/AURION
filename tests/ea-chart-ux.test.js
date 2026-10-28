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


/**
 * Return the full text of the element whose opening tag contains `at`.
 *
 * Counts nested <div> open/close pairs, so "is X inside Y" can be asked
 * of real markup instead of guessing at character distances.
 */
function sliceElement(html, at) {
  if (at < 0) return null;
  const start = html.lastIndexOf("<", at);
  if (start < 0) return null;
  let i = start, depth = 0;
  const tag = /<(\/?)div\b|\/>/g;
  tag.lastIndex = start;
  let m;
  while ((m = tag.exec(html))) {
    if (m[0] === "/>") continue;
    depth += m[1] ? -1 : 1;
    i = m.index + m[0].length;
    if (depth === 0) {
      const close = html.indexOf(">", i);
      return html.slice(start, close < 0 ? i : close + 1);
    }
  }
  return html.slice(start);
}

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

check("the chart cannot be pushed past the newest bar", () => {
  const { chart } = freshChart();
  chart.pan(-99999);
  if (chart.offset !== 0) throw new Error("offset ran to " + chart.offset);
  const L = chart.layout();
  if (L.cells !== L.rows.length) {
    throw new Error(`${L.cells - L.rows.length} empty cells left on the right`);
  }
});

check("the chart cannot be pushed past the oldest bar", () => {
  const { chart } = freshChart();
  chart.pan(99999);
  const L = chart.layout();
  if (L.rows.length !== chart.span) {
    throw new Error(`only ${L.rows.length} of ${chart.span} cells hold a bar`);
  }
});

check("no reachable scroll position leaves empty space", () => {
  /* Swept rather than spot-checked, and at several zoom levels, because
     the bound involves the span and a single sample would miss an
     off-by-one at one particular width. */
  const { chart } = freshChart(400);
  const bad = [];
  for (const span of [20, 60, 120, 240]) {
    chart.span = span;
    for (let want = -40; want <= 440; want += 7) {
      chart.offset = want;
      chart.clampOffset();
      const L = chart.layout();
      if (!L) continue;
      if (L.cells !== L.rows.length) bad.push(`span ${span}, offset ${chart.offset}: ${L.cells - L.rows.length} blank cells`);
    }
  }
  if (bad.length) throw new Error(bad.slice(0, 5).join("\n"));
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
     1-2-5 series now, so the gap between labels is a round number. */
  const { chart } = freshChart(400, { width: 900, height: 500 });
  const vals = tickTexts(chart).map(Number).filter(Number.isFinite);
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

  const bundle = ["js/themes.js", "js/skins.js", "js/i18n.js", "js/api.js", "js/feed.js", "js/calendar.js", "js/charts.js", "js/app.js"]
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
      /* Measured by containment, not by how many characters apart the two
         happen to be. The original check allowed 600 characters between
         them, which quietly made the test about markup length: replacing
         the instrument <select> with a searchable picker broke it while
         the toolbar was still a single row. What actually matters is that
         both sit inside the same .mk-bar. */
      const bar = sliceElement(html, html.indexOf('class="mk-bar"'));
      if (!bar) throw new Error("the toolbar element could not be read");
      if (!bar.includes("mk-pick")) throw new Error("the instrument controls are outside the bar");
      if (!bar.includes("mk-sig")) throw new Error("the signal switches are outside the bar");
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
      const ics = (ticket.match(/class="ct-ic"/g) || []).length;
      if (ics !== 4) throw new Error(ics + " icon buttons for the 4 level verbs");
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

/* ------------------------------------------------------------------ result */

const failed = results.filter((r) => !r).length;
console.log(`\nea-chart-ux: ${results.length - failed} of ${results.length} checks passed`);
/* Explicit, because booting the desk in jsdom starts its polling timers and
   the process would otherwise sit there for as long as the runner allows -
   a suite that passes but never returns still breaks the build. */
process.exit(failed ? 1 : 0);
