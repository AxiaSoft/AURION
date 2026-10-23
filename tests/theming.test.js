"use strict";
/* ---------------------------------------------------------------------------
   Theme naming, theme customisation, the custom background picture, and the
   named risk-free ladder.

   These four were reported together from the live desk:

     - the default theme had no name of its own, it was just "Liquid Glass";
     - the builder only edited the one theme called "custom", so the eleven
       designed themes could not be adjusted at all;
     - a background was tied to whichever theme shipped with it;
     - risk-free settings showed 0.20 and 0.50 where the trader thinks TP1
       and TP2.

   The test deliberately does not use jsdom's getComputedStyle: that resolves
   no custom properties on this codebase, so assertions about resolved values
   pass whatever the stylesheet says (see tests/appearance.test.js for the
   long version). Here we drive the real themes.js against a small localStorage
   stub and read back what it would publish, which is the actual behaviour.
   --------------------------------------------------------------------------- */

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

let pass = 0;
let fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`PASS  ${name}${detail ? "  — " + detail : ""}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? "  — " + detail : ""}`); }
}

/* ------------------------------------------------------------ themes.js ---
   A minimal browser: a storage that really stores, an <html> with a dataset,
   and a <style> whose textContent we can read back. Everything themes.js
   decides ends up in one of those three places. */
function loadTheme(initialStorage) {
  const store = Object.assign({}, initialStorage || {});
  const styleEl = { id: "", textContent: "" };
  const htmlEl = { dataset: {}, getAttribute: () => null, setAttribute: () => {} };

  const win = {
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; },
    },
    document: {
      documentElement: htmlEl,
      head: { appendChild: () => {} },
      getElementById: (id) => (id === "aurion-theme-knobs" ? styleEl : null),
      createElement: () => styleEl,
    },
    matchMedia: () => ({ matches: false, addEventListener: () => {} }),
    addEventListener: () => {},
    dispatchEvent: () => {},
    CustomEvent: function () {},
    MutationObserver: undefined,
  };
  win.window = win;

  vm.createContext(win);
  vm.runInContext(read("apps/web/js/themes.js"), win, { filename: "themes.js" });
  /* Every theme but the default is premium, and a locked theme is refused -
     deliberately - by set(). Without this the harness silently stays on the
     default and every "edited neu" assertion would be testing the default
     theme instead. */
  win.AurionTheme.setPaid(true);
  return { api: win.AurionTheme, html: htmlEl, style: styleEl, store };
}

/* ----------------------------------------------------- 1. the default name */
const en = JSON.parse(read("lang/en.json"));
const fa = JSON.parse(read("lang/fa.json"));
const ar = JSON.parse(read("lang/ar.json"));

const { api } = loadTheme();
const defaultId = api.DEFAULT;

check(
  "the default theme is named AURION in every language",
  [en, fa, ar].every((d) => d.themes[defaultId + "_name"] === "AURION"),
  [en, fa, ar].map((d) => d.themes[defaultId + "_name"]).join(" / ")
);

check(
  "nothing still calls the default theme Liquid Glass",
  ![en, fa, ar].some((d) => /liquid glass/i.test(d.themes.locked_note || "")),
  en.themes.locked_note.slice(0, 48) + "…"
);

/* --------------------------------- 2. every theme can be customised, apart */
{
  const t = loadTheme();
  t.api.set("neu");
  const before = t.api.knobs();
  t.api.edit({ blur: 31, shadow: 55 });
  const after = t.api.knobs();

  check(
    "a built-in theme accepts edits",
    before.blur !== 31 && after.blur === 31 && after.shadow === 55,
    `neu blur ${before.blur} -> ${after.blur}`
  );

  check(
    "an edited theme is published, not just stored",
    /--blur:31px/.test(t.style.textContent),
    (t.style.textContent.match(/--blur:[^;]*/) || ["?"])[0]
  );

  /* The bug this guards: one shared slot meant editing neu also moved clay. */
  t.api.set("clay");
  check(
    "edits do not leak to another theme",
    t.api.knobs().blur === t.api.BY_ID.clay.knobs.blur,
    `clay blur ${t.api.knobs().blur}, expected ${t.api.BY_ID.clay.knobs.blur}`
  );

  t.api.set("neu");
  check("edits survive leaving the theme and coming back", t.api.knobs().blur === 31);

  check("edited themes are flagged as edited", t.api.edited("neu") === true && t.api.edited("clay") === false);

  t.api.reset();
  check(
    "reset puts a built-in theme back exactly as it shipped",
    t.api.knobs().blur === t.api.BY_ID.neu.knobs.blur && t.api.edited("neu") === false,
    `neu blur back to ${t.api.knobs().blur}`
  );
}

/* --------------------------------------- 3. any background with any theme */
{
  const t = loadTheme();
  t.api.set("cyber");
  t.api.edit({ bg: "waves" });
  check(
    "a theme can be given a background it did not ship with",
    t.html.dataset.bg === "waves" && t.html.dataset.skin === "cyber",
    `skin=${t.html.dataset.skin} bg=${t.html.dataset.bg}`
  );
}

/* ---------------------------------------- 4. the trader's own picture */
{
  const t = loadTheme();
  const url = "data:image/jpeg;base64,AAAA";
  t.api.setBgImage(url);
  t.api.edit({ bg: "photo" });

  check(
    "the picture is kept on this machine only",
    Object.keys(t.store).some((k) => k.indexOf("bgimage") !== -1),
    Object.keys(t.store).join(", ")
  );

  check(
    "choosing a picture switches the backdrop to it",
    t.html.dataset.bg === "photo",
    `bg=${t.html.dataset.bg}`
  );
  check(
    "the picture reaches the stylesheet as a quoted url",
    t.style.textContent.includes(`--bg-photo:url("${url}")`),
    (t.style.textContent.match(/--bg-photo:[^;]*/) || ["missing"])[0]
  );
  check(
    "the scrim over the picture is published too",
    /--bg-photo-dim:0\.\d+/.test(t.style.textContent),
    (t.style.textContent.match(/--bg-photo-dim:[^}]*/) || ["missing"])[0]
  );

  t.api.setBgDim(70);
  check("the scrim follows the slider", /--bg-photo-dim:0\.700/.test(t.style.textContent));

  /* Removing the file must not leave a blank page behind the desk. */
  t.api.setBgImage("");
  check(
    "removing the picture falls back to a real backdrop",
    t.html.dataset.bg !== "photo" && t.api.BACKDROPS.indexOf(t.html.dataset.bg) !== -1,
    `bg=${t.html.dataset.bg}`
  );
}

/* -------------------------------------------- 5. css backs the photo backdrop */
{
  const css = read("apps/web/css/themes.css");
  check(
    "themes.css paints the chosen picture",
    /html\[data-bg="photo"\]/.test(css) && /var\(--bg-photo/.test(css),
    "rules present"
  );
  check(
    "themes.css darkens behind content so text stays readable",
    /var\(--bg-photo-dim/.test(css)
  );
}

/* ----------------------------------- 6. the builder edits the active theme */
{
  const app = read("apps/web/js/app.js");
  check(
    "the builder writes through AurionTheme.edit, not the old custom-only slot",
    /AurionTheme\.edit\(/.test(app) && !/AurionTheme\.setCustom\(/.test(app),
    "setCustom no longer called from the desk"
  );
  check(
    "the builder is no longer hidden unless the custom theme is picked",
    !/panel\.hidden\s*=\s*current\s*!==\s*"custom"/.test(app)
  );
  check(
    "the picture is scaled down before it is stored",
    /BG_MAX_EDGE/.test(app) && /toDataURL\("image\/jpeg"/.test(app),
    "shrinkImage present"
  );
}

/* ------------------------------- 7. risk free reads TP1/TP2, not 0.20/0.50 */
{
  const app = read("apps/web/js/app.js");
  check(
    "the raw trigger-percentage slider is gone from risk-free settings",
    !/st-rf-trigger/.test(app)
  );
  check(
    "risk-free settings render a named ladder",
    /rfLadderHtml/.test(app) && /st-rf-ladder/.test(app)
  );
  check(
    "a rung that moves the stop to the entry is worded, not numbered",
    /strategies\.rf_to_entry/.test(app)
  );

  const keys = ["rf_steps", "rf_ladder_help", "rf_to_entry", "rf_rung_at"];
  const missing = [];
  [["en", en], ["fa", fa], ["ar", ar]].forEach(([code, d]) => {
    keys.forEach((k) => { if (!d.strategies || !d.strategies[k]) missing.push(code + "." + k); });
  });
  check("every ladder string is translated", missing.length === 0, missing.join(", ") || "all present");

  /* The desk renders what the engine sends; if the shape drifts the ladder
     silently renders blank, which is exactly the failure being fixed. */
  const trader = read("engine/aurion/runtime/trader.py");
  check(
    "the engine labels each rung TP1, TP2 … and says where the stop goes",
    /"label":\s*f"TP\{i\}"/.test(trader) && /"moves_to":\s*"entry" if i == 1 else f"TP\{i - 1\}"/.test(trader),
    "snapshot contract intact"
  );
  check(
    "the desk posts the ladder step count to the route the proxy forwards",
    /API\.post\("\/api\/risk_free"/.test(app) &&
      /guarded\.post\("\/risk_free"/.test(read("backend/src/index.js")),
    "/api/risk_free -> /v1/risk_free"
  );
}

/* ------------------------------------------------- 8. the ladder stylesheet */
{
  const css = read("apps/web/css/app.css");
  check(
    "the ladder has styling to render as rows",
    [".rf-ladder", ".rf-rung", ".rf-rung-tag", ".rf-rung-at"].every((c) => css.includes(c))
  );
  check(
    "the background picker has styling",
    [".bgpic", ".bgpic-thumb"].every((c) => css.includes(c))
  );
}

console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail === 0 ? 0 : 1);
