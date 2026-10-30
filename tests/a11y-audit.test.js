/**
 * Accessibility audit — every view, every render.
 *
 * This suite exists because an audit run once is a number in a chat
 * log. It found 100 defects across the fourteen views, and every one
 * of them was the kind that is invisible to the person who wrote it:
 * a toggle switch whose entire content is an empty <i>, a <select>
 * with no name, a <th> with no scope. None of them look wrong. All of
 * them mean the control does not exist for anyone using a screen
 * reader or voice control.
 *
 * The checks are deliberately the ones a DOM can answer without a
 * layout engine. Contrast, focus order and touch-target size are real
 * requirements too, but asserting them here would mean asserting
 * something other than what they are, so they live in
 * tests/appearance.test.js and tests/button-centring.test.js where
 * the CSS is read directly.
 *
 * Rule sources: ui-ux-pro-max priority 1 (Accessibility), 8 (Forms &
 * Feedback) and 10 (Charts & Data).
 *
 * Run: node tests/a11y-audit.test.js
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const WEB = path.join(ROOT, "apps", "web");
const read = (p) => fs.readFileSync(path.join(WEB, p), "utf8");

let jsdom = null;
try { jsdom = require(require.resolve("jsdom")); } catch { /* optional */ }
if (!jsdom) {
  console.log("SKIP  a11y audit (jsdom not installed)");
  process.exit(0);
}

const { JSDOM, VirtualConsole } = jsdom;
const dom = new JSDOM(read("index.html"), {
  url: "http://localhost/",
  runScripts: "outside-only",
  pretendToBeVisual: true,
  virtualConsole: new VirtualConsole(),
});
const win = dom.window;
win.fetch = async () => ({ ok: true, json: async () => ({ ok: true, data: {} }) });
win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
win.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
win.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
win.URL.createObjectURL = () => "blob:stub";
win.AudioContext = class { createGain() { return { connect() {}, gain: {} }; } };
/* No canvas backend here, and a view that paints on render would
   throw before it returned its markup. */
win.HTMLCanvasElement.prototype.getContext = () => null;

const bundle = ["js/themes.js", "js/skins.js", "js/i18n.js", "js/api.js", "js/calendar.js", "js/charts.js", "js/app.js"]
  .map(read).join("\n;\n");
win.eval(bundle + "\n;window.__T = { S, views, I18N };");
const T = win.__T;

/* With the real dictionary loaded. An audit against I18N.t echoing
   its own keys back would pass on labels that are empty in every
   language the product actually ships. */
T.I18N.pack = JSON.parse(fs.readFileSync(path.join(ROOT, "lang", "en.json"), "utf8"));
T.S.version = "1.4.0";
T.S.buildDate = "2026-10-30";
const agent = (symbol, timeframe) => ({ symbol, timeframe, alive: true, online: true, last_seen: Date.now() });
T.S.snap = {
  engine: "online",
  agents: [agent("EURUSD", "M15"), agent("XAUUSD", "H1")],
  mt5: {
    connected: true,
    account: {
      login: 51234, company: "Broker Capital Ltd", server: "Live07", account_type: "real",
      account_label: "real", currency: "USD", leverage: 500, margin_mode: "hedging",
      equity: 24318.42, balance: 24083.92, profit: 234.5, margin: 1860, margin_free: 22458.42,
    },
  },
  prop: {
    enabled: true, locked: false, daily_pl_pct: -1.42, drawdown_pct: 3.9,
    profile: { id: "ftmo_challenge", max_daily_loss_pct: 5, max_drawdown_pct: 10 },
  },
  strategy: { name: "smart_money", auto_trade: true },
  telegram: { enabled: false, chats: [] },
  positions: [{
    ticket: 1, symbol: "EURUSD", type: "buy", volume: 0.2, strategy: "smart_money",
    price_open: 1.0842, price_current: 1.0861, sl: 1.081, tp: 1.092, profit: 38, profit_pct: 0.16,
  }],
  orders: [{ ticket: 9, symbol: "EURUSD", type: "buy_limit", volume: 0.1, price: 1.07, sl: 1.06, tp: 1.09, strategy: "trend" }],
  history: [],
  ai: { symbol: "EURUSD", confidence: 0.42, regime: "trend", pattern: "flag", samples: 120, need: 200, features: {}, activity: [] },
  license: { premium: true, plan: "pro" },
  kill_switch: false, ticks: {}, strategies: [],
};

const VIEWS = ["command", "markets", "intelligence", "calendar", "strategies", "execution",
  "charts", "terminal", "backtest", "history", "upgrade", "settings", "about", "profile"];

/* Rendering each view once covers the branch the fixture happens to
   take and nothing else. The first pass of this audit passed Profile
   clean while a 2FA code box with no label sat in the branch that
   renders when two-factor is already ON - a state the fixture did not
   have. A control is not accessible because the happy path is.
   These are the state flips that change what the views emit. */
const STATES = [
  ["default", () => {}],
  ["nothing connected", () => {
    T.S.snap.mt5.connected = false;
    T.S.snap.agents = [];
    T.S.snap.engine = "offline";
    T.S.snap.positions = [];
    T.S.snap.orders = [];
  }],
  ["two-factor on, free plan, prop off", () => {
    T.S.user = { ...(T.S.user || {}), totp_enabled: true, gmail: "a@b.c", phone: "+1" };
    T.S.snap.license = { premium: false, plan: "trial", paid: false };
    T.S.snap.prop.enabled = false;
    T.S.snap.telegram = { enabled: true, chats: [{ id: 1, title: "Desk" }] };
  }],
  ["locked out and killed", () => {
    T.S.snap.kill_switch = true;
    T.S.snap.prop.locked = true;
    T.S.snap.prop.lock_reason = "daily loss reached";
    T.S.snap.strategy.auto_trade = false;
  }],
];

const failures = [];
const fail = (rule, where) => { if (where) failures.push(`${rule}\n      ${where}`); };
const txt = (el) => (el.textContent || "").replace(/\s+/g, " ").trim();
const named = (el) => Boolean(txt(el) || el.getAttribute("aria-label") ||
  el.getAttribute("aria-labelledby") || el.getAttribute("title"));

const BASE_SNAP = JSON.stringify(T.S.snap);
const BASE_USER = JSON.stringify(T.S.user || {});
const seen = new Set();

for (const [stateName, apply] of STATES) {
  T.S.snap = JSON.parse(BASE_SNAP);
  T.S.user = JSON.parse(BASE_USER);
  apply();

for (const view of VIEWS) {
  let html;
  try {
    html = T.views[view]();
  } catch (e) {
    fail("a view throws while rendering", `${view} [${stateName}]: ${e.message}`);
    continue;
  }
  const d = win.document.createElement("div");
  d.innerHTML = html;
  /* The same defect found in four states is one defect. */
  const at = (s) => {
    const key = `${view}|${s}`;
    return seen.has(key) ? null : (seen.add(key), `${view} [${stateName}]: ${s}`);
  };

  /* 1. A control with no accessible name does not exist.
        Not to a screen reader, and not to voice control, which needs
        a name to be able to say "click auto trade" at all. Sixteen
        toggle switches on this desk were a <button> wrapping one
        empty <i>. */
  for (const b of d.querySelectorAll("button, a[href], [role=button]")) {
    if (!named(b)) fail("a control has no accessible name", at(`<${b.tagName.toLowerCase()} class="${b.className}" id="${b.id}">`));
  }

  /* 2. An icon beside its own visible label is decoration. A reader
        that announces both says the name twice; worse, an unlabelled
        <svg> can be announced as "graphic". */
  for (const b of d.querySelectorAll("button, a[href]")) {
    if (!txt(b)) continue;
    for (const s of b.querySelectorAll("svg")) {
      if (s.getAttribute("aria-hidden") !== "true") {
        fail("a decorative icon beside visible text is not aria-hidden", at(`"${txt(b).slice(0, 36)}"`));
      }
    }
  }

  /* 3. Every field needs a label, and a placeholder is not one: it
        disappears the moment you type, it is not announced by every
        reader, and it fails contrast far more often than body text.
        The skill lists "placeholder-only label" as an anti-pattern
        under Forms & Feedback for exactly these reasons. */
  for (const i of d.querySelectorAll("input, select, textarea")) {
    if ((i.getAttribute("type") || "").toLowerCase() === "hidden") continue;
    const wrapping = i.closest("label");
    const pointing = i.id && d.querySelector(`label[for="${i.id}"]`);
    if ((wrapping && txt(wrapping)) || (pointing && txt(pointing))) continue;
    if (i.getAttribute("aria-label") || i.getAttribute("aria-labelledby")) continue;
    fail(i.getAttribute("placeholder") ? "a field is labelled only by its placeholder" : "a field has no label at all",
      at(`#${i.id || "(no id)"} .${i.className}`));
  }

  /* 4. A <button> with no type submits the form it is standing in.
        Most of these are not in a form today, which is exactly why
        it is cheap to fix now and expensive the first time one is. */
  for (const b of d.querySelectorAll("button:not([type])")) {
    fail("a button has no type attribute", at(`"${txt(b).slice(0, 30)}"`));
  }

  /* 5. Read cell by cell, a positions row without header scope is
        eight numbers and no column names - which is all of the
        information. */
  for (const table of d.querySelectorAll("table")) {
    const th = [...table.querySelectorAll("th")];
    if (!th.length) { fail("a table has no header row", at(`.${table.className}`)); continue; }
    if (th.some((x) => !x.getAttribute("scope"))) fail("a table's header cells have no scope", at(`.${table.className}`));
  }

  /* 6. alt="" is a decision - "this image carries nothing" - and a
        missing alt is the absence of one. */
  for (const im of d.querySelectorAll("img")) {
    if (im.getAttribute("alt") === null) fail("an image has no alt attribute", at(im.getAttribute("src") || ""));
  }
}

}

/* 7. Source-level: every icon leaves the icon() helper hidden, so no
      caller has to remember. Written against the source because the
      point is that there is ONE place to get it wrong. */
const appJs = fs.readFileSync(path.join(WEB, "js", "app.js"), "utf8");
for (const m of [...appJs.matchAll(/<svg(?![^>]*aria-hidden)[^>]*viewBox/g)]) {
  fail("an svg is built without aria-hidden", `app.js: ${m[0].slice(0, 60)}`);
}

/* jsdom's window keeps the desk's own timers alive, so the process
   never exits on its own once the bundle has been evaluated. Tear it
   down and exit explicitly rather than leaving `npm test` waiting on
   an interval that belongs to a page nobody is looking at. */
const done = (code) => { try { win.close(); } catch { /* */ } process.exit(code); };

if (failures.length) {
  const grouped = new Map();
  for (const f of failures) {
    const [rule, where] = f.split("\n");
    if (!grouped.has(rule)) grouped.set(rule, []);
    grouped.get(rule).push(where.trim());
  }
  for (const [rule, where] of [...grouped].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`FAIL  ${rule}  (${where.length})`);
    for (const w of where.slice(0, 8)) console.log("      " + w);
    if (where.length > 8) console.log(`      … and ${where.length - 8} more`);
  }
  console.log(`\na11y audit: ${failures.length} findings across ${VIEWS.length} views \u00d7 ${STATES.length} states`);
  done(1);
}
console.log(`a11y audit: ${VIEWS.length} views \u00d7 ${STATES.length} states clean`);
done(0);
