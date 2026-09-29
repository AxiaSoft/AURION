/**
 * The strategy card's "enabled" markers, exercised head-less.
 *
 * The bug this exists to stop coming back: the live patcher rewrote the state
 * pill's *words* on every snapshot and left its *class* alone, so a strategy
 * that had just been switched off still read "Disabled" in the green of an
 * enabled one until something rebuilt the tab. The DOM was right and the
 * colour was a snapshot old.
 *
 * app.js declares its state in a script-level `const`, so the assertions are
 * appended to its source and run inside the same scope rather than poking at
 * it from outside.
 *
 *     node apps/web/js/strategies.test.cjs
 */
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const here = __dirname;
const noop = () => {};

/* A DOM just large enough: elements are registered under the selector the
   patcher will look them up with. */
function makeElement(tag) {
  const classes = new Set();
  return {
    tag,
    attrs: {},
    textContent: "",
    innerHTML: "",
    className: "",
    style: { setProperty: noop, removeProperty: noop },
    dataset: {},
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
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

const nodes = new Map();
function register(selector) {
  const el = makeElement("span");
  nodes.set(selector, el);
  return el;
}

function makeWindow() {
  const store = new Map();
  const blank = () => makeElement("div");
  const doc = {
    documentElement: blank(), body: blank(), head: blank(),
    createElement: blank, createTextNode: () => ({}),
    getElementById: () => null,
    querySelector: (sel) => nodes.get(sel) || null,
    querySelectorAll: (sel) => (nodes.has(sel) ? [nodes.get(sel)] : []),
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

const NAME = "ema_rsi";
const pill = register('[data-st-on="' + NAME + '"]');
const sw = register('button.switch[data-st="' + NAME + '"]');
const card = register('[data-st-card="' + NAME + '"]');
const wl = register('[data-st-wl="' + NAME + '"]');
const pf = register('[data-st-pf="' + NAME + '"]');
const avg = register('[data-st-avg="' + NAME + '"]');

/* Start the card where the first render would have left it: enabled. */
pill.classList.add("on");
pill.textContent = "Enabled";
sw.classList.add("on");
sw.setAttribute("aria-pressed", "true");

const probe = `
  S.snap = { strategy: { items: [{
    name: "${NAME}", enabled: false, last_action: "idle",
    win_rate: 41.5, net: -12.25, trades: 9, wins: 4, losses: 5,
    profit_factor: 0.81, avg: -1.36,
  }] } };
  patchStrategyLive();
  globalThis.__afterOff = true;
`;
vm.runInContext(fs.readFileSync(path.join(here, "app.js"), "utf8") + probe, win, { filename: "app.js" });

let failed = 0;
function check(name, cond) {
  if (cond) console.log("  ok  " + name);
  else { console.log("FAIL  " + name); failed++; }
}

check("the patcher ran", win.__afterOff === true);
check("the pill's words follow the snapshot", pill.textContent !== "Enabled");
check("the pill's colour follows the snapshot", pill.has("on") === false);
check("the switch follows the snapshot", sw.has("on") === false);
check("the switch says so out loud", sw.getAttribute("aria-pressed") === "false");
check("the card reads as off", card.has("is-off") === true);
check("the record is patched", String(wl.innerHTML).indexOf("4") === 0 && String(wl.innerHTML).indexOf("5") > 0);
check("the profit factor is patched", pf.textContent === "0.81");
check("the average is patched", avg.textContent !== "");

/* ...and back on again, because a one-way patch is the same bug mirrored. */
vm.runInContext(`
  S.snap.strategy.items[0].enabled = true;
  S.snap.strategy.items[0].profit_factor = null;
  patchStrategyLive();
`, win, { filename: "app.js" });

check("switching back on repaints the pill", pill.has("on") === true);
check("switching back on repaints the switch", sw.has("on") === true);
check("...and the pressed state", sw.getAttribute("aria-pressed") === "true");
check("...and the card is no longer dimmed", card.has("is-off") === false);
check("an unknown profit factor reads as a dash", pf.textContent === "—");

console.log(failed ? `\n${failed} failing.` : "\nThe enabled state stays in step.");
process.exit(failed ? 1 : 0);
