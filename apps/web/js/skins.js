/* ===========================================================================
   AURION — appearance: skin, accent colour, performance tier.

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
    perf: "aurion.perf",
  };

  var SKINS = ["glass", "clay", "skeu", "neu"];
  // whatever the trader supplies. The generated alternatives were removed:
  // three more built-in backgrounds is three more things to keep looking
  // right across five skins and two themes, for no real gain.

  // Presets are (base, mid, third, ink). The first one is the original palette,
  // which is what an untouched install keeps.
  // Twenty curated accents. A free colour picker was offered first and removed:
  // most hand-picked values land somewhere that fights the dark surfaces or
  // goes muddy in the light theme, and every one of them still has to pass the
  // readability pass below. A fixed set can be tuned once and trusted.
  //
  // Each entry is [base, mid, third] - the mid and third stops build gradients.
  // The readable foreground is never stored here; it is derived from the base.
  var ACCENTS = {
    aurora:    ["#3ee0c4", "#2bb8c9", "#7c6cff"],
    teal:      ["#2ec4b6", "#1b9aaa", "#3ee0c4"],
    emerald:   ["#34d399", "#10b981", "#3ee0c4"],
    lime:      ["#a3e635", "#65a30d", "#34d399"],
    citrus:    ["#facc15", "#eab308", "#f97316"],
    amber:     ["#e8c07a", "#d79a3c", "#ff9f6b"],
    sunset:    ["#fb923c", "#ea580c", "#f43f5e"],
    coral:     ["#ff8a65", "#f4511e", "#ff4081"],
    rose:      ["#ff7d9c", "#e94f75", "#ff9f6b"],
    crimson:   ["#f43f5e", "#be123c", "#fb7185"],
    magenta:   ["#e879f9", "#c026d3", "#7c6cff"],
    orchid:    ["#c084fc", "#9333ea", "#e879f9"],
    violet:    ["#8b7bff", "#6c5ce7", "#c16cff"],
    indigo:    ["#818cf8", "#4f46e5", "#8b7bff"],
    azure:     ["#4cc9f0", "#3a86ff", "#7c6cff"],
    sky:       ["#38bdf8", "#0284c7", "#4cc9f0"],
    ice:       ["#a5f3fc", "#22d3ee", "#93c5fd"],
    steel:     ["#94a3b8", "#475569", "#64748b"],
    sand:      ["#d6c7a1", "#a1874e", "#e8c07a"],
    graphite:  ["#cbd5e1", "#64748b", "#94a3b8"],
  };

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

  function getSkin() {
    // oneOf() also rescues anyone whose stored skin no longer exists - the
    // minimal skin was removed, and its users must land on the default rather
    // than on an attribute nothing styles.
    return oneOf(read(LS.skin, "glass"), SKINS, "glass");
  }

  function setSkin(name) {
    var skin = oneOf(name, SKINS, "glass");
    write(LS.skin, skin);
    apply();
    return skin;
  }

  /* --------------------------------------------------------------- accent */

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

  var INK_DARK = "#061014";
  var INK_LIGHT = "#f5f8ff";

  function contrastRatio(a, b) {
    var hi = Math.max(a, b), lo = Math.min(a, b);
    return (hi + 0.05) / (lo + 0.05);
  }

  /**
   * Foreground for text sitting ON the accent.
   *
   * A fixed luminance threshold looked right and was not: a mid-tone like
   * #38bdf8 sits almost exactly on any threshold you pick, and whichever side
   * it falls on gives about 2:1 contrast - unreadable. So both candidates are
   * measured and the better one wins, which is what the eye does anyway.
   */
  function readableInk(hex) {
    var lum = luminance(hex);
    return contrastRatio(lum, luminance(INK_DARK)) >= contrastRatio(lum, luminance(INK_LIGHT))
      ? INK_DARK : INK_LIGHT;
  }

  function accentTriplet(value) {
    var preset = ACCENTS[value] || ACCENTS.aurora;
    // The ink is always derived - "dark text on a light accent, light text on
    // a dark one" has to hold for every entry, not be maintained by hand.
    return [preset[0], preset[1], preset[2], readableInk(preset[0])];
  }

  function getAccent() {
    var v = read(LS.accent, "aurora");
    return ACCENTS[v] ? v : "aurora";
  }

  function setAccent(value) {
    if (!ACCENTS[value]) return getAccent();
    write(LS.accent, value);
    apply();
    return value;
  }

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
    ACCENTS: ACCENTS,
    apply: apply,
    getSkin: getSkin,
    setSkin: setSkin,
    getAccent: getAccent,
    setAccent: setAccent,
    accentTriplet: accentTriplet,
    getPerfMode: getPerfMode,
    setPerfMode: setPerfMode,
    effectivePerf: effectivePerf,
  };

  // The wallpaper picker was removed; drop anything it left behind rather
  // than leaving a multi-megabyte data URL in the user's storage forever.
  try {
    localStorage.removeItem("aurion.bg");
    localStorage.removeItem("aurion.wallpaper");
  } catch (e) { /* nothing to clean up */ }

  apply();
  watchTheme();
})(typeof window !== "undefined" ? window : this);
