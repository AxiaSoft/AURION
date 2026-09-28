/**
 * Evaluate every desk script in a minimal DOM and assert it loads clean.
 *
 * check-calls.mjs finds calls to functions that do not exist. It cannot find a
 * reference to a *variable* that does not exist - twice now, a refactor left
 * one behind (`renderSettings()`, then `LS.accent`) and the desk booted to an
 * empty page. Running the code is the only check that catches both.
 *
 *     node apps/web/js/smoke.test.cjs
 */
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const here = __dirname;
const SCRIPTS = ["skins.js", "i18n.js", "api.js", "calendar.js", "charts.js", "app.js"];

function makeWindow() {
  const store = new Map();
  const noop = () => {};
  const el = () => ({
    style: { setProperty: noop, removeProperty: noop },
    classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
    dataset: {}, setAttribute: noop, getAttribute: () => null, removeAttribute: noop,
    appendChild: noop, prepend: noop, remove: noop, querySelector: () => null,
    querySelectorAll: () => [], addEventListener: noop, removeEventListener: noop,
    getContext: () => null, getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0 }),
    children: [], innerHTML: "", textContent: "", value: "", focus: noop, click: noop,
  });
  const doc = {
    documentElement: el(), body: el(), head: el(),
    createElement: el, createTextNode: () => ({}),
    getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
    addEventListener: noop, removeEventListener: noop, visibilityState: "visible", scripts: [],
  };
  const win = {
    document: doc, navigator: { language: "en", hardwareConcurrency: 8, userAgent: "node" },
    location: { href: "http://127.0.0.1:8080/", protocol: "http:", host: "127.0.0.1:8080" },
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }),
    addEventListener: noop, removeEventListener: noop, setTimeout, clearTimeout,
    setInterval: () => 0, clearInterval: noop, requestAnimationFrame: () => 0,
    fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
    WebSocket: function () { this.close = noop; this.send = noop; this.addEventListener = noop; },
    MutationObserver: function () { this.observe = noop; this.disconnect = noop; },
    Notification: function () {}, console,
  };
  win.window = win;
  win.globalThis = win;
  win.self = win;
  return win;
}

const sandbox = makeWindow();
vm.createContext(sandbox);

let failed = 0;
for (const name of SCRIPTS) {
  const code = fs.readFileSync(path.join(here, name), "utf8");
  try {
    vm.runInContext(code, sandbox, { filename: name });
    console.log("  ok  " + name + " evaluates with no missing references");
  } catch (e) {
    failed++;
    console.log("  FAIL " + name + ": " + e.message);
  }
}

// The two globals the desk cannot boot without.
for (const [name, path_] of [["AurionSkin", "skins.js"], ["views", "app.js"]]) {
  const present = name === "views"
    ? (() => { try { return vm.runInContext(`typeof views`, sandbox) === "object"; } catch { return false; } })()
    : typeof sandbox[name] === "object";
  if (present) console.log(`  ok  ${name} defined by ${path_}`);
  else { failed++; console.log(`  FAIL ${name} missing after loading ${path_}`); }
}

if (failed) { console.log(`\n${failed} failure(s).`); process.exit(1); }
console.log("\nAll desk scripts load clean.");
