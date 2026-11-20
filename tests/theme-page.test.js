/**
 * Four reported faults on the personalisation page.
 *
 *  1. "I choose a wallpaper and the screen goes black, and nothing is
 *     selected. Only my own uploaded picture can be picked; every other
 *     tile snaps back to the theme's own tile, which has no picture. And
 *     choosing a wallpaper on Velvet or Relief destroys the theme - it
 *     stops being velvet or relief and comes back as the default theme
 *     in a slightly different colour."
 *
 *     Two separate bugs with one symptom. Every shipped tile but three
 *     asks for a scene pinned to one cut - "ocean@night" - and both READ
 *     paths in themes.js validated the stored value with a bare
 *     WALLPAPERS.indexOf(), which does not know that spelling. The choice
 *     was written, then dropped on the way back out. Meanwhile the edit
 *     promoted the desk onto Custom, and Custom ships no wallpaper of its
 *     own and none of the material rules - so the desk lost its picture
 *     AND its material in the same click.
 *
 *  2. "No loading cover when an accent changes" - said twice. An accent is
 *     a handful of variables; covering the desk for the best part of a
 *     second to change them hides the very thing being judged. And the
 *     trader's own swatch must be marked as theirs with a dashed ring.
 *
 *  3. The candle preview bars are too fat, and up and down have to read
 *     clearly - which colour alone cannot promise on the one card where
 *     the two colours are about to be changed.
 *
 *  4. Everything on this page has to land in the moment, with no internal
 *     refresh.
 *
 *     node tests/theme-page.test.js
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
let fails = 0;
const check = (name, fn) => {
  try {
    const note = fn();
    console.log("ok   " + name + (note ? "  (" + note + ")" : ""));
  } catch (e) {
    fails++;
    console.log("FAIL " + name + "\n       " + (e && e.message ? e.message : e));
  }
};

const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const themesJs = read("apps/web/js/themes.js");
const appJs = read("apps/web/js/app.js");
const appCss = read("apps/web/css/app.css");
const skinsCss = read("apps/web/css/skins.css");

function themeWindow(mode) {
  const dom = new JSDOM(`<!doctype html><html data-theme="${mode || "dark"}"><head></head><body></body></html>`,
    { pretendToBeVisual: true, runScripts: "outside-only", url: "https://aurion.test/" });
  const win = dom.window;
  win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {},
    addListener() {}, removeListener() {} });
  win.eval(themesJs);
  win.AurionTheme.setPaid(true);
  return win;
}

/** The <style> themes.js publishes into the page. */
const published = (win) => {
  const tag = win.document.getElementById("aurion-theme-knobs");
  return tag ? tag.textContent : "";
};

/* ---------------------------------------- 1. the wallpaper can be chosen */

check("a cut-pinned wallpaper survives being stored and read back", () => {
  const T = themeWindow("dark").AurionTheme;
  T.set("midnight");
  T.edit({ wall: "ocean@night" }, { keep: true });
  if (T.wall("midnight") !== "ocean@night")
    throw new Error("read back as " + (T.wall("midnight") || "nothing"));
  return "ocean@night";
});

check("every tile the gallery offers is a choice the engine will keep", () => {
  /* The gallery builds two tiles per scene, both cut-pinned. If any one
     of them cannot survive the round trip it is a tile that silently
     does nothing when clicked. */
  const win = themeWindow("dark");
  const T = win.AurionTheme;
  T.set("midnight");
  const bad = [];
  T.WALLPAPERS.forEach((w) => {
    ["@night", "@day"].forEach((cut) => {
      T.edit({ wall: w + cut }, { keep: true });
      if (T.wall("midnight") !== w + cut) bad.push(w + cut);
    });
  });
  if (bad.length) throw new Error("dropped: " + bad.join(", "));
  return T.WALLPAPERS.length * 2 + " tiles round-trip";
});

check("the chosen picture is the one published, so the desk is not left bare", () => {
  /* The black screen: the choice was dropped, no --theme-bg was
     published, and the theme it fell back to - Custom - has no rule of
     its own in themes.css, so the backdrop was nothing at all. */
  const win = themeWindow("dark");
  const T = win.AurionTheme;
  T.set("clay");
  T.edit({ wall: "ocean@night" }, { keep: true });
  const css = published(win);
  if (!/--theme-bg:url\(/.test(css)) throw new Error("no wallpaper was published at all");
  if (!/ocean-dark\.jpg/.test(css)) throw new Error("published something else: " + css.slice(-180));
  return "ocean-dark.jpg";
});

check("a wallpaper does not cost Velvet or Relief its material", () => {
  /* clay is Velvet and neu is Relief on screen. Everything that makes
     them what they are is written in css/themes.css against their own
     data-skin, so the attribute IS the theme. */
  const bad = [];
  ["clay", "neu"].forEach((id) => {
    const win = themeWindow("dark");
    const T = win.AurionTheme;
    T.set(id);
    T.edit({ wall: "aurora@night" }, { keep: true });
    if (T.effective() !== id) bad.push(id + " became " + T.effective());
    if (win.document.documentElement.dataset.skin !== id)
      bad.push(id + " draws as " + win.document.documentElement.dataset.skin);
  });
  if (bad.length) throw new Error(bad.join("; "));
  return "clay stays clay, neu stays neu";
});

check("nor does the trader's own picture, nor clearing it", () => {
  const win = themeWindow("dark");
  const T = win.AurionTheme;
  T.set("neu");
  T.setBgImage("data:image/jpeg;base64,AAAA");
  T.edit({ bg: "photo", wall: "none" }, { keep: true });
  if (T.effective() !== "neu") throw new Error("the upload moved the desk to " + T.effective());
  if (win.document.documentElement.dataset.bg !== "photo")
    throw new Error("the picture was not turned on: bg=" + win.document.documentElement.dataset.bg);
  T.edit({ bg: "flat" }, { keep: true });
  if (T.effective() !== "neu") throw new Error("clearing it moved the desk to " + T.effective());
  return "neu throughout";
});

check("keep is spelled out in themes.js rather than implied", () => {
  const src = themesJs.slice(themesJs.indexOf("function editTheme"));
  const body = src.slice(0, src.indexOf("\n  }"));
  if (!/opts && opts\.keep/.test(body))
    throw new Error("editTheme has no way to store an edit against the theme on screen");
  return "opts.keep";
});

check("a knob still promotes the desk onto Custom", () => {
  /* The material numbers are what Custom is FOR. Only the backdrop and
     the accent were taken out of promotion, and taking out more would
     quietly end the feature. */
  const T = themeWindow("dark").AurionTheme;
  T.set("midnight");
  T.edit({ radius: 7 });
  if (T.effective() !== "custom") throw new Error("a knob no longer promotes: " + T.effective());
  return "midnight -> custom";
});

check("the tiles ask for the pictures through assetUrl", () => {
  /* wallUrl() answers a path relative to the document, and the backend
     answers every unmatched path with index.html - so on any URL with a
     segment in it a tile was handed HTML where it expected a JPEG and
     painted nothing. That is the half of the report that reads "only my
     own picture shows up": a data URL has no path to get wrong. */
  const i = appJs.indexOf("function themeBuilderHtml");
  const body = appJs.slice(i, appJs.indexOf("function themeColourNow", i));
  if (/\$\{esc\(AurionTheme\.wallUrl\(/.test(body))
    throw new Error("a tile still paints from a document-relative path");
  if (!/AurionTheme\.assetUrl/.test(body))
    throw new Error("the tiles never go through assetUrl");
  const m = appJs.slice(appJs.indexOf("function markWallTiles"));
  const mark = m.slice(0, m.indexOf("function renderSettingsKnobs"));
  if (!/assetUrl/.test(mark))
    throw new Error("re-marking the tiles puts the broken path back");
  return "assetUrl in both places";
});

/* ------------------------------------------- 2. no cover for an accent */

check("choosing a shipped accent raises no veil", () => {
  const i = appJs.indexOf('const b = e.target.closest("[data-accent]")');
  if (i < 0) throw new Error("the shipped-accent handler is gone");
  const body = appJs.slice(i, appJs.indexOf("bindThemesGallery();", i));
  if (/morphTheme\(/.test(body))
    throw new Error("the accent row still covers the desk while it recolours");
  if (!/setAccent\(b\.dataset\.accent\)/.test(body))
    throw new Error("the accent is never applied");
  return "no cover";
});

check("nor does the trader's own accent", () => {
  const i = appJs.indexOf("function applyCustomAccent");
  const body = appJs.slice(i, appJs.indexOf("function bindAppearance", i));
  if (/morphTheme\(/.test(body)) throw new Error("the custom accent covers the desk");
  return "no cover";
});

check("an accent does not cost the theme its material either", () => {
  const i = appJs.indexOf('const b = e.target.closest("[data-accent]")');
  const body = appJs.slice(i, appJs.indexOf("bindThemesGallery();", i));
  if (!/keep: true/.test(body))
    throw new Error("picking an accent still promotes the desk onto Custom");
  return "keep: true";
});

check("the trader's own swatch wears a dashed ring", () => {
  const i = skinsCss.indexOf(".accent-dot.accent-custom{");
  if (i < 0) throw new Error("the custom dot has no rule of its own");
  const rule = skinsCss.slice(i, skinsCss.indexOf("}", i));
  if (!/outline:[^;]*dashed/.test(rule))
    throw new Error("the ring is not dashed: " + rule.replace(/\s+/g, " "));
  /* An outline rather than the border, because the border is how every
     dot in the row shows that it is the one in force. */
  if (/border:/.test(rule))
    throw new Error("the ring took the border, which marks the selected dot");
  if (!/accent-dot accent-custom/.test(appJs))
    throw new Error("the swatch no longer carries the class the rule needs");
  return "outline dashed";
});

/* ----------------------------------------- 3. the candle preview reads */

check("the preview bodies have a width of their own, and a thin one", () => {
  const i = appCss.indexOf(".cndl{");
  if (i < 0) throw new Error(".cndl is gone");
  const rule = appCss.slice(i, appCss.indexOf("}", i));
  const m = /--cndl-w:\s*(\d+(?:\.\d+)?)px/.exec(rule);
  if (!m) throw new Error("the body still fills its whole share of the strip");
  if (Number(m[1]) > 10) throw new Error("a " + m[1] + "px body is not slim");
  const after = appCss.slice(appCss.indexOf(".cndl::after{"));
  const body = after.slice(0, after.indexOf("}"));
  if (!/width:var\(--cndl-w\)/.test(body))
    throw new Error("the body does not use the width it was given");
  if (/inset-inline:0/.test(body))
    throw new Error("the body is still stretched edge to edge");
  return m[1] + "px";
});

check("up and down differ by more than their colour", () => {
  const i = appCss.indexOf(".cndl.is-up::after{");
  if (i < 0) throw new Error("a rising bar is told apart by colour alone");
  const rule = appCss.slice(i, appCss.indexOf("}", i));
  if (!/background:transparent/.test(rule) || !/border:/.test(rule))
    throw new Error("a rising bar is not hollow: " + rule.replace(/\s+/g, " "));
  if (!/\.cndl\.is-up\{color:var\(--candle-up\)\}/.test(appCss.replace(/[ \n\t]/g, "")))
    throw new Error("the rising bar no longer reads the candle-up variable");
  return "hollow up, filled down";
});

/* ------------------------------------------------ 4. in the moment */

check("picking a wallpaper updates the page it was picked on", () => {
  const h = appJs.slice(appJs.indexOf('const b = e.target.closest("[data-wallpick]");'));
  const body = h.slice(0, h.indexOf("const fx = $(\"knob-fx\")"));
  ["renderSettingsKnobs()", "verifyWallpaper()", "markThemeCards()", "repaintChartsForTheme()"]
    .forEach((call) => {
      if (body.indexOf(call) < 0) throw new Error("the handler never calls " + call);
    });
  return "four callers, no refresh";
});

check("a knob that promotes the desk re-marks the gallery on the spot", () => {
  const i = appJs.indexOf('const slider = e.target.closest("[data-knob]");');
  const body = appJs.slice(i, appJs.indexOf("const walls = $(\"knob-walls\")", i));
  if (!/AurionTheme\.effective\(\) !== was/.test(body))
    throw new Error("the gallery is never told the theme moved");
  if (body.indexOf("markThemeCards()") < 0)
    throw new Error("the gallery is never re-marked");
  return "compared, then re-marked";
});

check("the effect and the typeface re-mark it too", () => {
  const i = appJs.indexOf('const fx = $("knob-fx");');
  const body = appJs.slice(i, appJs.indexOf("panel.addEventListener", i));
  const marks = body.split("markThemeCards()").length - 1;
  if (marks < 2) throw new Error("only " + marks + " of the two selects re-mark the gallery");
  return "both";
});

console.log(fails ? `\ntheme page: ${fails} FAILED` : "\ntheme page: all checks passed");
process.exit(fails ? 1 : 0);
