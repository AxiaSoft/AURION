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
  /* How the trader's own picture is framed. A background that can only be
     "cover, centred" crops whatever matters in the photograph as often as
     not - the subject is rarely in the middle, and a desk is a far wider
     frame than a phone photo. */
  var LS_BGFIT = "aurion.theme.bgfit";    /* cover | contain              */
  var LS_BGZOOM = "aurion.theme.bgzoom";  /* 100..300 (%)                 */
  var LS_BGX = "aurion.theme.bgx";        /* 0..100 (%) horizontal focus  */
  var LS_BGY = "aurion.theme.bgy";        /* 0..100 (%) vertical focus    */
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
  /* What can sit behind the desk.
   *
   * There used to be ten entries here, eight of them backdrops the desk
   * DREW: soft gradients, drifting blobs, an aurora, a grid, waves. They
   * are gone. Two reasons, and the second is the one that mattered:
   *
   *   - they competed with the thing the desk exists to show. A price
   *     column over a moving gradient is harder to read than the same
   *     column over a flat panel.
   *   - they were opaque and sat in the same layer as the photographs,
   *     so choosing a wallpaper while a drawn backdrop was active did
   *     nothing anyone could see.
   *
   * What is left is honest: a flat themed colour, or a picture - one of
   * the twenty AURION ships, or the trader's own. */
  var BACKDROPS = ["flat", "photo"];

  /* Anything stored by an older build maps onto the flat backdrop. Without
     this a desk left on "blobs" would read an unknown value and keep it. */
  var RETIRED_BACKDROPS = ["soft", "blobs", "aurora", "grid", "waves", "dusk", "layered", "none"];

  function liveBackdrop(v) {
    return BACKDROPS.indexOf(v) === -1 ? "flat" : v;
  }

  /* ---------------------------------------------------------- wallpapers --
   *
   * AURION ships twenty photographs in assets/bg - a dark and a light cut of
   * ten scenes. Until now each one was nailed to the theme of the same name
   * in css/themes.css: the only way to see the ocean photograph was to use
   * the Ocean theme, and a trader who liked that picture on Midnight had no
   * way to say so.
   *
   * They are a library now. Any theme can wear any of them, the choice is
   * remembered per theme (so Midnight and Ocean can each keep their own),
   * and the dark or light cut is chosen from the mode in force rather than
   * picked by hand - a dark photograph under a light desk is nobody's
   * intention, and asking the trader to re-choose on every mode switch
   * would be busywork.
   *
   * The names are the file stems in assets/bg. Adding one is a line here and
   * two files on disk. */
  var WALLPAPERS = [
    "aurion",
    "aurora", "clay", "cyber", "frost", "midnight",
    "minimal", "mono", "neu", "ocean", "sunset"
  ];

  /* Most wallpapers follow one naming rule - assets/bg/<name>-<cut>.jpg -
     and need no entry here. AURION's own backdrop does not: it is the orb
     the desk and the sign-in screen have always been painted with, and it
     lives beside them as a PNG rather than in the gallery folder.

     It was therefore the one picture a trader could see on screen and not
     find in the list. Pointing at the real files is better than copying
     three megabytes of PNG into assets/bg just to satisfy the pattern. */
  var WALL_SRC = {
    aurion: { dark: "assets/login-orb.png", light: "assets/login-orb-light.png" },
  };

  /* Which picture a theme ships with. Usually the one that shares its name;
     the default theme is called AURION on screen but "glass" in storage, so
     it is spelled out. */
  var THEME_OWN_WALL = { glass: "aurion" };

  /* "" means the theme keeps whatever css/themes.css gives it; "none" means
     the trader asked for no photograph at all, which is not the same thing
     and has to survive a reload. */
  /* A choice is either a scene ("ocean"), which follows the desk's own
     light/dark mode, or a scene pinned to one cut ("ocean@day"). Both cuts
     of all ten scenes are offered: "show me the night version of this
     picture on a light desk" is a legitimate thing to want, and silently
     swapping the cut underneath made it impossible to ask for. */
  function splitWall(choice) {
    var v = String(choice || "");
    var at = v.indexOf("@");
    if (at === -1) return { name: v, cut: "" };
    return { name: v.slice(0, at), cut: v.slice(at + 1) };
  }

  /** Is this a wallpaper choice the library can actually serve? */
  function validWall(choice) {
    var p = splitWall(choice);
    if (WALLPAPERS.indexOf(p.name) === -1) return false;
    return p.cut === "" || p.cut === "day" || p.cut === "night";
  }

  function wallUrl(name, light) {
    var p = splitWall(name);
    if (!p.name || p.name === "none" || WALLPAPERS.indexOf(p.name) === -1) return "";
    /* An explicit cut wins over the mode; without one the mode decides. */
    var useLight = p.cut === "day" ? true : p.cut === "night" ? false : Boolean(light);
    /* Relative to the DOCUMENT, not to css/themes.css: this lands in a
       <style> element in index.html, so "../assets" would resolve one
       directory too high and silently load nothing. */
    var special = WALL_SRC[p.name];
    if (special) return useLight ? special.light : special.dark;
    return "assets/bg/" + p.name + "-" + (useLight ? "light" : "dark") + ".jpg";
  }

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
    /* getCustom rebuilds from a whitelist rather than returning what was
       stored, so anything not named here is silently dropped on the way
       out - which is how the wallpaper was saved correctly and then read
       back as "none chosen". */
    if (parsed.wall === "none" || WALLPAPERS.indexOf(parsed.wall) !== -1) out.wall = parsed.wall;
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
    /* Warm and cool are a matched pair: the same sepia tone, with cool
       turned through 180 degrees so the amber becomes blue.

       They used to be swapped on screen. "Cool" was a bare
       hue-rotate(150deg) with no sepia under it, which does not tint
       anything - it spins every hue in the picture a long way round the
       wheel, so a blue sea came out orange. Measured over a spread of
       sample colours it warmed them by +20.7, while "warm" managed only
       +10.1: the cool setting was the warmer of the two.

       The sepia has to be strong. A partial one leaves the original hues
       alive underneath, and the 180-degree turn then inverts THOSE as
       well - navy went to orange again. Measurement puts the threshold
       for a consistent tone at .75; .8 clears it with margin while
       keeping as much of the picture's own colour as possible.
       See tests/bg-effects.test.js, which computes this rather than
       taking the names on trust. */
    warm:   "sepia(.8) saturate(1.35)",
    cool:   "sepia(.8) hue-rotate(180deg) saturate(1.35)",
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

  /* The photograph a theme ships with, independent of any choice laid over
     it. css/themes.css names each file after its skin, so the mapping is the
     id itself - except Glass and Custom, which ship with none. */
  function themeOwnWall(id) {
    if (THEME_OWN_WALL[id]) return THEME_OWN_WALL[id];
    return WALLPAPERS.indexOf(id) === -1 ? "" : id;
  }

  /** Which wallpaper this theme has been given: "" = the theme's own. */
  function activeWall(id) {
    var edit = (id === "custom" ? getCustom() : readEdits()[id]) || {};
    var w = edit.wall;
    if (w === "none") return "none";
    return validWall(w) ? w : "";
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
      if (edit.wall === "none" || WALLPAPERS.indexOf(edit.wall) !== -1) out.wall = edit.wall;
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
      else if (key === "bg" && RETIRED_BACKDROPS.indexOf(patch[key]) !== -1) next.bg = "flat";
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
      } else if (key === "wall") {
        /* "" clears the choice and hands the theme back to its own
           photograph; "none" is the trader actively asking for none. */
        if (!patch[key]) delete next.wall;
        else if (patch[key] === "none" || validWall(patch[key])) next.wall = patch[key];
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

  /* The framing of the trader's own picture, as one object. */
  function getBgCrop() {
    var fit = read(LS_BGFIT, "cover");
    return {
      fit: fit === "contain" ? "contain" : "cover",
      zoom: clamp(read(LS_BGZOOM, 100), 100, 300),
      x: clamp(read(LS_BGX, 50), 0, 100),
      y: clamp(read(LS_BGY, 50), 0, 100),
    };
  }

  function setBgCrop(next, opts) {
    next = next || {};
    if (next.fit !== undefined) write(LS_BGFIT, next.fit === "contain" ? "contain" : "cover");
    if (next.zoom !== undefined) write(LS_BGZOOM, String(clamp(next.zoom, 100, 300)));
    if (next.x !== undefined) write(LS_BGX, String(clamp(next.x, 0, 100)));
    if (next.y !== undefined) write(LS_BGY, String(clamp(next.y, 0, 100)));
    if (!(opts && opts.silent)) apply();
    return getBgCrop();
  }

  function resetBgCrop() {
    write(LS_BGFIT, null); write(LS_BGZOOM, null); write(LS_BGX, null); write(LS_BGY, null);
    apply();
    return getBgCrop();
  }

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
      else if (key === "bg" && RETIRED_BACKDROPS.indexOf(patch[key]) !== -1) next.bg = "flat";
      else if (key === "wall") {
        if (!patch[key]) delete next.wall;
        else if (patch[key] === "none" || validWall(patch[key])) next.wall = patch[key];
      }
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

  /* Where the shipped wallpapers really live.

     The twenty pictures are addressed twice: themes.css names them as
     "../assets/bg/x.jpg", which the browser resolves against the STYLESHEET,
     and this file names them for a <style> it injects into the document,
     which resolves against the DOCUMENT. Those two bases agree only while
     the desk is served from the root of the web folder.

     The backend serves index.html for every unmatched path, so the desk can
     legitimately be sitting on a URL with a segment in it - and a
     document-relative "assets/bg/x.jpg" would then resolve to a path the
     catch-all answers with index.html. The browser gets HTML where it
     expected a JPEG, decodes nothing, and paints nothing: a wallpaper that
     silently fails to appear while every value involved looks correct.

     So the published URL is made absolute against the stylesheet that owns
     the pictures. Both routes then point at the same file no matter where
     the document is. */
  function assetUrl(rel) {
    try {
      var doc = global.document;
      var links = doc ? doc.getElementsByTagName("link") : [];
      for (var i = 0; i < links.length; i++) {
        var href = links[i].getAttribute && links[i].getAttribute("href");
        if (href && href.indexOf("css/themes.css") !== -1) {
          /* links[i].href is already absolute; the pictures sit one level
             up from css/, exactly as themes.css spells it. */
          return new global.URL("../" + rel, links[i].href).href;
        }
      }
      if (doc && doc.baseURI) return new global.URL(rel, doc.baseURI).href;
    } catch (e) { /* fall through to the relative form */ }
    return rel;
  }

  /** The CSS for a theme's chosen wallpaper, or "" to leave it alone. */
  function wallCss(id) {
    var choice = activeWall(id);
    if (!choice) return "";
    if (choice === "none") return "html[data-skin][data-bg][data-motion]{--theme-bg:none}";
    var el = root();
    var light = Boolean(el && el.dataset && el.dataset.theme === "light");
    var url = wallUrl(choice, light);
    if (!url) return "";
    return "html[data-skin][data-bg][data-motion]{--theme-bg:url(\"" +
      assetUrl(url).replace(/"/g, "%22") + "\")}";
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
    /* liveBackdrop maps anything an older build stored onto a backdrop
       that still exists, so a desk left on "blobs" comes back flat. */
    var bg = liveBackdrop(k.bg);
    var picture = getBgImage();
    if (bg === "photo" && !picture) bg = "flat";
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
      /* [data-bg] and [data-motion] are carried only to win a specificity fight, and it is
         always present because apply() sets it a few lines above.

         Without it this rule scored 2 attributes - exactly what
         themes.css scores for html[data-skin="ocean"][data-theme="light"]
         - and lost the tie on source order, because this <style> is
         created while themes.js runs in <head>, BEFORE the stylesheet
         links below it. The visible effect was that on a light desk a
         chosen wallpaper and any custom colour were silently replaced by
         the theme's own, on ten of the twelve themes. Dark mode worked,
         which is what made it look intermittent.

         Moving the element to the end of <head> would have fixed that
         and broken something else: "liquid glass off", the cheap
         rendering tier and prefers-reduced-motion also score 2 and have
         to stay ABOVE the trader's choices. They are lifted to 4
         attributes in themes.css for the same reason. */
      "html[data-skin][data-bg][data-motion]{" +
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
      /* The chosen wallpaper, if this theme has been given one.
       *
       * It overrides --theme-bg, which css/themes.css sets per skin. This
       * rule carries [data-skin][data-theme] and lands in a <style> at the
       * end of <head>, so it outranks those on both specificity and source
       * order - the same place the trader's colours already win from. */
      wallCss(id) +
      (bg === "photo"
        ? (function () {
            var c = getBgCrop();
            /* The framing is published as plain CSS values so themes.css
               owns how they are used. Zoom is a scale on the layer rather
               than a background-size, which keeps "cover" meaning cover at
               every zoom level - a background-size in percent would letterbox
               the picture the moment the aspect ratios disagreed. The focus
               point is both the background-position and the transform
               origin, so zooming in keeps looking at the chosen spot
               instead of drifting back to the middle. */
            return "html[data-bg=\"photo\"]{--bg-photo:url(\"" + picture.replace(/"/g, "%22") + "\");" +
              "--bg-photo-dim:" + (getBgDim() / 100).toFixed(3) + ";" +
              "--bg-photo-fit:" + c.fit + ";" +
              "--bg-photo-zoom:" + (c.zoom / 100).toFixed(3) + ";" +
              "--bg-photo-x:" + c.x + "%;" +
              "--bg-photo-y:" + c.y + "%}";
          }())
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

      /* Light/dark is set straight onto <html> by the desk, without coming
         through here. A wallpaper has a dark and a light cut, so the
         published rule has to be rebuilt when the mode flips - otherwise
         the desk goes light and keeps the night photograph.
         Guarded on the value actually changing: apply() rewrites
         data-skin/data-bg/data-motion, and reacting to its own writes would
         be an endless loop. */
      var lastMode = el.dataset ? el.dataset.theme : "";
      new MutationObserver(function () {
        var now = el.dataset ? el.dataset.theme : "";
        if (now === lastMode) return;
        lastMode = now;
        if (activeWall(effectiveTheme())) apply();
      }).observe(el, { attributes: true, attributeFilter: ["data-theme"] });
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
    validWall: validWall,
    assetUrl: assetUrl,
    splitWall: splitWall,
    themeKnobs: themeKnobs,
    edit: editTheme,
    reset: resetTheme,
    edited: isEdited,
    getBgImage: getBgImage,
    setBgImage: setBgImage,
    getBgDim: getBgDim,
    setBgDim: setBgDim,
    getBgCrop: getBgCrop,
    setBgCrop: setBgCrop,
    resetBgCrop: resetBgCrop,
    FONTS: FONTS,
    COLOR_KEYS: COLOR_KEYS,
    FX: FX,
    fx: activeFx,
    colours: themeColours,
    colourCss: colourCss,
    WALLPAPERS: WALLPAPERS,
    wall: activeWall,
    themeWall: themeOwnWall,
    wallUrl: wallUrl,
  };

  apply();
  watch();
})(typeof window !== "undefined" ? window : this);
