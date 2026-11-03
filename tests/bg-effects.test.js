/* What the background effects actually do to a picture.
 *
 * "Warm" and "cool" were swapped on screen, and no string-matching test
 * could have noticed: both entries were valid CSS, spelled correctly, and
 * applied to the right layer. The only way to tell them apart is to work
 * out what the filter chain does to real colours.
 *
 * So this file implements the filter maths from the Filter Effects spec -
 * the same colour matrices a browser uses for sepia(), saturate() and
 * hue-rotate() - runs every entry in the FX table over a spread of sample
 * colours, and measures the result. "Warm" has to move colour towards red
 * and amber; "cool" has to move it towards blue. Measured, not asserted.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const WEB = path.join(ROOT, "apps", "web");

let pass = 0;
const failures = [];
function check(name, fn) {
  try {
    const r = fn();
    if (r === false) throw new Error("returned false");
    pass++;
  } catch (e) {
    failures.push(name + " -> " + e.message);
  }
}

/* ------------------------------------------------- the filter colour maths */

/* Each filter is a 5x4 colour matrix applied in non-linear sRGB, which is
   what CSS filter functions do. Values come straight from the spec. */

function matMul(a, b) {
  /* Both are 4x5 (rows R,G,B,A; columns R,G,B,A,offset). Compose b after a. */
  const out = [];
  for (let r = 0; r < 4; r++) {
    const row = [];
    for (let c = 0; c < 5; c++) {
      let v = 0;
      for (let k = 0; k < 4; k++) v += b[r][k] * a[k][c];
      if (c === 4) v += b[r][4];
      row.push(v);
    }
    out.push(row);
  }
  return out;
}

const IDENTITY = [
  [1, 0, 0, 0, 0],
  [0, 1, 0, 0, 0],
  [0, 0, 1, 0, 0],
  [0, 0, 0, 1, 0],
];

/* https://drafts.fxtf.org/filter-effects/#sepiaEquivalent */
function sepia(amount) {
  const a = 1 - Math.min(1, Math.max(0, amount));
  return [
    [0.393 + 0.607 * a, 0.769 - 0.769 * a, 0.189 - 0.189 * a, 0, 0],
    [0.349 - 0.349 * a, 0.686 + 0.314 * a, 0.168 - 0.168 * a, 0, 0],
    [0.272 - 0.272 * a, 0.534 - 0.534 * a, 0.131 + 0.869 * a, 0, 0],
    [0, 0, 0, 1, 0],
  ];
}

/* https://drafts.fxtf.org/filter-effects/#saturateEquivalent */
function saturate(s) {
  return [
    [0.213 + 0.787 * s, 0.715 - 0.715 * s, 0.072 - 0.072 * s, 0, 0],
    [0.213 - 0.213 * s, 0.715 + 0.285 * s, 0.072 - 0.072 * s, 0, 0],
    [0.213 - 0.213 * s, 0.715 - 0.715 * s, 0.072 + 0.928 * s, 0, 0],
    [0, 0, 0, 1, 0],
  ];
}

/* https://drafts.fxtf.org/filter-effects/#huerotateEquivalent */
function hueRotate(deg) {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return [
    [0.213 + c * 0.787 - s * 0.213, 0.715 - c * 0.715 - s * 0.715, 0.072 - c * 0.072 + s * 0.928, 0, 0],
    [0.213 - c * 0.213 + s * 0.143, 0.715 + c * 0.285 + s * 0.140, 0.072 - c * 0.072 - s * 0.283, 0, 0],
    [0.213 - c * 0.213 - s * 0.787, 0.715 - c * 0.715 + s * 0.715, 0.072 + c * 0.928 + s * 0.072, 0, 0],
    [0, 0, 0, 1, 0],
  ];
}

function brightness(k) {
  return [
    [k, 0, 0, 0, 0],
    [0, k, 0, 0, 0],
    [0, 0, k, 0, 0],
    [0, 0, 0, 1, 0],
  ];
}

/** Parse a CSS filter chain into one combined colour matrix. */
function chainMatrix(css) {
  let m = IDENTITY;
  const re = /([a-z-]+)\(([^)]*)\)/g;
  let hit;
  while ((hit = re.exec(css))) {
    const fn = hit[1];
    const raw = hit[2].trim();
    const num = parseFloat(raw) || 0;
    const frac = /%$/.test(raw) ? num / 100 : num;
    if (fn === "sepia") m = matMul(m, sepia(frac));
    else if (fn === "saturate") m = matMul(m, saturate(frac));
    else if (fn === "hue-rotate") m = matMul(m, hueRotate(parseFloat(raw) || 0));
    else if (fn === "brightness") m = matMul(m, brightness(frac));
    else if (fn === "blur") { /* spatial, not colour - no effect here */ }
    else throw new Error("unknown filter function: " + fn);
  }
  return m;
}

function applyMatrix(m, rgb) {
  const [r, g, b] = rgb.map((v) => v / 255);
  const out = [];
  for (let i = 0; i < 3; i++) {
    let v = m[i][0] * r + m[i][1] * g + m[i][2] * b + m[i][4];
    out.push(Math.round(Math.min(1, Math.max(0, v)) * 255));
  }
  return out;
}

/* A spread of colours standing in for the twenty wallpapers: the desk's own
   teals and violets, sky and sea blues, sand, foliage, skin, and neutrals. */
const SAMPLES = [
  [62, 224, 196],  [124, 108, 255], [43, 184, 201],  [32, 58, 96],
  [16, 22, 38],    [120, 170, 220], [230, 200, 150], [90, 130, 70],
  [210, 160, 130], [128, 128, 128], [200, 90, 70],   [60, 90, 140],
  [240, 240, 245], [35, 35, 40],    [170, 120, 200], [80, 160, 150],
];

/* Warmth: how far the colour leans to the red end against the blue end.
   Green sits in the middle of the visible range and contributes to both
   amber and cyan, so it is the red-blue difference that carries the sense
   of temperature. Normalised against brightness so that a filter cannot
   look "warmer" merely by lightening the picture. */
function warmth(rgb) {
  const sum = rgb[0] + rgb[1] + rgb[2] || 1;
  return ((rgb[0] - rgb[2]) / sum) * 100;
}

function luma(rgb) {
  return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
}

/* ------------------------------------------------------------ the FX table */

function loadFx() {
  const noop = () => {};
  const store = new Map();
  const styles = {};
  const mk = () => ({
    style: { setProperty: noop, removeProperty: noop },
    classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
    dataset: {}, setAttribute: noop, getAttribute: () => null, removeAttribute: noop,
    appendChild(c) { styles[c.id] = c; }, remove: noop,
    querySelector: () => null, querySelectorAll: () => [],
    addEventListener: noop, removeEventListener: noop, textContent: "",
  });
  const win = {
    document: {
      documentElement: mk(), body: mk(), head: mk(), createElement: mk,
      getElementById: (id) => styles[id] || null, getElementsByTagName: () => [],
      querySelector: () => null, querySelectorAll: () => [],
      addEventListener: noop, removeEventListener: noop,
      readyState: "complete", baseURI: "http://x/",
    },
    navigator: { language: "en", hardwareConcurrency: 8 },
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k),
    },
    getComputedStyle: () => ({ getPropertyValue: () => "" }),
    matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }),
    addEventListener: noop, removeEventListener: noop, dispatchEvent: noop,
    CustomEvent: function () {}, MutationObserver: function () { this.observe = noop; this.disconnect = noop; },
    URL, requestAnimationFrame: (f) => f(), cancelAnimationFrame: noop,
    setTimeout, clearTimeout, console,
  };
  win.window = win;
  vm.createContext(win);
  for (const f of ["skins.js", "themes.js"]) {
    vm.runInContext(fs.readFileSync(path.join(WEB, "js", f), "utf8"), win, { filename: f });
  }
  return win.AurionTheme.FX;
}

const FX = loadFx();

/* --------------------------------------------------------------- the checks */

check("every effect is a chain this test understands", () => {
  Object.entries(FX).forEach(([name, css]) => {
    if (name === "none") { if (css) throw new Error('"none" must be empty'); return; }
    chainMatrix(css);                       // throws on an unknown function
  });
});

/* Judge the colour the filter PRODUCES, not how far it moved.

   Warm and cool are toning filters: they pull the whole picture towards
   one hue. A colour that was already deep blue therefore comes out of the
   cool filter less extreme than it went in, even though the result is
   plainly cool - so "did every sample get bluer?" is the wrong question
   and marks a correct filter as broken. The right question is whether
   what comes out is warm or cool. */
function outputWarmth(css) {
  const m = chainMatrix(css);
  return SAMPLES.map((s) => warmth(applyMatrix(m, s)));
}

check("warm leaves every colour on the warm side", () => {
  const w = outputWarmth(FX.warm);
  const cold = w.filter((x) => x <= 0).length;
  if (cold) {
    throw new Error(cold + " of " + w.length + " sample colours came out COOL; " +
      "the coolest is " + Math.min(...w).toFixed(1));
  }
});

check("cool leaves every colour on the cool side", () => {
  const c = outputWarmth(FX.cool);
  const hot = c.filter((x) => x >= 0).length;
  if (hot) {
    throw new Error(hot + " of " + c.length + " sample colours came out WARM; " +
      "the warmest is " + Math.max(...c).toFixed(1) +
      " - which is the two effects being swapped");
  }
});

check("cool is cooler than warm for every single colour", () => {
  /* The direct statement of "these two are not the wrong way round",
     made per colour so one lucky average cannot hide a swap. */
  const mw = chainMatrix(FX.warm);
  const mc = chainMatrix(FX.cool);
  const gaps = SAMPLES.map((s) => warmth(applyMatrix(mw, s)) - warmth(applyMatrix(mc, s)));
  const wrong = gaps.filter((g) => g <= 0).length;
  if (wrong) throw new Error(wrong + " colours are warmer under cool than under warm");
  if (Math.min(...gaps) < 3) {
    throw new Error("the two are barely distinguishable on some colours: " +
      Math.min(...gaps).toFixed(1));
  }
});

check("both tints are strong enough to be worth choosing", () => {
  const w = outputWarmth(FX.warm).reduce((a, b) => a + b, 0) / SAMPLES.length;
  const c = outputWarmth(FX.cool).reduce((a, b) => a + b, 0) / SAMPLES.length;
  if (w < 5) throw new Error("warm is too faint: " + w.toFixed(1));
  if (c > -5) throw new Error("cool is too faint: " + c.toFixed(1));
});

check("no effect wrecks a picture's brightness", () => {
  /* A hue rotation large enough to swap the ends of the spectrum also
     mangles luminance. Dim and bright are meant to change it; the tints
     are not. */
  ["warm", "cool", "grey"].forEach((name) => {
    const m = chainMatrix(FX[name]);
    SAMPLES.forEach((s) => {
      const before = luma(s);
      const after = luma(applyMatrix(m, s));
      if (Math.abs(after - before) > 60) {
        throw new Error(name + " moved rgb(" + s + ") from luma " +
          before.toFixed(0) + " to " + after.toFixed(0));
      }
    });
  });
});

check("grey really is colourless, and dim and bright only change level", () => {
  const g = chainMatrix(FX.grey);
  SAMPLES.forEach((s) => {
    const [r, gg, b] = applyMatrix(g, s);
    if (Math.abs(r - gg) > 2 || Math.abs(gg - b) > 2) {
      throw new Error("grey left colour in rgb(" + s + ") -> " + [r, gg, b]);
    }
  });
  SAMPLES.forEach((s) => {
    if (luma(applyMatrix(chainMatrix(FX.dim), s)) > luma(s) + 1) throw new Error("dim brightened");
    if (luma(applyMatrix(chainMatrix(FX.bright), s)) < luma(s) - 1) throw new Error("bright darkened");
  });
});

/* ----------------------------------------------------------------- report */

if (failures.length) {
  console.error("bg-effects: " + failures.length + " FAILED of " + (pass + failures.length));
  failures.forEach((f) => console.error("  x " + f));
  process.exit(1);
}
console.log("bg-effects: " + pass + " checks passed");
