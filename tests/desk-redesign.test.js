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
    win.eval(bundle + "\n;window.__T = { S, views, propStatusHtml, propFormHtml, analysisCardHtml, positionsStripHtml, paintChartPositions, patchLive, bindCloseButtons, API, setConfirm(f){ askConfirm = f; } };");
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
      const h = /\$\("stage"\)\?\.querySelectorAll\("\[data-open-chart\]"\)[\s\S]{0,1400}?\n      \}\);/.exec(appJs);
      if (!h) throw new Error("could not find the chart-grid handler");
      const body = h[0];
      if (!/closest\("button/.test(body)) {
        throw new Error("a press on a control inside the card still opens the chart");
      }
      const guardAt = body.indexOf("closest(\"button");
      const openAt = body.indexOf("openChartDesk(");
      if (guardAt > openAt) throw new Error("the guard runs after the chart has already opened");
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
      if (!/id="tvd-pos"/.test(chartJs)) throw new Error("the dock container went too");
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

    check("the account figures are no longer six identical boxes", () => {
      const d = frag(T.views.command());
      if (d.querySelector(".cmd-strip")) throw new Error("the flat six-column strip is still there");
      const hero = d.querySelector(".cmd-acct-hero");
      if (!hero) throw new Error("there is no headline figure");
      if (!d.querySelectorAll(".cmd-sub").length) throw new Error("there are no secondary figures");
    });

    check("equity is the headline and the reference figures sit under it", () => {
      const d = frag(T.views.command());
      const hero = d.querySelector('.cmd-acct-hero [data-metric="command.equity"]');
      if (!hero) throw new Error("equity is not the headline figure");
      for (const k of ["command.balance", "command.margin", "command.free_margin", "command.leverage"]) {
        const el = d.querySelector(`.cmd-sub [data-metric="${k}"]`);
        if (!el) throw new Error(k + " is not a secondary figure");
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
      const acct = d.querySelector(".cmd-acct");
      if (!acct.querySelector("#cmd-acc-type")) throw new Error("the account type left the account card");
      if (!/Broker/.test(acct.textContent)) throw new Error("the broker is no longer shown");
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

    /* ---- 3. About ----------------------------------------------------- */

    check("the About page shows the build stamp in the new format", () => {
      const d = frag(T.views.about());
      if (!/DSK-281026/.test(d.textContent)) throw new Error("the DSK stamp is not on the page");
      if (/2026-10-28/.test(d.textContent)) throw new Error("the raw ISO date is still printed");
    });

    check("the version line a user copies carries the build too", () => {
      /* It exists to be pasted into a support message, and "v2.4.1"
         alone does not say which build. */
      const h = /const copy = \$\("about-copy-ver"\);[\s\S]{0,700}?\n    \};/.exec(appJs);
      if (!h) throw new Error("the copy handler is gone");
      if (!/buildTag\(/.test(h[0])) throw new Error("the copied string has no build stamp");
    });

    check("the About page leads with what it is and whether it is running", () => {
      /* Rebuilt from scratch. It used to be an identity rail beside a
         stack of cards, and this check pinned that shape. The shape is
         not the point - the order is. A trader opens this page to find
         out whether the system is up and what to paste into a support
         message, and both of those now come before the reference
         detail rather than after a logo and a blurb. */
      const d = frag(T.views.about());
      const hero = d.querySelector(".abx-hero");
      if (!hero) throw new Error("no banner");
      if (!hero.querySelector("#about-copy-ver")) {
        throw new Error("the support actions are not in the banner");
      }
      if (!d.querySelector(".abx-state")) throw new Error("no live state row");
      if (!d.querySelector(".abx-cols")) throw new Error("no detail grid");
      const html = T.views.about();
      const order = ["abx-hero", "abx-state", "abx-cols"].map((c) => html.indexOf(c));
      if (order.some((i) => i < 0) || order[0] > order[1] || order[1] > order[2]) {
        throw new Error("the page is not in the order banner, state, detail");
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
    "the command centre": /@media\s*\(max-width:560px\)\{[^@]*\.cmd-acct-top\{flex-direction:column/,
    "prop risk": /@media\s*\(max-width:560px\)\{[^@]*\.pr-meters,\.pr-grid,\.pr-checks\{grid-template-columns:minmax\(0,1fr\)\}/,
    "the AI page": /@media\s*\(max-width:560px\)\{[^@]*\.ai-read\{grid-template-columns:minmax\(0,1fr\)\}/,
  };
  const missing = Object.keys(want).filter((k) => !want[k].test(flat));
  if (missing.length) throw new Error("no phone rules for: " + missing.join(", "));
});

check("the positions list sheds detail rather than overflowing on a phone", () => {
  const flat = chartCss.replace(/\s*\n\s*/g, "");
  if (!/@media\s*\(max-width:620px\)\{[^@]*\.tv-pos-lv,\.tv-pos-at\{display:none\}/.test(flat)) {
    throw new Error("the list keeps all six columns on a phone");
  }
});

check("the rebuilt sections dropped their inline styles", () => {
  const spans = [
    ["command", "  command() {", "  markets() {"],
    ["intelligence", "  intelligence() {", "  calendar() {"],
    ["about", "  about() {", "  profile() {"],
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
