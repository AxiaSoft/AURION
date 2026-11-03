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
  const at = css.indexOf("@media (max-width:560px)");
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

/* ========================= 1. there is only ONE open-positions container

   There used to be two: a panel floating over the chart and the dock's
   own Positions pane, both painted from the same rows. Four checks used
   to live here making sure the floating one did not collide with the
   drawing-tools button in the same corner. The overlay has been removed
   on request, so that entire class of bug is gone with it - what is
   left to protect is that it does not come back. */

check("there is exactly one open-positions container", () => {
  if (/id="tv-pos"/.test(toolsJs)) throw new Error("the floating panel is back in the markup");
  /* The id, not the whole attribute: the dock's panes come from one
     helper now, so only the id itself is a literal in the source. */
  /* The container is the bottom dock. There used to be a second copy
     in the side panel; it has been removed on request, so "exactly
     one" is now literally true rather than true of the overlay only. */
  if (!/id="tv-posdock-body"/.test(toolsJs)) throw new Error("the dock container is missing");
  if (/data-pane="positions"/.test(toolsJs)) throw new Error("the side panel's positions pane is back");
  if (/\.tv-pos\{/.test(chartCss)) throw new Error("the floating panel's rule is back");
  if (/tv-pos-sum/.test(appJs)) throw new Error("the floating summary pill is back");
  if (/\.tv\.tools-open\s+\.tv-pos\s*\{/.test(chartCss)) {
    throw new Error("the rule hiding the floating panel survived the panel itself");
  }
  return "dock only";
});

check("the shared row styling survived the removal", () => {
  /* The list was rebuilt for the bottom dock and the classes went with
     it: .tv-pos-* became .tvp-*. What has to survive is that the rows
     are styled at all, and that direction and profit are still told
     apart by something other than their position in the line. */
  for (const cls of [".tvp-list", ".tvp-row", ".tvp-pl", ".tvp-dir"]) {
    if (!chartCss.includes(cls)) throw new Error(cls + " is unstyled");
  }
  if (!/\.is-buy \.tvp-dir b\{color:var\(--candle-up\)\}/.test(chartCss)) {
    throw new Error("a long is not coloured as one");
  }
  /* And the old names must be gone, not left behind as dead rules.
     Comments are stripped first: the removal is explained in prose
     that names the classes it removed, and a plain substring search
     found that prose and called it a surviving rule. */
  const bare = chartCss.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const dead of [".tv-pos-row", ".tv-pos-body", ".tv-pos-lv", ".tv-pos-dir", ".tv-pos-at"]) {
    if (new RegExp(dead.replace(".", "\\.") + "(?![\\w-])").test(bare)) {
      throw new Error(dead + " is a dead rule nothing can match");
    }
  }
  return "rows styled, old rules removed";
});

/* ================================================ 2. the side panel */

check("the side panel is a drawing workspace and nothing else", () => {
  /* This used to assert that Positions was an unconditional tab here.
     It has been removed on request, and the reasoning that put it
     here has been overtaken: the panel at phone width is a 300px
     overlay on a 390px screen, so reading the book in it hid the
     chart the book belongs to, while the bottom dock resizes the
     chart instead of covering it.

     Objects must still be unconditional, and Trade must still be the
     conditional one - that part of the structure is unchanged. */
  const dock = toolsJs.slice(toolsJs.indexOf("function dockHtml"), toolsJs.indexOf("function html(o)"));
  const base = /const tabs = \[([\s\S]*?)\];/.exec(dock);
  if (!base) throw new Error("the tab table is gone");
  if (/"positions"/.test(base[1])) throw new Error("the Positions tab is back in the panel");
  if (!/"objects"/.test(base[1])) throw new Error("Objects is not an unconditional tab");
  if (/ticket/.test(base[1])) throw new Error("the base tab table is behind a ticket check");
  if (!/if \(o\.ticket\) tabs\.push\(\["trade"/.test(dock)) {
    throw new Error("Trade is no longer the conditional one");
  }
  return "objects + props, trade on a ticket";
});

check("a shut dock still says something is open", () => {
  /* Two counters, not three: the side panel's tab badge went with the
     tab. The requirement is unchanged - a count that disappears
     rather than sitting at zero - and the toolbar chip is now the
     only thing standing between a trader and an unseen open trade,
     which is why it is also capped and named out loud. */
  if (!/id="tv-pos-toggle-n"/.test(toolsJs)) throw new Error("no chip on the toolbar button");
  const fn = appJs.slice(appJs.indexOf("function paintChartPositions"), appJs.indexOf("function bindCancelButtons"));
  if (!/chip\.hidden = n === 0/.test(fn)) throw new Error("the chip is not hidden when nothing is open");
  if (!/"tv-posdock-n"/.test(fn)) throw new Error("the bottom dock's header carries no count");
  if (!/n > 9 \? "9\+"/.test(fn)) throw new Error("the chip is not capped");
  if (!/setAttribute\("aria-label"/.test(fn)) throw new Error("the count is not announced");
  return "counted, capped, hidden at zero";
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
  win.eval(files.map(read).join("\n;\n") + ";window.__T={S,views,paintChartPositions,allPositions,positionsListHtml};");
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

check("the one container lists every open trade and resting order", () => withChart((win, T) => {
  T.paintChartPositions(POS, ORD);
  const dock = win.document.getElementById("tv-posdock-body");
  const d = dock.querySelectorAll(".tvp-row:not(.tvp-head)").length;
  if (d !== 3) throw new Error("the container shows " + d + " rows, expected 3");
  return d + " rows";
}));

check("the dock's close and cancel buttons are wired, not decorative", () => withChart((win, T) => {
  T.paintChartPositions(POS, ORD);
  const dock = win.document.getElementById("tv-posdock-body");
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

check("an empty book empties it, and a refill fills it again", () => withChart((win, T) => {
  T.paintChartPositions(POS, ORD);
  T.paintChartPositions([], []);
  const dock = win.document.getElementById("tv-posdock-body");
  const badge = win.document.getElementById("tv-pos-toggle-n");
  if (!badge.hidden) throw new Error("the chip stayed on an empty book");
  if (!dock.textContent.trim()) throw new Error("the container went blank instead of saying so");
  if (dock.querySelector(".tvp-row:not(.tvp-head)")) throw new Error("the container kept its rows");

  /* The repaint is signature-gated. Going empty and back must not leave
     a stale signature that swallows the redraw. */
  T.paintChartPositions(POS, ORD);
  const d = dock.querySelectorAll(".tvp-row:not(.tvp-head)").length;
  if (d !== 3) throw new Error("after refilling, the container shows " + d + " rows");
  if (badge.hidden || badge.textContent !== "3") throw new Error("badge reads '" + badge.textContent + "'");
  return "emptied and refilled";
}));

check("the count is positions plus resting orders", () => withChart((win, T) => {
  T.paintChartPositions(POS, ORD);
  const badge = win.document.getElementById("tv-pos-toggle-n");
  if (badge.textContent !== "3") throw new Error("badge reads " + badge.textContent + ", expected 3");
  T.paintChartPositions(POS, []);
  if (badge.textContent !== "2") throw new Error("without orders the badge reads " + badge.textContent);
  /* And past nine it says so without overflowing a 17px circle. */
  T.paintChartPositions(Array.from({ length: 12 }, (_, i) => ({ ...POS[0], ticket: 100 + i })), []);
  if (badge.textContent !== "9+") throw new Error("twelve positions read as " + badge.textContent);
  return "2 + 1 = 3, and 12 reads 9+";
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
  /* Rows of the shared .tvp-list, not a table. The header row carries
     .tvp-head and is not a trade. */
  const rows = card.querySelectorAll(".tvp-row:not(.tvp-head)");
  if (rows.length !== 2) throw new Error("expected both trades, got " + rows.length);
  const syms = [...card.querySelectorAll(".tvp-row:not(.tvp-head) .tvp-sym")]
    .map((t) => t.textContent.trim()).sort();
  if (syms.join(",") !== "EURUSD,XAUUSD") {
    throw new Error("the card is filtered to the chart's symbol: " + syms.join(","));
  }
  /* The whole point of the pane: thirty trades must not make a card
     thirty rows tall. */
  if (!card.querySelector(".pos-pane")) throw new Error("the list is not in a capped pane");
  if (!card.querySelector("[data-close]")) throw new Error("the positions cannot be closed from here");
  return "both instruments listed";
});

check("Markets shows the book once, in the whole-book pane", () => {
  /* This used to assert the opposite: the per-symbol strip above the
     chart and the whole-book card below it were both meant to be here,
     the strip answering "what am I holding in this instrument".

     Two answers to one question on one page is one answer too many.
     The strip is filtered to the symbol on screen and the table is
     not, so the same trade appeared twice in two shapes, and switching
     instrument made the upper copy disagree with the lower one. The
     whole-book card is the one that stays true, so it is the one
     that stays. It is the same row shape as the strip was, now, which
     is what makes having only one of them unambiguous rather than a
     loss. */
  const view = appJs.slice(appJs.indexOf("  markets() {"), appJs.indexOf("  intelligence() {"));
  if (/positionsStripHtml\(/.test(view)) throw new Error("the per-symbol strip is back");
  if (!/class="card pos-card mk-pos"/.test(view)) throw new Error("the whole-book card is missing");
  return "one book, in the table";
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

check("exactly one tab is selected, and it is the one that opens", () => {
  /* A tab strip whose first tab is not the active one reads as broken.
     Whichever tab leads, precisely one must be marked.

     The default used to be chosen by screen width - positions on a
     phone, objects on a desktop - and it never worked, because bind()
     ends with showDock(ui.dockTab || "objects") and overrode the
     markup's choice a moment after the panel appeared. With the
     Positions tab gone there is one default, and the two now agree.
     That agreement is the thing to hold. */
  const dock = toolsJs.slice(toolsJs.indexOf("function dockHtml"), toolsJs.indexOf("function html(o)"));
  if (!/const first = "objects"/.test(dock)) {
    throw new Error("the default tab is not a single constant");
  }
  if (!/showDock\(ui\.dockTab \|\| "objects"\)/.test(toolsJs)) {
    throw new Error("bind()'s fallback no longer matches the markup's default");
  }
  /* And the pane that is shown must be the tab that is marked, or the
     panel opens on a highlighted tab showing someone else's content.
     One helper now decides both, from `first`, which is the structural
     reason it cannot go wrong - so that is what is pinned here, and
     the rendered result is checked on a real phone-width DOM below. */
  if (!/\$\{first === name \? "" : " hidden"\}/.test(dock)) {
    throw new Error("a pane's hidden state is not tied to the default tab");
  }
  if (!/aria-selected="\$\{cur\}"/.test(dock) || !/const cur = id === first/.test(dock)) {
    throw new Error("the selected tab is not tied to the default tab");
  }
  return "objects, in the markup and at bind";
});

check("the Positions tab and its pane are both gone from the panel", () => withChart((win) => {
  /* The inverse of what this used to assert, and asserted the same
     way: against the rendered panel, so a leftover tab pointing at a
     pane that no longer exists would be caught. Half a removal is
     worse than none - a tab whose pane is missing shows blank. */
  if (win.document.querySelector('[data-dock="positions"]')) throw new Error("the Positions tab is back");
  if (win.document.querySelector('[data-pane="positions"]')) throw new Error("the Positions pane is back");
  if (win.document.getElementById("tvd-pos")) throw new Error("the side pane element survived");
  /* Every surviving tab still points at a pane that exists. */
  for (const t of win.document.querySelectorAll('.tvd-tabs [role="tab"]')) {
    if (!win.document.getElementById(t.getAttribute("aria-controls") || "")) {
      throw new Error(t.dataset.dock + " points at a pane that is not there");
    }
  }
  /* And the book is still reachable from the chart - one tap on the
     toolbar, into the dock that resizes rather than covers. */
  if (!win.document.getElementById("tv-pos-toggle")) throw new Error("nothing opens the positions dock");
  if (!win.document.getElementById("tv-posdock-body")) throw new Error("the positions dock is gone too");
  return "removed cleanly, book still one tap away";
}));

check("the tabs are a tab strip to a screen reader, not three buttons", () => withChart((win) => {
  /* It carried role="tablist" and role="tab" and nothing else: no tab
     said whether it was the current one, none named the pane it
     governed, and the panes were plain divs. The roles were decoration. */
  const strip = win.document.querySelector(".tvd-tabs");
  if (!strip || strip.getAttribute("role") !== "tablist") throw new Error("no tablist");
  if (!strip.getAttribute("aria-label")) throw new Error("the tablist is unnamed");
  const tabs = [...strip.querySelectorAll('[role="tab"]')];
  if (tabs.length < 2) throw new Error(tabs.length + " tabs");
  const sel = tabs.filter((t) => t.getAttribute("aria-selected") === "true");
  if (sel.length !== 1) throw new Error(sel.length + " tabs claim to be selected");
  /* One stop for the whole strip, not one per tab. */
  const stops = tabs.filter((t) => t.tabIndex === 0);
  if (stops.length !== 1) throw new Error(stops.length + " tab stops in the strip");
  if (stops[0] !== sel[0]) throw new Error("the tab stop is not the selected tab");
  for (const t of tabs) {
    const pane = win.document.getElementById(t.getAttribute("aria-controls") || "");
    if (!pane) throw new Error(t.dataset.dock + " controls nothing");
    if (pane.getAttribute("role") !== "tabpanel") throw new Error(t.dataset.dock + "'s pane is not a tabpanel");
    /* A pane that scrolls must be reachable by keyboard. */
    if (pane.tabIndex !== 0) throw new Error(t.dataset.dock + "'s pane cannot be focused to scroll it");
  }
  return tabs.length + " tabs, 1 selected, 1 stop";
}));

check("the close button is not inside the tab strip", () => withChart((win) => {
  /* It used to be the last child of the tablist, so it was announced as
     part of the tab sequence - and with four labels in a 250px column
     it was the thing that got pushed off the edge. */
  const strip = win.document.querySelector(".tvd-tabs");
  const close = win.document.getElementById("tv-dock-close");
  if (!close) throw new Error("the panel has no close button");
  if (strip.contains(close)) throw new Error("the close button is still inside the tablist");
  if (!close.getAttribute("aria-label")) throw new Error("the close button has no name");
  return "in its own header";
}));

check("arrow keys move between the tabs", () => withChart((win) => {
  /* A roving tabindex without arrow keys is a trap: one tab reachable,
     the rest unreachable from the keyboard entirely.

     The handler is attached here rather than relying on the app having
     done it, because the app attaches it inside bind(), which wants a
     live chart engine. That the app does attach it is asserted
     separately, below. */
  win.document.addEventListener("keydown", win.AurionChartUI.dockKey);
  const tabs = [...win.document.querySelectorAll('.tvd-tabs [role="tab"]')];
  const start = tabs.find((t) => t.getAttribute("aria-selected") === "true");
  start.dispatchEvent(new win.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
  const now = win.document.querySelectorAll('.tvd-tabs [aria-selected="true"]');
  if (now.length !== 1) throw new Error(now.length + " tabs selected after an arrow key");
  if (now[0] === start) throw new Error("the arrow key did not move the selection");
  /* End goes to the last tab, and the move is exclusive. */
  now[0].dispatchEvent(new win.KeyboardEvent("keydown", { key: "End", bubbles: true }));
  const last = win.document.querySelector('.tvd-tabs [aria-selected="true"]');
  if (last !== tabs[tabs.length - 1]) throw new Error("End did not reach the last tab");
  return "arrows and End";
}));

check("and the desk actually attaches that keyboard map", () => {
  /* The half the DOM test above cannot see. It must also come before
     the chart's own key handler, which pans on the arrow keys - two
     handlers acting on one press would change the tab and scroll the
     price out from under the trader. */
  const dk = toolsJs.indexOf('addEventListener("keydown", dockKey)');
  const ok = toolsJs.indexOf('addEventListener("keydown", onKey)');
  if (dk < 0) throw new Error("dockKey is never attached");
  if (ok < 0) throw new Error("the chart key handler is gone");
  if (dk > ok) throw new Error("the chart pans before the tab strip gets the key");
  if (!/if \(e\.defaultPrevented\) return;/.test(toolsJs)) {
    throw new Error("the chart handler does not stand down once the key is handled");
  }
  return "attached, and first";
});

check("on a phone the panel opens on one pane, and it is the marked one", () => {
  /* This used to assert the phone opened on Positions. It never did -
     bind()'s fallback switched it to Objects immediately - and the
     tab is gone now in any case.

     What was worth checking is still checked, and it is the part that
     reads as broken when it goes wrong: exactly one tab marked,
     exactly one pane visible, and the two the same one. */
  const win = boot();
  win.matchMedia = (q) => ({ matches: /max-width:\s*980px/.test(q), addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  const ws = win.document.createElement("div");
  win.document.body.appendChild(ws);
  ws.innerHTML = win.AurionChartUI.html({ symbol: "EURUSD", timeframe: "M15" });
  const marked = [...win.document.querySelectorAll("[data-dock].on")];
  if (marked.length !== 1) throw new Error(marked.length + " tabs are marked selected");
  const shown = [...win.document.querySelectorAll(".tvd-body")].filter((p) => !p.hidden);
  if (shown.length !== 1) throw new Error(shown.length + " panes are visible at once");
  if (shown[0].dataset.pane !== marked[0].dataset.dock) {
    throw new Error("the " + marked[0].dataset.dock + " tab is marked but the " + shown[0].dataset.pane + " pane is showing");
  }
  if (marked[0].dataset.dock !== "objects") throw new Error("the phone opens on " + marked[0].dataset.dock);
  return "objects marked, objects shown";
});

/* ------------------------------------------------------------------ result */

const failed = results.filter((x) => !x).length;
console.log("\nopen-positions: " + (failed ? failed + " FAILED of " : results.length + " of ") + results.length + " checks passed");
process.exit(failed ? 1 : 0);
