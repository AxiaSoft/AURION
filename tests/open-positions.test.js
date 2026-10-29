/**
 * Open positions, where a trader can actually see them.
 *
 * Two faults were reported:
 *
 *   1. On a phone the EA chart's floating positions panel had gone
 *      behind the drawing-tools button. Both are pinned to the
 *      bottom-start corner and the button is drawn at a far higher
 *      z-index, so a trader with money in the market saw a pencil where
 *      the running profit should have been. The fix is twofold: lift the
 *      panel clear of the button, and give the side panel a Positions
 *      tab so the full list has a home that nothing can cover.
 *
 *   2. The Markets page only ever showed the positions on the instrument
 *      currently on screen, so switching to EURUSD made three open gold
 *      trades vanish from the page. It now carries the Command Centre's
 *      table as well.
 *
 * The overlap is checked as arithmetic rather than by eye: the button's
 * box and the panel's offset are both in the stylesheet, so whether they
 * collide is a sum, and a sum is something a test can keep true.
 *
 *     node tests/open-positions.test.js
 */

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const WEB = path.join(ROOT, "apps", "web");
const read = (p) => fs.readFileSync(path.join(WEB, p), "utf8");

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

const appJs = read("js/app.js");
const toolsJs = read("js/chart-tools.js");
const chartCss = read("css/chart.css");
const appCss = read("css/app.css");

/** The body of the first rule whose selector matches, inside `scope`. */
function rule(css, selector) {
  const re = new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\{([^}]*)\\}");
  const m = re.exec(css);
  if (!m) throw new Error("no rule for " + selector);
  return m[1];
}
function decl(body, prop) {
  const m = new RegExp("(?:^|[;{\\s])" + prop + "\\s*:\\s*([^;}]+)").exec(body);
  return m ? m[1].trim() : null;
}
/** The narrow-screen block that holds the chart's mobile layout. */
function mobileBlock(css) {
  const at = css.indexOf("@media (max-width:620px)");
  if (at < 0) throw new Error("no 620px block in chart.css");
  return css.slice(at, css.indexOf("\n}", at));
}
/** px out of a calc() of plain px terms plus env() fallbacks. */
function pxOf(value) {
  const inner = /calc\(([^)]*(?:\([^)]*\)[^)]*)*)\)/.exec(value);
  const expr = inner ? inner[1] : value;
  const terms = expr.match(/(^|[+\-\s])\d+(\.\d+)?px/g) || [];
  if (!terms.length) throw new Error("no px in " + value);
  return terms.reduce((a, t) => a + (t.trim().startsWith("-") ? -1 : 1) * parseFloat(t.replace(/[^\d.]/g, "")), 0);
}

/* ============================================ 1. the phone-sized overlap */

check("the tools button and the positions panel share the bottom-start corner", () => {
  /* The premise of the whole fix. If this ever stops being true the
     arithmetic below is measuring nothing. */
  const fab = rule(chartCss, ".tv-toolsfab");
  if (!/inset-inline-start/.test(fab)) throw new Error("the tools button is no longer start-anchored");
  const pos = rule(mobileBlock(chartCss), ".tv-pos");
  if (!/inset-inline-start/.test(pos)) throw new Error("the positions panel is no longer start-anchored");
  return "both inset-inline-start";
});

check("on a phone the positions panel clears the tools button", () => {
  const fab = rule(chartCss, ".tv-toolsfab");
  const fabBottom = pxOf(decl(fab, "inset-block-end"));
  const fabH = pxOf(decl(fab, "height"));
  const fabTop = fabBottom + fabH;            // how far up the screen the button reaches

  const pos = rule(mobileBlock(chartCss), ".tv-pos");
  const posBottom = pxOf(decl(pos, "bottom") || decl(pos, "inset-block-end"));

  if (posBottom < fabTop) {
    throw new Error("the panel starts at " + posBottom + "px but the button reaches "
      + fabTop + "px, so it is drawn underneath it again");
  }
  return "panel at " + posBottom + "px, button ends at " + fabTop + "px";
});

check("the panel is not left under the button by z-index either", () => {
  /* Belt and braces: clearing it vertically is the real fix, but a
     later layout change that moves it back must not also find it
     buried. */
  const fabZ = Number(decl(rule(chartCss, ".tv-toolsfab"), "z-index"));
  const posZ = Number(decl(rule(mobileBlock(chartCss), ".tv-pos"), "z-index"));
  if (!(posZ >= fabZ)) throw new Error("positions z-index " + posZ + " is below the button's " + fabZ);
  return posZ + " >= " + fabZ;
});

check("opening the tools sheet puts the floating panel away", () => {
  const m = mobileBlock(chartCss);
  if (!/\.tv\.tools-open\s+\.tv-pos\s*\{[^}]*display:\s*none/.test(m)) {
    throw new Error("two stacked panels would share the corner while the sheet is open");
  }
  return "hidden while the sheet is open";
});

/* ================================================ 2. the side-panel tab */

check("the side panel has a Positions tab and a pane for it", () => {
  if (!/data-dock="positions"/.test(toolsJs)) throw new Error("no Positions tab");
  if (!/data-pane="positions"/.test(toolsJs)) throw new Error("no Positions pane");
  if (!/id="tvd-pos"/.test(toolsJs)) throw new Error("the pane has no id for app.js to paint into");
  return "tab + pane";
});

check("the tab is offered whether or not a ticket is open", () => {
  /* The Trade tab is conditional on o.ticket. Positions must not be:
     the whole point is seeing trades you did not open from this chart. */
  const dock = toolsJs.slice(toolsJs.indexOf("function dockHtml"), toolsJs.indexOf("function html(o)"));
  const line = dock.split("\n").find((l) => l.includes('data-dock="positions"'));
  if (!line) throw new Error("tab not found in dockHtml");
  if (/o\.ticket\s*\?/.test(line)) throw new Error("the Positions tab is behind a ticket check");
  return "unconditional";
});

check("the tab carries a count, so a shut panel still says something is open", () => {
  if (!/id="tvd-pos-n"/.test(toolsJs)) throw new Error("no badge element");
  if (!/tvd-badge/.test(chartCss)) throw new Error("the badge is unstyled");
  const fn = appJs.slice(appJs.indexOf("function paintChartPositions"), appJs.indexOf("function bindCancelButtons"));
  if (!/badge\.hidden\s*=\s*n === 0/.test(fn)) throw new Error("the badge is not hidden when nothing is open");
  return "counted and hidden at zero";
});

/* ------------------------------------------------- rendered, in a real DOM */

const { JSDOM, VirtualConsole } = require("jsdom");

function boot() {
  const vc = new VirtualConsole();
  const dom = new JSDOM(read("index.html"), {
    url: "http://localhost/", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole: vc,
  });
  const win = dom.window;
  win.fetch = async () => ({ ok: true, json: async () => ({ ok: true, data: [] }) });
  win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  win.ResizeObserver = win.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
  win.URL.createObjectURL = () => "b:";
  win.AudioContext = class { createGain() { return { connect() {}, gain: {} }; } };
  const files = ["js/themes.js", "js/skins.js", "js/i18n.js", "js/api.js", "js/calendar.js",
    "js/chart-series.js", "js/charts.js", "js/chart-tools.js", "js/pnl-charts.js", "js/app.js"];
  win.eval(files.map(read).join("\n;\n") + ";window.__T={S,views,paintChartPositions,allPositions,MK_POS_COLS};");
  return win;
}

const POS = [
  { ticket: 11, symbol: "EURUSD", type: "buy", volume: 0.2, price_open: 1.08, price_current: 1.085, sl: 1.07, tp: 1.1, profit: 12.5, profit_pct: 0.12, strategy: "trend" },
  { ticket: 12, symbol: "XAUUSD", type: "sell", volume: 0.1, price_open: 2410, price_current: 2405, sl: 2420, tp: 2390, profit: -4.2, profit_pct: -0.04, strategy: "scalp" },
];
const ORD = [{ ticket: 13, symbol: "EURUSD", type: "buy_limit", volume: 0.1, price: 1.075, sl: 1.07, tp: 1.09 }];

function withChart(fn) {
  const win = boot();
  const T = win.__T;
  T.S.snap = {
    engine: "online", ticks: { EURUSD: { bid: 1.085, ask: 1.0851 } }, agents: [],
    positions: POS, orders: ORD, license: { premium: true }, gates: [],
    mt5: { connected: true, account: { equity: 1e4, balance: 1e4, currency: "USD" } },
  };
  T.S.symbol = "EURUSD"; T.S.candles = [];
  const ws = win.document.createElement("div");
  win.document.body.appendChild(ws);
  ws.innerHTML = win.AurionChartUI.html({ symbol: "EURUSD", timeframe: "M15" });
  return fn(win, T);
}

check("the side panel lists the same trades as the chart panel", () => withChart((win, T) => {
  T.paintChartPositions(POS, ORD);
  const dock = win.document.getElementById("tvd-pos");
  const float = win.document.getElementById("tv-pos");
  const d = dock.querySelectorAll(".tv-pos-row").length;
  const f = float.querySelectorAll(".tv-pos-row").length;
  if (d !== 3) throw new Error("dock shows " + d + " rows, expected 3");
  if (d !== f) throw new Error("dock has " + d + " rows but the chart panel has " + f);
  return d + " rows in both";
}));

check("the side panel's close and cancel buttons are wired, not decorative", () => withChart((win, T) => {
  T.paintChartPositions(POS, ORD);
  const dock = win.document.getElementById("tvd-pos");
  const closes = dock.querySelectorAll("[data-close]");
  const cancels = dock.querySelectorAll("[data-cancel]");
  if (closes.length !== 2) throw new Error("expected 2 close buttons, got " + closes.length);
  if (cancels.length !== 1) throw new Error("expected 1 cancel button, got " + cancels.length);
  /* innerHTML throws handlers away with the old nodes; bindCloseButtons
     has to run again on every repaint or the control dies at the first
     snapshot. */
  if (typeof closes[0].onclick !== "function") throw new Error("the close button has no handler");
  if (typeof cancels[0].onclick !== "function") throw new Error("the cancel button has no handler");
  return "2 closes, 1 cancel, all bound";
}));

check("an empty book empties both, and a refill fills both again", () => withChart((win, T) => {
  T.paintChartPositions(POS, ORD);
  T.paintChartPositions([], []);
  const dock = win.document.getElementById("tvd-pos");
  const float = win.document.getElementById("tv-pos");
  const badge = win.document.getElementById("tvd-pos-n");
  if (!float.hidden) throw new Error("the floating panel stayed on an empty book");
  if (!badge.hidden) throw new Error("the badge stayed on an empty book");
  if (!dock.textContent.trim()) throw new Error("the side panel went blank instead of saying so");
  if (dock.querySelector(".tv-pos-row")) throw new Error("the side panel kept its rows");

  /* The repaint is signature-gated. Going empty and back must not leave
     a stale signature that swallows the redraw. */
  T.paintChartPositions(POS, ORD);
  const d = dock.querySelectorAll(".tv-pos-row").length;
  if (d !== 3) throw new Error("after refilling, the side panel shows " + d + " rows");
  if (float.hidden) throw new Error("the floating panel stayed hidden after refilling");
  if (badge.hidden || badge.textContent !== "3") throw new Error("badge reads '" + badge.textContent + "'");
  return "emptied and refilled";
}));

check("the count is positions plus resting orders", () => withChart((win, T) => {
  T.paintChartPositions(POS, ORD);
  const badge = win.document.getElementById("tvd-pos-n");
  if (badge.textContent !== "3") throw new Error("badge reads " + badge.textContent + ", expected 3");
  T.paintChartPositions(POS, []);
  if (badge.textContent !== "2") throw new Error("without orders the badge reads " + badge.textContent);
  return "2 + 1 = 3";
}));

/* ==================================== 3. the Markets page's own position list */

check("the Markets page shows the open book, not just the chart's instrument", () => {
  const win = boot();
  const T = win.__T;
  T.S.snap = {
    engine: "online", ticks: { EURUSD: { bid: 1.085, ask: 1.0851 } }, agents: [],
    positions: POS, orders: [], license: { premium: true }, gates: [],
    mt5: { connected: true, account: { equity: 1e4, balance: 1e4, currency: "USD" } },
  };
  T.S.symbol = "EURUSD"; T.S.candles = [];
  const host = win.document.createElement("div");
  win.document.body.appendChild(host);
  host.innerHTML = T.views.markets();

  const card = host.querySelector(".mk-pos");
  if (!card) throw new Error("no positions card on the Markets page");
  const rows = card.querySelectorAll("tbody tr");
  if (rows.length !== 2) throw new Error("expected both trades, got " + rows.length);
  const syms = [...card.querySelectorAll("td[data-k=symbol]")].map((t) => t.textContent).sort();
  if (syms.join(",") !== "EURUSD,XAUUSD") {
    throw new Error("the card is filtered to the chart's symbol: " + syms.join(","));
  }
  if (!card.querySelector("[data-close]")) throw new Error("the positions cannot be closed from here");
  return "both instruments listed";
});

check("the per-symbol strip above the chart is left alone", () => {
  /* The strip answers "what am I holding in this instrument" and is
     still the right thing directly above its chart. The new card is an
     addition, not a replacement. */
  const view = appJs.slice(appJs.indexOf("  markets() {"), appJs.indexOf("  intelligence() {"));
  if (!/positionsStripHtml\(S\.symbol\)/.test(view)) throw new Error("the per-symbol strip was removed");
  if (!/class="card pos-card mk-pos"/.test(view)) throw new Error("the new card is missing");
  return "both present";
});

check("the Markets table is patched live, like the Command Centre's", () => {
  const block = appJs.slice(appJs.indexOf('if (v === "markets")'), appJs.indexOf('if (v === "intelligence")'));
  if (!/paintPositions\("mk-pos"/.test(block)) throw new Error("the table is never repainted on a snapshot");
  if (!/allPositions\(\)/.test(block)) throw new Error("the repaint is not fed every position");
  /* Rebuilding the card wholesale would tear down the table under the
     trader; paintPositions updates cells in place. */
  if (/\$\("mk-pos"\)\.innerHTML/.test(block)) throw new Error("the card is rebuilt rather than patched");
  return "paintPositions on every snapshot";
});

check("the Markets card uses the full width of the grid", () => {
  const body = rule(appCss, ".mk-pos");
  if (!/grid-column:\s*1\s*\/\s*-1/.test(body)) throw new Error(".mk-pos does not span both columns");
  return "grid-column: 1 / -1";
});

check("both position lists are translated in all three languages", () => {
  for (const lang of ["en", "fa", "ar"]) {
    const pack = JSON.parse(fs.readFileSync(path.join(ROOT, "lang", lang + ".json"), "utf8"));
    for (const key of ["chart.positions", "command.positions", "status.no_positions"]) {
      const v = key.split(".").reduce((o, k) => (o || {})[k], pack);
      if (!v) throw new Error("missing " + key + " in " + lang);
    }
  }
  return "3 keys x 3 languages";
});

check("exactly one tab is selected, and the phone leads with positions", () => {
  /* A tab strip whose first tab is not the active one reads as broken.
     Whichever tab leads, precisely one must be marked. */
  const dock = toolsJs.slice(toolsJs.indexOf("function dockHtml"), toolsJs.indexOf("function html(o)"));
  if (!/const first = narrow\(\) \? "positions" : "objects"/.test(dock)) {
    throw new Error("the default tab is not chosen by screen width");
  }
  /* And the pane that is shown must be the tab that is marked, or the
     panel opens on a highlighted tab showing someone else's content. */
  if (!/data-pane="positions"\$\{first === "positions" \? "" : " hidden"\}/.test(dock)) {
    throw new Error("the positions pane's hidden state is not tied to the default tab");
  }
  if (!/data-pane="objects"\$\{first === "objects" \? "" : " hidden"\}/.test(dock)) {
    throw new Error("the objects pane's hidden state is not tied to the default tab");
  }
  return "narrow -> positions, wide -> objects";
});

check("on a phone the side panel opens on the trades, with one pane showing", () => {
  const win = boot();
  /* narrow() asks matchMedia; the harness answers for a phone. */
  win.matchMedia = (q) => ({ matches: /max-width:\s*980px/.test(q), addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  const ws = win.document.createElement("div");
  win.document.body.appendChild(ws);
  ws.innerHTML = win.AurionChartUI.html({ symbol: "EURUSD", timeframe: "M15" });
  const marked = [...win.document.querySelectorAll("[data-dock].on")];
  if (marked.length !== 1) throw new Error(marked.length + " tabs are marked selected");
  if (marked[0].dataset.dock !== "positions") throw new Error("the phone opens on " + marked[0].dataset.dock);
  const shown = [...win.document.querySelectorAll(".tvd-body")].filter((p) => !p.hidden);
  if (shown.length !== 1) throw new Error(shown.length + " panes are visible at once");
  if (shown[0].dataset.pane !== "positions") throw new Error("the visible pane is " + shown[0].dataset.pane);
  return "positions tab marked, positions pane shown";
});

/* ------------------------------------------------------------------ result */

const failed = results.filter((x) => !x).length;
console.log("\nopen-positions: " + (failed ? failed + " FAILED of " : results.length + " of ") + results.length + " checks passed");
process.exit(failed ? 1 : 0);
