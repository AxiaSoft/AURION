/**
 * Four reported appearance faults, and the rules that stop them coming back.
 *
 *  6. The instrument and timeframe dropdowns above the Markets chart were
 *     different sizes. They are different ELEMENTS - a button in a
 *     positioned wrapper, and a native <select> - so nothing was making
 *     them agree on a width or a height.
 *
 *  7. Clicking any search box put a hard rectangle over it. Not the
 *     shell's own ring, which is rounded: the skin layer's global
 *     `:focus-visible { outline: 2px solid accent; outline-offset: 2px }`
 *     landing on the borderless, square, edge-to-edge input INSIDE the
 *     rounded shell. Text inputs match :focus-visible on pointer focus as
 *     well as keyboard focus, which is why it happened on every click.
 *
 *  9. The symbol checkboxes in the allowed-symbols picker grew extra
 *     squares above and below on Neo and Clay. Those skins style
 *     `.field input` wholesale, the picker lives inside a `.field`, and a
 *     neumorphic inset shadow on a 13px native checkbox is exactly a pair
 *     of soft squares.
 *
 * 11. In light mode nothing may be personalised except the typeface, the
 *     accent colour and the pictures. Enforced on the READ path in
 *     themes.js, not just hidden in the editor, so a theme edited on a
 *     dark desk reverts to its shipped light values while the desk is
 *     light - and comes back untouched afterwards.
 *
 *     node tests/appearance-fixes.test.js
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
const appJs = read("apps/web/js/app.js");
const themesJs = read("apps/web/js/themes.js");
const appCss = read("apps/web/css/app.css");
const themesCss = read("apps/web/css/themes.css");
const enLang = JSON.parse(read("lang/en.json"));
const faLang = JSON.parse(read("lang/fa.json"));

/** The body of the rule whose selector list is exactly `sel`. */
function exact(css, sel) {
  const re = new RegExp("(?:^|\\})\\s*" + sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    + "\\s*\\{([^}]*)\\}", "m");
  const m = css.match(re);
  if (!m) throw new Error("no rule for " + sel + "{");
  return m[1];
}

/** The body of the first rule whose selector list contains `sel`. */
function rule(css, sel) {
  const re = new RegExp("(^|[},])\\s*([^{}]*" + sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    + "[^{}]*)\\{([^}]*)\\}", "m");
  const m = css.match(re);
  if (!m) throw new Error("no rule for " + sel);
  return m[3];
}

/* ===================================================== 6. the paired controls */

check("the Markets toolbar still puts the two controls side by side", () => {
  /* The premise. If the picker and the select stop sharing .mk-pick the
     rules below are matching nothing. */
  const bar = appJs.slice(appJs.indexOf('<div class="mk-pick">'));
  const head = bar.slice(0, 400);
  if (!/symbolPickerHtml\("sym"/.test(head)) throw new Error("the instrument picker left .mk-pick");
  /* Matched on the id alone. The first version of this pinned the whole
     opening tag, so adding an aria-label to the select - which it badly
     needed - failed a check about LAYOUT. */
  if (!/<select[^>]*\bid="tf"/.test(head)) throw new Error("the timeframe select left .mk-pick");
  return "sympick + select#tf";
});

check("the two controls are given the same width", () => {
  const body = rule(appCss, ".mk-pick > *");
  /* flex:1 1 0 - a zero basis - is the only way two items of unequal
     content width end up the same size. `auto` sizes from content first,
     which is what made the symbol wider than M15. */
  if (!/flex:\s*1\s+1\s+0\b/.test(body)) {
    throw new Error(".mk-pick > * is '" + body.trim() + "', which still sizes from content");
  }
  return body.trim();
});

check("the two controls are given the same height", () => {
  const pick = exact(appCss, ".mk-pick");
  if (!/align-items:\s*stretch/.test(pick)) throw new Error(".mk-pick does not stretch its children");
  /* Stretching the WRAPPER is not enough: the button inside it keeps its
     own min-height and sits short in a taller row. */
  const btn = rule(appCss, ".mk-pick .sympick-btn");
  if (!/block-size:\s*100%/.test(btn) && !/height:\s*100%/.test(btn)) {
    throw new Error("the picker's button does not fill its stretched wrapper");
  }
  if (!/display:\s*flex/.test(rule(appCss, ".mk-pick .sympick"))) {
    throw new Error("the wrapper is not a flex container, so 100% height resolves against nothing");
  }
  return "stretch + full-height button";
});

check("the two controls read with the same weight", () => {
  const sel = rule(appCss, ".mk-pick > select.ctrl");
  const cur = rule(appCss, ".sympick-cur");
  const w = (s) => (s.match(/font-weight:\s*(\d+)/) || [])[1];
  if (!w(sel) || w(sel) !== w(cur)) {
    throw new Error("select is weight " + w(sel) + ", the picker's label is " + w(cur));
  }
  return "both " + w(sel);
});

/* ======================================================= 7. the search boxes */

check("the rectangle is identified: the skin outlines every focused thing", () => {
  /* Guards the diagnosis itself. If this global rule is ever removed the
     exemption below becomes dead weight and should go with it. */
  if (!/html\[data-skin\]\s*:focus-visible\{[^}]*outline:\s*2px solid/.test(themesCss)) {
    throw new Error("the global skin focus outline is gone; re-check whether the exemption is still needed");
  }
  return "html[data-skin] :focus-visible";
});

check("a search input is exempted from that outline", () => {
  const m = themesCss.match(/html\[data-skin\]\s*\.dsk-search-i:focus-visible[^{]*\{([^}]*)\}/);
  if (!m) throw new Error("the search input still takes the skin's square outline");
  if (!/outline:\s*none/.test(m[1])) throw new Error("exempted but not actually cleared: " + m[1]);
  /* The exemption must come AFTER the rule it overrides - same
     specificity otherwise, and source order decides. */
  if (themesCss.indexOf(".dsk-search-i:focus-visible") < themesCss.indexOf("html[data-skin] :focus-visible")) {
    throw new Error("the exemption is written above the rule it has to beat");
  }
  return "outline:none, after the rule it beats";
});

check("the outline is cleared even with no skin active", () => {
  const body = rule(appCss, ".dsk-search-i:focus-visible");
  if (!/outline:\s*none/.test(body)) throw new Error("app.css does not clear it on its own");
  return "belt and braces";
});

check("removing the outline did not remove the focus indication", () => {
  /* Access: the shell has to show focus, and more firmly than before,
     because it is now the only thing showing it. */
  const body = rule(appCss, ".dsk-search:focus-within");
  const border = Number((body.match(/border-color:rgb\(var\(--accent-rgb\)\s*\/\s*([\d.]+)\)/) || [])[1]);
  const ring = Number((body.match(/box-shadow:0 0 0 \d+px rgb\(var\(--accent-rgb\)\s*\/\s*([\d.]+)\)/) || [])[1]);
  if (!(border >= 0.8)) throw new Error("the focused border is only " + border + " opaque");
  if (!(ring > 0.12)) throw new Error("the focus ring is no stronger than it was (" + ring + ")");
  return "border " + border + ", ring " + ring;
});

check("the ring is on the shell, so it follows the rounded corner", () => {
  if (!/border-radius:var\(--ctl-r\)/.test(exact(appCss, ".dsk-search"))) {
    throw new Error("the shell is not rounded, so there was never a mismatch to fix");
  }
  return "--ctl-r";
});

check("every search box on the desk is the same shell", () => {
  /* The fix is one rule, so it only fixes everything if every search box
     really is the shared component - including the two in the chart
     workspace and the one in the symbol popover. */
  const srcs = [appJs, read("apps/web/js/chart-tools.js")];
  let n = 0;
  for (const src of srcs) {
    for (const m of src.matchAll(/<input[^>]*type="search"[^>]*>/g)) {
      n++;
      if (!/dsk-search-i/.test(m[0])) {
        throw new Error("a search input outside the shared shell: " + m[0].slice(0, 90));
      }
    }
  }
  if (n < 6) throw new Error("only found " + n + " search inputs; the sweep is not matching");
  return n + " inputs, all .dsk-search-i";
});

/* ================================================= 9. the symbol checkboxes */

check("the allowed-symbols picker really is inside a .field", () => {
  /* The premise of the bug: that is the only reason the skins' .field
     input rules reach the checkboxes at all. */
  const i = appJs.indexOf('<div class="field sym-field">');
  if (i < 0) throw new Error("the picker is no longer in a .field");
  const block = appJs.slice(i, i + 3000);
  if (!/<div class="sym-panel"/.test(block)) throw new Error("the panel moved out of the field");
  return ".field sym-field";
});

check("a skin dresses text fields and nothing else", () => {
  for (const type of ["checkbox", "radio", "range", "color"]) {
    const sel = 'html[data-skin] .field input[type="' + type + '"]';
    if (!themesCss.includes(sel)) throw new Error("no exemption for " + type);
  }
  const m = themesCss.match(/html\[data-skin\] \.field input\[type="checkbox"\][\s\S]*?\{([^}]*)\}/);
  if (!/box-shadow:\s*none/.test(m[1])) {
    throw new Error("exempted but the shadow survives: " + m[1]);
  }
  return "checkbox, radio, range, color";
});

check("the exemption outranks the skins it has to beat", () => {
  /* [data-skin] + .field + [type] beats [data-skin="neu"] + .field on
     specificity, but only because of the attribute selector - and it is
     written last, so order backs it up either way. */
  const neu = themesCss.indexOf('html[data-skin="neu"] .field input,');
  const clay = themesCss.indexOf('html[data-skin="clay"] .field input,');
  const fix = themesCss.indexOf('html[data-skin] .field input[type="checkbox"]');
  if (neu < 0 || clay < 0) throw new Error("the Neo/Clay rules moved; re-check the override");
  if (!(fix > neu && fix > clay)) throw new Error("the override is written before Neo/Clay");
  return "after both";
});

check("the search box inside that field is exempted too", () => {
  if (!themesCss.includes("html[data-skin] .field .dsk-search-i")) {
    throw new Error("the allowed-symbols search still takes the skin's field surface");
  }
  return "shell owns the surface";
});

check("the native tick is still themed, just not re-skinned", () => {
  if (!/html\[data-skin\] input\[type=checkbox\][\s\S]{0,120}accent-color:var\(--accent\)/.test(themesCss)) {
    throw new Error("accent-color was dropped with the shadow");
  }
  return "accent-color kept";
});

/* ================================================= 11. the light-mode lock */

/* The real module, driven against a real <html data-theme>. */
function themeModule(mode) {
  /* A url is not decoration: without one jsdom gives the window no
     localStorage, themes.js's write() silently does nothing, and every
     check below passes for the wrong reason. */
  const dom = new JSDOM(`<!doctype html><html data-theme="${mode}"><head></head><body></body></html>`,
    { pretendToBeVisual: true, runScripts: "outside-only", url: "https://aurion.test/" });
  const win = dom.window;
  win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {},
    addListener() {}, removeListener() {} });
  win.eval(themesJs);
  return win;
}

check("the lock is on the read path, not only in the editor", () => {
  const win = themeModule("dark");
  const T = win.AurionTheme;
  if (typeof T.lightLocked !== "function") throw new Error("AurionTheme.lightLocked is not exposed");
  if (T.lightLocked()) throw new Error("the dark desk reports itself locked");
  return "lightLocked()";
});

check("on a dark desk every colour and knob still takes", () => {
  const win = themeModule("dark");
  const T = win.AurionTheme;
  T.edit({ page: "#123456", panel: "#654321", ink: "#abcdef", candle_up: "#00ff00", radius: 4 });
  const k = T.knobs();
  const c = T.colours(T.effective());
  if (c.page !== "#123456") throw new Error("page did not take on a dark desk: " + c.page);
  if (c.candle_up !== "#00ff00") throw new Error("candle_up did not take: " + c.candle_up);
  if (k.radius !== 4) throw new Error("radius did not take: " + k.radius);
  return "all applied";
});

check("on a light desk the page, panel, ink and candle edits do not apply", () => {
  const win = themeModule("light");
  const T = win.AurionTheme;
  T.edit({ page: "#123456", panel: "#654321", ink: "#abcdef",
           candle_up: "#00ff00", candle_down: "#ff00ff" });
  const c = T.colours(T.effective());
  for (const key of ["page", "panel", "ink", "candle_up", "candle_down"]) {
    if (c[key]) throw new Error(key + " is customisable in light mode (" + c[key] + ")");
  }
  return "all five held back";
});

check("on a light desk the surface knobs do not apply either", () => {
  const win = themeModule("light");
  const T = win.AurionTheme;
  const before = T.knobs();
  T.edit({ radius: 2, blur: 0, surface: 5, shadow: 0, border: 40, motion: 10 });
  const after = T.knobs();
  for (const key of ["radius", "blur", "surface", "shadow", "border", "motion"]) {
    if (after[key] !== before[key]) {
      throw new Error(key + " moved from " + before[key] + " to " + after[key] + " in light mode");
    }
  }
  return "six knobs held";
});

check("the typeface, the accent and the pictures stay open in light mode", () => {
  const win = themeModule("light");
  const T = win.AurionTheme;
  const font = Object.keys(T.FONTS).find((f) => f !== "theme");
  const wall = T.WALLPAPERS[0];
  T.edit({ font, accent: "emerald", wall });
  const k = T.knobs();
  const c = T.colours(T.effective());
  if (c.font !== font) throw new Error("the typeface is locked, and must not be: " + c.font);
  if (k.accent !== "emerald") throw new Error("the accent is locked, and must not be: " + k.accent);
  if (k.wall !== wall) throw new Error("the wallpaper is locked, and must not be: " + k.wall);
  return "font + accent + wall";
});

check("nothing is deleted - a dark-desk theme survives a trip through light", () => {
  /* The lock holds the edits back; it does not throw them away. A trader
     who flips to light for an hour must not lose an afternoon's work. */
  const win = themeModule("dark");
  const T = win.AurionTheme;
  T.edit({ page: "#123456", radius: 4 });
  win.document.documentElement.dataset.theme = "light";
  if (T.colours(T.effective()).page) throw new Error("the edit applied in light mode");
  win.document.documentElement.dataset.theme = "dark";
  const c = T.colours(T.effective());
  if (c.page !== "#123456") throw new Error("the edit was lost on the way back: " + c.page);
  if (T.knobs().radius !== 4) throw new Error("the knob was lost on the way back");
  return "held, then restored";
});

check("the custom theme's knobs are locked too", () => {
  /* The custom theme is nothing BUT knobs, and it reads through a
     different code path - getCustom() rather than the per-theme overlay -
     so it needs its own check with the theme actually switched to it. */
  const win = themeModule("light");
  const T = win.AurionTheme;
  T.setPaid(true);
  T.set("custom");
  if (T.effective() !== "custom") throw new Error("could not switch to the custom theme");
  const shipped = T.defaultCustom().radius;
  T.setCustom({ radius: shipped === 2 ? 30 : 2 });
  if (T.knobs().radius !== shipped) {
    throw new Error("custom radius moved to " + T.knobs().radius + " in light mode");
  }
  win.document.documentElement.dataset.theme = "dark";
  if (T.knobs().radius === shipped) throw new Error("and it is still locked on a dark desk");
  return "locked light, free dark";
});

check("the editor hides what it cannot change, rather than greying it", () => {
  const i = appJs.indexOf('id="set-theme-custom"');
  if (i < 0) throw new Error("the builder card moved");
  const card = appJs.slice(i, i + 7000);
  if (!/<div class="knob-grid"\$\{lightNow \? " hidden" : ""\}>/.test(card)) {
    throw new Error("the surface knobs are still offered on a light desk");
  }
  if (!/themes\.light_locked/.test(card)) throw new Error("nothing explains why the card is short");
  if (!/<div class="tb-sec"\$\{lightNow \? " hidden" : ""\}>/.test(card)) {
    throw new Error("the effects section is still offered on a light desk");
  }
  return "hidden, with a reason";
});

check("the typeface survives the hiding of the colour section", () => {
  /* It lives inside the colours section in the markup, so the hiding has
     to stop short of it or the one colour choice that IS allowed in light
     mode disappears with the ones that are not. */
  const i = appJs.indexOf('id="set-theme-custom"');
  const card = appJs.slice(i, i + 7000);
  const hide = card.indexOf('<div${lightNow ? " hidden" : ""}>');
  const close = card.indexOf("</div>", card.indexOf('id="col-warn"'));
  const font = card.indexOf('id="knob-font"');
  if (!(hide > 0 && close > hide && font > close)) {
    throw new Error("the typeface field is inside the block that light mode hides");
  }
  return "outside the hidden block";
});

check("switching the cut redraws the builder", () => {
  /* Otherwise going light leaves a page full of swatches that silently
     do nothing - worse than the bug. */
  const i = appJs.indexOf("function setThemeNow");
  const fn = appJs.slice(i, appJs.indexOf("\n}", i));
  if (!/S\.view === "settings"/.test(fn)) throw new Error("setThemeNow does not redraw the settings page");
  return "re-shown on mode change";
});

check("the explanation is translated everywhere, and says what is still allowed", () => {
  const en = enLang.themes && enLang.themes.light_locked;
  const fa = faLang.themes && faLang.themes.light_locked;
  if (!en || !fa) throw new Error("themes.light_locked is missing");
  if (!/dark/i.test(en)) throw new Error("the English copy does not say where to go instead");
  if (en.length < 80) throw new Error("the copy is too short to explain anything");
  return en.length + " chars";
});

/* ================================================ 2. the calendar's heights */

const calJs = read("apps/web/js/calendar.js");

check("the list shows today, and only today", () => {
  const i = calJs.indexOf("_agenda(cells) {");
  const fn = calJs.slice(i, calJs.indexOf("_dayPanel(key)", i));
  if (!/const todayKey = this\._dayKey\(Date\.now\(\)\)/.test(fn)) {
    throw new Error("the list no longer works out what today is");
  }
  if (!/\.filter\(\(d\) => d\.key === todayKey\)/.test(fn)) {
    throw new Error("the list is not filtered down to today");
  }
  if (/\.filter\(\(d\) => d\.evs\.length\)/.test(fn)) {
    throw new Error("it is still rendering every day of the month that has events");
  }
  return "one day";
});

check("browsing to another month says so rather than showing an empty box", () => {
  const i = calJs.indexOf("_agenda(cells) {");
  const fn = calJs.slice(i, calJs.indexOf("_dayPanel(key)", i));
  if (!/calendar\.agenda_away/.test(fn)) throw new Error("no message for a month without today in it");
  for (const lang of ["en", "fa", "ar"]) {
    const d = JSON.parse(read("lang/" + lang + ".json"));
    if (!d.calendar || !d.calendar.agenda_away) throw new Error("calendar.agenda_away missing from " + lang);
  }
  return "translated in three";
});

check("the month view's side list can no longer outgrow the page", () => {
  const body = exact(appCss, ".cal-day");
  if (/max-height:\s*none/.test(body)) throw new Error("it is still explicitly uncapped");
  if (!/max-block-size:\s*min\(/.test(body)) throw new Error("no ceiling on the side list: " + body.trim());
  return (body.match(/max-block-size:[^;]*/) || [""])[0];
});

check("the side list scrolls its events, not its heading", () => {
  /* Scrolling the whole card would take the date out of view, and then
     a list of times means nothing. */
  const evs = rule(appCss, ".cal-day .cal-evs");
  if (!/overflow:\s*auto/.test(evs)) throw new Error("the events do not scroll");
  if (!/min-block-size:\s*0/.test(evs)) throw new Error("a flex child without min-size:0 will not shrink to scroll");
  const card = exact(appCss, ".cal-day");
  if (!/display:\s*flex/.test(card)) throw new Error("the card is not a flex column, so the cap cannot reach the list");
  return "heading pinned";
});

check("the list itself has a backstop too", () => {
  const body = exact(appCss, ".cal-agenda");
  if (!/max-block-size:/.test(body) || !/overflow:\s*auto/.test(body)) {
    throw new Error("one holiday with thirty releases would still run off the screen");
  }
  return "capped";
});

/* ================================================ 8. the prop-risk numbers */

check("the prop page really does mix input types in one grid", () => {
  /* The premise: if they were all type=number there would be nothing to
     reconcile and these rules would be noise. */
  const i = appJs.indexOf("function propNum");
  if (i < 0) throw new Error("propNum is gone");
  if (!/type="number"/.test(appJs.slice(i, i + 900))) throw new Error("propNum stopped using type=number");
  const j = appJs.indexOf("function propTime");
  if (!/type="time"/.test(appJs.slice(j, j + 2600))) throw new Error("propTime stopped using type=time");
  return "number + time";
});

check("every value sits at the same height, by height and not by floor", () => {
  const body = rule(appCss, '.prop-fields .field input[type="number"]');
  if (/^[\s\S]*$/.test(body) && !/block-size:var\(--ctl-h\)/.test(body)) {
    throw new Error("still only a minimum height: " + body.trim());
  }
  if (!/line-height:/.test(body)) throw new Error("no shared line-height, so each type seats its own way");
  if (!/padding-block:\s*0/.test(body)) throw new Error("vertical padding can still shift a value off the line");
  return "fixed block-size + line-height";
});

check("every value sits at the same side", () => {
  const body = rule(appCss, '.prop-fields .field input[type="number"]');
  if (!/text-align:start/.test(body)) throw new Error("no shared alignment");
  if (!/direction:ltr/.test(appCss.slice(appCss.indexOf(".prop-fields .field input[type=\"number\"],\n.prop-fields .field input[type=\"time\"]")))) {
    throw new Error("the digits are not laid out left to right");
  }
  if (!appCss.includes('html[dir="rtl"] .prop-fields .field input[type="number"]')) {
    throw new Error("nothing re-seats the value on an RTL desk, which is where it was reported");
  }
  return "ltr digits, page-start seat";
});

check("a column of numbers lines up digit for digit", () => {
  const body = rule(appCss, '.prop-fields .field input[type="number"]');
  if (!/font-variant-numeric:tabular-nums/.test(body)) {
    throw new Error("proportional figures make a ragged column out of an aligned one");
  }
  return "tabular-nums";
});

check("the spinner arrows are gone from the risk limits", () => {
  if (!/\.prop-fields input\[type="number"\]::-webkit-inner-spin-button/.test(appCss)) {
    throw new Error("the webkit spinners survive, and they eat inline-end space unevenly");
  }
  if (!/\.prop-fields input\[type="number"\]\{[^}]*appearance:textfield/.test(appCss)) {
    throw new Error("no appearance:textfield, so Firefox keeps its spinner");
  }
  return "both engines";
});

check("the settings are laid out as tiles", () => {
  const body = exact(appCss, ".pr-grid .field");
  if (!/border-radius:/.test(body) || !/background:/.test(body) || !/border:/.test(body)) {
    throw new Error("the fields have no surface of their own: " + body.trim());
  }
  return "surface + edge + radius";
});

check("the tiles did not break the row alignment that was already there", () => {
  /* There is a deliberate four-row grid making every input in a row land
     on the same line whatever the labels above them do. Giving the field
     a padding box must not disturb it. */
  const body = exact(appCss, ".pr-grid .field");
  if (!/grid-template-rows:auto 1fr auto auto/.test(body)) {
    throw new Error("the four-row alignment grid was overwritten: " + body.trim());
  }
  if (!/block-size:100%/.test(body)) throw new Error("the fields no longer fill their cell");
  return "still a four-row grid";
});

console.log(fails ? "\nappearance-fixes: " + fails + " FAILED" : "\nappearance-fixes: all checks passed");
process.exit(fails ? 1 : 0);
