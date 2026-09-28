/* ===========================================================================
   AURION — appearance: skin, accent colour, wallpaper, performance tier.

   Deliberately standalone and dependency-free so index.html can apply the saved
   look before the first paint. It owns nothing but <html> attributes, a handful
   of CSS custom properties and its own localStorage keys; no application state
   is touched.
   =========================================================================== */
(function (global) {
  "use strict";

  var LS = {
    skin: "aurion.skin",
    accent: "aurion.accent",
    bg: "aurion.bg",
    wallpaper: "aurion.wallpaper",
    perf: "aurion.perf",
  };

  var SKINS = ["glass", "clay", "skeu", "neu", "minimal"];
  var BACKGROUNDS = ["default", "aurora", "deep", "mesh", "custom"];

  // Presets are (base, mid, third, ink). The first one is the original palette,
  // which is what an untouched install keeps.
  var ACCENTS = {
    aurora:  ["#3ee0c4", "#2bb8c9", "#7c6cff", "#061014"],
    violet:  ["#8b7bff", "#6c5ce7", "#c16cff", "#0b0714"],
    amber:   ["#e8c07a", "#d79a3c", "#ff9f6b", "#1a1206"],
    rose:    ["#ff7d9c", "#e94f75", "#ff9f6b", "#1d0a11"],
    azure:   ["#4cc9f0", "#3a86ff", "#7c6cff", "#04101a"],
    lime:    ["#9ee493", "#5fbb63", "#3ee0c4", "#06140a"],
  };

  // A custom wallpaper is a data URL in localStorage. Browsers give the whole
  // origin about 5 MB, and the desk keeps real state there too, so the image is
  // capped well below that instead of silently blowing the quota.
  var MAX_WALLPAPER_BYTES = 2 * 1024 * 1024;

  function read(key, fallback) {
    try {
      var v = localStorage.getItem(key);
      return v === null || v === "" ? fallback : v;
    } catch (e) {
      return fallback;
    }
  }

  function write(key, value) {
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch (e) {
      /* private mode or a full quota must never break the desk */
    }
  }

  function root() {
    return global.document && global.document.documentElement;
  }

  function oneOf(value, list, fallback) {
    return list.indexOf(value) === -1 ? fallback : value;
  }

  /* ----------------------------------------------------------------- skin */

  function getSkin() { return oneOf(read(LS.skin, "glass"), SKINS, "glass"); }

  function setSkin(name) {
    var skin = oneOf(name, SKINS, "glass");
    write(LS.skin, skin);
    apply();
    return skin;
  }

  /* --------------------------------------------------------------- accent */

  function normaliseHex(value) {
    if (typeof value !== "string") return null;
    var v = value.trim();
    if (/^#[0-9a-fA-F]{3}$/.test(v)) {
      return "#" + v[1] + v[1] + v[2] + v[2] + v[3] + v[3];
    }
    return /^#[0-9a-fA-F]{6}$/.test(v) ? v.toLowerCase() : null;
  }

  function mix(hex, other, weight) {
    var a = parseInt(hex.slice(1), 16);
    var b = parseInt(other.slice(1), 16);
    var out = 0;
    for (var shift = 16; shift >= 0; shift -= 8) {
      var ca = (a >> shift) & 255;
      var cb = (b >> shift) & 255;
      out |= Math.round(ca * (1 - weight) + cb * weight) << shift;
    }
    return "#" + ("000000" + out.toString(16)).slice(-6);
  }

  // Relative luminance, so text on a bright accent is dark and vice versa.

  function rgbTriplet(hex) {
    var n = parseInt(hex.slice(1), 16);
    return ((n >> 16) & 255) + " " + ((n >> 8) & 255) + " " + (n & 255);
  }


  function luminance(hex) {
    var n = parseInt(hex.slice(1), 16);
    var ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(function (c) {
      var v = c / 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
  }

  /** Text colour for a surface that is a translucent wash of the accent over
      the page: that is dominated by the page, so it follows the theme. */
  function contrastInk() {
    var el = root();
    var light = el && el.dataset.theme === "light";
    return light ? "#0b1018" : "#e8edf7";
  }

  /** Keep an accent usable as *text*. Yellow reads fine on a dark page and
      disappears on a light one; this lifts or deepens it until it does not. */
  function legibleOnPage(hex) {
    var el = root();
    var light = el && el.dataset.theme === "light";
    var lum = luminance(hex);
    if (light && lum > 0.42) return mix(hex, "#000000", Math.min(0.55, (lum - 0.42) * 1.6));
    if (!light && lum < 0.22) return mix(hex, "#ffffff", Math.min(0.55, (0.22 - lum) * 2.2));
    return hex;
  }

  /** Foreground for text sitting ON the accent, by relative luminance.
      0.45 is where a mid-tone stops being readable with light text. */
  function readableInk(hex) {
    return luminance(hex) > 0.45 ? "#061014" : "#f5f8ff";
  }

  function accentTriplet(value) {
    // The ink is always derived, never taken from the preset table: the rule
    // "dark text on a light accent, light text on a dark one" has to hold for
    // a colour the user invents as much as for one we shipped.
    if (ACCENTS[value]) {
      var preset = ACCENTS[value];
      return [preset[0], preset[1], preset[2], readableInk(preset[0])];
    }
    var hex = normaliseHex(value);
    if (!hex) return ACCENTS.aurora;
    // A custom colour only gives us one hue, so the gradient is derived from it:
    // a slightly deeper mid tone and a hue-shifted third stop.
    return [hex, mix(hex, "#000000", 0.22), mix(hex, "#7c6cff", 0.55), readableInk(hex)];
  }

  function getAccent() { return read(LS.accent, "aurora"); }

  function setAccent(value) {
    var ok = ACCENTS[value] ? value : normaliseHex(value);
    if (!ok) return getAccent();
    write(LS.accent, ok);
    apply();
    return ok;
  }

  /* ------------------------------------------------------------ wallpaper */

  function getBackground() { return oneOf(read(LS.bg, "default"), BACKGROUNDS, "default"); }

  function setBackground(name) {
    var bg = oneOf(name, BACKGROUNDS, "default");
    if (bg === "custom" && !read(LS.wallpaper, "")) return getBackground();
    write(LS.bg, bg);
    apply();
    return bg;
  }

  /**
   * Store a user-picked image and switch to it.
   * @returns {Promise<{ok:boolean, error?:string}>}
   */
  function setWallpaperFile(file) {
    return new Promise(function (resolve) {
      if (!file) return resolve({ ok: false, error: "no-file" });
      if (!/^image\//.test(file.type)) return resolve({ ok: false, error: "not-an-image" });
      if (file.size > MAX_WALLPAPER_BYTES) return resolve({ ok: false, error: "too-large" });

      var reader = new FileReader();
      reader.onerror = function () { resolve({ ok: false, error: "unreadable" }); };
      reader.onload = function () {
        var url = String(reader.result || "");
        try {
          localStorage.setItem(LS.wallpaper, url);
        } catch (e) {
          return resolve({ ok: false, error: "no-space" });
        }
        write(LS.bg, "custom");
        apply();
        resolve({ ok: true });
      };
      reader.readAsDataURL(file);
    });
  }

  function clearWallpaper() {
    write(LS.wallpaper, null);
    if (getBackground() === "custom") write(LS.bg, "default");
    apply();
  }

  function maxWallpaperMb() { return MAX_WALLPAPER_BYTES / (1024 * 1024); }

  /* ----------------------------------------------------------------- perf */

  /**
   * "auto" asks the machine. Four cores or less, or 4 GB or less, is the kind
   * of box where a wall of backdrop-filters turns scrolling into a slideshow,
   * so those get the cheap tier by default. Anyone can override it explicitly.
   */
  function detectPerf() {
    try {
      var cores = global.navigator && global.navigator.hardwareConcurrency;
      var mem = global.navigator && global.navigator.deviceMemory;
      if ((typeof cores === "number" && cores > 0 && cores <= 4) ||
          (typeof mem === "number" && mem > 0 && mem <= 4)) return "fast";
    } catch (e) { /* fall through to rich */ }
    return "rich";
  }

  function getPerfMode() {
    var v = read(LS.perf, "auto");
    return v === "fast" || v === "rich" ? v : "auto";
  }

  function effectivePerf() {
    var mode = getPerfMode();
    return mode === "auto" ? detectPerf() : mode;
  }

  function setPerfMode(mode) {
    var m = mode === "fast" || mode === "rich" ? mode : "auto";
    write(LS.perf, m);
    apply();
    return m;
  }

  /* ---------------------------------------------------------------- apply */

  function apply() {
    var el = root();
    if (!el) return;

    var skin = getSkin();
    el.dataset.skin = skin;

    var bg = getBackground();
    var wallpaper = bg === "custom" ? read(LS.wallpaper, "") : "";
    if (bg === "custom" && !wallpaper) bg = "default";
    el.dataset.bg = bg;
    if (wallpaper) el.style.setProperty("--skin-wallpaper", 'url("' + wallpaper + '")');
    else el.style.removeProperty("--skin-wallpaper");

    var a = accentTriplet(getAccent());
    el.style.setProperty("--accent", a[0]);
    el.style.setProperty("--accent-2", a[1]);
    el.style.setProperty("--accent-3", a[2]);
    el.style.setProperty("--accent-ink", a[3]);
    // app.css expresses every tinted hover, focus ring, badge and chart colour
    // as rgb(var(--accent-rgb) / alpha), so the triplets are what actually make
    // the whole desk follow the picked colour - not just the solid fills.
    el.style.setProperty("--accent-rgb", rgbTriplet(a[0]));
    el.style.setProperty("--accent-3-rgb", rgbTriplet(a[2]));
    el.style.setProperty("--scroll-thumb-hover", a[0]);

    // Two more readability values the stylesheet needs:
    //   --accent-ink-soft  text drawn ON a translucent wash of the accent
    //   --accent-readable  the accent itself, nudged until it is legible as
    //                      text on the page background (a pale yellow accent
    //                      is fine on a button and invisible as a label)
    el.style.setProperty("--accent-ink-soft", contrastInk());
    el.style.setProperty("--accent-readable", legibleOnPage(a[0]));

    // A skin that is not glass has no blur to pay for, so the expensive tier is
    // only meaningful under the glass skin.
    el.dataset.perf = skin === "glass" ? effectivePerf() : "fast";
  }

  // The theme can change without the accent changing, and both readability
  // values depend on it, so watch the attribute rather than hoping app.js
  // remembers to call us.
  function watchTheme() {
    try {
      var el = root();
      if (!el || typeof MutationObserver === "undefined") return;
      new MutationObserver(function () { apply(); })
        .observe(el, { attributes: true, attributeFilter: ["data-theme"] });
    } catch (e) { /* not fatal */ }
  }

  global.AurionSkin = {
    SKINS: SKINS,
    BACKGROUNDS: BACKGROUNDS,
    ACCENTS: ACCENTS,
    apply: apply,
    getSkin: getSkin,
    setSkin: setSkin,
    getAccent: getAccent,
    setAccent: setAccent,
    accentTriplet: accentTriplet,
    getBackground: getBackground,
    setBackground: setBackground,
    setWallpaperFile: setWallpaperFile,
    clearWallpaper: clearWallpaper,
    hasWallpaper: function () { return !!read(LS.wallpaper, ""); },
    maxWallpaperMb: maxWallpaperMb,
    getPerfMode: getPerfMode,
    setPerfMode: setPerfMode,
    effectivePerf: effectivePerf,
  };

  apply();
  watchTheme();
})(typeof window !== "undefined" ? window : this);
