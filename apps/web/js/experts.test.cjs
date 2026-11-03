/**
 * The Expert Advisors card, rendered head-less.
 *
 * The fault it exists to stop coming back: AURION can update itself, the
 * two .mq5 files inside MetaTrader cannot, and for a long time nothing in
 * the product noticed. The desk kept talking to whatever expert happened to
 * be attached - everything read "connected" while the versions had drifted
 * apart. The card is the place that says both numbers out loud, so the
 * assertions here are about exactly that: the shipped version, the version
 * each chart reports, the warning when they differ, and an install guide
 * that is actually present rather than implied.
 *
 *     node apps/web/js/experts.test.cjs
 */
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const here = __dirname;
const noop = () => {};

function makeElement(tag) {
  const classes = new Set();
  return {
    tag, attrs: {}, textContent: "", innerHTML: "", className: "",
    hidden: false,
    style: { setProperty: noop, removeProperty: noop },
    dataset: {},
    classList: {
      add: (c) => classes.add(c), remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle: (c, on) => { if (on === undefined) { classes.has(c) ? classes.delete(c) : classes.add(c); } else if (on) classes.add(c); else classes.delete(c); return classes.has(c); },
    },
    has: (c) => classes.has(c),
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return this.attrs[k] === undefined ? null : this.attrs[k]; },
    removeAttribute(k) { delete this.attrs[k]; },
    appendChild: noop, remove: noop, focus: noop, click: noop,
    querySelector: () => null, querySelectorAll: () => [],
    addEventListener: noop, removeEventListener: noop,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0 }),
    children: [], value: "",
  };
}

function makeWindow() {
  const store = new Map();
  const blank = () => makeElement("div");
  const doc = {
    documentElement: blank(), body: blank(), head: blank(),
    createElement: blank, createTextNode: () => ({}),
    getElementById: () => null,
    querySelector: () => null, querySelectorAll: () => [],
    addEventListener: noop, removeEventListener: noop, visibilityState: "visible", scripts: [],
  };
  const win = {
    document: doc,
    navigator: { language: "en", hardwareConcurrency: 8, userAgent: "node" },
    location: { href: "http://127.0.0.1:8080/", protocol: "http:", host: "127.0.0.1:8080" },
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    getComputedStyle: () => ({ getPropertyValue: () => "" }),
    matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }),
    addEventListener: noop, removeEventListener: noop, dispatchEvent: noop,
    CustomEvent: function (t, i) { this.type = t; this.detail = i && i.detail; },
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval: noop,
    requestAnimationFrame: () => 0,
    fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
    WebSocket: function () { this.close = noop; this.send = noop; this.addEventListener = noop; },
    MutationObserver: function () { this.observe = noop; this.disconnect = noop; },
    Notification: function () {}, console,
  };
  win.window = win; win.globalThis = win; win.self = win;
  return win;
}

const win = makeWindow();
vm.createContext(win);
for (const f of ["skins.js", "themes.js", "i18n.js", "api.js", "calendar.js", "charts.js"]) {
  vm.runInContext(fs.readFileSync(path.join(here, f), "utf8"), win, { filename: f });
}

/* The real English pack, so the assertions read the sentences a user
   would read rather than the keys. */
const EN = fs.readFileSync(path.join(here, "..", "..", "..", "lang", "en.json"), "utf8");

const probe = `
  I18N.pack = ${EN};

  S.snap = { experts: {
    shipped: [
      { id: "bridge", file: "AurionBridge.mq5", role: "bridge", required: true, version: "1.18", available: true },
      { id: "chart_agent", file: "AurionChartAgent.mq5", role: "agent", required: false, version: "1.18", available: true },
    ],
    version: "1.18",
    charts: [
      { chart_id: "1", symbol: "EURUSD", timeframe: "M15", ea_name: "AurionBridge", version: "1.17", state: "old" },
      { chart_id: "2", symbol: "XAUUSD", timeframe: "H1", ea_name: "AurionBridge", version: "1.18", state: "ok" },
    ],
    stale: [{ chart_id: "1", symbol: "EURUSD", timeframe: "M15", version: "1.17", state: "old" }],
    outdated: true,
    installed: { version: "1.18", at: "2026-10-16T09:30:00Z", folders: ["C:/x/MQL5/Experts/Aurion"] },
    folder: "MQL5/Experts/Aurion",
    http_port_hint: 18765,
  } };
  globalThis.__stale = expertsCardHtml();
  globalThis.__staleCount = eaStale().length;
  globalThis.__pill = eaStaleLabel();

  S.snap.experts.charts = [{ chart_id: "2", symbol: "XAUUSD", timeframe: "H1", version: "1.18", state: "ok" }];
  S.snap.experts.stale = [];
  S.snap.experts.outdated = false;
  globalThis.__clean = expertsCardHtml();
  globalThis.__cleanCount = eaStale().length;

  S.snap.experts = undefined;
  globalThis.__empty = expertsCardHtml();
`;
vm.runInContext(fs.readFileSync(path.join(here, "pnl-charts.js"), "utf8"), win, { filename: "pnl-charts.js" });
vm.runInContext(fs.readFileSync(path.join(here, "app.js"), "utf8") + probe, win, { filename: "app.js" });

let failed = 0;
function check(name, cond) {
  if (cond) console.log("  ok  " + name);
  else { console.log("FAIL  " + name); failed++; }
}

const stale = String(win.__stale);
const clean = String(win.__clean);

check("the card renders", stale.includes("ea-card"));
check("it names both shipped experts",
  stale.includes("AurionBridge.mq5") && stale.includes("AurionChartAgent.mq5"));
check("it shows the version this build ships", stale.includes("v1.18"));
check("it shows the version each chart is running", stale.includes("v1.17"));
check("an old expert raises the warning", stale.includes("ea-warn"));
check("...naming the chart that is behind", stale.includes("EURUSD"));
check("an up-to-date desk does not warn", !clean.includes("ea-warn"));
check("the chart that matches is still listed", clean.includes("XAUUSD"));
check("the install guide is on the card", stale.includes("ea-guide") && stale.includes("<ol>"));
check("the guide has every step", (stale.match(/<li>/g) || []).length >= 6);
check("the file can be saved from here", stale.includes("data-ea-save=\"bridge\""));
check("the copy receipt is shown", stale.includes("ea-copied"));
check("the stale count is counted", win.__staleCount === 1 && win.__cleanCount === 0);
check("the pill says how many and what is shipped",
  String(win.__pill).includes("1") && String(win.__pill).includes("1.18"));
check("no snapshot yet is not a crash", String(win.__empty).includes("ea-card"));

/* Every string on the card has to exist in all three packs, or a Persian
   desk shows raw keys like "ea.step4" where the instructions should be. */
const packs = ["fa", "en", "ar"].map((l) => ({
  lang: l,
  data: JSON.parse(fs.readFileSync(path.join(here, "..", "..", "..", "lang", l + ".json"), "utf8")),
}));
const want = ["title", "help", "guide_title", "guide_note", "outdated_title", "outdated_body",
  "save_file", "copied", "attached", "no_charts", "stale_pill", "changed_by_update",
  "step1", "step2", "step3", "step4", "step5", "step6"];
for (const p of packs) {
  const missing = want.filter((k) => !(p.data.ea || {})[k]);
  check(`the ${p.lang} pack has the card's labels`, missing.length === 0);
}

console.log(failed ? `\n${failed} failing.` : "\nThe desk knows which expert is attached.");
process.exit(failed ? 1 : 0);
