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
       aurion.theme.paid     last known licence verdict, so a paid desk paints
                             its theme at boot instead of flashing the free one

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
  /* Per-theme edits, keyed by theme id: {"neu":{"blur":12,"bg":"waves"}, ...}.
     The builder used to write to one slot that only the "custom" theme read,
     so picking Neumorphism and moving a slider appeared to do nothing. Every
     theme is now editable and keeps its own edits, and the originals are
     never overwritten - they are the table above, so "reset" is exact. */
  var LS_EDITS = "aurion.theme.edits";
  /* A background picture the trader chose, as a data URL. Local to this
     machine; it is never sent anywhere. */
  var LS_BGIMG = "aurion.theme.bgimage";
  var LS_BGDIM = "aurion.theme.bgdim";
  var LS_PAID = "aurion.theme.paid";
  var DEFAULT_SKIN = "glass";

  /* -------------------------------------------------------------------------
     What freemium gets.

     Liquid Glass is the product's own look and is never taken away - a free
     desk is a complete desk, not a crippled one. The other eleven materials
     and the custom builder are premium, and so is the accent row: while the
     lock is on, the accent is whatever the active theme was designed with.

     The premium flag is mirrored into localStorage because this file runs in
     <head>, long before the engine snapshot that carries the licence can
     arrive. Reading the last known answer at boot is what keeps a paying user
     from seeing their theme flash to glass and back on every launch. It is a
     cache for painting, never the authority: the snapshot corrects it within
     the first second, in both directions.
     ------------------------------------------------------------------------- */
  var FREE_THEMES = ["glass"];

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
  var BACKDROPS = ["soft", "blobs", "aurora", "grid", "waves", "dusk", "layered", "flat", "none", "photo"];

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

  /** The theme the user chose, licensed or not. */
  function getTheme() {
    var v = read(LS_SKIN, DEFAULT_SKIN);
    return BY_ID[v] ? v : DEFAULT_SKIN;
  }

  function isPaid() {
    return read(LS_PAID, "0") === "1";
  }

  function isLocked(id) {
    if (!BY_ID[id]) return false;
    return !isPaid() && FREE_THEMES.indexOf(id) === -1;
  }

  /** The theme actually on screen: the chosen one, or glass if it is locked. */
  function effectiveTheme() {
    var id = getTheme();
    return isLocked(id) ? DEFAULT_SKIN : id;
  }

  /**
   * Tell the engine's verdict to the theme layer.
   *
   * Returns true when the answer changed something visible, so the desk knows
   * whether it has to re-mark the gallery. Both directions matter: activating
   * a key restores the theme the user had picked before it lapsed, and losing
   * one puts the desk back on glass without a reload.
   */
  function setPaid(paid) {
    var next = paid ? "1" : "0";
    if (read(LS_PAID, "0") === next) return false;
    var before = effectiveTheme();
    write(LS_PAID, next);
    var after = effectiveTheme();
    // apply() pins or releases the accent by itself; deliberately nothing is
    // written to the accent key here, so a key that lapses and is renewed
    // gives the user back the exact colour they had chosen.
    apply();
    // The theme on screen only moves when the chosen one was locked, but the
    // padlocks move either way, so the caller is told about both.
    if (before !== after) {
      try {
        global.dispatchEvent(new CustomEvent("aurion:theme", { detail: { id: after, licence: true } }));
      } catch (e) { /* CustomEvent is not essential */ }
    }
    return true;
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

  /* -------------------------------------------------------------------------
     Colour and font overrides.

     The builder used to move only the seven material numbers, so a trader
     could make Neumorphism flatter but not change a single colour: the page,
     the panels, the text and the typeface all came from the theme and could
     not be touched. These five let the whole interface be recoloured without
     leaving the theme.

     Everything is derived from three choices rather than asking for fifteen
     hex codes. A surface is never one colour - the desk stacks nine shades
     so a card reads as sitting above the page - so the chosen panel colour
     becomes the bottom of that ladder and the rest is mixed towards white
     keeping the separation the design relies on. Picking nine shades by hand
     is how a theme ends up flat and unreadable.
     ------------------------------------------------------------------------- */
  var FONTS = {
    theme:  "",                                        /* whatever the page already asks for */
    outfit: "Outfit,Vazirmatn,system-ui,sans-serif",
    vazir:  "Vazirmatn,Outfit,system-ui,sans-serif",
    mono:   "\"IBM Plex Mono\",Vazirmatn,ui-monospace,monospace",
    system: "system-ui,-apple-system,Segoe UI,sans-serif",
  };

  var COLOR_KEYS = ["page", "panel", "ink"];

  /* Effects over the backdrop.

     These apply to every background, not just to a picture the trader
     supplied: the built-in backdrops are drawn by the desk, and a trader who
     likes the aurora but finds it loud should be able to calm it without
     having to abandon it. Expressed as a filter so one declaration covers
     all ten backdrops instead of ten hand-written variants. */
  var FX = {
    none:   "",
    blur:   "blur(26px)",
    dim:    "brightness(.55)",
    bright: "brightness(1.35)",
    grey:   "saturate(0)",
    warm:   "sepia(.45) saturate(1.3) hue-rotate(-14deg)",
    cool:   "saturate(1.15) hue-rotate(150deg)",
  };

  function hexToRgb(hex) {
    var h = String(hex || "").trim().replace(/^#/, "");
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }

  function rgbToHex(c) {
    return "#" + c.map(function (n) {
      var v = Math.max(0, Math.min(255, Math.round(n))).toString(16);
      return v.length === 1 ? "0" + v : v;
    }).join("");
  }

  function mix(a, b, t) {
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  }

  /* Perceived brightness, not the plain average: the eye reads green as far
     brighter than blue, and a navy panel would otherwise be called light. */
  function luma(c) { return (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255; }

  /** Turn the three chosen colours into the variables the desk actually uses. */
  function colourCss(colours) {
    var out = "";
    var panel = hexToRgb(colours.panel);
    var page = hexToRgb(colours.page);
    var ink = hexToRgb(colours.ink);

    if (page) {
      var pageLight = luma(page) > 0.5;
      out += "--bg:" + rgbToHex(page) + ";";
      out += "--bg2:" + rgbToHex(mix(page, pageLight ? [0, 0, 0] : [255, 255, 255], 0.05)) + ";";
      out += "--deep:" + rgbToHex(mix(page, [0, 0, 0], 0.25)) + ";";
    }

    if (panel) {
      var light = luma(panel) > 0.5;
      var towards = light ? [0, 0, 0] : [255, 255, 255];
      for (var i = 1; i <= 9; i++) {
        var t = ((i - 1) / 8) * 0.075;
        var shade = mix(panel, towards, t);
        out += "--s" + i + ":" + shade.map(function (n) { return Math.round(n); }).join(" ") + ";";
      }
      /* Hairlines and hovers are drawn as a translucent wash over the panel.
         On a light panel a white wash is invisible, so the wash flips. */
      out += "--wash:" + (light ? "0 0 0" : "255 255 255") + ";";
      out += "--field:" + rgbToHex(mix(panel, towards, 0.055)) + ";";
      out += "--field2:" + rgbToHex(mix(panel, towards, 0.035)) + ";";
      out += "--field-hi:" + rgbToHex(mix(panel, towards, 0.085)) + ";";
      out += "--chart-panel:" + rgbToHex(mix(panel, towards, 0.02)) + ";";
    }

    if (ink) {
      var base = panel || page || [0, 0, 0];
      out += "--ink:" + rgbToHex(ink) + ";";
      /* Secondary text is the same colour faded into the surface behind it,
         which keeps the hue of the chosen text instead of greying it out. */
      out += "--muted:" + rgbToHex(mix(ink, base, 0.42)) + ";";
      out += "--faint:" + rgbToHex(mix(ink, base, 0.62)) + ";";
      out += "--chart-text:" + rgbToHex(ink) + ";";
      out += "--chart-muted:" + rgbToHex(mix(ink, base, 0.42)) + ";";
    }

    if (colours.font && FONTS[colours.font]) out += "--font:" + FONTS[colours.font] + ";";
    return out;
  }

  /** The backdrop effect chosen for a theme, or "none". */
  function activeFx(id) {
    var edit = readEdits()[id];
    return edit && FX[edit.fx] !== undefined && edit.fx ? edit.fx : "none";
  }

  /** The colour and font overrides in force for a theme, if any. */
  function themeColours(id) {
    var edit = readEdits()[id];
    var out = {};
    if (!edit) return out;
    for (var i = 0; i < COLOR_KEYS.length; i++) {
      var k = COLOR_KEYS[i];
      if (hexToRgb(edit[k])) out[k] = edit[k];
    }
    if (edit.font && FONTS[edit.font]) out.font = edit.font;
    if (edit.fx && FX[edit.fx]) out.fx = edit.fx;
    return out;
  }

  /* ------------------------------------------------------- per-theme edits */

  function readEdits() {
    var raw = read(LS_EDITS, "");
    if (!raw) return {};
    try {
      var parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch (e) { return {}; }
  }

  /** The theme's own numbers with this trader's edits laid over the top. */
  function themeKnobs(id) {
    var t = BY_ID[id] || BY_ID[DEFAULT_SKIN];
    var out = {};
    for (var k in BASE_KNOBS) {
      if (!Object.prototype.hasOwnProperty.call(BASE_KNOBS, k)) continue;
      out[k] = t.knobs[k] === undefined ? BASE_KNOBS[k] : t.knobs[k];
    }
    out.bg = t.bg;
    out.accent = t.accent;

    var edit = readEdits()[id];
    if (edit && typeof edit === "object") {
      for (var key in LIMITS) {
        if (!Object.prototype.hasOwnProperty.call(LIMITS, key)) continue;
        if (edit[key] === undefined || edit[key] === null) continue;
        out[key] = clamp(edit[key], LIMITS[key][0], LIMITS[key][1]);
      }
      if (typeof edit.accent === "string") out.accent = edit.accent;
      if (BACKDROPS.indexOf(edit.bg) !== -1) out.bg = edit.bg;
      for (var ci = 0; ci < COLOR_KEYS.length; ci++) {
        if (hexToRgb(edit[COLOR_KEYS[ci]])) out[COLOR_KEYS[ci]] = edit[COLOR_KEYS[ci]];
      }
      if (edit.font && FONTS[edit.font]) out.font = edit.font;
      if (edit.fx && FX[edit.fx]) out.fx = edit.fx;
    }
    return out;
  }

  /** Has this theme been changed from how it shipped? */
  function isEdited(id) {
    var edit = readEdits()[id];
    if (!edit) return false;
    for (var k in edit) {
      if (Object.prototype.hasOwnProperty.call(edit, k)) return true;
    }
    return false;
  }

  /** Edit the theme currently in use - built-in ones included. */
  function editTheme(patch, opts) {
    var id = effectiveTheme();
    if (id === "custom") return setCustom(patch, opts);

    var all = readEdits();
    var next = all[id] && typeof all[id] === "object" ? all[id] : {};
    for (var key in patch) {
      if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
      if (LIMITS[key]) next[key] = clamp(patch[key], LIMITS[key][0], LIMITS[key][1]);
      else if (key === "accent" && typeof patch[key] === "string") next.accent = patch[key];
      else if (key === "bg" && BACKDROPS.indexOf(patch[key]) !== -1) next.bg = patch[key];
      else if (COLOR_KEYS.indexOf(key) !== -1) {
        // An empty value means "back to the theme's own colour", which is
        // how the clear button works without a second code path.
        if (!patch[key]) delete next[key];
        else if (hexToRgb(patch[key])) next[key] = rgbToHex(hexToRgb(patch[key]));
      } else if (key === "fx") {
        if (!patch[key] || patch[key] === "none") delete next.fx;
        else if (FX[patch[key]]) next.fx = patch[key];
      } else if (key === "font") {
        if (!patch[key] || patch[key] === "theme") delete next.font;
        else if (FONTS[patch[key]]) next.font = patch[key];
      }
    }
    all[id] = next;
    write(LS_EDITS, JSON.stringify(all));
    if (!(opts && opts.silent)) apply();
    if (next.accent) applyAccent(next.accent);
    return themeKnobs(id);
  }

  /** Put the theme in use back to how it shipped. */
  function resetTheme() {
    var id = effectiveTheme();
    if (id === "custom") return resetCustom();
    var all = readEdits();
    delete all[id];
    write(LS_EDITS, JSON.stringify(all));
    apply();
    applyAccent(BY_ID[id].accent);
    return themeKnobs(id);
  }

  /* ---------------------------------------------- the trader's own picture */

  function getBgImage() { return read(LS_BGIMG, "") || ""; }

  function setBgImage(dataUrl) {
    if (!dataUrl) write(LS_BGIMG, null);
    else write(LS_BGIMG, String(dataUrl));
    apply();
    return getBgImage();
  }

  function getBgDim() { return clamp(read(LS_BGDIM, 45), 0, 90); }

  function setBgDim(value) {
    write(LS_BGDIM, String(clamp(value, 0, 90)));
    apply();
    return getBgDim();
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
    if (next.accent && effectiveTheme() === "custom") applyAccent(next.accent);
    return next;
  }

  function resetCustom() {
    write(LS_CUSTOM, null);
    apply();
    if (effectiveTheme() === "custom") applyAccent(defaultCustom().accent);
    return getCustom();
  }

  /** The knobs actually in force right now: the theme, plus any edits. */
  function activeKnobs() {
    var id = effectiveTheme();
    if (id === "custom") return getCustom();
    return themeKnobs(id);
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
    var id = effectiveTheme();
    var k = activeKnobs();

    el.dataset.skin = id;
    /* "photo" is the trader's own picture. If they picked it and then removed
       the file we fall back rather than leave an empty page. */
    var bg = k.bg || "soft";
    var picture = getBgImage();
    if (bg === "photo" && !picture) bg = "soft";
    el.dataset.bg = bg;
    /* Premium gates the accent row too, so while it is locked the theme's own
       accent is pinned - the desk still looks designed, it just looks the one
       way this theme was designed to look. */
    try {
      if (global.AurionSkin && global.AurionSkin.forceAccent) {
        global.AurionSkin.forceAccent(isPaid() ? null : (k.accent || BY_ID[id].accent));
      }
    } catch (e) { /* the theme still applies without the pin */ }

    var motion = clamp(k.motion, 0, 160);
    el.dataset.motion = motion === 0 ? "off" : motion < 70 ? "soft" : "full";

    publish(
      "html[data-skin][data-theme]{" +
      "--surface-alpha:" + (clamp(k.surface, 0, 100) / 100).toFixed(3) + ";" +
      "--border-alpha:" + (clamp(k.border, 0, 100) / 100).toFixed(3) + ";" +
      "--blur:" + clamp(k.blur, 0, 60) + "px;" +
      "--radius-lg:" + clamp(k.radius, 0, 40) + "px;" +
      "--shadow-strength:" + (clamp(k.shadow, 0, 200) / 100).toFixed(3) + ";" +
      "--motion-scale:" + (motion / 100).toFixed(3) + ";" +
      /* The trader's colours ride in the same rule as the knobs, so they
         keep the same place in the cascade: above every theme in
         themes.css, below "liquid glass off" and the cheap rendering
         tier. A colour the trader chose must still not be allowed to
         re-introduce translucency those two have ruled out. */
      colourCss(themeColours(id)) + "}" +
      /* The picture rides on a custom property so css/themes.css owns the
         layout - position, size and the scrim over it - and this file only
         ever hands over the source. CSS url() has to be quoted: a data URL
         is full of characters that are not valid unquoted. */
      /* The effect is a variable the backdrop rules read, so it lands on
         whichever backdrop is showing. Declared even when empty, because
         "none" has to be able to clear an effect set a moment ago. */
      "html[data-bg]{--bg-fx:" + (FX[activeFx(id)] || "none") + "}" +
      (bg === "photo"
        ? "html[data-bg=\"photo\"]{--bg-photo:url(\"" + picture.replace(/"/g, "%22") + "\");" +
          "--bg-photo-dim:" + (getBgDim() / 100).toFixed(3) + "}"
        : "")
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
    // A locked theme is not applied and, deliberately, not remembered either:
    // storing it would leave a free desk holding a choice it cannot see.
    if (isLocked(id)) return getTheme();
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
    effective: effectiveTheme,
    set: setTheme,
    FREE: FREE_THEMES,
    locked: isLocked,
    paid: isPaid,
    setPaid: setPaid,
    apply: apply,
    knobs: activeKnobs,
    getCustom: getCustom,
    setCustom: setCustom,
    resetCustom: resetCustom,
    defaultCustom: defaultCustom,
    BACKDROPS: BACKDROPS,
    themeKnobs: themeKnobs,
    edit: editTheme,
    reset: resetTheme,
    edited: isEdited,
    getBgImage: getBgImage,
    setBgImage: setBgImage,
    getBgDim: getBgDim,
    setBgDim: setBgDim,
    FONTS: FONTS,
    COLOR_KEYS: COLOR_KEYS,
    FX: FX,
    fx: activeFx,
    colours: themeColours,
  };

  apply();
  watch();
})(typeof window !== "undefined" ? window : this);
