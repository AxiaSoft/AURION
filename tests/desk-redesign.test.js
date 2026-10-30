/**
 * Six changes asked for from the desk:
 *
 *   1. open positions in the markets view must be closable;
 *   2. the EA chart must show open positions differently;
 *   3. the About page, redesigned again for desktop and mobile;
 *   4. the build stamp written DSK-DDMMYY;
 *   5. the AI page, rebuilt for desktop and mobile;
 *   6. prop risk and the command centre, both rebuilt for both sizes.
 *
 * Nearly all of it is rendered in jsdom and inspected through the DOM
 * rather than matched against the source, because these are claims
 * about what reaches the screen. The one exception is the responsive
 * behaviour: jsdom does no layout, so the breakpoints are checked as
 * stylesheet rules, which is the most that can honestly be asserted
 * without a real browser.
 *
 *     node tests/desk-redesign.test.js
 */

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const WEB = path.join(ROOT, "apps", "web");
const read = (p) => fs.readFileSync(path.join(WEB, p), "utf8");

const results = [];
const pending = [];
function check(name, fn) {
  try {
    const note = fn();
    if (note && typeof note.then === "function") {
      /* An async check reports when it settles; the summary waits for
         all of them before counting. */
      const slot = results.push(null) - 1;
      pending.push(note.then(
        (n) => { results[slot] = true; console.log("PASS  " + name + (typeof n === "string" ? "  — " + n : "")); },
        (e) => { results[slot] = false; console.log("FAIL  " + name + "\n      " + e.message); }
      ));
      return;
    }
    results.push(true);
    console.log("PASS  " + name + (note ? "  — " + note : ""));
  } catch (e) {
    results.push(false);
    console.log("FAIL  " + name + "\n      " + e.message);
  }
}

const appJs = read("js/app.js");
const appCss = read("css/app.css");
const chartCss = read("css/chart.css");
const chartJs = read("js/chart-tools.js");

/* ======================================================================
   4. The build stamp
   ====================================================================== */

const buildTag = (() => {
  const src = /function buildTag\(iso\) \{[\s\S]*?\n\}/.exec(appJs);
  if (!src) return null;
  // eslint-disable-next-line no-eval
  return eval("(" + src[0].replace(/^function buildTag/, "function") + ")");
})();

check("the build stamp is written DSK-DDMMYY", () => {
  if (!buildTag) throw new Error("buildTag is missing");
  const got = buildTag("2026-10-28");
  if (got !== "DSK-281026") throw new Error("2026-10-28 became " + got + ", expected DSK-281026");
});

check("a single-digit day and month keep their leading zeros", () => {
  /* DSK-5126 would be unreadable and would not sort against its
     neighbours; the format is fixed-width or it is not a format. */
  const got = buildTag("2026-01-05");
  if (got !== "DSK-050126") throw new Error("2026-01-05 became " + got);
  if (got.length !== 10) throw new Error("the stamp is " + got.length + " characters, not 10");
});

check("the century is dropped, not the decade", () => {
  if (buildTag("2024-12-31") !== "DSK-311224") throw new Error(buildTag("2024-12-31"));
  if (buildTag("2030-06-09") !== "DSK-090630") throw new Error(buildTag("2030-06-09"));
});

check("a missing or malformed date is never stamped with today", () => {
  /* Inventing a build date is worse than admitting there is not one:
     it is a number a user reads back to support as fact. */
  for (const bad of ["", null, undefined, "   "]) {
    const got = buildTag(bad);
    if (!/^DSK-\u2014$/.test(got)) throw new Error(JSON.stringify(bad) + " became " + got);
  }
  if (buildTag("not-a-date") !== "DSK-not-a-date") throw new Error("unexpected input was reshaped");
});

check("the wire format is left alone", () => {
  /* Only the display changes. ISO sorts and is unambiguous, and the
     backend derives it from a file mtime. */
  const api = fs.readFileSync(path.join(ROOT, "backend", "src", "index.js"), "utf8");
  if (!/buildDate = stat\.mtime\.toISOString\(\)\.slice\(0,10\)/.test(api)) {
    throw new Error("the backend no longer sends an ISO build date");
  }
  if (/DSK-/.test(api)) throw new Error("the display format leaked into the API");
});

/* ======================================================================
   Rendered checks
   ====================================================================== */

let jsdom = null;
try { jsdom = require(require.resolve("jsdom")); } catch { /* optional */ }

if (!jsdom) {
  console.log("SKIP  rendered checks (jsdom not installed)");
} else {
  const { JSDOM, VirtualConsole } = jsdom;
  const vc = new VirtualConsole();
  const dom = new JSDOM(read("index.html"), {
    url: "http://localhost/", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole: vc,
  });
  const win = dom.window;
  win.fetch = async () => ({ ok: true, json: async () => ({ ok: true, data: {} }) });
  win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  win.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  win.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
  win.URL.createObjectURL = () => "blob:stub";
  win.AudioContext = class { createGain() { return { connect() {}, gain: {} }; } };

  const bundle = ["js/themes.js", "js/skins.js", "js/i18n.js", "js/api.js", "js/calendar.js", "js/charts.js", "js/app.js"]
    .map(read).join("\n;\n");
  let T = null;
  try {
    win.eval(bundle + "\n;window.__T = { S, views, I18N, propStatusHtml, propFormHtml, analysisCardHtml, positionsStripHtml, paintChartPositions, patchLive, bindCloseButtons, API, setConfirm(f){ askConfirm = f; } };");
    T = win.__T;
  } catch (e) {
    console.log("FAIL  the desk bundle loads\n      " + e.message);
    results.push(false);
  }

  const frag = (html) => {
    const d = win.document.createElement("div");
    d.innerHTML = html;
    return d;
  };

  if (T) {
    const agents = [
      { symbol: "EURUSD", timeframe: "M15", alive: true, online: true, last_seen: Date.now() },
      { symbol: "XAUUSD", timeframe: "H1", alive: true, online: true, last_seen: Date.now() },
    ];
    const basePos = [
      { ticket: 101, symbol: "EURUSD", type: "buy", volume: 0.2, price_open: 1.08, price_current: 1.085, sl: 1.07, tp: 1.1, profit: 12.4, profit_pct: 0.5, strategy: "trend" },
      { ticket: 102, symbol: "EURUSD", type: "sell", volume: 0.1, price_open: 1.09, price_current: 1.085, sl: 1.1, tp: 1.07, profit: -4.2, profit_pct: -0.2, strategy: "trend" },
    ];
    T.S.snap = {
      engine: "online",
      ticks: { EURUSD: { bid: 1.085, ask: 1.0851 }, XAUUSD: { bid: 2412.3, ask: 2412.7 } },
      agents,
      mt5: { connected: true, account: { equity: 10234.5, balance: 10000, profit: 234.5, margin: 120, margin_free: 9880, currency: "USD", leverage: 100, company: "Broker", server: "Live-1", account_type: "real", margin_mode: "netting" } },
      prop: { enabled: true, locked: false, daily_pl_pct: -1.4, drawdown_pct: 3.2, profile: { id: "ftmo_challenge", max_daily_loss_pct: 2, max_drawdown_pct: 5 } },
      positions: basePos,
      orders: [{ ticket: 9, symbol: "EURUSD", type: "buy_limit", volume: 0.1, price: 1.07, sl: 1.06, tp: 1.09, strategy: "trend" }],
      strategy: { name: "trend", auto_trade: true, manual_volume: 0.2 },
      analysis: {
        symbol: "EURUSD", timeframe: "M15", ready: false, setup: null, strategy: "trend", strategy_enabled: true,
        ai: { confidence: 0.42, min_confidence: 0.6, gate: true },
        blockers: [{ text: "Confidence below threshold", fix: "wait for a stronger read" }],
        when: "next bar", console: [{ ts: "2026-10-28T10:00:00", code: "EVAL", message: "evaluated", level: "info" }],
        refusals: [{ reason: "low_conf", count: 3 }],
      },
      ai: { symbol: "EURUSD", confidence: 0.42, regime: "trend", pattern: "flag", samples: 120, need: 200, features: { rsi: 55.2, atr: 0.0012 }, activity: [{ ts: "10:00", text: "scanned" }] },
      license: { premium: true, plan: "pro" },
      gates: [],
    };
    T.S.symbol = "EURUSD";
    T.S.timeframe = "M15";
    T.S.version = "2.4.1";
    T.S.buildDate = "2026-10-28";

    /* ---- 1. closing a position from the markets view ----------------- */

    check("every open trade on the markets chart carries a close control", () => {
      const d = frag(T.positionsStripHtml("EURUSD"));
      const chips = d.querySelectorAll(".pos-chip");
      if (chips.length !== 2) throw new Error(chips.length + " chips for 2 open trades");
      for (const c of chips) {
        if (!c.querySelector("[data-close]")) throw new Error("a chip has no close control");
      }
    });

    check("the close control names the trade it would close", () => {
      /* A bare cross tells a screen reader nothing, and tells a trader
         with four trades open nothing either. */
      const d = frag(T.positionsStripHtml("EURUSD"));
      const b = d.querySelector(".pos-chip [data-close]");
      const label = b.getAttribute("aria-label") || "";
      if (!/EURUSD/.test(label)) throw new Error("aria-label is " + JSON.stringify(label));
      if (!/BUY/i.test(label)) throw new Error("the direction is not named: " + JSON.stringify(label));
      /* fmt() trims trailing zeros across the whole desk, so 0.2 -- not
         0.20 -- is the house format for a volume. */
      if (!/0\.2\b/.test(label)) throw new Error("the size is not named: " + JSON.stringify(label));
    });

    check("it closes the ticket it is attached to, not the first one", () => {
      const d = frag(T.positionsStripHtml("EURUSD"));
      const got = [...d.querySelectorAll("[data-close]")].map((b) => b.dataset.close);
      if (got.join(",") !== "101,102") throw new Error("tickets: " + got.join(","));
    });

    check("a chart with nothing open shows no close controls at all", () => {
      const d = frag(T.positionsStripHtml("XAUUSD"));
      if (d.querySelector("[data-close]")) throw new Error("a close button with no position");
      if (!d.querySelector(".pos-none")) throw new Error("no empty state");
    });

    check("the markets view wires the close controls when it mounts", () => {
      /* Rendering a button nobody binds is the failure that looks fine
         in a screenshot. */
      const binds = appJs.slice(appJs.indexOf('if (view === "markets") {'), appJs.indexOf('if (view === "markets") {') + 500);
      if (!/bindCloseButtons\(/.test(binds)) throw new Error("the markets view never binds its close buttons");
    });

    check("the strip re-binds after a snapshot repaints it", () => {
      /* innerHTML throws the old buttons away with their handlers; the
         control would work until the first tick and then silently stop. */
      const fn = /function paintPositionStrips\(\) \{[\s\S]*?\n\}/.exec(appJs)[0];
      if (!/bindCloseButtons\(/.test(fn)) throw new Error("paintPositionStrips does not re-bind");
    });

    /* Driven for real rather than read: "it calls askConfirm" is not the
       guarantee -- the guarantee is that saying no leaves the position
       open. An earlier version of this test passed while ignoring the
       answer entirely. */
    const drive = async (answer) => {
      const calls = [];
      const realPost = T.API.post;
      T.API.post = async (url, body) => { calls.push({ url, body }); return { ok: true }; };
      T.setConfirm(async () => answer);
      const host = win.document.createElement("div");
      host.innerHTML = T.positionsStripHtml("EURUSD");
      win.document.body.appendChild(host);
      try {
        const btn = host.querySelector("[data-close]");
        T.bindCloseButtons(host);
        await btn.onclick();
        return { calls, btn };
      } finally {
        T.API.post = realPost;
        host.remove();
      }
    };

    check("answering no to the confirmation leaves the position open", async () => {
      const { calls } = await drive(false);
      if (calls.length) throw new Error("the position was closed anyway: " + JSON.stringify(calls[0]));
    });

    check("answering yes closes exactly that ticket", async () => {
      const { calls } = await drive(true);
      if (calls.length !== 1) throw new Error(calls.length + " requests sent");
      if (calls[0].url !== "/api/order") throw new Error("posted to " + calls[0].url);
      if (calls[0].body.action !== "close") throw new Error("action was " + calls[0].body.action);
      if (calls[0].body.ticket !== 101) throw new Error("closed ticket " + calls[0].body.ticket);
    });

    check("the confirmation is marked destructive", () => {
      const fn = /function bindCloseButtons\(root\) \{[\s\S]*?\n\}\n/.exec(appJs)[0];
      if (!/danger: true/.test(fn)) throw new Error("the dialog is not styled as a destructive action");
      if (!/b\.disabled = true/.test(fn)) throw new Error("the button is not disabled while in flight");
    });

    check("closing a trade from a chart card does not also open the chart", () => {
      /* The whole card is a button that opens the chart fullscreen, and
         it now contains real controls inside it. Without a guard the
         close press bubbles up and throws the trader into a fullscreen
         chart on the way to confirming. */
      const h = /\$\("stage"\)\?\.querySelectorAll\("\[data-open-chart\]"\)[\s\S]{0,2200}?\n      \}\);/.exec(appJs);
      if (!h) throw new Error("could not find the chart-grid handler");
      const body = h[0];
      if (!/closest\("button/.test(body)) {
        throw new Error("a press on a control inside the card still opens the chart");
      }
      const guardAt = body.indexOf("closest(\"button");
      const openAt = body.indexOf("openChartDesk(");
      if (guardAt > openAt) throw new Error("the guard runs after the chart has already opened");
    });

    check("the card is the only way to open a chart, and it is a real control", () => {
      /* There were two: the card, and a full-width button inside it
         carrying the same data-open-chart. The button never worked -
         the shared handler bails whenever the click starts inside a
         button, a guard written for the card and then inherited by
         the button - so it was a dead control repeating the card's
         own job. It is gone, which means the card itself has to carry
         the semantics the button was added to provide. */
      const card = appJs.slice(appJs.indexOf("const chartCard = ("), appJs.indexOf("if (agents.length || testers.length)"));
      if (/class="btn tiny block chart-open"/.test(card)) throw new Error("the dead open button is back");
      if (!/role="button"/.test(card)) throw new Error("the card has no role");
      if (!/tabindex="0"/.test(card)) throw new Error("the card is not a tab stop");
      if (!/aria-label="\$\{esc\(I18N\.t\("charts\.open_sr"/.test(card)) {
        throw new Error("the card has no accessible name");
      }
      const h = /\$\("stage"\)\?\.querySelectorAll\("\[data-open-chart\]"\)[\s\S]{0,2200}?\n      \}\);/.exec(appJs)[0];
      if (!/el\.onkeydown/.test(h)) throw new Error("a role=button that ignores the keyboard is a div with a costume");
      if (!/ev\.key !== "Enter" && ev\.key !== " "/.test(h)) throw new Error("Enter and Space are not both handled");
      if (!/preventDefault/.test(h)) throw new Error("Space will scroll the page as well as open the chart");
    });

    check("the chart grid binds the close buttons it renders", () => {
      const block = appJs.slice(appJs.indexOf('if (view === "charts") {'), appJs.indexOf('if (view === "markets") {'));
      if (!/bindCloseButtons\(/.test(block)) throw new Error("the grid's close buttons are never wired");
    });

    /* ---- 2. positions on the EA chart -------------------------------- */

    check("there is no second open-trades panel floating over the chart", () => {
      /* There were two places showing the same book: a panel anchored
         over the chart and the dock's own pane. Asked for the overlay
         to go and the single container to stay. This guards the
         removal - the markup, the painter and the stylesheet. */
      if (/id="tv-pos"/.test(chartJs)) throw new Error("the on-chart panel is back in the markup");
      if (/\.tv-pos\{/.test(chartCss)) throw new Error("the on-chart panel's rule is back");
      if (/tv-pos-sum/.test(appJs)) throw new Error("the floating summary pill is back");
      /* Matched as an id rather than as a whole id="..." attribute: the
         dock's panes are built by one helper now, so the attribute is
         assembled at runtime and only the id itself is a literal. */
      if (!/"tvd-pos"/.test(chartJs)) throw new Error("the dock container went too");
    });

    [...win.document.querySelectorAll("#tvd-pos")].forEach((n) => n.remove());
    const posHost = win.document.createElement("div");
    posHost.id = "tvd-pos";
    win.document.body.appendChild(posHost);

    check("the one container says so when nothing is open", () => {
      T.paintChartPositions([], []);
      if (!/tvd-empty/.test(posHost.innerHTML)) {
        throw new Error("an empty book leaves the container blank");
      }
    });

    check("each open trade is a row, and shows what it is making", () => {
      /* The old chips showed SL, TP and the strategy but never the
         running profit -- the one number that is actually moving. */
      T.paintChartPositions(basePos, []);
      const rows = posHost.querySelectorAll(".tv-pos-row");
      if (rows.length !== 2) throw new Error(rows.length + " rows for 2 trades");
      const pls = [...rows].map((r) => r.querySelector(".tv-pos-pl").textContent.trim());
      if (!pls.includes("+12.4")) throw new Error("the winning trade's profit is not shown: " + pls.join(" | "));
      if (!pls.some((t) => t.startsWith("-4.2"))) throw new Error("the losing trade's loss is not shown: " + pls.join(" | "));
    });

    check("a profit reads as a gain and a loss as a loss", () => {
      T.paintChartPositions(basePos, []);
      const rows = [...posHost.querySelectorAll(".tv-pos-row")];
      if (!rows[0].querySelector(".tv-pos-pl").className.includes("up")) {
        throw new Error("+12.40 is not marked as a gain");
      }
      if (!rows[1].querySelector(".tv-pos-pl").className.includes("down")) {
        throw new Error("-4.20 is not marked as a loss");
      }
    });

    check("the direction of each trade is distinguishable", () => {
      T.paintChartPositions(basePos, []);
      const rows = [...posHost.querySelectorAll(".tv-pos-row")];
      if (!rows[0].classList.contains("is-buy")) throw new Error("the buy is not marked");
      if (!rows[1].classList.contains("is-sell")) throw new Error("the sell is not marked");
    });

    check("a resting order is not counted as an open position", () => {
      /* It has not filled; showing it as exposure would overstate the
         position, and it needs a cancel rather than a close. */
      const ord = [{ ticket: 9, symbol: "EURUSD", type: "buy_limit", volume: 0.1, price: 1.07, sl: 1.06, tp: 1.09 }];
      T.paintChartPositions(basePos, ord);
      const resting = posHost.querySelector(".tv-pos-row.is-resting");
      if (!resting) throw new Error("the resting order is not marked as waiting");
      if (resting.querySelector("[data-close]")) throw new Error("a resting order offers a close");
      if (!resting.querySelector("[data-cancel]")) throw new Error("a resting order offers no cancel");
    });

    check("the dock tab still carries the count while the pane is shut", () => {
      /* With the overlay gone this badge is the only sign of an open
         trade when the dock is closed, so it matters more than before. */
      const badge = win.document.createElement("span");
      badge.id = "tvd-pos-n";
      win.document.body.appendChild(badge);
      T.paintChartPositions(basePos, [{ ticket: 9, type: "buy_limit", volume: 0.1, price: 1.07 }]);
      if (badge.textContent !== "3") throw new Error("the badge reads " + badge.textContent);
      if (badge.hidden) throw new Error("the badge is hidden with trades open");
      T.paintChartPositions([], []);
      if (!badge.hidden) throw new Error("the badge lingers with an empty book");
      badge.remove();
    });

    /* ---- 5. the AI page ---------------------------------------------- */

    check("the AI page leads with the direction picker, then the verdict", () => {
      /* The original rule here was "lead with the verdict, not with a
         feature dump". The feature-dump half still stands. The first
         half changed on request: the direction slider is what chooses
         which symbol is being analysed, so it has to sit above the
         analysis it controls rather than below it. */
      const d = frag(T.views.intelligence());
      const cards = [...d.querySelectorAll("section.card, div.card")];
      const idxSlider = cards.findIndex((c) => c.querySelector("#ai-slide-stage"));
      const idxVerdict = cards.findIndex((c) => c.classList.contains("ai-verdict"));
      if (idxSlider !== 0) {
        throw new Error("the direction picker is not first (it is at " + idxSlider + ")");
      }
      if (idxVerdict !== 1) {
        throw new Error("the verdict does not follow it (it is at " + idxVerdict + ")");
      }
      if (!d.querySelector(".ai-v-state")) throw new Error("there is no verdict line");
      // and the raw material is still not what greets you
      const idxFeat = cards.findIndex((c) => c.querySelector("#ai-feat"));
      if (idxFeat > -1 && idxFeat < idxVerdict) {
        throw new Error("the feature dump is above the verdict again");
      }
    });

    check("a blocked robot says so and says why in the same place", () => {
      const d = frag(T.views.intelligence());
      const card = d.querySelector(".ai-verdict");
      if (!card.classList.contains("is-blocked")) throw new Error("a blocked robot is not marked blocked");
      const why = card.querySelector(".an-why");
      if (!why || !/Confidence below threshold/.test(why.textContent)) {
        throw new Error("the blocker is not shown on the verdict card");
      }
    });

    check("a ready robot reads differently from a blocked one", () => {
      const keep = T.S.snap.analysis.ready, keepS = T.S.snap.analysis.setup;
      T.S.snap.analysis.ready = true; T.S.snap.analysis.setup = { dir: "buy" };
      const d = frag(T.views.intelligence());
      T.S.snap.analysis.ready = keep; T.S.snap.analysis.setup = keepS;
      if (!d.querySelector(".ai-verdict").classList.contains("is-ready")) {
        throw new Error("a ready robot is not marked ready");
      }
    });

    check("confidence is drawn against its threshold, not just printed", () => {
      /* "62% / 60%" and "58% / 60%" read almost the same and mean
         opposite things. */
      const d = frag(T.views.intelligence());
      const fill = d.querySelector(".ai-conf-fill");
      const need = d.querySelector(".ai-conf-need");
      if (!fill || !need) throw new Error("there is no confidence meter");
      if (!/--w:\s*42%/.test(fill.getAttribute("style") || "")) {
        throw new Error("the bar does not show 42%: " + fill.getAttribute("style"));
      }
      if (!/--at:\s*60%/.test(need.getAttribute("style") || "")) {
        throw new Error("the threshold is not marked at 60%: " + need.getAttribute("style"));
      }
    });

    check("a confidence under the threshold is not painted as sufficient", () => {
      const d = frag(T.views.intelligence());
      if (d.querySelector(".ai-conf-fill").classList.contains("is-ok")) {
        throw new Error("42% against a 60% threshold is shown as met");
      }
      const keep = T.S.snap.analysis.ai.confidence;
      T.S.snap.analysis.ai.confidence = 0.8;
      const d2 = frag(T.views.intelligence());
      T.S.snap.analysis.ai.confidence = keep;
      if (!d2.querySelector(".ai-conf-fill").classList.contains("is-ok")) {
        throw new Error("80% against a 60% threshold is not shown as met");
      }
    });

    check("with the gate off there is no meter to misread", () => {
      const keep = T.S.snap.analysis.ai.gate;
      T.S.snap.analysis.ai.gate = false;
      const d = frag(T.views.intelligence());
      T.S.snap.analysis.ai.gate = keep;
      if (d.querySelector(".ai-conf-bar")) throw new Error("a threshold meter is drawn when nothing is gated on it");
      if (!d.querySelector(".ai-conf-off")) throw new Error("nothing says the gate is off");
    });

    check("the raw features are folded away rather than leading the page", () => {
      const d = frag(T.views.intelligence());
      const det = d.querySelector("details.ai-feats");
      if (!det) throw new Error("the feature dump is not collapsible");
      if (det.hasAttribute("open")) throw new Error("eighteen raw numbers are open by default");
      if (!d.querySelector("#ai-feat")) throw new Error("the feature host id was lost");
    });

    check("the AI page keeps the hooks the live patcher writes to", () => {
      const d = frag(T.views.intelligence());
      for (const id of ["ai-regime", "ai-pattern", "ai-samples", "ai-why", "ai-feat", "ai-feat-sym", "ai-feed", "btn-train"]) {
        if (!d.querySelector("#" + id)) throw new Error("#" + id + " was lost in the rewrite");
      }
    });

    check("the analysis card keeps its own live hooks", () => {
      const d = frag(T.analysisCardHtml());
      for (const id of ["an-card", "an-console"]) {
        if (!d.querySelector("#" + id)) throw new Error("#" + id + " was lost");
      }
    });

    /* ---- 6a. prop risk ----------------------------------------------- */

    check("each prop rule is measured against its own limit", () => {
      /* "-1.4%" means nothing without the number it counts towards. */
      const d = frag(T.propStatusHtml());
      const meters = d.querySelectorAll(".pr-meter");
      if (meters.length !== 2) throw new Error(meters.length + " meters, expected daily loss and drawdown");
      const bars = [...d.querySelectorAll(".pr-meter-bar > i")].map((i) => i.getAttribute("style"));
      if (!/--w:\s*70%/.test(bars[0])) throw new Error("1.4 of 2 should be 70%, got " + bars[0]);
      if (!/--w:\s*64%/.test(bars[1])) throw new Error("3.2 of 5 should be 64%, got " + bars[1]);
    });

    check("a rule close to its limit is flagged before it is broken", () => {
      const keep = T.S.snap.prop.daily_pl_pct;
      T.S.snap.prop.daily_pl_pct = -1.9;             // 95% of 2
      const near = frag(T.propStatusHtml()).querySelector(".pr-meter");
      T.S.snap.prop.daily_pl_pct = -2.4;             // over
      const over = frag(T.propStatusHtml()).querySelector(".pr-meter");
      T.S.snap.prop.daily_pl_pct = keep;
      if (!near.classList.contains("is-near")) throw new Error("95% of the daily limit is not flagged");
      if (near.classList.contains("is-over")) throw new Error("95% is reported as a breach");
      if (!over.classList.contains("is-over")) throw new Error("a breach is not flagged");
    });

    check("a meter never exceeds its own bar", () => {
      const keep = T.S.snap.prop.drawdown_pct;
      T.S.snap.prop.drawdown_pct = 40;               // 800% of the limit
      const bar = frag(T.propStatusHtml()).querySelectorAll(".pr-meter-bar > i")[1];
      T.S.snap.prop.drawdown_pct = keep;
      if (!/--w:\s*100%/.test(bar.getAttribute("style"))) {
        throw new Error("the bar reads " + bar.getAttribute("style"));
      }
    });

    check("with no limit configured no fraction is invented", () => {
      const keep = T.S.snap.prop.profile.max_daily_loss_pct;
      T.S.snap.prop.profile.max_daily_loss_pct = 0;
      const d = frag(T.propStatusHtml());
      T.S.snap.prop.profile.max_daily_loss_pct = keep;
      const bar = d.querySelector(".pr-meter-bar > i");
      if (!/--w:\s*0%/.test(bar.getAttribute("style"))) throw new Error("a bar was drawn against no limit");
      if (d.querySelector(".pr-meter").classList.contains("is-over")) throw new Error("no limit was reported as breached");
    });

    check("the live patcher moves the bar, not only the number", () => {
      /* A frozen bar beside a moving figure is worse than no bar: it
         reads as a live measurement and is not one. */
      const host = win.document.createElement("div");
      host.innerHTML = T.propStatusHtml();
      win.document.body.appendChild(host);
      const keepView = T.S.view;
      T.S.view = "settings";                         // the prop block only runs there
      try {
        T.S.snap.prop.daily_pl_pct = -0.5;           // 25% of 2
        T.patchLive();
        const bar = host.querySelector(".pr-meter-bar > i");
        const num = host.querySelector("#risk-dpl").textContent.trim();
        if (!/25%/.test(bar.style.getPropertyValue("--w"))) {
          throw new Error("the bar stayed at " + JSON.stringify(bar.style.getPropertyValue("--w")));
        }
        if (!/0\.50|0\.5/.test(num)) throw new Error("the figure reads " + num);
      } finally {
        T.S.snap.prop.daily_pl_pct = -1.4;
        T.S.view = keepView;
        host.remove();
      }
    });

    check("the prop form keeps every control it had", () => {
      const d = frag(T.propFormHtml());
      const want = ["pr-preset", "pr-id", "pr-about", "pr-dday", "pr-mdd", "pr-dtp", "pr-pt", "pr-lot",
        "pr-lotsym", "pr-n", "pr-ps", "pr-dayn", "pr-risk", "pr-holdmin", "pr-maxhold", "pr-gap",
        "pr-cl", "pr-hs", "pr-he", "pr-fri", "pr-nb", "pr-na", "pr-syms", "pr-syms-btn", "pr-syms-q",
        "pr-syms-list", "pr-syms-all", "pr-syms-none", "pr-vio", "pr-news", "pr-we", "pr-hold", "pr-hedge"];
      const missing = want.filter((id) => !d.querySelector("#" + id));
      if (missing.length) throw new Error("lost in the rewrite: " + missing.join(", "));
    });

    check("the status card keeps its switch and its lock controls", () => {
      const d = frag(T.propStatusHtml());
      for (const id of ["prop-enable", "prop-enable-sub", "risk-state", "risk-lock", "risk-dpl", "risk-dd", "pr-lock", "pr-unlock"]) {
        if (!d.querySelector("#" + id)) throw new Error("#" + id + " was lost");
      }
    });

    check("a locked preset still refuses to be edited", () => {
      /* The rules of a funded challenge are not the trader's to change;
         the rewrite must not have unlocked them. */
      const d = frag(T.propFormHtml());
      const fs_ = d.querySelector("fieldset.prop-fields");
      if (!fs_ || !fs_.hasAttribute("disabled")) throw new Error("a preset account's fields are editable");
      if (d.querySelector("#pr-save")) throw new Error("a locked profile offers a save button");
    });

    check("a custom profile can be edited and saved", () => {
      const keep = T.S.snap.prop.profile.id;
      T.S.snap.prop.profile.id = "custom";
      const d = frag(T.propFormHtml());
      T.S.snap.prop.profile.id = keep;
      if (d.querySelector("fieldset.prop-fields").hasAttribute("disabled")) throw new Error("custom fields are locked");
      if (!d.querySelector("#pr-save")) throw new Error("there is no save button");
    });

    /* ---- 6b. the command centre -------------------------------------- */

    check("the account figures are not all the same size", () => {
      /* This has survived two rebuilds because the fault it guards
         against keeps being tempting: putting every number the broker
         reports in one row of equal boxes. Equity is watched, the
         leverage is looked up once a month, and the day's P/L can end
         the account - three different jobs. */
      const d = frag(T.views.command());
      if (d.querySelector(".cmd-strip")) throw new Error("the flat six-column strip is back");
      if (!d.querySelector(".ccx-equity")) throw new Error("there is no headline figure");
      if (!d.querySelectorAll(".ccx-ref-row").length) throw new Error("there are no reference figures");
      if (!d.querySelectorAll(".ccx-risk-row").length) throw new Error("the risk figures are not set apart");
    });

    check("equity is the headline, risk is measured, reference is listed", () => {
      const d = frag(T.views.command());
      if (!d.querySelector('.ccx-equity [data-metric="command.equity"]')) {
        throw new Error("equity is not the headline figure");
      }
      /* The two that can end an account are shown against the limit
         they are a fraction of - a bare percentage does not say how
         much room is left. */
      for (const k of ["command.daily_pl", "command.drawdown"]) {
        const row = d.querySelector(`.ccx-risk-row [data-metric="${k}"]`);
        if (!row) throw new Error(k + " is not shown as a risk figure");
        if (!row.closest(".ccx-risk-row").querySelector(".ccx-risk-bar")) {
          throw new Error(k + " has no bar against its limit");
        }
      }
      for (const k of ["command.balance", "command.margin", "command.free_margin", "command.leverage"]) {
        if (!d.querySelector(`.ccx-ref-row [data-metric="${k}"]`)) {
          throw new Error(k + " is not a reference figure");
        }
      }
    });

    check("a risk bar that reads as live actually moves", () => {
      /* patchMetric writes text only. A bar left behind by the live
         patcher is worse than no bar at all: it looks current and is
         not. */
      const src = appJs.slice(appJs.indexOf('if (v === "command" && mt5Live())'));
      const body = src.slice(0, src.indexOf("\n  if (v ==="));
      if (!/patchRiskBar\("command\.daily_pl"/.test(body)) {
        throw new Error("the daily P/L bar is never moved by the live patcher");
      }
      if (!/patchRiskBar\("command\.drawdown"/.test(body)) {
        throw new Error("the drawdown bar is never moved by the live patcher");
      }
      const fn = appJs.slice(appJs.indexOf("function patchRiskBar"));
      if (!/is-over/.test(fn.slice(0, 900))) {
        throw new Error("the bar moves but never changes state at the limit");
      }
    });

    check("every figure the live patcher writes to is still present and unique", () => {
      /* patchMetric takes the first match in the document, so a
         duplicated key silently updates the wrong one. */
      const d = frag(T.views.command());
      for (const k of ["command.equity", "command.profit", "command.daily_pl", "command.drawdown",
        "command.balance", "command.margin", "command.free_margin", "command.leverage"]) {
        const n = d.querySelectorAll(`[data-metric="${k}"]`).length;
        if (n !== 1) throw new Error(k + " appears " + n + " times");
      }
    });

    check("the account identity is folded in, not repeated in its own card", () => {
      const d = frag(T.views.command());
      const head = d.querySelector(".ccx-head");
      if (!head) throw new Error("there is no masthead");
      if (!head.querySelector("#cmd-acc-type")) throw new Error("the account type left the masthead");
      if (!/Broker/.test(head.textContent)) throw new Error("the broker is no longer shown");
      /* The masthead used to also carry an #ea-strip of attached-chart
         badges. It has gone: it repeated, as pills, exactly what the
         status area underneath already said in words, and it was the
         widest thing in the masthead, so the equity figure - the one
         number this page exists for - was pushed off the first line on
         anything narrower than a desktop. The masthead is now identity
         on one side and equity on the other, and nothing else. */
      if (head.querySelector("#ea-strip")) throw new Error("the chart pill strip is back in the masthead");
    });

    check("the command centre keeps positions full width and the strategy list", () => {
      const d = frag(T.views.command());
      if (!d.querySelector(".card.pos-card #live-pos")) throw new Error("the positions card was lost");
      if (!d.querySelector("#live-st-wrap #live-st")) throw new Error("the live strategy list was lost");
    });

    check("a profit and a loss on the account read differently", () => {
      const d = frag(T.views.command());
      const up = d.querySelector('[data-metric="command.profit"]');
      if (!up.className.includes("up")) throw new Error("a profit of +234.50 is not marked as a gain");
      const keep = T.S.snap.mt5.account.profit;
      T.S.snap.mt5.account.profit = -50;
      const d2 = frag(T.views.command());
      T.S.snap.mt5.account.profit = keep;
      if (!d2.querySelector('[data-metric="command.profit"]').className.includes("down")) {
        throw new Error("a loss is not marked as a loss");
      }
    });

    /* ---- 2b. settings ------------------------------------------------- */

    check("the settings rail is names, not a second column of tags", () => {
      /* Four of the ten entries used to carry a state word - "on",
         "off", "linked", "not linked". The intent was to answer
         "which of these needs attention", but four tags among ten
         names is not an answer; it is more text to read before you
         can find the entry you came for, and it duplicated what each
         section already says at the top of itself. */
      const d = frag(T.views.settings());
      const rail = d.querySelector("#set-jump");
      if (!rail) throw new Error("the rail is gone");
      if (rail.querySelector(".sj-state")) throw new Error("a state tag is still in the rail");
      const buttons = [...rail.querySelectorAll("button[data-jump]")];
      if (buttons.length < 8) throw new Error("the rail lost entries");
      for (const b of buttons) {
        const kids = [...b.children].map((x) => x.className);
        if (kids.some((c) => !/sj-(ic|txt)/.test(c))) {
          throw new Error("a rail entry carries something other than its icon and name: " + kids.join(","));
        }
      }
    });

    check("on a phone the rail is a sheet, not a strip that hides six of its eight entries", () => {
      /* Below 1000px the rail used to become a horizontal scroller:
         .sj-grp display:none, .sj-txt small display:none, and eight
         chips in a row that showed about three. The headings and the
         line of text saying what each section decides were the first
         things dropped, which is backwards - they are the reason the
         rail earns its space. */
      const d = frag(T.views.settings());
      const open = d.querySelector("#set-sheet-open");
      if (!open) throw new Error("nothing opens the sheet");
      if (open.getAttribute("aria-controls") !== "set-jump") throw new Error("the trigger is not tied to the nav");
      if (open.getAttribute("aria-expanded") !== "false") throw new Error("the trigger does not report its state");
      if (!d.querySelector("#set-sheet-now")) throw new Error("the closed sheet does not name the current section");
      for (const id of ["set-sheet-scrim", "set-sheet-grab", "set-sheet-close", "set-sheet-bar"]) {
        if (!d.querySelector("#" + id)) throw new Error("the sheet has no " + id);
      }

      const m = /@media \(max-width:1000px\)\{([\s\S]*?)\n\}\n/.exec(appCss);
      if (!m) throw new Error("the 1000px rung is gone");
      const rung = m[1];
      if (/\.sj-grp\{display:none\}/.test(rung.replace(/\s+/g, ""))) {
        throw new Error("the group headings are hidden again");
      }
      if (/\.sj-txt small\{display:none\}/.test(rung)) {
        throw new Error("the descriptions are hidden again");
      }
      if (/overflow-x:auto/.test(rung)) throw new Error("the sideways scroller is back");
      const tight = rung.replace(/\s+/g, "");
      if (!/\.set-jump\.is-sheet\{[^}]*position:fixed/.test(tight)) throw new Error("the sheet is not anchored to the viewport");
      if (!/inset-block-end:0/.test(tight)) throw new Error("the sheet is not at the bottom edge");
      if (!/html\.set-sheet-open\.set-jump\.is-sheet\{transform:translateY\(0\)/.test(tight)) {
        throw new Error("opening the sheet does not bring it on screen");
      }
      /* A sheet that slides has to be laid out while closed, so it is
         translated away rather than displayed none. */
      if (/\.set-jump\.is-sheet\{[^}]*display:none/.test(tight)) throw new Error("the closed sheet is display:none and cannot slide");
      if (!/touch-action:none/.test(tight)) throw new Error("the handle will be stolen by the page's own scrolling");
      /* The desktop rail must be untouched by all of it. */
      if (!/^\.sj-open,\.sj-scrim,\.sj-grab,\.sj-sheet-head,\.sj-bar\{display:none\}/m.test(appCss)) {
        throw new Error("the sheet furniture shows on the desktop rail too");
      }
    });

    check("the opener floats on the bottom edge and the sections clear it", () => {
      /* It was a row at the top of the page: the furthest point from
         the thumb, and a line of height spent on a screen that has
         none spare. Now fixed to the bottom - which means the page
         below it has to reserve the room, or the last section sits
         under it unreachable. */
      const d = frag(T.views.settings());
      const bar = d.querySelector("#set-sheet-bar");
      if (!bar) throw new Error("there is no bar");
      if (!bar.contains(d.querySelector("#set-sheet-open"))) throw new Error("the opener is not in the bar");
      /* Last in the DOM as well as last on the screen, so the reading
         order and the tab order match what the eye sees. */
      const main = d.querySelector(".set-main");
      if (!main) throw new Error("no main column");
      if (!(bar.compareDocumentPosition(main) & 4)) {
        throw new Error("the bar still comes before the sections in the DOM");
      }
      const m = /@media \(max-width:1000px\)\{([\s\S]*?)\n\}\n/.exec(appCss);
      const tight = m[1].replace(/\s+/g, "");
      if (!/\.sj-bar\{[^}]*position:fixed/.test(tight)) throw new Error("the bar does not float");
      if (!/\.sj-bar\{[^}]*inset-block-end:/.test(tight)) throw new Error("the bar is not on the bottom edge");
      if (!/\.set-main\{padding-block-end:/.test(tight)) {
        throw new Error("the sections run underneath the floating bar");
      }
      /* Toasts land on the same edge. */
      if (!/body\.has-set-bar\.toast-wrap\{inset-block-end:/.test(tight)) {
        throw new Error("a toast would appear on top of the bar");
      }
      /* And the bar steps aside rather than sitting behind the sheet. */
      if (!/html\.set-sheet-open\.sj-bar\{opacity:0/.test(tight)) {
        throw new Error("the bar stays put under the open sheet");
      }
    });

    check("the sheet is parented to the body, not to the animating stage", () => {
      /* .stage.is-entering animates `rise`, a transform, for 480ms on
         every view change, and a transformed ancestor becomes the
         containing block for its fixed descendants. Rendered inside
         the stage, the sheet and the bar were positioned against the
         stage rather than the viewport for the first half-second on
         the page - and the stage is overflow:auto, so they were
         clipped by it as well. Same fault, same cure, as the
         calendar's day card. */
      if (!/function sweepSetSheet\(\)/.test(appJs)) throw new Error("there is no sweep");
      const portal = appJs.slice(appJs.indexOf("function portalSetSheet()"), appJs.indexOf("function bindSetSheet()"));
      if (!/document\.body\.appendChild/.test(portal)) throw new Error("nothing is portaled");
      for (const id of ["set-sheet-scrim", "set-jump", "set-sheet-bar"]) {
        if (!portal.includes(id)) throw new Error(id + " is left behind in the stage");
      }
      /* Unconditional, and before the stage is rebuilt: Settings
         re-renders itself in place when the light cut or the
         breakpoint changes, and a guarded sweep would leave a portaled
         copy behind and give the document two #set-jump. */
      /* Anchored on show()'s own paint: "const paint = () => {" alone
         also matches the gate-slide renderer earlier in the file. */
      const show = appJs.slice(appJs.indexOf("const paint = () => {\n    S._paintTimer = null;"),
                               appJs.indexOf("S.mountedView = view;"));
      const sweepAt = show.indexOf("sweepSetSheet()");
      const wipeAt = show.indexOf("stage.innerHTML =");
      if (sweepAt < 0) throw new Error("leaving settings leaves the sheet on screen");
      if (sweepAt > wipeAt) throw new Error("the sweep runs after the new copy has been rendered");
      if (/if \(changing\) sweepSetSheet/.test(appJs)) throw new Error("the sweep is guarded on a view change");
      /* Portaled out of .set-rail, so the open state cannot be a class
         on the settings desk and the rules cannot be scoped to it. */
      if (/desk\.classList\.(add|remove)\("sheet-open"\)/.test(appJs)) {
        throw new Error("the open state is still a class on the desk the sheet no longer lives in");
      }
      if (!/classList\.add\("is-sheet"\)/.test(portal)) throw new Error("the portaled nav is not marked, so the sheet rules cannot reach it");
    });

    check("the sheet can be closed by dragging it away, not only by a button", () => {
      /* The handle at the top of a sheet is a promise. A sheet that
         draws one and then only responds to a close button has told
         the thumb something untrue. */
      const fn = appJs.slice(appJs.indexOf("function bindSetSheet()"), appJs.indexOf("function showSetTab("));
      if (!fn) throw new Error("the sheet is never bound");
      for (const ev of ["pointerdown", "pointermove", "pointerup", "pointercancel"]) {
        if (!fn.includes(ev)) throw new Error("the drag does not handle " + ev);
      }
      if (!/setPointerCapture/.test(fn)) throw new Error("the drag is lost the moment the finger leaves the handle");
      if (!/offsetHeight \* 0\.25/.test(fn)) throw new Error("there is no distance threshold");
      if (!/flick/.test(fn)) throw new Error("a fast short flick does not close it");
      /* And the three other ways out. */
      if (!/scrim\.onclick/.test(fn)) throw new Error("tapping outside does not close it");
      if (!/e\.key !== "Escape"/.test(fn)) throw new Error("Escape does not close it");
      if (!/mq\.matches|S\.view === "settings"/.test(fn)) throw new Error("crossing the breakpoint leaves the sheet state behind");
      /* Choosing a section is the commonest dismissal of all. */
      const bind = appJs.slice(appJs.indexOf('const jump = $("set-jump");'));
      if (!/showSetTab\(b\.dataset\.jump\);[\s\S]{0,400}?closeSetSheet\(\);/.test(bind)) {
        throw new Error("picking a section leaves the sheet covering it");
      }
    });

    check("only the entries scroll, so a drag on the handle is not a scroll", () => {
      /* The handle and the title were position:sticky inside the
         scrolling nav, with hand-counted top offsets that came apart
         as soon as either changed height - and a drag starting on a
         sticky handle inside a scroller is competing with that
         scroller. The nav is a flex column now: handle, title and
         search are flex:none, and a single region holds the list. */
      const d = frag(T.views.settings());
      const list = d.querySelector("#set-jump .sj-list");
      if (!list) throw new Error("the entries are not in a region of their own");
      const n = list.querySelectorAll("button[data-jump]").length;
      if (n !== 8) throw new Error("the list holds " + n + " entries, expected 8");
      if (d.querySelector("#set-jump > button[data-jump]")) {
        throw new Error("an entry is outside the scrolling region");
      }
      /* On the rail the wrapper must not exist as far as layout goes. */
      if (!/^\.sj-list\{display:contents\}/m.test(appCss)) {
        throw new Error("the wrapper changes the desktop rail's layout");
      }
      const m = /@media \(max-width:1000px\)\{([\s\S]*?)\n\}\n/.exec(appCss);
      const tight = m[1].replace(/\s+/g, "");
      if (!/\.sj-list\{[^}]*overflow-y:auto/.test(tight)) throw new Error("the list does not scroll");
      if (!/\.sj-list\{[^}]*flex:1 1 auto/.test(tight.replace(/flex:1 1 auto/g, "flex:1 1 auto"))
          && !/\.sj-list\{[^}]*flex:11auto/.test(tight)) {
        throw new Error("the list does not take the leftover height");
      }
      if (!/\.set-jump\.is-sheet\{[^}]*overflow:hidden/.test(tight)) {
        throw new Error("the sheet itself still scrolls, so it fights the drag");
      }
      /* Comments stripped first: this block explains the sticky boxes
         it replaced, and the explanation is not the thing being
         forbidden. */
      if (/position:sticky/.test(tight.replace(/\/\*[\s\S]*?\*\//g, ""))) {
        throw new Error("the sticky offsets are back");
      }
    });

    check("but the broker section still states whether it is connected", () => {
      /* Removing the rail tag must not remove the information. It
         belongs in the section, where you can act on it. */
      const keep = T.S.snap.mt5.connected;
      try {
        T.S.snap.mt5.connected = true;
        const on = frag(T.views.settings()).querySelector("#s-msg").textContent;
        T.S.snap.mt5.connected = false;
        const off = frag(T.views.settings()).querySelector("#s-msg").textContent;
        if (!on.trim() || !off.trim()) throw new Error("the broker section says nothing about its state");
        if (on === off) throw new Error("connected and disconnected read the same");
      } finally { T.S.snap.mt5.connected = keep; }
    });

    check("every settings section says what it decides", () => {
      /* A heading that repeats the rail label tells you nothing twice. */
      const d = frag(T.views.settings());
      const blocks = [...d.querySelectorAll(".set-block")];
      /* Eight, not nine: the Strategies section was a second copy of
         the Strategies page - same cards, same uploader, same element
         ids - so whichever one rendered second won the ids. */
      if (blocks.length !== 8) throw new Error(blocks.length + " sections, expected 8");
      for (const b of blocks) {
        const h = b.querySelector(".stx-head");
        if (!h) throw new Error(b.id + " has no section header");
        if (!h.querySelector(".set-title")) throw new Error(b.id + " lost its title");
        const why = h.querySelector(".stx-why");
        const title = h.querySelector(".set-title").textContent.trim();
        /* The harness runs without a loaded dictionary, so I18N.t
           echoes the key back - which is enough to prove the line is
           there and is a different string from the heading, and not
           enough to prove it is a sentence. The sentences are checked
           by check-lang.mjs, which is where they live. */
        if (!why || !why.textContent.trim()) {
          throw new Error(b.id + " does not say what it is for");
        }
        if (why.textContent.trim() === title) {
          throw new Error(b.id + " just repeats its own heading");
        }
      }
    });

    check("the settings shell is declared once, not three times", () => {
      /* .set-jump had three complete from-scratch definitions in this
         stylesheet, each overridden by the next. Grepping for it found
         a rule and proved nothing about which one was in force. */
      const bases = (appCss.match(/^\.set-jump\s*\{/gm) || []).length;
      if (bases) throw new Error(bases + " unscoped .set-jump base rule(s) are back");
      const scoped = (appCss.match(/^\.set-rail \.set-jump\s*\{/gm) || []).length;
      if (scoped !== 1) throw new Error("the rail is declared " + scoped + " times outside media queries");
    });

    check("the light-mode rail follows the chosen accent", () => {
      /* It was two literal rgba teals, so any other accent came out
         right on dark and wrong on light. */
      const i = appCss.indexOf('html[data-theme="light"] .set-rail .set-jump button.on');
      if (i < 0) throw new Error("the light rail override is gone");
      const rule = appCss.slice(i, appCss.indexOf("}", i));
      if (/rgba\(/.test(rule)) throw new Error("the light rail is still painted with a literal colour");
      if (!/var\(--accent-rgb\)/.test(rule)) throw new Error("the light rail does not use the accent");
    });

    /* ---- 2c. profile --------------------------------------------------- */

    check("one card does not do four unrelated jobs", () => {
      /* The plan card had four <h3>s in it: what is active, what you
         could buy, the pay button, and the receipts. Four sections
         inside one card is four sections pretending to be one, and it
         put "Pay and activate" in the middle of a stack. */
      const d = frag(T.views.profile());
      for (const card of d.querySelectorAll(".card")) {
        const n = card.querySelectorAll(".pfx-head").length;
        if (n > 2) throw new Error(`a card carries ${n} section headings`);
      }
      const pay = d.querySelector("#pf-pay");
      const grid = d.querySelector("#plan-grid");
      if (!pay || !grid) throw new Error("the plan chooser lost a part");
      if (pay.closest(".card") !== grid.closest(".card")) {
        throw new Error("the pay button is not in the card it pays for");
      }
      /* And the receipts are not between them. */
      if (d.querySelector("#pf-pays").closest(".card") === grid.closest(".card")) {
        throw new Error("the payment history shares a card with the chooser");
      }
    });

    check("preferences and security do not share a save button", () => {
      const d = frag(T.views.profile());
      const prefs = d.querySelector("#pf-save").closest(".card");
      const pass = d.querySelector("#pf-pass").closest(".card");
      if (prefs === pass) throw new Error("one Save covers both a display name and a password");
    });

    check("two-factor state is a word before it is a colour", () => {
      const d = frag(T.views.profile());
      const state = d.querySelector(".pfx-state");
      if (!state || !state.textContent.trim()) throw new Error("the 2FA state is not stated");
      if (!/is-(on|off)/.test(state.className)) throw new Error("the 2FA state carries no class to colour");
    });

    check("the avatar is sized once, not twice", () => {
      /* .prof-ava was declared twice nineteen lines apart - 76px with a
         shadow, then 64px without - so the avatar was a size nobody
         chose and half the rule had been dead for months. */
      const n = (appCss.match(/^\.pfx-ava\s*\{/gm) || []).length;
      if (n !== 1) throw new Error(`.pfx-ava is declared ${n} times`);
      if (/^\.prof-ava\s*\{/m.test(appCss)) throw new Error("the old duplicated rule is still here");
    });

    /* ---- 2d. execution -------------------------------------------------- */

    check("the pending-orders heading is not the words \"no pending orders\"", () => {
      /* It was. The heading over the table was I18N.t("status.no_orders"),
         so with two live orders the page announced "No pending orders"
         and then listed two. */
      const S2 = JSON.parse(JSON.stringify(T.S.snap || {}));
      T.S.snap.orders = [{ ticket: 1, symbol: "EURUSD", type: "buy limit", volume: 0.1, price: 1.05 }];
      let d;
      try { d = frag(T.views.execution()); } finally { T.S.snap = S2; }
      const empty = T.I18N.t("status.no_orders");
      const heads = [...d.querySelectorAll("h3")].map((h) => h.textContent.trim());
      if (heads.includes(empty)) throw new Error("the heading is still the empty-state sentence");
      if (!heads.includes(T.I18N.t("exec.orders"))) throw new Error("the orders section lost its heading");
    });

    check("flatten-all is fenced off and last", () => {
      /* Close every position at market, no undo. It used to sit in the
         middle of the left card, directly above the manual buy/sell
         buttons - one slip from the controls you use all day. */
      const d = frag(T.views.execution());
      const flat = d.querySelector("#ex-flat");
      if (!flat) throw new Error("the emergency control vanished");
      const zone = flat.closest(".exx-danger");
      if (!zone) throw new Error("the emergency control is not in a marked-off zone");
      const buy = d.querySelector("#ex-buy");
      if (buy && buy.closest(".card") === zone) throw new Error("the manual ticket shares the danger zone");
      /* Nothing interactive after it. */
      const all = [...d.querySelectorAll("button, input, select")];
      if (all.indexOf(flat) !== all.length - 1) throw new Error("something sits after the emergency control");
    });

    check("the disconnected notice leads instead of trailing", () => {
      /* "MetaTrader is not connected" means nothing on this page can
         trade at all. It was a grey <p class="sub"> at the bottom,
         under the order ticket it invalidates. mt5Live() is true when
         mt5.connected OR any agent is live, so both have to go. */
      const keep = JSON.parse(JSON.stringify(T.S.snap || {}));
      T.S.snap.mt5 = { connected: false };
      T.S.snap.agents = [];
      let d;
      try { d = frag(T.views.execution()); } finally { T.S.snap = keep; }
      const off = d.querySelector(".exx-off");
      if (!off) throw new Error("no notice is shown while MetaTrader is down");
      /* Not "above everything" - gateHtml() can put a licence gate
         first, and that outranks it. Above the thing it invalidates:
         the order ticket, and the rest of the page with it. */
      const ticket = d.querySelector("#ex-buy").closest(".card");
      /* DOCUMENT_POSITION_FOLLOWING = 4 */
      if (!(off.compareDocumentPosition(ticket) & 4)) {
        throw new Error("the notice sits below the ticket it invalidates");
      }
      if (!(off.compareDocumentPosition(d.querySelector(".exx-cols")) & 4)) {
        throw new Error("the notice is not above the body of the page");
      }
    });

    /* ---- 3. About ----------------------------------------------------- */

    check("the About page shows the build stamp in the new format", () => {
      const d = frag(T.views.about());
      if (!/DSK-281026/.test(d.textContent)) throw new Error("the DSK stamp is not on the page");
      if (/2026-10-28/.test(d.textContent)) throw new Error("the raw ISO date is still printed");
    });

    check("the build stamp is printed, not hidden behind a copy button", () => {
      /* This used to assert that the copy-to-clipboard button put the
         build stamp next to the version, because "v2.4.1" alone does
         not say which build a customer is running.

         The requirement survives; the button does not. It copied a
         string the page already prints in full, in selectable text,
         two lines further down - a control to do by hand what the
         hand could already do. What matters is that the stamp is on
         the page at all, so that is what is checked. */
      const about = appJs.slice(appJs.indexOf("  about() {"), appJs.indexOf("\n  profile() {"));
      if (/about-copy-ver/.test(about)) throw new Error("the copy button is back");
      if ((about.match(/buildTag\(buildDate\)/g) || []).length < 2) {
        throw new Error("the build stamp is not printed beside the version");
      }
    });

    check("the About page leads with what it is, and says nothing about state", () => {
      /* Rebuilt twice. It was an identity rail beside a stack of cards;
         then a banner, a six-chip live-state row, and a detail grid.
         The state row has now gone too. It answered "is the engine up,
         is MT5 connected, how many charts" - which is the Command
         centre's entire job, answered there on the screen a trader
         actually watches. Here it was a slower second copy, right only
         while the page happened to be open.

         What is left is what the page is uniquely for: what this build
         is, and what to paste into a support message. */
      const d = frag(T.views.about());
      const hero = d.querySelector(".abx-hero");
      if (!hero) throw new Error("no banner");
      if (!hero.querySelector("#about-check-update")) {
        throw new Error("the update check is not in the banner");
      }
      if (d.querySelector(".abx-state")) throw new Error("the live state row is back");
      if (!d.querySelector(".abx-facts")) throw new Error("no detail");
      /* And all of it in one container, not a banner plus a grid of
         cards: three bordered boxes and three shadows were holding
         eleven short facts, which is furniture standing in for
         content. */
      const panels = d.querySelectorAll(".card");
      if (panels.length !== 1) throw new Error(panels.length + " cards on the page, expected 1");
      const html = T.views.about();
      const order = ["abx-hero", "abx-facts", "abx-maker"].map((c) => html.indexOf(c));
      if (order.some((i) => i < 0) || order[0] > order[1] || order[1] > order[2]) {
        throw new Error("the page is not in the order banner, facts, maker");
      }
    });
  }
}

/* ======================================================================
   Responsive rules — the most that can be asserted without a browser
   ====================================================================== */

check("every rebuilt section has narrow-screen rules", () => {
  const flat = appCss.replace(/\s*\n\s*/g, "");
  const want = {
    "the command centre": /@media\s*\(max-width:560px\)\{[^@]*\.ccx-head\{\s*grid-template-columns:minmax\(0,1fr\)/,
    "prop risk": /@media\s*\(max-width:560px\)\{[^@]*\.pr-meters,\.pr-grid,\.pr-checks\{grid-template-columns:minmax\(0,1fr\)\}/,
    "the AI page": /@media\s*\(max-width:560px\)\{[^@]*\.ai-read\{grid-template-columns:minmax\(0,1fr\)\}/,
  };
  const missing = Object.keys(want).filter((k) => !want[k].test(flat));
  if (missing.length) throw new Error("no phone rules for: " + missing.join(", "));
});

check("the positions list sheds detail rather than overflowing on a phone", () => {
  const flat = chartCss.replace(/\s*\n\s*/g, "");
  if (!/@media\s*\(max-width:\s*560px\)\{[^@]*\.tv-pos-lv,\.tv-pos-at\{display:none\}/.test(flat)) {
    throw new Error("the list keeps all six columns on a phone");
  }
});

check("the rebuilt sections dropped their inline styles", () => {
  const spans = [
    ["command", "  command() {", "  markets() {"],
    ["intelligence", "  intelligence() {", "  calendar() {"],
    ["about", "  about() {", "  profile() {"],
    ["settings", "  settings() {", "  about() {"],
    ["propStatusHtml", "function propStatusHtml() {", "/**\n * One numeric prop-rule field."],
    ["propFormHtml", "function propFormHtml() {", "/**\n * The prop guide"],
    ["analysisCardHtml", "function analysisCardHtml() {", "\nconst views = {"],
  ];
  const bad = [];
  for (const [name, a, b] of spans) {
    const i = appJs.indexOf(a), j = appJs.indexOf(b);
    if (i < 0 || j < 0) { bad.push(name + " (not found)"); continue; }
    /* style="--w:42%" is a computed value handed to the stylesheet and
       is the only correct way to pass one; it is not what "inline
       styles" means here. Anything else is. */
    const all = appJs.slice(i, j).match(/style="[^"]*"/g) || [];
    const n = all.filter((st) => !/^style="\s*(--[\w-]+:[^;"]*;?\s*)+"$/.test(st)).length;
    if (n) bad.push(`${name} (${n})`);
  }
  if (bad.length) throw new Error("inline styles remain in: " + bad.join(", "));
});

check("the dead KPI renderer went with the strip it fed", () => {
  if (/function kpi\(key, value, suffix, signed\)/.test(appJs)) {
    throw new Error("the global kpi() helper is still there with no caller");
  }
  if (/\.cmd-strip\{/.test(appCss)) throw new Error(".cmd-strip is still styled with nothing using it");
});

check("every new string is translated in all three languages", () => {
  const want = {
    exec: ["close_title", "close_confirm", "close_confirm_one"],
    chart: ["pos_expand", "pos_collapse"],
    risk: ["of_limit", "no_limit"],
  };
  const missing = [];
  for (const code of ["en", "fa", "ar"]) {
    const d = JSON.parse(fs.readFileSync(path.join(ROOT, "lang", code + ".json"), "utf8"));
    for (const [sec, keys] of Object.entries(want)) {
      for (const k of keys) if (!d[sec] || !d[sec][k]) missing.push(`${code}.${sec}.${k}`);
    }
    if (!d.ai || !d.ai.an || !d.ai.an.needs) missing.push(`${code}.ai.an.needs`);
  }
  if (missing.length) throw new Error("missing: " + missing.join(", "));
});

Promise.all(pending).then(() => {
  const passed = results.filter(Boolean).length;
  console.log(`\ndesk-redesign: ${passed} of ${results.length} checks passed`);
  process.exit(passed === results.length ? 0 : 1);
});
