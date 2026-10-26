/* ===========================================================================
   The theme controls: the wallpaper actually applying, the retired drawn
   backdrops staying dead, framing a custom picture, and the accent.

   The centre of this file is the bug it was written for. A chosen wallpaper
   was being stored correctly, published correctly, and then silently
   discarded in light mode because the published rule and the per-theme rule
   in themes.css had the SAME specificity and themes.css came later in the
   document. Nothing about the value was wrong, so checking the value proved
   nothing - the only honest check resolves the cascade.

   So that is what the first group does: it scores both rules the way a
   browser would and asserts the trader's choice outranks the theme default,
   while the capability and accessibility guards still outrank the trader.
   =========================================================================== */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const WEB = path.join(ROOT, "apps", "web");
const read = (p) => fs.readFileSync(path.join(WEB, p), "utf8");

/* Comments describe code; they are not code. Several checks here look for
   the ABSENCE of a pattern, and would otherwise be fooled by a comment
   explaining why that pattern was removed. */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
}

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
function eq(a, b, what) {
  if (a !== b) throw new Error((what || "") + " expected " + JSON.stringify(b) + ", got " + JSON.stringify(a));
}

/* ---------------------------------------------------------------- harness */

/* Enough of a DOM for skins.js and themes.js to run and for us to read back
   what they published. Deliberately small: the point is the CSS text and the
   attributes on <html>, not a browser. */
function makeWindow() {
  const noop = () => {};
  const store = new Map();
  const styles = {};
  const props = {};
  const mk = () => ({
    style: { setProperty: (k, v) => { props[k] = v; }, removeProperty: (k) => { delete props[k]; } },
    classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
    dataset: {},
    setAttribute: noop, getAttribute: () => null, removeAttribute: noop,
    appendChild(c) { styles[c.id] = c; }, remove: noop,
    querySelector: () => null, querySelectorAll: () => [],
    addEventListener: noop, removeEventListener: noop,
    textContent: "",
  });
  const root = mk();
  const win = {
    document: {
      documentElement: root, body: mk(), head: mk(),
      createElement: mk,
      getElementById: (id) => styles[id] || null,
      querySelector: () => null, querySelectorAll: () => [],
      addEventListener: noop, removeEventListener: noop,
      readyState: "complete",
    },
    navigator: { language: "en", hardwareConcurrency: 8 },
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    getComputedStyle: () => ({ getPropertyValue: () => "" }),
    matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }),
    addEventListener: noop, removeEventListener: noop, dispatchEvent: noop,
    CustomEvent: function () {}, MutationObserver: function () { this.observe = noop; this.disconnect = noop; },
    requestAnimationFrame: (f) => f(), cancelAnimationFrame: noop,
    setTimeout, clearTimeout, console,
  };
  win.window = win;
  vm.createContext(win);
  for (const f of ["skins.js", "themes.js", "colorpicker.js"]) {
    vm.runInContext(read("js/" + f), win, { filename: f });
  }
  win.__styles = styles;
  win.__props = props;
  win.__published = () => (styles["aurion-theme-knobs"] || {}).textContent || "";
  return win;
}

/* How many attribute selectors one COMPOUND selector carries. Scoring a
   whole comma-separated list at once is exactly the mistake that hid this
   bug for a release: "a[x][y], b[z]" is not a specificity of three. */
function attrScore(compound) {
  return (compound.match(/\[[^\]]+\]/g) || []).length;
}

/* ------------------------------------------------- 1. the cascade is right */

const themesCss = read("css/themes.css");
const win = makeWindow();
const T = win.AurionTheme;
T.setPaid(true);

check("a chosen wallpaper is published at all", () => {
  T.edit({ wall: "ocean" });
  const css = win.__published();
  if (!/--theme-bg/.test(css)) throw new Error("no --theme-bg published");
  if (!/ocean-/.test(css)) throw new Error("the chosen scene is not in the published CSS");
});

check("the trader's rule outranks the per-theme default in LIGHT mode", () => {
  /* The per-theme light rules look like html[data-skin="ocean"][data-theme="light"].
     That is two attributes. The published rule has to beat it, and it cannot
     do so on source order, because the injected <style> is created from a
     <head> script and therefore lands BEFORE the <link> to themes.css. */
  const published = /html(\[[^\]]+\])+(?=\{)/.exec(win.__published());
  if (!published) throw new Error("could not find the published selector");
  const mine = attrScore(published[0]);

  const defaults = themesCss.match(/html\[data-skin="[a-z]+"\]\[data-theme="light"\]/g) || [];
  if (!defaults.length) throw new Error("no light per-theme rules found to compare against");
  const worst = Math.max(...defaults.map(attrScore));
  if (!(mine > worst)) {
    throw new Error("published scores " + mine + ", theme default scores " + worst +
      " - a tie or a loss means the wallpaper is silently discarded in light mode");
  }
});

check("the capability and accessibility guards still outrank the trader", () => {
  const published = /html(\[[^\]]+\])+(?=\{)/.exec(win.__published());
  const mine = attrScore(published[0]);
  const guards = [
    /html\[data-glass="off"\](\[[^\]]+\])+/,
    /html\[data-perf="fast"\](\[[^\]]+\])+\{[\s\S]{0,80}--blur/,
    /html(\[[^\]]+\])+\{\s*--motion-scale:0/,
  ];
  guards.forEach((re, i) => {
    const m = re.exec(themesCss);
    if (!m) throw new Error("guard " + i + " is missing from themes.css");
    const sel = /html(\[[^\]]+\])+/.exec(m[0])[0];
    if (!(attrScore(sel) > mine)) {
      throw new Error("guard " + i + " scores " + attrScore(sel) + " vs the trader's " + mine +
        " - a colour choice could switch blur or motion back on");
    }
  });
});

/* --------------------------------------- 2. the drawn backdrops are gone */

const RETIRED = ["blobs", "aurora", "waves", "dusk", "layered", "grid", "soft", "none"];

check("the engine offers only the flat colour and a picture", () => {
  eq(JSON.stringify(T.BACKDROPS), JSON.stringify(["flat", "photo"]), "BACKDROPS");
});

check("no CSS rule can still paint a retired backdrop", () => {
  const left = RETIRED.filter((v) => themesCss.includes('[data-bg="' + v + '"]'));
  if (left.length) throw new Error("themes.css still styles: " + left.join(", "));
});

check("a stored retired backdrop migrates instead of leaving a blank desk", () => {
  /* Someone upgrading has one of these in their storage right now. */
  RETIRED.forEach((v) => {
    T.edit({ bg: v });
    const got = T.knobs().bg;
    if (got !== "flat" && got !== "photo") {
      throw new Error('stored bg "' + v + '" survived as "' + got + '"');
    }
  });
});

check("the settings screen no longer builds a backdrop gallery", () => {
  const app = stripComments(read("js/app.js"));
  if (/data-bgpick/.test(app)) throw new Error("app.js still renders backdrop tiles");
  if (/knob-bgtiles/.test(app)) throw new Error("app.js still references #knob-bgtiles");
});

/* ------------------------------------ 3. both cuts of every wallpaper */

check("every scene resolves to a real file in both cuts", () => {
  T.WALLPAPERS.forEach((w) => {
    [["@day", "light"], ["@night", "dark"]].forEach(([suffix, cut]) => {
      if (!T.validWall(w + suffix)) throw new Error(w + suffix + " rejected by validWall");
      /* The pin has to win over the desk's own mode, in BOTH directions,
         or "night version on a light desk" is still unreachable. */
      [true, false].forEach((lightDesk) => {
        const url = T.wallUrl(w + suffix, lightDesk);
        if (!url.endsWith(w + "-" + cut + ".jpg")) {
          throw new Error(w + suffix + " on a " + (lightDesk ? "light" : "dark") +
            " desk resolved to " + url);
        }
        const onDisk = path.join(WEB, url);
        if (!fs.existsSync(onDisk)) throw new Error("missing asset " + url);
      });
    });
    /* Unpinned still follows the desk. */
    if (!T.wallUrl(w, true).endsWith(w + "-light.jpg")) throw new Error(w + " ignores light mode");
    if (!T.wallUrl(w, false).endsWith(w + "-dark.jpg")) throw new Error(w + " ignores dark mode");
  });
});

check("nonsense wallpaper values are refused", () => {
  ["ocean@noon", "nope", "nope@day", "@day"].forEach((v) => {
    if (T.validWall(v)) throw new Error('validWall accepted "' + v + '"');
  });
});

check("the gallery offers both cuts of each scene", () => {
  const app = read("js/app.js");
  if (!/@night/.test(app) || !/@day/.test(app)) {
    throw new Error("app.js does not build pinned day/night tiles");
  }
});

/* ------------------------------------------- 4. framing a custom picture */

check("the framing knobs round-trip and clamp", () => {
  const c = T.setBgCrop({ fit: "contain", zoom: 180, x: 25, y: 70 });
  eq(c.fit, "contain", "fit"); eq(c.zoom, 180, "zoom"); eq(c.x, 25, "x"); eq(c.y, 70, "y");
  const wild = T.setBgCrop({ zoom: 9999, x: -40, y: 400 });
  eq(wild.zoom, 300, "zoom clamp"); eq(wild.x, 0, "x clamp"); eq(wild.y, 100, "y clamp");
  eq(T.setBgCrop({ fit: "banana" }).fit, "cover", "an unknown fit falls back to cover");
});

check("the framing reaches the stylesheet as usable values", () => {
  T.setBgImage("data:image/jpeg;base64,AAAA");
  T.edit({ bg: "photo" });
  T.setBgCrop({ fit: "cover", zoom: 150, x: 30, y: 65 });
  const css = win.__published();
  ["--bg-photo-fit:cover", "--bg-photo-zoom:1.500", "--bg-photo-x:30%", "--bg-photo-y:65%"]
    .forEach((want) => {
      if (!css.includes(want)) throw new Error("missing " + want + " in the published CSS");
    });
});

check("the stylesheet consumes the framing on the photo layer", () => {
  const rule = /html\[data-bg="photo"\] \.aurora::before\{[\s\S]*?\}/.exec(themesCss);
  if (!rule) throw new Error("the photo layer rule is gone");
  ["--bg-photo-x", "--bg-photo-y", "--bg-photo-fit", "--bg-photo-zoom"].forEach((v) => {
    if (!rule[0].includes(v)) throw new Error(rule[0].includes("cover") && v === "--bg-photo-fit"
      ? "fit is still hard-coded" : "the photo layer ignores " + v);
  });
  /* Zoom as a transform, not a background-size: a size in percent stops
     meaning "cover" the moment the aspect ratios disagree. */
  if (!/transform:\s*scale\(var\(--bg-photo-zoom/.test(rule[0])) {
    throw new Error("zoom must be a transform on the layer");
  }
});

check("resetting the framing puts it back to centred and unzoomed", () => {
  const c = T.resetBgCrop();
  eq(c.fit, "cover", "fit"); eq(c.zoom, 100, "zoom"); eq(c.x, 50, "x"); eq(c.y, 50, "y");
});

/* ----------------------------------------- 5. the colour picker is ours */

check("no native colour input is left anywhere in the desk", () => {
  /* Strip comments first: this file argues IN a comment that the native
     input is the wrong control, and a blunt grep would flag that prose. */
  const app = stripComments(read("js/app.js"));
  if (/type=["']color["']/.test(app)) {
    throw new Error("app.js still renders <input type=\"color\">, which opens the OS dialog");
  }
  if (!fs.existsSync(path.join(WEB, "js/colorpicker.js"))) throw new Error("colorpicker.js is missing");
  if (!read("index.html").includes("js/colorpicker.js")) throw new Error("index.html never loads it");
});

check("the picker's colour maths is lossless", () => {
  const P = win.AurionPicker;
  ["#3ee0c4", "#ff6600", "#000000", "#ffffff", "#7c6cff", "#123456", "#fe0a9b", "#010203"]
    .forEach((hex) => {
      const [h, s, v] = P.hexToHsv(hex);
      eq(P.hsvToHex(h, s, v), hex, hex + " round trip");
    });
  eq(P.normHex("#AbC"), "#aabbcc", "short hex");
  eq(P.normHex("zzz"), null, "nonsense");
});

check("dragging a colour previews without republishing the stylesheet", () => {
  /* This is request 6. The old handler called edit() - a full republish -
     plus a chart repaint on every pointer move. The preview path must not
     call edit(); the commit path must. */
  const app = read("js/app.js");
  const fn = /function previewColour[\s\S]*?\n}/.exec(app);
  if (!fn) throw new Error("previewColour() is missing");
  if (/AurionTheme\.edit\(/.test(fn[0])) throw new Error("the preview path still republishes the theme");
  if (!/setProperty/.test(fn[0])) throw new Error("the preview must write inline custom properties");
  if (!/repaintChartsForTheme/.test(/onCommit\([\s\S]*?\n {8}\}/.exec(app) || [""])[0]) {
    /* Charts are redrawn once the choice settles, not during the drag. */
    if (!/onCommit[\s\S]{0,600}repaintChartsForTheme/.test(app)) {
      throw new Error("charts are never repainted on commit");
    }
  }
  const preview = app.indexOf("previewColour(key, hex)");
  const dragRepaint = app.slice(preview, preview + 400);
  if (/repaintChartsForTheme/.test(dragRepaint)) {
    throw new Error("charts are still being repainted mid-drag");
  }
});

check("the picker coalesces pointer moves into one frame", () => {
  const src = read("js/colorpicker.js");
  if (!/requestAnimationFrame/.test(src)) throw new Error("no frame coalescing in the picker");
});

/* ------------------------------- 6. the accent, and only the accent */

check("a custom accent colour takes effect", () => {
  const S = win.AurionSkin;
  S.setCustomAccent("#ff6600");
  eq(S.getAccent(), "custom", "accent id");
  eq(win.__props["--accent"], "#ff6600", "--accent");
  if (!win.__props["--accent-ink"]) throw new Error("no readable ink was derived");
});

check("the accent gradient publishes and can be turned off again", () => {
  const S = win.AurionSkin;
  S.setAccentGradient({ from: "#ff6600", to: "#7c6cff", angle: 135 });
  const g = win.__props["--accent-gradient"];
  if (!g || !/linear-gradient\(135deg/.test(g)) throw new Error("no gradient published, got " + g);
  if (!win.__props["--accent-grad-ink"]) throw new Error("no ink derived for the gradient");
  S.setAccentGradient(null);
  if (win.__props["--accent-gradient"]) throw new Error("the gradient survived being turned off");
});

check("the gradient never leaks onto the page, panels or text", () => {
  /* The user was explicit: gradient support is for the accent alone. A
     gradient behind a column of prices costs legibility and earns nothing. */
  const grad = themesCss.slice(themesCss.indexOf("The accent gradient."));
  const rules = grad.match(/^[^@{}\n][^{}]*\{[^}]*\}/gm) || [];
  rules.forEach((r) => {
    if (!/var\(--accent-gradient\)/.test(r)) return;
    const sel = r.slice(0, r.indexOf("{"));
    if (/(^|[\s,])(html|body|\.aurora|\.card|\.panel)\b/.test(sel.replace(/html\[data-accent-grad="on"\]/g, ""))) {
      throw new Error("the accent gradient is being painted on a large surface: " + sel.trim());
    }
  });
  /* And nothing may feed a gradient into the single-colour token, or every
     border and focus ring on the desk tries to paint one. */
  if (/--accent:\s*linear-gradient/.test(read("js/skins.js"))) {
    throw new Error("--accent must stay a single colour");
  }
});

check("choosing a shipped accent clears the custom one", () => {
  const app = read("js/app.js");
  const i = app.indexOf('const b = e.target.closest("[data-accent]")');
  if (i < 0) throw new Error("the shipped-accent handler is gone");
  const near = app.slice(i, i + 400);
  if (!/setCustomAccent\(""\)/.test(near) || !/setAccentGradient\(null\)/.test(near)) {
    throw new Error("a stored custom accent would keep overriding the shipped one");
  }
});

/* ----------------------------------------------- 7. strings and cache */

check("every new string exists in all three languages", () => {
  const keys = ["wall_day", "wall_night", "bg_crop", "bg_fit_cover", "bg_fit_contain",
    "bg_zoom", "bg_recentre", "bg_crop_hint", "pick_colour", "solid", "gradient",
    "angle", "hex", "accent_custom"];
  ["en", "fa", "ar"].forEach((lang) => {
    const d = JSON.parse(fs.readFileSync(path.join(ROOT, "lang", lang + ".json"), "utf8"));
    keys.forEach((k) => {
      if (!d.themes || !d.themes[k]) throw new Error(lang + " is missing themes." + k);
    });
    /* And the names of the backdrops that no longer exist are gone. */
    RETIRED.forEach((v) => {
      if (d.themes && d.themes["bg_" + v]) throw new Error(lang + " still names the retired backdrop " + v);
    });
  });
});

check("the browser is forced to pick up every file that changed", () => {
  const html = read("index.html");
  const want = ["js/skins.js?v=desk97", "js/themes.js?v=desk121", "js/app.js?v=desk127",
    "css/themes.css?v=desk111", "css/app.css?v=desk129", "js/colorpicker.js?v=desk1"];
  want.forEach((w) => { if (!html.includes(w)) throw new Error("index.html is missing " + w); });
  if (!read("sw.js").includes("aurion-shell-v113")) throw new Error("the service worker cache was not bumped");
});

/* ----------------------------------------------------------------- report */

if (failures.length) {
  console.error("theme-controls: " + failures.length + " FAILED of " + (pass + failures.length));
  failures.forEach((f) => console.error("  x " + f));
  process.exit(1);
}
console.log("theme-controls: " + pass + " checks passed");
