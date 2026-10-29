/**
 * Searching for an instrument, everywhere one is chosen.
 *
 * Two asks:
 *
 *   1. Every place that picks a symbol should let you search for it, the
 *      way the markets toolbar already does. Two were left on a native
 *      <select> -- the order ticket and the backtest -- which is fine
 *      with three charts attached and unusable with thirty.
 *
 *   2. The EA chart grid should be searchable, with the match brought up
 *      so it can be tapped to open.
 *
 * The risky part of (1) is not the widget, it is that the old <select>
 * was read as `$("ex-sym").value` and listened to for `change` in half a
 * dozen places, including the path that actually sends an order. A
 * replacement that looks right but reports the wrong instrument is worse
 * than the <select> was, so those are driven through real events here
 * rather than inspected.
 *
 *     node tests/symbol-search.test.js
 */

const fs = require("node:fs");
const path = require("node:path");
const { JSDOM, VirtualConsole } = require("jsdom");

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
const appCss = read("css/app.css");

const SYMS = ["EURUSD", "GBPUSD", "XAUUSD", "US500", "BTCUSD", "EURJPY"];

function boot() {
  const dom = new JSDOM(read("index.html"), {
    url: "http://localhost/", runScripts: "outside-only",
    pretendToBeVisual: true, virtualConsole: new VirtualConsole(),
  });
  const win = dom.window;
  win.fetch = async () => ({ ok: true, json: async () => ({ ok: true, data: [] }) });
  win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  win.ResizeObserver = win.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
  win.URL.createObjectURL = () => "b:";
  win.AudioContext = class { createGain() { return { connect() {}, gain: {} }; } };
  const files = ["js/themes.js", "js/skins.js", "js/i18n.js", "js/api.js", "js/calendar.js",
    "js/chart-series.js", "js/charts.js", "js/chart-tools.js", "js/pnl-charts.js", "js/app.js"];
  win.eval(files.map(read).join("\n;\n")
    + ";window.__T={S,views,symbolFieldHtml,bindSymbolField,fillSymbolField,"
    + "applyChartSearch,bindChartSearch,symbolScore,symbolQuery,searchSymbols};");
  const T = win.__T;
  T.S.snap = {
    engine: "online", ticks: {}, license: { premium: true }, gates: [], positions: [], orders: [],
    mt5: { connected: true, account: { equity: 1e4, currency: "USD" } },
    agents: SYMS.map((s, i) => ({ symbol: s, timeframe: "M15", alive: true, online: true, chart_id: i, last_seen: Date.now(), ea_name: "AurionBridge" })),
  };
  T.S.symbol = "EURUSD"; T.S.candles = [];
  return { win, T };
}

const click = (win, el) => el.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
const type = (win, el, v) => { el.value = v; el.dispatchEvent(new win.Event("input", { bubbles: true })); };
const key = (win, el, k) => el.dispatchEvent(new win.KeyboardEvent("keydown", { key: k, bubbles: true }));

/** A mounted, bound symbol field. */
function field(id = "ex-sym", selected = "GBPUSD") {
  const { win, T } = boot();
  const host = win.document.createElement("div");
  win.document.body.appendChild(host);
  host.innerHTML = T.symbolFieldHtml(id, selected);
  T.bindSymbolField(id);
  return { win, T, hidden: win.document.getElementById(id) };
}

/* ================================================ 1. the searchable field */

check("every place that picks one instrument now offers a search", () => {
  /* The markets toolbar and the prop-risk list already had one; these
     two were the stragglers. A <select> left anywhere here means the
     ask was only half done. */
  for (const [id, where] of [["ex-sym", "the order ticket"], ["bt-sym", "the backtest"]]) {
    const re = new RegExp("symbolFieldHtml\\(\"" + id + "\"");
    if (!re.test(appJs)) throw new Error(where + " does not use the searchable field");
  }
  if (/symbolSelectHtml/.test(appJs)) throw new Error("the old <select> builder is still in the file");
  return "ex-sym and bt-sym";
});

check("the field keeps a value readable as .value, as the <select> was", () => {
  /* Six call sites read $("ex-sym").value, one of which sends the
     order. A combobox that does not answer .value would send on the
     wrong instrument, silently. */
  const { win, hidden } = field();
  if (!hidden) throw new Error("no element under the old id");
  if (hidden.tagName !== "INPUT") throw new Error("id is on a " + hidden.tagName);
  if (hidden.value !== "GBPUSD") throw new Error("value is " + JSON.stringify(hidden.value));
  if (hidden.type !== "hidden") throw new Error("the value carrier is visible");
  return "hidden input, value GBPUSD";
});

check("picking fires a real change event, so the old listeners still run", () => {
  /* rememberManual and the S.symbol sync both listen for change. */
  const { win, hidden } = field();
  let fired = 0, seen = null;
  hidden.addEventListener("change", () => { fired += 1; seen = hidden.value; });
  click(win, win.document.getElementById("ex-sym-pick-btn"));
  type(win, win.document.getElementById("ex-sym-pick-q"), "xau");
  click(win, win.document.querySelector('#ex-sym-pick-list [data-sym="XAUUSD"]'));
  if (fired !== 1) throw new Error("change fired " + fired + " times");
  if (seen !== "XAUUSD") throw new Error("listener saw " + seen);
  if (hidden.value !== "XAUUSD") throw new Error("value is " + hidden.value);
  return "1 change, XAUUSD";
});

check("typing filters the list and the chosen name reaches the button", () => {
  const { win, hidden } = field();
  click(win, win.document.getElementById("ex-sym-pick-btn"));
  type(win, win.document.getElementById("ex-sym-pick-q"), "xau");
  const rows = [...win.document.querySelectorAll("#ex-sym-pick-list .sympick-row")].map((r) => r.dataset.sym);
  if (rows.join(",") !== "XAUUSD") throw new Error("'xau' matched " + rows.join(","));
  click(win, win.document.querySelector('#ex-sym-pick-list [data-sym="XAUUSD"]'));
  const label = win.document.querySelector("#ex-sym-pick .sympick-cur").textContent;
  if (label !== "XAUUSD") throw new Error("the button still reads " + label);
  if (!win.document.getElementById("ex-sym-pick-pop").hidden) throw new Error("the popup stayed open");
  return "filtered, chosen, closed";
});

check("the field tracks its own value, not the desk's current symbol", () => {
  /* The backtest and the ticket are forms: choosing an instrument to
     test must not be the same act as changing the chart on screen. */
  const { win, T, hidden } = field("bt-sym", "GBPUSD");
  T.S.symbol = "EURUSD";
  click(win, win.document.getElementById("bt-sym-pick-btn"));
  const marked = [...win.document.querySelectorAll("#bt-sym-pick-list .sympick-row.on")].map((r) => r.dataset.sym);
  if (marked.join(",") !== "GBPUSD") {
    throw new Error("the list marks " + (marked.join(",") || "nothing") + ", not the field's own GBPUSD");
  }
  return "marks GBPUSD while S.symbol is EURUSD";
});

check("a field whose instrument disappears falls back to a real one", () => {
  /* Otherwise an order could be sent on a symbol the terminal has
     stopped reporting. */
  const { win, T, hidden } = field("ex-sym", "XAUUSD");
  if (hidden.value !== "XAUUSD") throw new Error("setup: " + hidden.value);
  T.S.snap.agents = T.S.snap.agents.filter((a) => a.symbol !== "XAUUSD");
  T.fillSymbolField("ex-sym", "EURUSD");
  if (hidden.value === "XAUUSD") throw new Error("the field still points at a detached chart");
  if (!SYMS.includes(hidden.value)) throw new Error("fell back to " + JSON.stringify(hidden.value));
  const label = win.document.querySelector("#ex-sym-pick .sympick-cur").textContent;
  if (label !== hidden.value) throw new Error("the button reads " + label + " but the value is " + hidden.value);
  return "fell back to " + hidden.value;
});

check("with no charts attached the field says so and holds no value", () => {
  const { win, T } = boot();
  T.S.snap.agents = [];
  const host = win.document.createElement("div");
  win.document.body.appendChild(host);
  host.innerHTML = T.symbolFieldHtml("ex-sym", "");
  const hidden = win.document.getElementById("ex-sym");
  if (hidden.value !== "") throw new Error("value is " + JSON.stringify(hidden.value));
  if (!win.document.getElementById("ex-sym-pick").classList.contains("is-empty")) {
    throw new Error("the field is not marked empty");
  }
  if (!win.document.getElementById("ex-sym-pick-btn").disabled) throw new Error("the button is still live");
  return "empty and disabled";
});

check("both fields are bound when their view mounts", () => {
  /* Rendered but unbound would look right and do nothing: the button
     would not open. Scoped to the mount block for that view, because
     the binding has to run when the view appears and not merely exist
     somewhere in the file. */
  for (const [id, view] of [["ex-sym", "execution"], ["bt-sym", "backtest"]]) {
    const marker = `if (view === "${view}") {`;
    const at = appJs.indexOf(marker);
    if (at < 0) throw new Error("could not find the mount block for " + view);
    const rest = appJs.slice(at + marker.length);
    const nextAt = rest.indexOf('\n  if (view === "');
    const block = nextAt < 0 ? rest : rest.slice(0, nextAt);
    if (!block.includes(`bindSymbolField("${id}")`)) {
      throw new Error(id + " is rendered but never bound in the " + view + " mount, so it would not open");
    }
  }
  return "execution and backtest";
});

/* ============================================= 2. the EA chart grid search */

function grid() {
  const { win, T } = boot();
  T.S.view = "charts"; T.S.chartFocus = null; T.S.chartQuery = "";
  const stage = win.document.createElement("div");
  stage.id = "stage";
  win.document.body.appendChild(stage);
  stage.innerHTML = T.views.charts();
  T.bindChartSearch();
  return { win, T, stage, input: win.document.getElementById("ch-q") };
}
/** Visible cards, in the order the grid will lay them out. */
function visible(stage) {
  return [...stage.querySelectorAll(".chart-card")]
    .filter((c) => !c.hidden)
    .sort((a, b) => Number(a.style.order || 0) - Number(b.style.order || 0))
    .map((c) => c.dataset.sym);
}

check("the EA chart page has a search over the attached charts", () => {
  const { stage, input } = grid();
  if (!input) throw new Error("no search box");
  if (stage.querySelectorAll(".chart-card").length !== SYMS.length) {
    throw new Error("expected " + SYMS.length + " cards");
  }
  return SYMS.length + " charts, one box";
});

check("searching brings the match to the top rather than only hiding others", () => {
  /* "that chart comes up and I click it" -- the point is that the match
     is the first thing under the box, not merely that the rest went.
     Hiding alone would satisfy a weaker test, so this uses a query
     where several cards match at different strengths and the best one
     is NOT first in the DOM: only real reordering can float it up.

     Of EURUSD GBPUSD XAUUSD US500 BTCUSD EURJPY, "us" starts US500 but
     merely occurs inside the four ...USD pairs. US500 is fourth in the
     grid and must come out first. */
  const { win, stage, input } = grid();
  type(win, input, "us");

  const matched = [...stage.querySelectorAll(".chart-card")].filter((c) => !c.hidden);
  if (matched.length !== 5) throw new Error("'us' matched " + matched.map((c) => c.dataset.sym).join(","));

  const domFirst = matched[0].dataset.sym;
  if (domFirst === "US500") throw new Error("the fixture no longer proves anything: US500 is already first in the DOM");

  const laidOut = visible(stage);
  if (laidOut[0] !== "US500") {
    throw new Error("the best match is laid out at position " + (laidOut.indexOf("US500") + 1)
      + " (" + laidOut.join(" ") + "); hiding the misses is not the same as bringing it up");
  }
  const best = Number(stage.querySelector('[data-sym="US500"]').style.order);
  const rest = matched.filter((c) => c.dataset.sym !== "US500").map((c) => Number(c.style.order));
  if (!rest.every((o) => o > best)) {
    throw new Error("US500 ranks " + best + " but the others rank " + rest.join(",") + " — nothing was reordered");
  }

  /* And a single exact hit still lands on its own. */
  type(win, input, "xau");
  const one = visible(stage);
  if (one.length !== 1 || one[0] !== "XAUUSD") throw new Error("'xau' gave " + one.join(","));
  return "US500 floated from 4th to 1st; 'xau' isolates one";
});

check("the cards are reordered, never re-rendered", () => {
  /* Each card holds a live canvas. Rebuilding the grid on a keystroke
     would tear them all down and repaint from nothing. */
  const { win, stage, input } = grid();
  const before = stage.querySelector('.chart-card[data-sym="XAUUSD"]');
  const canvasBefore = before.querySelector("canvas");
  type(win, input, "xau");
  type(win, input, "eur");
  type(win, input, "");
  const after = stage.querySelector('.chart-card[data-sym="XAUUSD"]');
  if (after !== before) throw new Error("the card was replaced");
  if (after.querySelector("canvas") !== canvasBefore) throw new Error("the canvas was replaced");

  const fn = appJs.slice(appJs.indexOf("function applyChartSearch"), appJs.indexOf("function bindChartSearch"));
  if (/innerHTML/.test(fn)) throw new Error("applyChartSearch writes innerHTML");
  return "same nodes, same canvas";
});

check("a search that matches nothing says so instead of showing an empty page", () => {
  const { win, stage, input } = grid();
  type(win, input, "zzzz");
  if (visible(stage).length) throw new Error("something matched 'zzzz'");
  const none = win.document.getElementById("ch-none");
  if (!none || none.hidden) throw new Error("no 'nothing matched' message");
  type(win, input, "eur");
  if (!win.document.getElementById("ch-none").hidden) throw new Error("the message stayed after a match");
  return "message shown, then withdrawn";
});

check("the box reports how many of the charts matched", () => {
  const { win, input } = grid();
  type(win, input, "eur");
  const n = win.document.getElementById("ch-q-n").textContent;
  if (n !== "2/6") throw new Error("count reads " + JSON.stringify(n));
  type(win, input, "");
  if (win.document.getElementById("ch-q-n").textContent !== "") throw new Error("the count lingers when empty");
  return "2/6";
});

check("Enter opens the top match, so the search need not end in a tap", () => {
  const { win, stage, input } = grid();
  let opened = null;
  stage.querySelectorAll("[data-open-chart]").forEach((el) => { el.onclick = () => { opened = el.dataset.sym; }; });
  type(win, input, "xau");
  key(win, input, "Enter");
  if (opened !== "XAUUSD") throw new Error("Enter opened " + opened);
  return "XAUUSD";
});

check("Escape and the clear button both put the whole grid back", () => {
  const { win, stage, input } = grid();
  type(win, input, "xau");
  key(win, input, "Escape");
  if (input.value !== "") throw new Error("Escape left " + JSON.stringify(input.value));
  if (visible(stage).length !== SYMS.length) throw new Error("only " + visible(stage).length + " came back");

  type(win, input, "btc");
  const clear = win.document.getElementById("ch-q-clear");
  if (clear.hidden) throw new Error("the clear button is hidden while there is a query");
  click(win, clear);
  if (input.value !== "") throw new Error("the clear button left " + JSON.stringify(input.value));
  if (!win.document.getElementById("ch-q-clear").hidden) throw new Error("the clear button stayed after clearing");
  return "both restore all " + SYMS.length;
});

check("a search survives the repaint a snapshot causes", () => {
  /* patchLive re-renders the view; a query held only in the input would
     be wiped out mid-typing every time the engine reported in. */
  const { win, T, input } = grid();
  type(win, input, "btc");
  if (T.S.chartQuery !== "btc") throw new Error("the query is not kept on S");
  const re = /value="\$\{esc\(S\.chartQuery \|\| ""\)\}"/;
  if (!re.test(appJs)) throw new Error("the view does not render the remembered query back into the box");
  return "kept on S.chartQuery";
});

check("one search box, and only when there is more than one chart", () => {
  const { win, T } = boot();
  T.S.snap.agents = [T.S.snap.agents[0]];
  T.S.view = "charts"; T.S.chartFocus = null;
  const stage = win.document.createElement("div");
  win.document.body.appendChild(stage);
  stage.innerHTML = T.views.charts();
  if (stage.querySelector("#ch-q")) throw new Error("a search box over a single chart is clutter");
  return "hidden for one chart";
});

/* ------------------------------------------------------- shared behaviour */

check("the grid and the picker rank a query the same way", () => {
  /* Two scoring functions would eventually disagree about what "EUR"
     finds, which is the sort of difference nobody reports and everybody
     notices. */
  const { T } = boot();
  if (!/function symbolScore\(/.test(appJs)) throw new Error("no shared scorer");
  const fn = appJs.slice(appJs.indexOf("function searchSymbols"), appJs.indexOf("function symbolPickerHtml"));
  if (!/symbolScore\(/.test(fn)) throw new Error("the picker does not use the shared scorer");
  const grid = appJs.slice(appJs.indexOf("function applyChartSearch"), appJs.indexOf("function bindChartSearch"));
  if (!/symbolScore\(/.test(grid)) throw new Error("the grid does not use the shared scorer");
  /* And it is punctuation-blind, so eur/usd finds EURUSD. */
  if (T.symbolScore("EURUSD", "", T.symbolQuery("eur/usd")) !== 0) {
    throw new Error("eur/usd does not match EURUSD exactly");
  }
  if (T.symbolScore("GBPUSD", "", T.symbolQuery("eur")) !== -1) throw new Error("'eur' matched GBPUSD");
  return "one scorer, punctuation-blind";
});

check("the search chrome is styled and has narrow-screen rules", () => {
  // The box no longer carries chrome of its own: every search on the desk
  // is the shared .dsk-search shell, and .ch-find* only places it in the
  // row. So the shell is what has to be styled, plus the layout classes.
  for (const sel of [".ch-find", ".ch-find-box", ".dsk-search", ".dsk-search-i",
                     ".dsk-search-x", ".chart-card[hidden]"]) {
    if (!appCss.includes(sel)) throw new Error("no rule for " + sel);
  }
  if (!/\.dsk-search:focus-within\{/.test(appCss)) {
    throw new Error("the shell draws no focus ring, so the input would show its own");
  }
  const at = appCss.indexOf(".ch-find{");
  const narrow = appCss.slice(at).indexOf("@media (max-width:620px)");
  if (narrow < 0) throw new Error("the search box has no phone rules");
  if (!/\.chart-card\[hidden\]\{\s*display:none/.test(appCss)) {
    throw new Error("hidden cards would still occupy a grid cell");
  }
  return "styled, with a 620px block";
});

check("the search is translated in all three languages", () => {
  for (const lang of ["en", "fa", "ar"]) {
    const pack = JSON.parse(fs.readFileSync(path.join(ROOT, "lang", lang + ".json"), "utf8"));
    for (const k of ["charts.search", "markets.search_sym", "markets.no_sym_match"]) {
      const v = k.split(".").reduce((o, x) => (o || {})[x], pack);
      if (!v) throw new Error("missing " + k + " in " + lang);
    }
  }
  return "3 keys x 3 languages";
});

/* ------------------------------------------------------------------ result */

const failed = results.filter((x) => !x).length;
console.log("\nsymbol-search: " + (failed ? failed + " FAILED of " : results.length + " of ") + results.length + " checks passed");
process.exit(failed ? 1 : 0);
