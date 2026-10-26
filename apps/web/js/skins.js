/* ===========================================================================
   AURION — display tier: how much the desk spends on visual effects.

   All that is left of the old appearance module. The interface styles and the
   accent picker were removed; the brand palette now lives entirely in
   css/app.css, where a theme switch is enough to change it.

   The file keeps its original name on purpose. It was briefly renamed to
   display.js - tidier, and also exactly the kind of change that breaks an
   install whose cached HTML still asks for the old path. A renamed script is a
   404, and a 404 here takes the whole desk with it.

   This owns one attribute on <html>:

       data-perf   rich | fast        fast removes every backdrop-filter

   Loaded from <head> so the choice is applied before the first paint.
   =========================================================================== */
(function (global) {
  "use strict";

  var LS_PERF = "aurion.perf";
  var LS_ACCENT = "aurion.accent";
  /* A hand-picked accent, and an optional gradient built from it.

     The note above ACCENTS explains why a free picker was dropped the
     first time: most hand-picked values fight the dark surfaces or go
     muddy in the light theme. That reasoning still holds for the twenty
     presets being the recommended path - but it argued for guidance, not
     for refusing the choice. A custom value goes through exactly the same
     readability derivation as a preset: the ink on top is measured, never
     stored, so an unwise colour stays legible even when it is not pretty.

     The gradient is accent-only on purpose. Panels, page and text are
     large areas read behind numbers; a gradient there costs legibility
     for nothing. On an accent it lands on buttons and badges, which are
     small and deliberate. */
  var LS_ACCENT_HEX = "aurion.accent.hex";
  var LS_ACCENT_GRAD = "aurion.accent.grad";

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

  /**
   * "auto" asks the machine. Four cores or less, or 4 GB or less, is the kind
   * of box where a wall of backdrop-filters turns scrolling into a slideshow,
   * so those get the cheap tier by default. Anyone can override it explicitly.
   */
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

  /** "#rrggbb" if the value is one, otherwise null. Accepts "#rgb" too. */
  function normHex(v) {
    var m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(v || "").trim());
    if (!m) return null;
    var h = m[1];
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    return "#" + h.toLowerCase();
  }

  function hexToHsl(hex) {
    var n = parseInt(hex.slice(1), 16);
    var r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
    var mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    var h = 0;
    if (d) {
      if (mx === r) h = ((g - b) / d) % 6;
      else if (mx === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
    }
    h *= 60; if (h < 0) h += 360;
    var l = (mx + mn) / 2;
    var sat = d ? d / (1 - Math.abs(2 * l - 1)) : 0;
    return [h, sat, l];
  }

  function hslToHex(h, sa, l) {
    h = ((h % 360) + 360) % 360;
    sa = Math.max(0, Math.min(1, sa));
    l = Math.max(0, Math.min(1, l));
    var c = (1 - Math.abs(2 * l - 1)) * sa;
    var x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    var m = l - c / 2;
    var t = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x]
          : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
    var out = 0;
    for (var i = 0; i < 3; i++) out = (out << 8) | Math.round((t[i] + m) * 255);
    return "#" + ("000000" + out.toString(16)).slice(-6);
  }

  /* A preset ships three hand-tuned stops. A custom colour has to grow its
     own: the mid turns a little and lifts, the third turns further. The
     shifts are small enough that the family still reads as one colour. */
  function derivedStops(hex) {
    var hsl = hexToHsl(hex);
    return [
      hex,
      hslToHex(hsl[0] - 12, Math.min(1, hsl[1] * 1.02), Math.max(0.16, hsl[2] * 0.88)),
      hslToHex(hsl[0] + 26, Math.min(1, hsl[1] * 0.96), Math.min(0.78, hsl[2] * 1.1)),
    ];
  }

  function customHex() { return normHex(read(LS_ACCENT_HEX, "")) || ""; }

  /** The accent gradient, or null when the trader has not asked for one. */
  function getAccentGradient() {
    try {
      var raw = read(LS_ACCENT_GRAD, "");
      if (!raw) return null;
      var g = JSON.parse(raw);
      if (!g || !g.on) return null;
      var from = normHex(g.from), to = normHex(g.to);
      if (!from || !to) return null;
      var angle = Number(g.angle);
      if (!isFinite(angle)) angle = 135;
      return { on: true, from: from, to: to, angle: ((angle % 360) + 360) % 360 };
    } catch (e) { return null; }
  }

  /* Passing null, false or {on:false} turns the gradient off. Anything that
     carries two usable stops turns it ON, whether or not it bothered to say
     on:true - an object describing a gradient that silently disables the
     gradient is a trap for the next caller. */
  function setAccentGradient(next) {
    var wantsOff = !next || next.on === false ||
      (next.on === undefined && !(normHex(next.from) && normHex(next.to)));
    if (wantsOff) write(LS_ACCENT_GRAD, null);
    else {
      write(LS_ACCENT_GRAD, JSON.stringify({
        on: true,
        from: normHex(next.from) || "#3ee0c4",
        to: normHex(next.to) || "#7c6cff",
        angle: ((Number(next.angle) || 0) % 360 + 360) % 360,
      }));
    }
    apply();
    return getAccentGradient();
  }

  function setCustomAccent(hex) {
    var h = normHex(hex);
    if (!h) return customHex();
    write(LS_ACCENT_HEX, h);
    write(LS_ACCENT, "custom");
    apply();
    return h;
  }

  function rgbTriplet(hex) {
    var n = parseInt(hex.slice(1), 16);
    return ((n >> 16) & 255) + " " + ((n >> 8) & 255) + " " + (n & 255);
  }


  function contrastRatio(a, b) {
    var hi = Math.max(a, b), lo = Math.min(a, b);
    return (hi + 0.05) / (lo + 0.05);
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

  // The surface an accent is most often drawn on as text: the panel colour of
  // the current theme. These two are the fallback - they mirror --s5 in
  // app.css and are what gets used before the stylesheets have parsed.
  var PAGE_SURFACE_DARK = "#0e1018";
  var PAGE_SURFACE_LIGHT = "#fafcff";
  var TEXT_CONTRAST_TARGET = 4.5;   // WCAG AA for normal text

  /**
   * The panel the accent is actually sitting on, read from the page.
   *
   * This used to be one of the two constants above, which was true while
   * there was one theme. There are twelve now, and their panels run from
   * Cyber's near-black to Clay's lilac - measuring a teal against #0e1018
   * and then drawing it on #3d2f5c is not a measurement, it is a guess. So
   * --s5 is read from the live document whenever it is there.
   */
  function panelSurface() {
    var el = root();
    var light = el && el.dataset.theme === "light";
    try {
      var raw = getComputedStyle(el).getPropertyValue("--s5").trim();
      var parts = raw.split(/[\s,]+/).filter(Boolean);
      if (parts.length === 3) {
        var hex = "#";
        for (var i = 0; i < 3; i++) {
          var n = Math.max(0, Math.min(255, parseInt(parts[i], 10) || 0));
          hex += ("0" + n.toString(16)).slice(-2);
        }
        return hex;
      }
    } catch (e) { /* before the stylesheet parses there is nothing to read */ }
    return light ? PAGE_SURFACE_LIGHT : PAGE_SURFACE_DARK;
  }

  /**
   * Keep an accent usable as *text*.
   *
   * The first version nudged the colour by a fixed amount when its luminance
   * crossed a threshold, which was a guess: measured afterwards, all twenty
   * accents still failed 4.5:1 as button labels on the light theme's panels.
   * This version states the goal instead - darken (or lighten) in small steps
   * until the contrast target is actually met, and stop as soon as it is, so a
   * colour that already passes is left exactly as the user chose it.
   */
  function legibleOnPage(hex) {
    var el = root();
    var light = el && el.dataset.theme === "light";
    var surface = panelSurface();
    var towards = light ? "#000000" : "#ffffff";
    var surfaceLum = luminance(surface);

    var out = hex;
    for (var step = 0; step < 20; step++) {
      if (contrastRatio(luminance(out), surfaceLum) >= TEXT_CONTRAST_TARGET) return out;
      out = mix(out, towards, 0.06);
    }
    return out;
  }

  // The two foregrounds any accent can take. Which one is used is measured,
  // never assumed - see readableInk below.
  var INK_DARK = "#061014";
  var INK_LIGHT = "#f5f8ff";

  function readableInk(hex) {
    var lum = luminance(hex);
    return contrastRatio(lum, luminance(INK_DARK)) >= contrastRatio(lum, luminance(INK_LIGHT))
      ? INK_DARK : INK_LIGHT;
  }

  function accentTriplet(value) {
    // "custom" is not in ACCENTS; its stops are derived from the hex the
    // trader chose, then put through the same readability pass as a preset.
    var preset = value === "custom" && customHex()
      ? derivedStops(customHex())
      : (ACCENTS[value] || ACCENTS.aurora);
    // The ink is always derived - "dark text on a light accent, light text on
    // a dark one" has to hold for every entry, not be maintained by hand.
    return [preset[0], preset[1], preset[2], readableInk(preset[0])];
  }

  /* The accent picker is premium. While it is locked the theme dictates the
     accent, and that is expressed here rather than by overwriting the stored
     value: a user who once picked sand and later lets a key lapse gets sand
     back the moment they renew, instead of silently losing it. */
  var forcedAccent = null;

  function forceAccent(value) {
    var next = ACCENTS[value] ? value : null;
    if (next === forcedAccent) return forcedAccent;
    forcedAccent = next;
    apply();
    return forcedAccent;
  }

  function getAccent() {
    if (forcedAccent) return forcedAccent;
    var v = read(LS_ACCENT, "aurora");
    if (v === "custom" && customHex()) return "custom";
    return ACCENTS[v] ? v : "aurora";
  }

  /** What the user chose, ignoring any lock - for the settings row. */
  function storedAccent() {
    var v = read(LS_ACCENT, "aurora");
    return ACCENTS[v] ? v : "aurora";
  }

  function setAccent(value) {
    if (!ACCENTS[value]) return getAccent();
    write(LS_ACCENT, value);
    apply();
    return getAccent();
  }

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
    var v = read(LS_PERF, "auto");
    return v === "fast" || v === "rich" ? v : "auto";
  }

  function effectivePerf() {
    var mode = getPerfMode();
    return mode === "auto" ? detectPerf() : mode;
  }

  function setPerfMode(mode) {
    var m = mode === "fast" || mode === "rich" ? mode : "auto";
    write(LS_PERF, m);
    apply();
    return m;
  }

  function apply() {
    var el = root();
    if (!el) return;
    el.dataset.perf = effectivePerf();

    var a = accentTriplet(getAccent());
    el.style.setProperty("--accent", a[0]);
    el.style.setProperty("--accent-2", a[1]);
    el.style.setProperty("--accent-3", a[2]);
    el.style.setProperty("--accent-ink", a[3]);
    // The alpha tints in app.css resolve through these, which is what makes a
    // chosen colour reach every hover, focus ring, badge and chip rather than
    // only the solid fills.
    el.style.setProperty("--accent-rgb", rgbTriplet(a[0]));
    el.style.setProperty("--accent-3-rgb", rgbTriplet(a[2]));
    el.style.setProperty("--scroll-thumb-hover", a[0]);
    el.style.setProperty("--accent-readable", legibleOnPage(a[0]));

    /* The gradient is published as a paint value, and as a flag so a rule
       can choose between it and the flat colour. It is deliberately NOT
       fed into --accent itself: everything that needs a single colour -
       a focus ring, a border, a chart series, the derived ink - still
       gets one, and only the handful of large accent fills opt in.
       --accent-grad-ink is measured against the darker of the two stops,
       because that is the worst case for a label sitting on the band. */
    var grad = getAccentGradient();
    if (grad) {
      el.style.setProperty("--accent-gradient",
        "linear-gradient(" + grad.angle + "deg, " + grad.from + ", " + grad.to + ")");
      el.style.setProperty("--accent-grad-ink",
        readableInk(luminance(grad.from) < luminance(grad.to) ? grad.from : grad.to));
      el.dataset.accentGrad = "on";
    } else {
      el.style.removeProperty("--accent-gradient");
      el.style.removeProperty("--accent-grad-ink");
      delete el.dataset.accentGrad;
    }
  }

  // Both readability values depend on the light/dark theme, so they are
  // re-derived when it changes rather than relying on a caller to remember.
  function watchTheme() {
    try {
      var el = root();
      if (!el || typeof MutationObserver === "undefined") return;
      new MutationObserver(function () { apply(); })
        .observe(el, { attributes: true, attributeFilter: ["data-theme"] });
    } catch (e) { /* not fatal */ }
  }

  // Settings that no longer exist are cleared rather than left behind: the
  // wallpaper picker could otherwise strand a multi-megabyte data URL in the
  // user's storage, and a stale skin or accent name would be read by nothing.
  try {
    localStorage.removeItem("aurion.bg");
    localStorage.removeItem("aurion.wallpaper");
    localStorage.removeItem("aurion.skin");
  } catch (e) { /* nothing to clean up */ }

  global.AurionSkin = {
    ACCENTS: ACCENTS,
    normHex: normHex,
    derivedStops: derivedStops,
    customAccent: customHex,
    setCustomAccent: setCustomAccent,
    accentGradient: getAccentGradient,
    setAccentGradient: setAccentGradient,
    getAccent: getAccent,
    storedAccent: storedAccent,
    setAccent: setAccent,
    forceAccent: forceAccent,
    accentTriplet: accentTriplet,
    apply: apply,
    getPerfMode: getPerfMode,
    setPerfMode: setPerfMode,
    effectivePerf: effectivePerf,
  };

  apply();
  watchTheme();

  // The first run happens in <head>, before any stylesheet has parsed, so
  // panelSurface() can only return its fallback there. Running once more when
  // the document is ready is what lets the readable forms of the accent be
  // measured against the theme that is actually on screen.
  try {
    if (global.document && global.document.readyState === "loading") {
      global.document.addEventListener("DOMContentLoaded", function () { apply(); });
    }
  } catch (e) { /* the fallback measurement still applies */ }
})(typeof window !== "undefined" ? window : this);
