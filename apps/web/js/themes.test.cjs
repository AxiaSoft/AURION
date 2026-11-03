/**
 * The licence gate on the theme layer, exercised head-less.
 *
 * Themes and accent colours are premium, and the rules that decide what a
 * free desk may wear are easy to get subtly wrong: a locked theme must not be
 * applied, must not be remembered, must not survive a reload, and must come
 * straight back the moment a key is activated. None of that is visible in a
 * screenshot, so it is asserted here.
 *
 *     node apps/web/js/themes.test.cjs
 */
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const here = __dirname;

function makeWindow() {
  const store = new Map();
  const noop = () => {};
  const el = () => ({
    style: { setProperty: noop, removeProperty: noop },
    classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
    dataset: {}, setAttribute: noop, getAttribute: () => null, removeAttribute: noop,
    appendChild: noop, remove: noop, querySelector: () => null, querySelectorAll: () => [],
    addEventListener: noop, removeEventListener: noop, textContent: "",
  });
  const doc = {
    documentElement: el(), body: el(), head: el(),
    createElement: el, getElementById: () => null,
    querySelector: () => null, querySelectorAll: () => [],
    addEventListener: noop, removeEventListener: noop, readyState: "complete",
  };
  const win = {
    document: doc,
    navigator: { language: "en", hardwareConcurrency: 8 },
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    getComputedStyle: () => ({ getPropertyValue: () => "" }),
    matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }),
    addEventListener: noop, removeEventListener: noop, dispatchEvent: noop,
    CustomEvent: function (type, init) { this.type = type; this.detail = init && init.detail; },
    MutationObserver: function () { this.observe = noop; this.disconnect = noop; },
    setTimeout, clearTimeout, console,
  };
  win.window = win;
  win.globalThis = win;
  return win;
}

const win = makeWindow();
vm.createContext(win);
for (const f of ["skins.js", "themes.js"]) {
  vm.runInContext(fs.readFileSync(path.join(here, f), "utf8"), win, { filename: f });
}

const T = win.AurionTheme;
const S = win.AurionSkin;
let failed = 0;

function check(name, cond) {
  if (cond) console.log("  ok  " + name);
  else { console.log("FAIL  " + name); failed++; }
}

/* ------------------------------------------------------------------ free -- */
check("freemium by default", T.paid() === false);
check("liquid glass is free", T.locked("glass") === false);
check("every other theme is locked", T.THEMES.every((t) => t.id === "glass" || T.locked(t.id)));
check("the custom builder is locked", T.locked("custom") === true);

T.set("cyber");
check("a locked theme is refused", T.get() === "glass");
check("...and nothing was applied", T.effective() === "glass");
check("...and nothing was remembered", win.localStorage.getItem("aurion.theme.skin") === null);

const freeAccent = S.getAccent();
S.setAccent("sand");
check("a free desk wears its theme's accent", S.getAccent() === freeAccent && freeAccent === "aurora");
check("...while still recording the pick", S.storedAccent() === "sand");

/* --------------------------------------------------------------- premium -- */
check("activating a key is a change", T.setPaid(true) === true);
check("a second call is not", T.setPaid(true) === false);
check("nothing is locked any more", T.THEMES.every((t) => T.locked(t.id) === false));
check("the recorded accent comes back", S.getAccent() === "sand");

T.set("cyber");
check("a premium theme applies", T.effective() === "cyber");
check("...and is remembered", win.localStorage.getItem("aurion.theme.skin") === "cyber");
check("...with the accent it was designed around", S.getAccent() === "magenta");

/* ---------------------------------------------------------------- lapsed -- */
check("losing the key is a change", T.setPaid(false) === true);
check("the desk falls back to glass", T.effective() === "glass");
check("but the choice is kept", T.get() === "cyber");
check("and the accent is pinned again", S.getAccent() === "aurora");

check("renewing restores the theme", T.setPaid(true) === true && T.effective() === "cyber");

/* ------------------------------------------------------------------ boot -- */
const cold = makeWindow();
cold.localStorage.setItem("aurion.theme.skin", "sunset");
cold.localStorage.setItem("aurion.theme.paid", "1");
vm.createContext(cold);
for (const f of ["skins.js", "themes.js"]) {
  vm.runInContext(fs.readFileSync(path.join(here, f), "utf8"), cold, { filename: f });
}
check("a paid desk paints its theme at boot, with no flash",
  cold.document.documentElement.dataset.skin === "sunset");

const coldFree = makeWindow();
coldFree.localStorage.setItem("aurion.theme.skin", "sunset");
vm.createContext(coldFree);
for (const f of ["skins.js", "themes.js"]) {
  vm.runInContext(fs.readFileSync(path.join(here, f), "utf8"), coldFree, { filename: f });
}
check("a free desk boots on glass whatever is stored",
  coldFree.document.documentElement.dataset.skin === "glass");

console.log(failed ? `\n${failed} failing.` : "\nThe licence gate holds.");
process.exit(failed ? 1 : 0);
