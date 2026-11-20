/**
 * Three reported personalisation faults, and the rules that stop them
 * coming back.
 *
 *  9. "I upload a picture and the row of backgrounds still shows an empty
 *     square as the chosen one." The uploaded picture was not in the
 *     gallery at all - it lived in a separate panel below - so the row
 *     showed every background on offer except the one just added, with
 *     nothing marked. It is a tile now, selected whenever the picture is
 *     the backdrop in force, which is also what makes it survive a reload.
 *
 * 10. "I change something and the theme name stays where it was." An edit
 *     made while a built-in theme was on screen was stored against that
 *     theme, so the gallery went on saying "midnight" while showing
 *     something midnight does not look like, and Custom - the slot
 *     personalisation is meant to live in - stayed at its defaults. An
 *     edit now moves the desk onto Custom, seeded from whatever was on
 *     screen so the switch itself changes nothing visible.
 *
 * 12. The page-background colour control is removed by request. Removing a
 *     control is not enough on its own: a value already in storage has to
 *     be dropped on the READ path, or it goes on being honoured on every
 *     desk that ever had one, and the control is one rediscovery away
 *     from coming back.
 *
 *     node tests/personalisation.test.js
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
const langs = {
  en: JSON.parse(read("lang/en.json")),
  fa: JSON.parse(read("lang/fa.json")),
  ar: JSON.parse(read("lang/ar.json")),
};

/* A url is not decoration: without one jsdom gives the window no
   localStorage, themes.js's write() silently does nothing, and every
   check below passes for the wrong reason. */
function themeModule(mode, seedStorage) {
  const dom = new JSDOM(`<!doctype html><html data-theme="${mode}"><head></head><body></body></html>`,
    { pretendToBeVisual: true, runScripts: "outside-only", url: "https://aurion.test/" });
  const win = dom.window;
  win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {},
    addListener() {}, removeListener() {} });
  if (seedStorage) seedStorage(win.localStorage);
  win.eval(themesJs);
  /* Every theme but glass is locked without a key, and a locked theme
     reads back as glass - so the promotion checks would be testing
     glass eleven times over. */
  win.AurionTheme.setPaid(true);
  return win;
}

/** The <style> themes.js publishes into the page. */
const css = (win) => {
  const tag = win.document.querySelector("style");
  return tag ? tag.textContent : "";
};

/* ------------------------------------- 10. an edit moves you to Custom */

check("editing a built-in theme moves the desk onto Custom", () => {
  const T = themeModule("dark").AurionTheme;
  T.set("midnight");
  if (T.effective() !== "midnight") throw new Error("could not get onto midnight");
  T.edit({ radius: 7 });
  if (T.effective() !== "custom") throw new Error("still on " + T.effective());
  if (T.knobs().radius !== 7) throw new Error("the edit did not land: radius " + T.knobs().radius);
  return "midnight -> custom";
});

check("the theme that was on screen is left exactly as it shipped", () => {
  const win = themeModule("dark");
  const T = win.AurionTheme;
  T.set("midnight");
  const shipped = T.BY_ID.midnight.knobs.radius;
  T.edit({ radius: shipped === 7 ? 9 : 7 });
  T.set("midnight");
  if (T.knobs().radius !== shipped)
    throw new Error("midnight drifted to " + T.knobs().radius + ", shipped " + shipped);
  if (T.edited("midnight")) throw new Error("midnight is flagged as edited");
  return "midnight radius still " + shipped;
});

check("the switch is seeded, so nothing visible changes but the edited thing", () => {
  /* The whole case against promotion is that it could be loud: land on
     Custom's own defaults and the desk's blur, corners, accent and
     wallpaper all jump because someone nudged one slider. Seeding is
     what makes it quiet, so it is pinned. */
  const win = themeModule("dark");
  const T = win.AurionTheme;
  const html = win.document.documentElement;
  T.set("sunset");
  T.apply();
  const before = T.knobs();
  const bgBefore = html.dataset.bg;
  T.edit({ radius: (before.radius || 0) + 3 });
  const after = T.knobs();
  /* bg is compared through the desk rather than through the stored
     name: several themes still name a retired backdrop, which the desk
     paints as flat, so the two spellings mean the same picture. */
  const moved = Object.keys(before)
    .filter((k) => k !== "radius" && k !== "bg" && before[k] !== after[k]);
  if (moved.length)
    throw new Error("promotion also moved: " + moved.map((k) => `${k} ${before[k]}->${after[k]}`).join(", "));
  if (html.dataset.bg !== bgBefore)
    throw new Error(`the backdrop changed: ${bgBefore} -> ${html.dataset.bg}`);
  return "only radius moved";
});

check("the wallpaper in force comes across with the promotion", () => {
  const T = themeModule("dark").AurionTheme;
  T.set("midnight");
  const own = T.themeWall("midnight");
  if (!own) throw new Error("midnight ships no picture, so this proves nothing");
  T.edit({ blur: 12 });
  if (T.wall("custom") !== own)
    throw new Error("custom shows " + (T.wall("custom") || "nothing") + ", expected " + own);
  return own;
});

check("the candle pair comes across too", () => {
  /* One pair cannot read on both sunset's warm maroon and glass's
     near-black, so a promotion that dropped the pair would recolour
     every candle on screen. */
  const T = themeModule("dark").AurionTheme;
  T.set("sunset");
  const pair = T.BY_ID.sunset.candles.dark;
  T.edit({ blur: 12 });
  const c = T.colours("custom");
  if (c.candle_up !== pair[0] || c.candle_down !== pair[1])
    throw new Error(`custom candles ${c.candle_up}/${c.candle_down}, sunset ships ${pair[0]}/${pair[1]}`);
  return pair.join(" / ");
});

check("a locked Custom is never forced on a desk that may not have it", () => {
  /* Custom is a paid theme on some licences. Promoting onto a theme the
     desk is not allowed to show would leave it on a locked skin, which
     is worse than the fault being fixed. */
  const T = themeModule("dark").AurionTheme;
  if (typeof T.locked !== "function") throw new Error("AurionTheme.locked is not exposed");
  T.setPaid(false);
  if (!T.locked("custom")) {
    const src = themesJs.slice(themesJs.indexOf("function promoteToCustom"));
    const body = src.slice(0, src.indexOf("\n  }"));
    if (!/isLocked\("custom"\)/.test(body))
      throw new Error("promoteToCustom does not consult isLocked at all");
    return "custom is unlocked here; the guard is on the source";
  }
  T.set("midnight");
  T.edit({ radius: 7 });
  if (T.effective() === "custom") throw new Error("shunted onto a locked theme");
  /* get(), not just effective(): effective() hides a locked theme
     behind glass, so a desk that had been moved onto a locked Custom
     would look fine here and then jump the moment a key was entered. */
  if (T.get() === "custom") throw new Error("the stored theme was changed to a locked one");
  return "stayed on " + T.effective();
});

/* ----------------------------------- 9. the uploaded picture is a tile */

const URL_ONE = "data:image/jpeg;base64,AAAA";

check("the gallery offers the trader's own picture as a tile", () => {
  if (!/data-wallpick="\$\{esc\(value\)\}"/.test(appJs))
    throw new Error("the tile template changed shape; this check needs rewriting");
  const block = appJs.slice(appJs.indexOf("const mine = AurionTheme.getBgImage();"));
  const tiles = block.slice(0, block.indexOf("const fxOptions"));
  if (!/wallTile\("photo"/.test(tiles))
    throw new Error("no tile is built for the trader's own picture");
  if (!/themes\.wall_mine/.test(tiles)) throw new Error("the tile has no label");
  if (!/\.filter\(Boolean\)/.test(tiles))
    throw new Error("the tile list is not filtered, so an empty string ships as a tile when there is no picture");
  return "wallTile(\"photo\", …)";
});

check("the picture's tile is labelled in all three languages", () => {
  for (const code of Object.keys(langs)) {
    const v = langs[code].themes && langs[code].themes.wall_mine;
    if (!v) throw new Error(code + " has no themes.wall_mine");
  }
  return langs.en.themes.wall_mine + " / " + langs.fa.themes.wall_mine;
});

check("picking the picture's tile asks for the backdrop, not a wallpaper id", () => {
  /* "photo" is not a filename in WALLPAPERS - validWall() would refuse
     it - so the handler has to translate the tile into the backdrop
     that draws it, and clear any shipped photograph that would
     otherwise stay layered on top. */
  const h = appJs.slice(appJs.indexOf('const b = e.target.closest("[data-wallpick]");'));
  const body = h.slice(0, h.indexOf("markThemeEdited();"));
  if (!/wallpick === "photo"/.test(body))
    throw new Error("the handler does not special-case the picture's tile");
  if (!/edit\(\{ bg: "photo", wall: "none" \}/.test(body))
    throw new Error("picking it does not set bg:photo with wall:none");
  /* And it is stored against the theme on screen. Promotion would cost
     the material themes their material: Velvet and Relief are drawn by
     rules written against their own data-skin, so a desk shunted onto
     Custom for choosing a photograph stops being velvet or relief and
     comes back as the default theme in a slightly different colour. */
  if (!/\{ keep: true \}/.test(body))
    throw new Error("choosing a backdrop still promotes the desk onto Custom");
  if (!/patch\.bg = "flat"/.test(body))
    throw new Error("picking another tile does not leave the picture backdrop, so nothing would change on screen");
  return "both halves in one call";
});

check("uploading a picture turns it on, and lifts any shipped photograph off it", () => {
  const u = appJs.slice(appJs.indexOf("function bindBackgroundPicture"));
  const body = u.slice(0, u.indexOf("function markWallTiles"));
  if (!/edit\(\{ bg: "photo", wall: "none" \}/.test(body))
    throw new Error("the upload path does not set bg:photo with wall:none");
  if (!/\{ keep: true \}/.test(body))
    throw new Error("uploading a picture still promotes the desk onto Custom");
  return "bg:photo, wall:none";
});

check("the picture is the marked tile, and stays marked across a re-render", () => {
  /* Two code paths decide which tile wears the dot - the one that
     builds the markup and the one that re-marks it afterwards - and
     they have to agree, or the mark appears and then vanishes. */
  for (const fn of ["const picked = ", "function markWallTiles"]) {
    const at = appJs.indexOf(fn);
    if (at === -1) throw new Error("cannot find " + fn);
    const body = appJs.slice(at, at + 700);
    if (!/knobs\(\)\.bg === "photo" && AurionTheme\.getBgImage\(\)/.test(body))
      throw new Error(fn.trim() + " does not treat the picture as the selection");
  }
  return "both paths agree";
});

check("a desk that was left on the picture comes back on the picture", () => {
  /* The reload case the report was really about: the backdrop is stored,
     so after a restart the picture must still be the backdrop in force
     - which is the condition the tile's mark is derived from. */
  const win = themeModule("dark");
  const T = win.AurionTheme;
  T.setBgImage(URL_ONE);
  T.edit({ bg: "photo", wall: "none" });
  if (T.knobs().bg !== "photo") throw new Error("the backdrop did not take");

  const again = themeModule("dark", (ls) => {
    for (let i = 0; i < win.localStorage.length; i++) {
      const k = win.localStorage.key(i);
      ls.setItem(k, win.localStorage.getItem(k));
    }
  }).AurionTheme;
  if (again.knobs().bg !== "photo")
    throw new Error("after a restart the backdrop is " + again.knobs().bg);
  if (again.getBgImage() !== URL_ONE) throw new Error("the picture itself was not kept");
  return "bg=photo, picture kept";
});

/* ------------------------- 12. the page-background control is removed */

check("no page colour is offered in the builder", () => {
  if (/colourRow\(\s*"page"/.test(appJs))
    throw new Error("the builder still draws a page-colour row");
  return "no colourRow(\"page\")";
});

check("its strings are gone from all three languages", () => {
  const left = [];
  for (const code of Object.keys(langs)) {
    const t = langs[code].themes || {};
    for (const k of ["c_page", "c_page_hint"]) if (k in t) left.push(code + "." + k);
  }
  if (left.length) throw new Error("still present: " + left.join(", "));
  return "c_page and c_page_hint removed";
});

check("page is not a colour the editor will accept", () => {
  const T = themeModule("dark").AurionTheme;
  T.edit({ page: "#123456" });
  const c = T.colours(T.effective());
  if (c.page) throw new Error("the editor stored it: " + c.page);
  return "refused";
});

check("a page colour already in storage is dropped on the read path", () => {
  /* The important half. A removed control that merely stops writing
     leaves every desk that ever had one still honouring it, and the
     next person to read the code sees a supported key. */
  const win = themeModule("dark", (ls) => {
    ls.setItem("aurion.theme.edits", JSON.stringify({ glass: { page: "#123456", panel: "#654321" } }));
  });
  const T = win.AurionTheme;
  const c = T.colours("glass");
  if (c.page) throw new Error("an old stored page colour is still honoured: " + c.page);
  if (c.panel !== "#654321")
    throw new Error("dropping page took the rest of the edit with it: panel " + c.panel);
  /* And it is gone from storage, not merely filtered out of one
     getter's answer. A value that survives in the file reappears in
     anything that exports or inspects the stored theme, and is one
     rediscovery away from being wired up again. */
  const stored = JSON.parse(win.localStorage.getItem("aurion.theme.edits") || "{}");
  if (stored.glass && "page" in stored.glass)
    throw new Error("still in storage: " + stored.glass.page);
  if (!stored.glass || stored.glass.panel !== "#654321")
    throw new Error("the clean-up ate the rest of the stored edit");
  return "page dropped from storage, panel kept";
});

check("no page-background variable is published, even when one is asked for", () => {
  const win = themeModule("dark", (ls) => {
    ls.setItem("aurion.theme.edits", JSON.stringify({ glass: { page: "#123456" } }));
  });
  win.AurionTheme.apply();
  const rule = css(win);
  for (const v of ["--bg:", "--bg2:", "--deep:"]) {
    if (rule.includes(v)) throw new Error(v + " is still published: " + (rule.match(/--bg[^;]*/) || [""])[0]);
  }
  if (rule.includes("#123456")) throw new Error("the stored colour reached the page by some other route");
  return "no --bg/--bg2/--deep";
});

check("the retirement is named, not implied", () => {
  /* A key that is simply absent from a whitelist reads as an oversight.
     Named in a retired list, with the drop happening on read, it reads
     as a decision. */
  if (!/RETIRED_COLOR_KEYS/.test(themesJs))
    throw new Error("themes.js does not name the retired keys");
  if (!/RETIRED_COLOR_KEYS = \["page"\]/.test(themesJs))
    throw new Error("page is not in the retired list");
  return "RETIRED_COLOR_KEYS";
});

console.log(fails ? `\npersonalisation: ${fails} FAILED` : "\npersonalisation: all checks passed");
process.exit(fails ? 1 : 0);
