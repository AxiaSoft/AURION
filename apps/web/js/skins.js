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

  // A custom wallpaper is stored as a data URL. Browsers give the whole origin
  // roughly 5 MB of localStorage and the desk keeps real state there too, so
  // instead of rejecting large pictures we re-encode them: a 24 MP phone photo
  // becomes a 2560px JPEG of a few hundred KB, which is more than a wallpaper
  // ever needs. Only if that still does not fit do we refuse.
  var WALLPAPER_MAX_EDGE = 2560;
  var WALLPAPER_QUALITY = 0.82;
  var WALLPAPER_INPUT_LIMIT = 40 * 1024 * 1024;   // sanity, not a design limit
  var WALLPAPER_STORE_LIMIT = 3.2 * 1024 * 1024;  // after re-encoding

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
   *
   * The file is decoded, scaled to fit WALLPAPER_MAX_EDGE and re-encoded as
   * JPEG before storage, so the size of the original barely matters - a 12 MB
   * photograph is accepted and kept as a few hundred kilobytes.
   *
   * @returns {Promise<{ok:boolean, error?:string}>}
   */
  function setWallpaperFile(file) {
    return new Promise(function (resolve) {
      if (!file) return resolve({ ok: false, error: "no-file" });
      if (!/^image\//.test(file.type)) return resolve({ ok: false, error: "not-an-image" });
      if (file.size > WALLPAPER_INPUT_LIMIT) return resolve({ ok: false, error: "too-large" });

      var reader = new FileReader();
      reader.onerror = function () { resolve({ ok: false, error: "unreadable" }); };
      reader.onload = function () {
        var raw = String(reader.result || "");
        downscale(raw, function (url) {
          try {
            localStorage.setItem(LS.wallpaper, url);
          } catch (e) {
            return resolve({ ok: false, error: "no-space" });
          }
          write(LS.bg, "custom");
          apply();
          resolve({ ok: true });
        }, function () {
          resolve({ ok: false, error: "unreadable" });
        });
      };
      reader.readAsDataURL(file);
    });
  }

  /** Decode, fit inside WALLPAPER_MAX_EDGE, re-encode as JPEG. */
  function downscale(dataUrl, done, fail) {
    try {
      var img = new Image();
      img.onerror = fail;
      img.onload = function () {
        var scale = Math.min(1, WALLPAPER_MAX_EDGE / Math.max(img.width, img.height));
        var w = Math.max(1, Math.round(img.width * scale));
        var h = Math.max(1, Math.round(img.height * scale));
        var canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        var ctx = canvas.getContext("2d");
        if (!ctx) return done(dataUrl);
        ctx.drawImage(img, 0, 0, w, h);

        var out = canvas.toDataURL("image/jpeg", WALLPAPER_QUALITY);
        // Step the quality down rather than giving up on a big picture.
        var quality = WALLPAPER_QUALITY;
        while (out.length > WALLPAPER_STORE_LIMIT && quality > 0.4) {
          quality -= 0.12;
          out = canvas.toDataURL("image/jpeg", quality);
        }
        done(out.length < dataUrl.length ? out : dataUrl);
      };
      img.src = dataUrl;
    } catch (e) {
      fail();
    }
  }

  function clearWallpaper() {
    write(LS.wallpaper, null);
    if (getBackground() === "custom") write(LS.bg, "default");
    apply();
  }

  function maxWallpaperMb() { return Math.round(WALLPAPER_INPUT_LIMIT / (1024 * 1024)); }

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
