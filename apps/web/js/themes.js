/* ===========================================================================
   AURION — the theme and morphism engine.

   A theme here is not a colour switch. Each one owns the *material* the desk
   is made of: how opaque a surface is, how far it blurs what is behind it,
   how it casts a shadow, how round it is, how bright its hairline reads, how
   much the interface is allowed to move, and what the page behind it does.
   Those seven numbers plus the accent are the whole vocabulary, and every
   component in css/themes.css is written against them - which is why adding a
   thirteenth theme is a dozen lines in the table below and nothing else.

   This file owns three attributes on <html>:

       data-skin     glass | frost | neu | clay | aurora | cyber | minimal
                     midnight | ocean | sunset | mono | custom
       data-bg       which backdrop the theme asks for
       data-motion   full | soft | off

   ...and, for the custom theme only, a handful of inline custom properties.

   Storage lives beside the existing keys rather than replacing them:

       aurion.theme.skin     the chosen theme id
       aurion.theme.custom   the custom theme's knobs, as JSON

   The light/dark choice (aurion.theme), the accent (aurion.accent) and the
   rendering tier (aurion.perf) are NOT duplicated here - they stay with
   js/skins.js, and a theme merely nominates the accent it was designed for.

   Loaded from <head>, synchronously, so the attributes are on the element
   before the first stylesheet is applied and the desk never flashes a theme
   the user did not choose.
   =========================================================================== */
(function (global) {
  "use strict";

  var LS_SKIN = "aurion.theme.skin";
  var LS_CUSTOM = "aurion.theme.custom";
  var DEFAULT_SKIN = "glass";

  /* -------------------------------------------------------------------------
     The table.

     accent    an id from AurionSkin.ACCENTS - applied when the theme is
               picked, and freely overridable afterwards from the accent row.
     bg        the backdrop the theme asks the page for (see css/themes.css).
     knobs     the seven material numbers. Themes state only what they change;
               anything omitted falls back to the glass baseline, so the table
               stays readable.
     ------------------------------------------------------------------------- */
  var BASE_KNOBS = {
    surface: 62,     /* % — how opaque a panel is over the page          */
    border: 10,      /* % — hairline strength                            */
    blur: 18,        /* px — backdrop blur on translucent surfaces       */
    radius: 22,      /* px — the large corner radius                     */
    shadow: 100,     /* % — shadow depth                                 */
    motion: 100,     /* % — animation amplitude and speed                */
  };

  var THEMES = [
    {
      id: "glass", accent: "aurora", bg: "soft", morph: "glass",
      knobs: { surface: 62, border: 10, blur: 18, radius: 22, shadow: 100, motion: 100 },
      swatch: ["#070910", "#151c2b", "#3ee0c4"],
    },
    {
      id: "frost", accent: "ice", bg: "blobs", morph: "glass",
      knobs: { surface: 30, border: 22, blur: 34, radius: 24, shadow: 75, motion: 100 },
      swatch: ["#070c18", "#22304e", "#a5f3fc"],
    },
    {
      id: "neu", accent: "steel", bg: "flat", morph: "neu",
      knobs: { surface: 100, border: 0, blur: 0, radius: 26, shadow: 130, motion: 90 },
      swatch: ["#1b1f27", "#252b36", "#94a3b8"],
    },
    {
      id: "clay", accent: "orchid", bg: "flat", morph: "clay",
      knobs: { surface: 100, border: 0, blur: 0, radius: 32, shadow: 140, motion: 125 },
      swatch: ["#191325", "#3d2f5c", "#c084fc"],
    },
    {
      id: "aurora", accent: "violet", bg: "aurora", morph: "glass",
      knobs: { surface: 46, border: 15, blur: 28, radius: 26, shadow: 110, motion: 120 },
      swatch: ["#070919", "#2a2266", "#8b7bff"],
    },
    {
      id: "cyber", accent: "magenta", bg: "grid", morph: "cyber",
      knobs: { surface: 78, border: 38, blur: 8, radius: 8, shadow: 95, motion: 110 },
      swatch: ["#030410", "#10183a", "#e879f9"],
    },
    {
      id: "minimal", accent: "sky", bg: "none", morph: "flat",
      knobs: { surface: 100, border: 14, blur: 0, radius: 10, shadow: 30, motion: 70 },
      swatch: ["#0c0e13", "#1e222a", "#38bdf8"],
    },
    {
      id: "midnight", accent: "indigo", bg: "layered", morph: "solid",
      knobs: { surface: 94, border: 10, blur: 6, radius: 16, shadow: 115, motion: 90 },
      swatch: ["#04060f", "#182148", "#818cf8"],
    },
    {
      id: "ocean", accent: "azure", bg: "waves", morph: "glass",
      knobs: { surface: 54, border: 14, blur: 24, radius: 22, shadow: 100, motion: 100 },
      swatch: ["#020e16", "#0c3c50", "#4cc9f0"],
    },
    {
      id: "sunset", accent: "sunset", bg: "dusk", morph: "glass",
      knobs: { surface: 56, border: 14, blur: 22, radius: 26, shadow: 105, motion: 105 },
      swatch: ["#16080d", "#46212a", "#fb923c"],
    },
    {
      id: "mono", accent: "graphite", bg: "none", morph: "flat",
      knobs: { surface: 100, border: 18, blur: 0, radius: 4, shadow: 20, motion: 55 },
      swatch: ["#09090a", "#212123", "#d4d4d8"],
    },
    {
      id: "custom", accent: "aurora", bg: "soft", morph: "glass",
      knobs: { surface: 62, border: 10, blur: 18, radius: 22, shadow: 100, motion: 100 },
      swatch: ["#06070b", "#161a26", "#3ee0c4"],
    },
  ];

  var BY_ID = {};
  for (var i = 0; i < THEMES.length; i++) BY_ID[THEMES[i].id] = THEMES[i];

  /* The morphism families a theme can belong to. Kept as a list so the UI can
     describe a theme without knowing the CSS. */
  var BACKDROPS = ["soft", "blobs", "aurora", "grid", "waves", "dusk", "layered", "flat", "none"];

  /* ------------------------------------------------------------------ util */

  function read(key, fallback) {
    try {
      var v = localStorage.getItem(key);
      return v === null || v === "" ? fallback : v;
    } catch (e) { return fallback; }
  }

  function write(key, value) {
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch (e) { /* private mode must never break the desk */ }
  }

  function root() {
    return global.document && global.document.documentElement;
  }

  function clamp(n, lo, hi) {
    n = Number(n);
    if (!isFinite(n)) return lo;
    return n < lo ? lo : n > hi ? hi : n;
  }

  /* ----------------------------------------------------------------- state */

  function getTheme() {
    var v = read(LS_SKIN, DEFAULT_SKIN);
    return BY_ID[v] ? v : DEFAULT_SKIN;
  }

  /** The knob limits, so the UI can build its sliders from one source. */
  var LIMITS = {
    surface: [10, 100, 1],
    border: [0, 60, 1],
    blur: [0, 40, 1],
    radius: [0, 34, 1],
    shadow: [0, 180, 5],
    motion: [0, 160, 10],
  };

  function defaultCustom() {
    var k = BY_ID.custom.knobs;
    return {
      accent: BY_ID.custom.accent,
      bg: BY_ID.custom.bg,
      surface: k.surface, border: k.border, blur: k.blur,
      radius: k.radius, shadow: k.shadow, motion: k.motion,
    };
  }

  function getCustom() {
    var out = defaultCustom();
    var raw = read(LS_CUSTOM, "");
    if (!raw) return out;
    var parsed = null;
    try { parsed = JSON.parse(raw); } catch (e) { parsed = null; }
    if (!parsed || typeof parsed !== "object") return out;
    for (var key in LIMITS) {
      if (!Object.prototype.hasOwnProperty.call(LIMITS, key)) continue;
      if (parsed[key] === undefined || parsed[key] === null) continue;
      out[key] = clamp(parsed[key], LIMITS[key][0], LIMITS[key][1]);
    }
    if (typeof parsed.accent === "string") out.accent = parsed.accent;
    if (BACKDROPS.indexOf(parsed.bg) !== -1) out.bg = parsed.bg;
    return out;
  }

  function setCustom(patch, opts) {
    var next = getCustom();
    for (var key in patch) {
      if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
      if (LIMITS[key]) next[key] = clamp(patch[key], LIMITS[key][0], LIMITS[key][1]);
      else if (key === "accent" && typeof patch[key] === "string") next.accent = patch[key];
      else if (key === "bg" && BACKDROPS.indexOf(patch[key]) !== -1) next.bg = patch[key];
    }
    write(LS_CUSTOM, JSON.stringify(next));
    if (!(opts && opts.silent)) apply();
    if (next.accent && getTheme() === "custom") applyAccent(next.accent);
    return next;
  }

  function resetCustom() {
    write(LS_CUSTOM, null);
    apply();
    if (getTheme() === "custom") applyAccent(defaultCustom().accent);
    return getCustom();
  }

  /** The knobs actually in force right now, theme defaults or custom. */
  function activeKnobs() {
    var id = getTheme();
    if (id === "custom") return getCustom();
    var t = BY_ID[id] || BY_ID[DEFAULT_SKIN];
    var out = {};
    for (var k in BASE_KNOBS) {
      if (!Object.prototype.hasOwnProperty.call(BASE_KNOBS, k)) continue;
      out[k] = t.knobs[k] === undefined ? BASE_KNOBS[k] : t.knobs[k];
    }
    out.bg = t.bg;
    out.accent = t.accent;
    return out;
  }

  function applyAccent(accentId) {
    try {
      if (global.AurionSkin && accentId && global.AurionSkin.ACCENTS[accentId]) {
        global.AurionSkin.setAccent(accentId);
      }
    } catch (e) { /* the theme still applies without its accent */ }
  }

  /* ----------------------------------------------------------------- apply */

  /**
   * The knobs are published as a stylesheet rule, not as inline properties on
   * <html>.
   *
   * Inline was the first attempt and it was wrong: an inline custom property
   * cannot be overridden by any rule, so "liquid glass off", the cheap
   * rendering tier and prefers-reduced-motion - all three of which have to be
   * able to say "no translucency" or "no movement" whatever the theme asked
   * for - had no way to be heard. A rule at [data-skin][data-theme] sits
   * above the :root defaults and below those three, which is exactly the
   * order of authority we want.
   */
  var sheet = null;

  function publish(css) {
    try {
      if (!sheet) {
        var doc = global.document;
        if (!doc) return;
        sheet = doc.getElementById("aurion-theme-knobs");
        if (!sheet) {
          sheet = doc.createElement("style");
          sheet.id = "aurion-theme-knobs";
          (doc.head || doc.documentElement).appendChild(sheet);
        }
      }
      sheet.textContent = css;
    } catch (e) { /* the theme's palette still applies without its knobs */ }
  }

  /** Write the active theme onto <html>. */
  function apply() {
    var el = root();
    if (!el) return;
    var id = getTheme();
    var k = activeKnobs();

    el.dataset.skin = id;
    el.dataset.bg = k.bg || "soft";

    var motion = clamp(k.motion, 0, 160);
    el.dataset.motion = motion === 0 ? "off" : motion < 70 ? "soft" : "full";

    publish(
      "html[data-skin][data-theme]{" +
      "--surface-alpha:" + (clamp(k.surface, 0, 100) / 100).toFixed(3) + ";" +
      "--border-alpha:" + (clamp(k.border, 0, 100) / 100).toFixed(3) + ";" +
      "--blur:" + clamp(k.blur, 0, 60) + "px;" +
      "--radius-lg:" + clamp(k.radius, 0, 40) + "px;" +
      "--shadow-strength:" + (clamp(k.shadow, 0, 200) / 100).toFixed(3) + ";" +
      "--motion-scale:" + (motion / 100).toFixed(3) + "}"
    );
  }

  /**
   * Choose a theme.
   *
   * The accent moves with it by default: a theme is a designed pairing, and
   * landing on Cyber with the sand accent still selected is not the theme
   * anybody clicked. The accent row underneath remains authoritative
   * afterwards, so the pairing is a starting point, not a cage.
   */
  function setTheme(id, opts) {
    if (!BY_ID[id]) return getTheme();
    write(LS_SKIN, id);
    apply();
    if (!(opts && opts.keepAccent)) {
      applyAccent(id === "custom" ? getCustom().accent : BY_ID[id].accent);
    }
    try {
      global.dispatchEvent(new CustomEvent("aurion:theme", { detail: { id: id } }));
    } catch (e) { /* CustomEvent is not essential */ }
    return id;
  }

  /* A theme change re-derives the accent's readable forms, exactly as a
     light/dark change does, because both depend on the surface underneath. */
  function watch() {
    try {
      var el = root();
      if (!el || typeof MutationObserver === "undefined") return;
      new MutationObserver(function () {
        if (global.AurionSkin) global.AurionSkin.apply();
      }).observe(el, { attributes: true, attributeFilter: ["data-skin"] });
    } catch (e) { /* not fatal */ }
  }

  global.AurionTheme = {
    THEMES: THEMES,
    BY_ID: BY_ID,
    LIMITS: LIMITS,
    DEFAULT: DEFAULT_SKIN,
    get: getTheme,
    set: setTheme,
    apply: apply,
    knobs: activeKnobs,
    getCustom: getCustom,
    setCustom: setCustom,
    resetCustom: resetCustom,
    defaultCustom: defaultCustom,
  };

  apply();
  watch();
})(typeof window !== "undefined" ? window : this);
