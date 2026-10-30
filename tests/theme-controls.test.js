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

check("every attribute the published rule relies on is actually on <html>", () => {
  /* The check that was missing, and the bug it let through.

     Specificity only matters if the selector MATCHES. An earlier version of
     this fix keyed the trader's rule on [data-theme], which reads like a
     permanent fixture of <html> but is written by app.js at boot - after
     themes.js has already run and published. The rule matched nothing on
     the first paint, every wallpaper disappeared and the desk came up
     black, while a specificity-only check like the one below stayed green.

     So: scoring the selector is not enough. Every attribute it names has
     to be one the engine has actually set by the time it publishes. */
  const fresh = makeWindow();
  fresh.AurionTheme.setPaid(true);
  fresh.AurionTheme.set("ocean");
  fresh.AurionTheme.edit({ wall: "sunset" });

  const present = Object.keys(fresh.document.documentElement.dataset)
    /* dataset keys are camelCase; the selectors spell them out */
    .map((k) => "data-" + k.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase()));

  const sel = /html(\[[^\]]+\])+(?=\{)/.exec(fresh.__published());
  if (!sel) throw new Error("nothing was published at all");
  const needed = (sel[0].match(/\[([a-z-]+)[\]=]/g) || [])
    .map((x) => x.replace(/[[\]=]/g, ""));
  const missing = needed.filter((a) => present.indexOf(a) === -1);
  if (missing.length) {
    throw new Error("the published rule requires " + missing.join(", ") +
      " but apply() only sets " + present.join(", ") +
      " - the rule would never match and the wallpaper would vanish");
  }
});

check("the guards match a real <html> too", () => {
  const fresh = makeWindow();
  fresh.AurionTheme.setPaid(true);
  fresh.AurionTheme.set("ocean");
  const present = Object.keys(fresh.document.documentElement.dataset)
    .map((k) => "data-" + k.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase()));
  /* data-glass is conditional by design - it exists only when the trader
     has switched translucency off - so it is exempt. */
  const exempt = ["data-glass"];
  [/html\[data-glass="off"\](\[[^\]]+\])+/,
   /html\[data-perf="fast"\](\[[^\]]+\])+\{[\s\S]{0,80}--blur/,
   /html(\[[^\]]+\])+\{\s*--motion-scale:0/].forEach((re, i) => {
    const m = re.exec(themesCss);
    if (!m) throw new Error("guard " + i + " is missing");
    const sel2 = /html(\[[^\]]+\])+/.exec(m[0])[0];
    const needed = (sel2.match(/\[([a-z-]+)[\]=]/g) || []).map((x) => x.replace(/[[\]=]/g, ""));
    const missing = needed.filter((a) => exempt.indexOf(a) === -1 && present.indexOf(a) === -1);
    if (missing.length) throw new Error("guard " + i + " needs " + missing.join(", ") + ", which is never set");
  });
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
  /* Compare the two cuts against each other rather than against a filename
     pattern. Most pictures are assets/bg/<name>-<cut>.jpg, but AURION's own
     backdrop is the orb the desk has always been painted with and lives
     beside the other artwork as a PNG - asserting the pattern would demand
     a duplicate of a file that already exists. */
  T.WALLPAPERS.forEach((w) => {
    if (!T.validWall(w + "@day") || !T.validWall(w + "@night")) {
      throw new Error(w + " does not offer both cuts");
    }
    const day = T.wallUrl(w + "@day", false);
    const night = T.wallUrl(w + "@night", true);
    if (!day || !night) throw new Error(w + " has a cut with no file");
    if (day === night) throw new Error(w + " uses the same file for both cuts");
    /* The pin has to win over the desk's own mode, in BOTH directions, or
       "the night picture on a light desk" is still unreachable. */
    [true, false].forEach((lightDesk) => {
      if (T.wallUrl(w + "@day", lightDesk) !== day) throw new Error(w + "@day follows the desk mode");
      if (T.wallUrl(w + "@night", lightDesk) !== night) throw new Error(w + "@night follows the desk mode");
    });
    /* Unpinned still follows the desk. */
    if (T.wallUrl(w, true) !== day) throw new Error(w + " ignores light mode");
    if (T.wallUrl(w, false) !== night) throw new Error(w + " ignores dark mode");
    [day, night].forEach((u) => {
      if (!fs.existsSync(path.join(WEB, u))) throw new Error("missing asset " + u);
    });
  });
});

check("resetting a theme leaves it with a backdrop, not a blank desk", () => {
  /* Every theme claims a picture of its own through themeWall(). The
     stylesheet has to actually define one for each, or "reset" hands the
     theme back a --theme-bg that nobody declares and the desk goes bare.
     That is what happened to AURION: the gallery offered its picture and
     the tile showed it, but no rule in themes.css named it, so choosing
     "the theme's own" - which is what reset restores - produced nothing. */
  const bare = [];
  ["glass", "frost", "neu", "clay", "aurora", "cyber",
   "minimal", "midnight", "ocean", "sunset", "mono"].forEach((skin) => {
    if (!T.themeWall(skin)) return;          // genuinely ships none
    const dark = new RegExp('html\\[data-skin="' + skin + '"\\]\\{[^}]*--theme-bg');
    const light = new RegExp('html\\[data-skin="' + skin + '"\\]\\[data-theme="light"\\]\\{[^}]*--theme-bg');
    if (!dark.test(themesCss) || !light.test(themesCss)) bare.push(skin);
  });
  if (bare.length) {
    throw new Error("these themes promise a picture that no rule defines, so a reset " +
      "leaves them blank: " + bare.join(", "));
  }
});

check("the files a theme's own backdrop points at exist", () => {
  const urls = themesCss.match(/--theme-bg:url\("\.\.\/([^"]+)"\)/g) || [];
  if (urls.length < 22) throw new Error("only " + urls.length + " theme backdrops declared");
  urls.forEach((u) => {
    const rel = /--theme-bg:url\("\.\.\/([^"]+)"\)/.exec(u)[1];
    if (!fs.existsSync(path.join(WEB, rel))) throw new Error("missing " + rel);
  });
});

check("a background effect reaches the shipped wallpapers", () => {
  /* The effect was applied to .aurora alone. The twenty wallpapers are
     painted by #bg-fx::before - a different element - so every effect
     appeared to do nothing on any of them while working fine on a flat
     colour or the trader's own photograph. */
  const fxRules = themesCss.match(/[^{}\n]*\{[^}]*filter:var\(--bg-fx[^}]*\}/g) || [];
  const targets = fxRules.map((r) => r.slice(0, r.indexOf("{")).trim());
  if (!targets.some((t) => t === ".aurora")) {
    throw new Error("the flat colour and the custom photo lost their effect");
  }
  if (!targets.some((t) => t.indexOf("#bg-fx") !== -1)) {
    throw new Error("the shipped wallpapers never receive --bg-fx: " + targets.join(" | "));
  }
});

check("every effect is a real filter the wallpaper layer can take", () => {
  const fx = T.FX;
  Object.keys(fx).forEach((k) => {
    const v = fx[k];
    if (k === "none") { if (v) throw new Error('"none" must be empty'); return; }
    if (!/^[a-z-]+\([^)]*\)/.test(v)) throw new Error(k + " is not a filter function: " + v);
  });
});

check("the AURION theme's own backdrop is offered like any other", () => {
  /* It was the one picture a trader could see on their desk and not find
     anywhere in the gallery. */
  if (T.WALLPAPERS.indexOf("aurion") === -1) throw new Error("aurion is not in the gallery");
  if (T.themeWall("glass") !== "aurion") {
    throw new Error('the default theme reports "' + T.themeWall("glass") + '" as its own picture');
  }
  ["en", "fa", "ar"].forEach((lang) => {
    const d = JSON.parse(fs.readFileSync(path.join(ROOT, "lang", lang + ".json"), "utf8"));
    if (!d.themes.wall_aurion) throw new Error(lang + " has no name for it");
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

check("the cut is named in the title, not stamped on the thumbnail", () => {
  const app = stripComments(read("js/app.js"));
  /* The label has to reach the tile's NAME. */
  if (!/\$\{name\}\s+\$\{darkLabel\}/.test(app) || !/\$\{name\}\s+\$\{lightLabel\}/.test(app)) {
    throw new Error("the cut is not part of the tile's name");
  }
  /* And nothing may be drawn over the artwork. */
  if (/wall-cut/.test(app) || /wall-cut/.test(read("css/themes.css"))) {
    throw new Error("the badge over the thumbnail is still there");
  }
});

check("a wallpaper that cannot be loaded is reported, not swallowed", () => {
  const app = stripComments(read("js/app.js"));
  if (!/function verifyWallpaper/.test(app)) throw new Error("nothing checks that the picture loads");
  if (!/wall-warn/.test(read("css/themes.css"))) throw new Error("the warning has no styling");
  const fn = /function verifyWallpaper[\s\S]*?\n}/.exec(app)[0];
  if (!/onerror/.test(fn)) throw new Error("the probe never handles failure");
  if (!/wall_missing/.test(fn)) throw new Error("the failure is not put into words");
  if (!/assetUrl/.test(fn)) throw new Error("the probe must test the same URL the stylesheet uses");
});

check("the published wallpaper URL does not depend on where the desk is served", () => {
  /* The backend answers every unmatched path with index.html, so a
     document-relative asset path resolves to HTML on any sub-path. */
  const t = read("js/themes.js");
  if (!/function assetUrl/.test(t)) throw new Error("no absolute resolution");
  const wc = /function wallCss[\s\S]*?\n  }/.exec(t)[0];
  if (!/assetUrl\(/.test(wc)) throw new Error("wallCss still publishes a bare relative path");
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

check("the accent gradient is gone, everywhere", () => {
  /* Offered once, then withdrawn by request. Removing a feature means
     removing it from the engine, the stylesheet, the picker and the
     strings - a leftover --accent-gradient still painted on buttons with
     nothing left in the interface able to switch it off is worse than
     never having shipped it. */
  const skins = read("js/skins.js");
  if (/setAccentGradient|getAccentGradient/.test(skins)) throw new Error("skins.js still exposes the gradient API");
  if (/accentGradient:/.test(skins)) throw new Error("skins.js still exports it");
  const app = stripComments(read("js/app.js"));
  if (/accentGradient|accent-grad/.test(app)) throw new Error("app.js still references it");
  const css = read("css/themes.css");
  if (/--accent-gradient|data-accent-grad/.test(css)) throw new Error("themes.css still paints it");
  const picker = stripComments(read("js/colorpicker.js"));
  if (/opts\.gradient|cp-tabs|cp-leg|cp-angle/.test(picker)) throw new Error("the picker still has a gradient editor");
  ["en", "fa", "ar"].forEach((lang) => {
    const d = JSON.parse(fs.readFileSync(path.join(ROOT, "lang", lang + ".json"), "utf8"));
    ["solid", "gradient", "angle"].forEach((k) => {
      if (d.themes[k]) throw new Error(lang + " still carries themes." + k);
    });
  });
  /* And a trader who saved one before it was withdrawn must not be left
     with it painted on. */
  if (!/removeItem\("aurion\.accent\.grad"\)/.test(skins)) {
    throw new Error("a stored gradient is never cleared on upgrade");
  }
});

check("the accent swatch shows the colour while it is being dragged", () => {
  /* The dot is the only thing on screen reporting what the accent now is;
     updating it on release makes the picker feel a step behind the hand. */
  const app = stripComments(read("js/app.js"));
  /* Anchored on the handler itself. A bare "data-accent-custom]" also
     matches the re-marking loop, which now reads that attribute too, and
     the window would open on the wrong function. */
  const i = app.indexOf('const custom = e.target.closest("[data-accent-custom]")');
  if (i < 0) throw new Error("the custom-accent handler is gone");
  const block = app.slice(i, i + 1200);
  const onInput = /onInput\(hex\)\s*\{[\s\S]*?\n        \}/.exec(block);
  if (!onInput) throw new Error("the custom accent has no live preview");
  /* The repaint may be written inline or delegated to the shared apply
     helper - three callers need it now, so it lives in one place. Either
     is fine; what must not happen is the drag leaving the dot behind. */
  const inline = /custom\.style\.background\s*=\s*hex/.test(onInput[0]);
  const delegated = /applyCustomAccent\(\s*hex\s*,\s*custom\s*\)/.test(onInput[0]);
  if (!inline && !delegated) {
    throw new Error("the swatch is not repainted during the drag");
  }
  if (delegated) {
    const h = /function applyCustomAccent\([\s\S]*?\n\}/.exec(app);
    if (!h) throw new Error("onInput delegates to applyCustomAccent, which does not exist");
    if (!/dot\.style\.background\s*=/.test(h[0])) {
      throw new Error("applyCustomAccent never repaints the swatch it was handed");
    }
  }
});

check("pressing the custom swatch applies the custom accent on that one click", () => {
  /* Coming back from a shipped accent used to take three gestures: open
     the picker, drag off the stored colour, drag back onto it. The colour
     was remembered the whole time - selecting it is the click. */
  const app = stripComments(read("js/app.js"));
  const i = app.indexOf('const custom = e.target.closest("[data-accent-custom]")');
  if (i < 0) throw new Error("the custom-accent handler is gone");
  const block = app.slice(i, i + 900);
  const openAt = block.indexOf("AurionPicker.open");
  if (openAt < 0) throw new Error("the custom swatch no longer opens the picker");
  const beforeOpen = block.slice(0, openAt);
  if (!/applyCustomAccent\(/.test(beforeOpen)) {
    throw new Error("the accent is only applied from inside the picker, so the click alone does nothing");
  }
  /* And it must apply the colour the desk already stored, not a constant. */
  if (!/customAccent\(\)/.test(beforeOpen)) {
    throw new Error("the click does not re-apply the stored custom colour");
  }
});

check("the custom swatch is unmarked when a shipped accent is chosen", () => {
  /* It is marked by data-accent-custom, not data-accent, so the loop that
     re-marks the shipped dots used to skip it and two accents appeared to
     be selected at once. */
  const app = stripComments(read("js/app.js"));
  const m = /function markAppearancePills\([\s\S]*?\n\}/.exec(app);
  if (!m) throw new Error("markAppearancePills is gone");
  if (!/\[data-accent-custom\]/.test(m[0])) {
    throw new Error("markAppearancePills never touches the custom swatch");
  }
  if (!/accent === "custom"/.test(m[0])) {
    throw new Error("the custom swatch is not marked from the accent actually in force");
  }
});

check("choosing a shipped accent clears the custom one", () => {
  const app = read("js/app.js");
  const i = app.indexOf('const b = e.target.closest("[data-accent]")');
  if (i < 0) throw new Error("the shipped-accent handler is gone");
  const near = app.slice(i, i + 400);
  if (!/setCustomAccent\(""\)/.test(near)) {
    throw new Error("a stored custom accent would keep overriding the shipped one");
  }
});

/* ----------------------------------------------- 7. strings and cache */

check("every new string exists in all three languages", () => {
  const keys = ["wall_cut_dark", "wall_cut_light", "wall_missing", "bg_crop", "bg_fit_cover", "bg_fit_contain",
    "bg_zoom", "bg_recentre", "bg_crop_hint", "pick_colour",
    "hex", "accent_custom", "wall_theme_none", "wall_aurion"];
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
  const want = ["js/skins.js?v=desk98", "js/themes.js?v=desk128", "js/app.js?v=desk155",
    "css/themes.css?v=desk116", "css/app.css?v=desk155", "css/skins.css?v=desk155",
    "js/colorpicker.js?v=desk2"];
  want.forEach((w) => { if (!html.includes(w)) throw new Error("index.html is missing " + w); });
  if (!read("sw.js").includes("aurion-shell-v145")) throw new Error("the service worker cache was not bumped");
});

/* ----------------------------------------------------------------- report */

if (failures.length) {
  console.error("theme-controls: " + failures.length + " FAILED of " + (pass + failures.length));
  failures.forEach((f) => console.error("  x " + f));
  process.exit(1);
}
console.log("theme-controls: " + pass + " checks passed");
