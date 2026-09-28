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
  }

  // Settings that no longer exist are cleared rather than left behind: the
  // wallpaper picker could otherwise strand a multi-megabyte data URL in the
  // user's storage, and a stale skin or accent name would be read by nothing.
  try {
    localStorage.removeItem("aurion.bg");
    localStorage.removeItem("aurion.wallpaper");
    localStorage.removeItem("aurion.skin");
    localStorage.removeItem("aurion.accent");
  } catch (e) { /* nothing to clean up */ }

  global.AurionSkin = {
    apply: apply,
    getPerfMode: getPerfMode,
    setPerfMode: setPerfMode,
    effectivePerf: effectivePerf,
  };

  apply();
})(typeof window !== "undefined" ? window : this);
