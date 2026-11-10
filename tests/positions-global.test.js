/**
 * The EA chart's position dock shows the whole account, not one symbol.
 *
 *     node tests/positions-global.test.js
 *
 * Reported: "if a position is open on EURUSD it should not only be
 * shown on the EURUSD chart - when I switch to gold it should be there
 * too; positions must be shown generally so they can be controlled."
 *
 * The dock was filtered with the same expression that filters the
 * chart's lines, so switching the chart to gold made a live EURUSD
 * position vanish from the desk entirely: open, costing money, with no
 * row and no close button anywhere on the page being looked at. The
 * flatten button underneath it closed the whole account the whole
 * time, standing over a list that showed part of it.
 *
 * The split now: LINES stay filtered, because a stop at 1.09500 is not
 * a price that exists on a gold axis and drawing it there would be
 * nonsense. The LIST is the whole book, this chart's symbol first, with
 * the rest marked and tappable to take the chart to them.
 *
 * Run for real. The three functions are pulled out of app.js and
 * executed in JSDOM against a fake book, and the rows are read back out
 * of the DOM - a source grep would not notice the filter coming back
 * one call upstream.
 */

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

let jsdom = null;
try { jsdom = require("jsdom"); } catch { /* optional */ }
if (!jsdom) { console.log("SKIP  positions-global (jsdom not installed)"); process.exit(0); }
const { JSDOM } = jsdom;

const ROOT = path.resolve(__dirname, "..");
const APP = fs.readFileSync(path.join(ROOT, "apps/web/js/app.js"), "utf8");
const CSS = fs.readFileSync(path.join(ROOT, "apps/web/css/chart.css"), "utf8");

let pass = 0;
const failures = [];
const check = (name, fn) => {
  try {
    const note = fn();
    pass++;
    console.log("ok   " + name + (note ? "  \u2014 " + note : ""));
  } catch (e) {
    failures.push(name);
    console.log("  x  " + name + "  \u2014 " + e.message);
  }
};
const must = (c, m) => { if (!c) throw new Error(m); };

/* ------------------------------------------------------- the rig ---- */

const grab = (from, to) => {
  const i = APP.indexOf(from);
  const j = APP.indexOf(to, i);
  if (i < 0 || j < 0) throw new Error("cannot slice app.js at: " + from);
  return APP.slice(i, j);
};

function build() {
  const dom = new JSDOM(`<!doctype html><html><body>
    <button id="tv-pos-toggle" title="Open positions"><span id="tv-pos-toggle-n"></span></button>
    <span id="tv-posdock-n"></span><span id="tv-posdock-sum"></span>
    <button id="tv-posdock-flat"></button>
    <div id="tv-posdock-body"></div></body></html>`, { url: "http://desk.test/" });
  const w = dom.window, d = w.document;
  const jumped = [];
  const ctx = {
    document: d, window: w,
    $: (id) => d.getElementById(id),
    esc: (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;"),
    fmt: (n, p = 2) => Number(n).toFixed(p),
    price: (n) => Number(n).toFixed(2),
    clsPnl: (v) => (Number(v) >= 0 ? "up" : "down"),
    icon: () => "<svg></svg>",
    strategyLabel: (s) => s || "",
    I18N: { t: (k) => String(k).split(".").pop() },
    bindCloseButtons: () => {},
    bindCancelButtons: () => {},
    flattenAll: async () => {},
    openChartDesk: (sym, tf) => jumped.push([sym, tf]),
    S: { chartFocus: { symbol: "XAUUSD", timeframe: "M15" }, timeframe: "M15" },
  };
  vm.createContext(ctx);
  vm.runInContext(
    grab("function positionsListHtml(pos, ord, focus) {", "function applyChartLevels(force) {")
    + grab("function paintChartPositions(pos, ord, focus) {", "/**\n * Tap a row for another symbol")
    + grab("function bindRowJump(root) {", "/** Cancel a resting order"),
    ctx,
  );
  return { w, d, ctx, jumped };
}

const POS = [
  { ticket: 1, symbol: "EURUSD", type: "buy", volume: 0.01, price_open: 1.1, sl: 1.09, tp: 1.12, profit: 3.2 },
  { ticket: 2, symbol: "XAUUSD", type: "sell", volume: 0.02, price_open: 2400, sl: 2410, tp: 2380, profit: -5.5 },
  { ticket: 3, symbol: "GBPUSD", type: "buy", volume: 0.03, price_open: 1.27, sl: 0, tp: 0, profit: 1.1 },
];
const ORD = [{ ticket: 9, symbol: "USDJPY", type: "buy_limit", volume: 0.01, price: 150, sl: 0, tp: 0 }];

/* paintChartPositions and nothing else. The row jump is deliberately
   NOT called by hand here: binding it is the renderer's job, and a rig
   that did it itself would pass just as happily with the call removed
   from app.js. */
const paint = (rig, focus, pos = POS, ord = ORD) => {
  rig.ctx.paintChartPositions(pos, ord, focus);
  return [...rig.d.querySelectorAll(".tvp-row:not(.tvp-head)")];
};
const syms = (rows) => rows.map((r) => r.dataset.sym);

/* ------------------------------------------------- what is listed ---- */

check("a gold chart still lists the EURUSD position", () => {
  const rows = paint(build(), "XAUUSD");
  must(syms(rows).includes("EURUSD"),
    "the position vanished with the chart - this is the reported fault");
  must(rows.length === POS.length + ORD.length,
    `the whole book must be there: ${rows.length} of ${POS.length + ORD.length}`);
  return syms(rows).join(" ");
});

check("every position keeps a working close button, whatever chart is open", () => {
  const rig = build();
  paint(rig, "XAUUSD");
  must(rig.d.querySelectorAll("[data-close]").length === POS.length,
    "a position with no close button cannot be controlled from here");
  must(rig.d.querySelectorAll("[data-cancel]").length === ORD.length,
    "a resting order carries a cancel, not a close");
  return POS.length + " close, " + ORD.length + " cancel";
});

check("the counters and the floating total cover the whole account", () => {
  const rig = build();
  paint(rig, "XAUUSD");
  must(rig.d.getElementById("tv-pos-toggle-n").textContent === "4", "the toolbar chip undercounts");
  must(rig.d.getElementById("tv-posdock-n").textContent === "4", "the dock header undercounts");
  /* 3.2 - 5.5 + 1.1. A per-symbol total on a dock listing every symbol
     would be the most misleading number on the screen. */
  must(rig.d.getElementById("tv-posdock-sum").textContent === "-1.20",
    "the total is not the account's: " + rig.d.getElementById("tv-posdock-sum").textContent);
  return "4 / 4 / -1.20";
});

/* --------------------------------------------- which ones are here --- */

check("the chart's own symbol comes first and is not marked as elsewhere", () => {
  const rows = paint(build(), "XAUUSD");
  const pos = rows.filter((r) => !r.classList.contains("is-resting"));
  must(pos[0].dataset.sym === "XAUUSD", "the chart's own trade is not at the top: " + syms(pos));
  must(!pos[0].classList.contains("is-away"), "the row with a line on this chart is marked as away");
  return syms(pos).join(" -> ");
});

check("rows for other symbols say so", () => {
  const rows = paint(build(), "XAUUSD");
  const away = rows.filter((r) => r.classList.contains("is-away")).map((r) => r.dataset.sym);
  must(away.sort().join(",") === "EURUSD,GBPUSD,USDJPY",
    "a row with no line on this chart looks identical to one with a line: " + away);
  return away.join(" ");
});

check("switching the chart re-orders and re-marks the same book", () => {
  const rig = build();
  paint(rig, "XAUUSD");
  const rows = paint(rig, "GBPUSD");
  const pos = rows.filter((r) => !r.classList.contains("is-resting"));
  must(pos[0].dataset.sym === "GBPUSD",
    "the list still describes the chart before last - the signature ignores the symbol");
  must(rows.find((r) => r.dataset.sym === "XAUUSD").classList.contains("is-away"),
    "the previous chart's row is still marked as being here");
  return syms(pos).join(" -> ");
});

/* --------------------------------------------------- getting there --- */

check("tapping a row for another symbol takes the chart to it", () => {
  const rig = build();
  const rows = paint(rig, "XAUUSD");
  rows.find((r) => r.dataset.sym === "EURUSD")
    .dispatchEvent(new rig.w.MouseEvent("click", { bubbles: true }));
  must(rig.jumped.length === 1 && rig.jumped[0][0] === "EURUSD",
    "a stop is dragged on the chart, not in a table: " + JSON.stringify(rig.jumped));
  must(rig.jumped[0][1] === "M15", "the timeframe was not carried over");
  return "openChartDesk(EURUSD, M15)";
});

check("...but closing a trade does not navigate away from the confirmation", () => {
  const rig = build();
  const rows = paint(rig, "XAUUSD");
  rows.find((r) => r.dataset.sym === "EURUSD").querySelector("button")
    .dispatchEvent(new rig.w.MouseEvent("click", { bubbles: true }));
  must(rig.jumped.length === 0, "the close button's click bubbled into the row jump");
  return "no jump";
});

check("...and a row for the chart you are already on is not a dead tap", () => {
  const rig = build();
  const rows = paint(rig, "XAUUSD");
  const own = rows.find((r) => r.dataset.sym === "XAUUSD");
  own.dispatchEvent(new rig.w.MouseEvent("click", { bubbles: true }));
  must(rig.jumped.length === 0, "it navigated to where it already was");
  must(own.getAttribute("role") !== "button", "it advertises itself as a button and does nothing");
  return "not clickable";
});

check("a jumpable row is reachable from the keyboard", () => {
  const rig = build();
  const rows = paint(rig, "XAUUSD");
  const row = rows.find((r) => r.dataset.sym === "GBPUSD");
  must(row.getAttribute("role") === "button" && row.getAttribute("tabindex") === "0",
    "it can only be used with a pointer");
  row.dispatchEvent(new rig.w.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  must(rig.jumped.length === 1 && rig.jumped[0][0] === "GBPUSD", "Enter does nothing");
  return "role + tabindex + Enter";
});

/* ------------------------------------------------------- the lines --- */

check("the chart's LINES are still filtered to the chart's symbol", () => {
  const fn = APP.slice(APP.indexOf("function applyChartLevels(force) {"));
  const body = fn.slice(0, fn.indexOf("\n}"));
  must(/setLevels\(pos\)/.test(body) && /setOrders\(ord\)/.test(body),
    "the lines are no longer drawn from the filtered list");
  must(/const onChart = \(rows\) =>/.test(body) && /r\.symbol === symbol/.test(body),
    "nothing filters them any more - a 1.09500 stop would be drawn on a gold axis");
  must(/paintChartPositions\(allPos, allOrd, symbol\)/.test(body),
    "the panel is not handed the whole book");
  return "lines filtered, list whole";
});

check("nothing else lost its list", () => {
  /* positionsListHtml is shared with the live cards and the positions
     card, which pass two arguments and must keep getting exactly what
     they got before. */
  const rig = build();
  const html = rig.ctx.positionsListHtml(POS, []);
  must((html.match(/class="tvp-row is-/g) || []).length === POS.length, "rows went missing");
  must(!/is-away/.test(html), "a caller that names no chart got rows marked as elsewhere");
  return "two-argument callers unchanged";
});

/* ------------------------------------------------------------ css --- */

check("a trade on another symbol is marked, never dimmed", () => {
  const i = CSS.indexOf(".tvp-row.is-away{");
  must(i > 0, "there is no style for it at all");
  const block = CSS.slice(i, CSS.indexOf("\n.tvp-head", i));
  must(!/opacity/.test(block), "real money was faded out for being on another chart");
  must(!/--faint/.test(block), "--faint measures about 3.5:1 and these are figures to read");
  must(/border-inline-start-style:dotted/.test(block), "nothing distinguishes it from a row with a line");
  must(/:focus-visible/.test(block), "a keyboard user cannot see which row is focused");
  return "dotted edge + accent symbol";
});

/* --------------------------------------------------------------------- */

if (failures.length) {
  console.log("\npositions-global: " + failures.length + " FAILED of " + (pass + failures.length));
  process.exit(1);
}
console.log("\npositions-global: " + pass + " checks passed");
