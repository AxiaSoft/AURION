/**
 * "The backtest shows the live market instead of replaying."
 *
 * It did. The running-backtest panel drew a thumbnail of the symbol's
 * current candles -- the same `canvas[data-mini]` the watchlist uses,
 * refreshed from the live feed every ten seconds -- and put it under a
 * heading about the test. So the chart on screen was today's market
 * while the numbers beside it were a replay of some window in the past,
 * and the two had nothing to do with each other. Worse, a replay
 * publishes its progress twice a second while the thumbnail moved only
 * every ten, so the one thing that looked like the test was the one
 * thing standing still.
 *
 * The engine now sends the bars it is actually walking, plus the trades
 * sitting on them, and the desk draws those.
 *
 * The drawing is checked by running it against a recording canvas
 * context and reading back what it asked for, rather than by grepping
 * the source: the bug being guarded against is a chart that draws the
 * wrong data, and that is invisible to a grep. jsdom has no canvas
 * implementation, so the context is a proxy that logs calls -- enough
 * to answer "how many candles, where, and in what colour", which is
 * what these checks ask. Where no DOM exists to drive, the source is
 * read instead, and that is said each time.
 *
 *     node tests/backtest-replay.test.js
 */

const fs = require("node:fs");
const path = require("node:path");
const { JSDOM, VirtualConsole } = require("jsdom");

const ROOT = path.resolve(__dirname, "..");
const WEB = path.join(ROOT, "apps", "web");
const read = (p) => fs.readFileSync(path.join(WEB, p), "utf8");

const appJs = read("js/app.js");
const appCss = read("css/app.css");

/** Source with comments stripped: the prose above a fix tends to quote
 *  the very thing the fix removed. */
function code(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}
const appCode = code(appJs);

const results = [];
function check(name, fn) {
  try {
    const note = fn();
    results.push(true);
    console.log("PASS  " + name + (note ? "  — " + note : ""));
  } catch (e) {
    results.push(false);
    console.log("FAIL  " + name + "\n      " + e.message);
  }
}

/* ----------------------------------------------------------- a desk --- */

function desk() {
  const files = ["themes.js", "skins.js", "i18n.js", "api.js", "calendar.js",
    "chart-series.js", "charts.js", "chart-tools.js", "pnl-charts.js", "app.js"];
  const src = files.map((f) => read("js/" + f)).join("\n;\n");
  const dom = new JSDOM("<!doctype html><html><body><div id='host'></div></body></html>",
    { runScripts: "outside-only", pretendToBeVisual: true, url: "http://localhost/",
      virtualConsole: new VirtualConsole() });
  const win = dom.window;
  win.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, data: {} }) });
  win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {},
    addListener() {}, removeListener() {} });
  win.ResizeObserver = win.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
  win.URL.createObjectURL = () => "blob:x";
  win.AudioContext = class {};

  // A canvas context that records instead of painting. `only` narrows
  // the recording to one canvas so the equity curve drawn in the same
  // panel does not show up in the replay chart's tally.
  const log = [];
  const state = { only: null };
  const gradient = { addColorStop() {} };
  win.HTMLCanvasElement.prototype.getContext = function () {
    const owner = this;
    const style = {};
    return new Proxy({}, {
      get: (_t, k) => {
        if (k === "canvas") return owner;
        if (k === "measureText") return () => ({ width: 10 });
        if (k === "createLinearGradient" || k === "createRadialGradient") return () => gradient;
        if (k in style) return style[k];
        return (...args) => {
          if (!state.only || owner.id === state.only) log.push({ op: k, args, style: { ...style } });
        };
      },
      set: (_t, k, v) => { style[k] = v; return true; },
    });
  };
  win.requestAnimationFrame = (f) => { f(0); return 1; };

  win.eval(src + ";window.__T={renderBacktestLive,paintBacktestLive,drawReplayChart,S};");
  return { win, doc: win.document, T: win.__T, log, state };
}

/**
 * A desk with the running-backtest panel already on screen.
 *
 * drawReplayChart finds its canvas by id, so there is no way to drive
 * it without the panel the engine's updates land in. Painting the
 * panel first also means these checks exercise the real path -- render
 * then draw -- rather than a canvas conjured up for the test.
 */
function panel(bt) {
  const d = desk();
  d.T.paintBacktestLive(d.doc.getElementById("host"), bt || liveRun(), true);
  d.state.only = "bt-replay";
  d.log.length = 0;
  d.draw = (b, m) => d.T.drawReplayChart(b, m || []);
  return d;
}

/** The moveTo/lineTo run that makes up the last closed shape drawn,
 *  isolated from the wicks, which use the same two calls. */
function lastShape(log) {
  const end = log.map((e) => e.op).lastIndexOf("closePath");
  if (end < 0) throw new Error("no closed shape was drawn");
  const start = log.slice(0, end).map((e) => e.op).lastIndexOf("beginPath");
  return log.slice(start + 1, end).filter((e) => e.op === "moveTo" || e.op === "lineTo");
}

/** A rising-then-falling series with unmistakable up and down bars. */
function bars(n = 160) {
  const out = [];
  let px = 2000;
  for (let i = 0; i < n; i++) {
    const o = px;
    px += Math.sin(i / 9) * 2.5;
    const c = px;
    out.push({
      t: "2026-01-02T" + String(9 + Math.floor(i / 12)).padStart(2, "0") +
         ":" + String((i * 5) % 60).padStart(2, "0") + ":00",
      o: +o.toFixed(2),
      h: +(Math.max(o, c) + 1).toFixed(2),
      l: +(Math.min(o, c) - 1).toFixed(2),
      c: +c.toFixed(2),
    });
  }
  return out;
}

function liveRun(extra = {}) {
  const b = bars();
  const marks = [
    { t: b[20].t, kind: "in", side: "buy", price: b[20].c, volume: 0.5 },
    { t: b[48].t, kind: "out", side: "buy", price: b[48].c, profit: 31.4, reason: "tp" },
    { t: b[90].t, kind: "in", side: "sell", price: b[90].c, volume: 0.5 },
    { t: b[110].t, kind: "out", side: "sell", price: b[110].c, profit: -12.2, reason: "sl" },
    { t: b[130].t, kind: "in", side: "buy", price: b[130].c, volume: 0.5, open: true },
  ];
  return {
    running: true, symbol: "XAUUSD", timeframe: "M5", strategy: "price_action", progress: 62,
    live: {
      equity: 10231.4, peak: 10260, equity_curve: [10000, 10120, 10231.4],
      trades_so_far: 7, at: b[b.length - 1].t, open_side: "sell", open_count: 2,
      replay_bars: b, marks, ...extra,
    },
  };
}

/* ======================= 1. it is the replay, not the market ========= */

check("the running panel no longer carries a live-market thumbnail", () => {
  const { doc, T } = desk();
  const host = doc.getElementById("host");
  T.paintBacktestLive(host, liveRun(), true);
  if (/data-mini/.test(host.innerHTML)) {
    throw new Error("the watchlist's live-feed canvas is still inside the backtest panel");
  }
  if (!doc.getElementById("bt-replay")) throw new Error("no replay canvas was rendered");
  return "canvas#bt-replay replaces canvas[data-mini]";
});

check("the panel never pulls the live feed", () => {
  // Source-read: paintMiniCharts fetches from the network, and the
  // point is that this panel must not call it at all.
  const at = appCode.indexOf("function paintBacktestLive");
  if (at < 0) throw new Error("paintBacktestLive is gone");
  const end = appCode.indexOf("\nfunction drawReplayChart", at);
  const body = appCode.slice(at, end > at ? end : at + 4000);
  if (/paintMiniCharts/.test(body)) throw new Error("still refreshing the live market");
  if (/_btChartAt/.test(appCode)) throw new Error("the ten-second live-feed throttle is still there");
  return "no feed call, no throttle";
});

check("paintMiniCharts still exists for the pages that do want the market", () => {
  // Removing the live thumbnail from the backtest must not take the
  // watchlist's thumbnails with it.
  if (!/function paintMiniCharts/.test(appCode)) throw new Error("paintMiniCharts was deleted");
  if (!/canvas\[data-mini\]/.test(appCode)) throw new Error("nothing reads data-mini any more");
  return "watchlist thumbnails untouched";
});

/* ======================= 2. it draws the bars it was sent =========== */

check("every replayed bar is drawn", () => {
  const b = bars(160);
  const { draw, log } = panel();
  draw(b);
  const bodies = log.filter((e) => e.op === "fillRect").length;
  if (bodies !== b.length) throw new Error("drew " + bodies + " candle bodies for " + b.length + " bars");
  return b.length + " candles";
});

check("the chart redraws when the replay moves on", () => {
  // The whole complaint: the picture must change as the run walks
  // forward. Two different windows must not produce the same drawing.
  const all = bars(200);
  const { draw, log } = panel();
  draw(all.slice(0, 160));
  const first = log.filter((e) => e.op === "fillRect").map((e) => e.args[1].toFixed(3)).join(",");
  log.length = 0;
  draw(all.slice(40, 200));
  const later = log.filter((e) => e.op === "fillRect").map((e) => e.args[1].toFixed(3)).join(",");
  if (first === later) throw new Error("a later window draws an identical chart");
  return "window advance changes the drawing";
});

check("up bars and down bars are not the same colour", () => {
  const b = [
    { t: "a", o: 10, h: 12, l: 9, c: 11 },
    { t: "b", o: 11, h: 11.5, l: 8, c: 9 },
    { t: "c", o: 9, h: 13, l: 8.5, c: 12.5 },
  ];
  const { draw, log } = panel();
  draw(b);
  const fills = log.filter((e) => e.op === "fillRect").map((e) => e.style.fillStyle);
  if (fills.length !== 3) throw new Error("expected 3 bodies, got " + fills.length);
  if (fills[0] !== fills[2]) throw new Error("two rising bars drawn in different colours");
  if (fills[0] === fills[1]) throw new Error("a rising and a falling bar are the same colour");
  return "rising " + fills[0] + " / falling " + fills[1];
});

check("the candles use the trader's own candle colours", () => {
  // Source-read: jsdom resolves no custom properties, so the only way
  // to tell which variable is consulted is to read the code.
  const at = appCode.indexOf("function drawReplayChart");
  const body = appCode.slice(at, at + 3200);
  if (!/--candle-up/.test(body) || !/--candle-down/.test(body)) {
    throw new Error("the replay invents its own green and red instead of the theme's candles");
  }
  return "--candle-up / --candle-down";
});

check("the price scale fits the bars it was given", () => {
  const { draw, log } = panel();
  const flat = bars(60).map((b) => ({ ...b, o: b.o + 9000, h: b.h + 9000, l: b.l + 9000, c: b.c + 9000 }));
  draw(flat);
  const ys = log.filter((e) => e.op === "fillRect").map((e) => e.args[1]);
  const span = Math.max(...ys) - Math.min(...ys);
  if (!(span > 10)) throw new Error("all candles collapsed onto one line (span " + span.toFixed(2) + ")");
  // The axis has to read in the instrument's own prices. A scale
  // labelled 0..1, or in pixels, is the usual way this goes wrong.
  const labels = log.filter((e) => e.op === "fillText").map((e) => String(e.args[0]));
  if (labels.length < 2) throw new Error("the price scale is unlabelled");
  const lo = Math.min(...flat.map((b) => b.l));
  const hi = Math.max(...flat.map((b) => b.h));
  const nums = labels.map((s) => Number(s.replace(/,/g, "")));
  if (nums.some((n) => !Number.isFinite(n))) throw new Error("unreadable labels: " + labels.join(" "));
  const slack = (hi - lo) * 0.25;
  const off = nums.filter((n) => n < lo - slack || n > hi + slack);
  if (off.length) {
    throw new Error("labels outside the " + lo.toFixed(0) + ".." + hi.toFixed(0) +
      " the bars occupy: " + off.join(" "));
  }
  if (new Set(nums).size !== nums.length) throw new Error("the axis repeats one price: " + labels.join(" "));
  return "axis " + labels.join(" / ");
});

/* ======================= 3. the trades are on the chart ============= */

check("entries and exits are marked", () => {
  const bt = liveRun();
  const { draw, log } = panel(bt);
  draw(bt.live.replay_bars, bt.live.marks);
  const dots = log.filter((e) => e.op === "arc").length;
  const shapes = log.filter((e) => e.op === "closePath").length;
  if (dots !== 2) throw new Error("expected 2 exit dots, drew " + dots);
  if (shapes !== 3) throw new Error("expected 3 entry markers, drew " + shapes);
  return "3 entries, 2 exits";
});

check("a winning exit and a losing exit are not the same colour", () => {
  const b = bars(40);
  const { draw, log } = panel();
  draw(b, [
    { t: b[10].t, kind: "out", side: "buy", price: b[10].c, profit: 50, reason: "tp" },
    { t: b[20].t, kind: "out", side: "buy", price: b[20].c, profit: -50, reason: "sl" },
  ]);
  const cols = log.filter((e) => e.op === "arc").map((e) => e.style.fillStyle);
  if (cols.length !== 2) throw new Error("expected 2 exit dots");
  if (cols[0] === cols[1]) throw new Error("a profit and a loss are drawn identically");
  return "win " + cols[0] + " / loss " + cols[1];
});

check("a buy marker and a sell marker point opposite ways", () => {
  const b = bars(40);
  const { draw, log } = panel();
  const run = (side) => {
    log.length = 0;
    draw(b, [{ t: b[10].t, kind: "in", side, price: b[10].c, volume: 0.1 }]);
    // Isolated from the wicks, which are drawn with the same calls.
    const pts = lastShape(log);
    if (pts.length < 3) throw new Error("the entry marker is not a shape");
    return pts[pts.length - 1].args[1] - b.length * 0 - pts[0].args[1];
  };
  const buy = run("buy");
  const sell = run("sell");
  if (Math.sign(buy) === Math.sign(sell)) throw new Error("both sides draw the same shape");
  return "buy " + buy.toFixed(1) + " / sell " + sell.toFixed(1);
});

check("a trade still open looks different from one already closed", () => {
  // The replay is watched while it runs, so the entry that has not
  // resolved yet is the one the eye should go to.
  const b = bars(40);
  const { draw, log } = panel();
  const ops = (open) => {
    log.length = 0;
    draw(b, [{ t: b[10].t, kind: "in", side: "buy", price: b[10].c, volume: 0.1, ...(open ? { open: true } : {}) }]);
    const from = log.map((e) => e.op).lastIndexOf("closePath");
    return log.slice(from).map((e) => e.op).join(",");
  };
  const settled = ops(false);
  const live = ops(true);
  if (settled === live) throw new Error("an open trade is drawn exactly like a finished one");
  return "settled [" + settled + "] vs open [" + live + "]";
});

check("a mark on a bar outside the window is not drawn", () => {
  const b = bars(40);
  const { draw, log } = panel();
  draw(b, [{ t: "1999-01-01T00:00:00", kind: "out", side: "buy", price: b[0].c, profit: 1 }]);
  if (log.filter((e) => e.op === "arc").length) {
    throw new Error("a trade from outside the replayed window was drawn onto it");
  }
  return "stale marks ignored";
});

check("marks land on the bar they belong to", () => {
  const b = bars(100);
  const { draw, log } = panel();
  const xOf = (i) => {
    log.length = 0;
    draw(b, [{ t: b[i].t, kind: "out", side: "buy", price: b[i].c, profit: 1 }]);
    return log.find((e) => e.op === "arc").args[0];
  };
  const early = xOf(5);
  const late = xOf(90);
  if (!(late > early)) throw new Error("a later trade is not drawn further right");
  const mid = xOf(47);
  if (!(mid > early && mid < late)) throw new Error("marks are not placed in bar order");
  return "ordered left to right";
});

check("the panel draws the chart, not just the canvas", () => {
  // The gap this closes: every drawing check above calls
  // drawReplayChart directly, so cutting the one call that the running
  // panel makes left the desk with a blank chart and the whole suite
  // still green.
  const d = desk();
  d.state.only = "bt-replay";
  const bt = liveRun();
  d.T.paintBacktestLive(d.doc.getElementById("host"), bt, true);
  const bodies = d.log.filter((e) => e.op === "fillRect").length;
  if (bodies !== bt.live.replay_bars.length) {
    throw new Error("a progress update drew " + bodies + " candles of " + bt.live.replay_bars.length);
  }
  if (!d.log.some((e) => e.op === "arc")) throw new Error("the panel drew no trade marks");
  return bodies + " candles from one update";
});

check("each progress update repaints the chart", () => {
  // A replay that paints once and freezes is the original complaint in
  // a new shape.
  const d = desk();
  const all = bars(240);
  const bt = liveRun();
  bt.live.replay_bars = all.slice(0, 160);
  d.T.paintBacktestLive(d.doc.getElementById("host"), bt, true);
  d.state.only = "bt-replay";
  d.log.length = 0;
  bt.live.replay_bars = all.slice(80, 240);
  bt.live.at = all[239].t;
  d.T.paintBacktestLive(d.doc.getElementById("host"), bt, true);
  const second = d.log.filter((e) => e.op === "fillRect");
  if (second.length !== 160) throw new Error("the second update drew " + second.length + " candles");
  return "repainted on update";
});

check("candle wicks are drawn, not just the bodies", () => {
  const { draw, log } = panel();
  const b = [{ t: "a", o: 10, h: 20, l: 1, c: 11 }, { t: "b", o: 11, h: 21, l: 2, c: 10 }];
  draw(b);
  // A wick has to reach beyond its body, or the high and the low are
  // simply not on the chart.
  const body = log.find((e) => e.op === "fillRect");
  const tops = log.filter((e) => e.op === "moveTo");
  if (!tops.length) throw new Error("no wicks drawn");
  const bodyTop = body.args[1];
  const bodyBottom = bodyTop + body.args[3];
  if (!tops.some((e) => e.args[1] < bodyTop - 0.5)) {
    throw new Error("no wick reaches above the body: the high is missing");
  }
  const lows = log.filter((e) => e.op === "lineTo");
  if (!lows.some((e) => e.args[1] > bodyBottom + 0.5)) {
    throw new Error("no wick reaches below the body: the low is missing");
  }
  return "high and low drawn";
});

/* ======================= 4. it survives bad input =================== */

check("an empty or one-bar replay draws nothing rather than throwing", () => {
  const { draw, log } = panel();
  for (const input of [[], [bars(1)[0]], null, undefined]) {
    draw(input);
  }
  if (log.length) throw new Error("drew something from no data");
  return "no data, no drawing";
});

check("bars with no prices do not produce a broken scale", () => {
  const { draw, log } = panel();
  draw(bars(30).map((b) => ({ ...b, o: 0, h: 0, l: 0, c: 0 })));
  const bad = log.filter((e) => e.args.some((a) => typeof a === "number" && !Number.isFinite(a)));
  if (bad.length) throw new Error("drew with NaN or Infinity: " + bad[0].op);
  return "degenerate input handled";
});

check("a progress update with no replay bars leaves the panel standing", () => {
  const { doc, T } = desk();
  const host = doc.getElementById("host");
  const bt = liveRun();
  delete bt.live.replay_bars;
  delete bt.live.marks;
  T.paintBacktestLive(host, bt, true);
  if (!doc.getElementById("bt-replay")) throw new Error("the panel collapsed without bars");
  return "older engine builds degrade quietly";
});

/* ======================= 5. the panel around it ===================== */

check("the bar being replayed is stamped on the chart", () => {
  const { doc, T } = desk();
  const host = doc.getElementById("host");
  const bt = liveRun();
  T.paintBacktestLive(host, bt, true);
  const stamp = doc.getElementById("bt-replay-at");
  if (!stamp) throw new Error("no bar stamp on the replay chart");
  if (stamp.textContent !== bt.live.at) {
    throw new Error("stamp says " + JSON.stringify(stamp.textContent) + ", run is at " + bt.live.at);
  }
  return stamp.textContent;
});

check("the stamp follows the run instead of freezing", () => {
  const { doc, T } = desk();
  const host = doc.getElementById("host");
  const bt = liveRun();
  T.paintBacktestLive(host, bt, true);
  const b = bars(200);
  bt.live.replay_bars = b.slice(40);
  bt.live.at = b[199].t;
  T.paintBacktestLive(host, bt, true);
  const stamp = doc.getElementById("bt-replay-at");
  if (stamp.textContent !== b[199].t) throw new Error("the stamp did not move with the replay");
  return "updates in place";
});

check("the open-trade count is reported, not just the side", () => {
  const { doc, T } = desk();
  const host = doc.getElementById("host");
  T.paintBacktestLive(host, liveRun(), true);
  const cells = [...host.querySelectorAll(".bt-kv b")].map((b) => b.textContent.trim());
  if (!cells.includes("7")) throw new Error("the trade count is missing from " + JSON.stringify(cells));
  if (!cells.some((c) => /SELL/i.test(c))) throw new Error("the open side is missing from " + JSON.stringify(cells));
  return cells.join(" / ");
});

/* ======================= 6. the stylesheet ========================== */

check("the stamp is positioned without physical sides", () => {
  const at = appCss.indexOf(".bt-replay-at");
  if (at < 0) throw new Error(".bt-replay-at has no styling");
  const block = appCss.slice(at, at + 420);
  const bad = block.match(/(?:(?:margin|padding|border|inset)-(?:left|right)|^\s*(?:top|left|right|bottom))\s*:/gm);
  if (bad) throw new Error("physical sides in an RTL desk: " + [...new Set(bad)].join(" "));
  if (!/inset-inline-start/.test(block)) throw new Error("the stamp is not placed logically");
  // Scoped to the rule bodies themselves. Slicing between two
  // selectors swept in every unrelated `position:relative` in between,
  // so the check passed even with the containing block unpositioned.
  const bodies = [...appCss.matchAll(/\.bt-live-chart\s*\{([^}]*)\}/g)].map((m) => m[1]);
  if (!bodies.length) throw new Error(".bt-live-chart has no rule");
  if (!bodies.some((b) => /position\s*:\s*relative/.test(b))) {
    throw new Error("the stamp has nothing to be positioned against");
  }
  return "logical insets only";
});

/* ------------------------------------------------------------------ */

const passed = results.filter(Boolean).length;
const failed = results.length - passed;
console.log(
  "\nbacktest-replay: " + (failed ? failed + " FAILED of " : "") +
  passed + " of " + results.length + " checks passed"
);
process.exit(failed ? 1 : 0);
