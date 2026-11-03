"use strict";
/* ---------------------------------------------------------------------------
   Sound & Notifications as its own tab, the widened theme builder, backdrop
   effects, and spacing that comes from a rule rather than from inline styles.

   Four reports, one test file, because they are all "the desk looks and sits
   wrong" rather than "the engine computed the wrong number".

   The spacing section is the one worth explaining. The fault reported was
   "buttons are stuck to the top or bottom and containers touch". The cause
   was that no stylesheet rule ever said two stacked cards are separated -
   each gap was a hand-written inline margin, and the gaps that were missing
   were simply the ones nobody had typed. So the test does not go looking for
   the individual reported spots: it asserts the rule exists, that it only
   ever pushes a *following* sibling (so it cannot disturb a container edge),
   and that it is written logically so RTL stays correct.
   --------------------------------------------------------------------------- */

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

const app = read("apps/web/js/app.js");
const css = read("apps/web/css/app.css");
const themesCss = read("apps/web/css/themes.css");
const en = JSON.parse(read("lang/en.json"));
const fa = JSON.parse(read("lang/fa.json"));
const ar = JSON.parse(read("lang/ar.json"));

let pass = 0;
let fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`PASS  ${name}${detail ? "  — " + detail : ""}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? "  — " + detail : ""}`); }
}

/* Load themes.js against a storage stub, as tests/theming.test.js does. */
function loadTheme() {
  const store = {};
  const styleEl = { id: "", textContent: "" };
  const htmlEl = { dataset: {} };
  const win = {
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; },
    },
    document: {
      documentElement: htmlEl,
      head: { appendChild: () => {} },
      getElementById: () => styleEl,
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
  win.AurionTheme.setPaid(true);
  return { api: win.AurionTheme, html: htmlEl, style: styleEl, store };
}

/* ======================================================= 1. the sound tab */

/* The settings sections are emitted by a block() helper, so the id is
   an argument rather than a literal in the markup. Slicing on the
   helper call is what makes "which section is this card in?" a
   question the source can answer at all. */
function setSection(id) {
  const start = app.indexOf(`block("${id}"`);
  if (start < 0) return "";
  const next = app.indexOf('\n      ${block("', start + 1);
  return app.slice(start, next < 0 ? app.indexOf("</div></div>`;", start) : next);
}

check(
  "Sound & Notifications is a tab of its own",
  /tabBtn\("set-notify"/.test(app) && setSection("set-notify").length > 0,
  "rail entry + section"
);

check(
  "the tab can actually be opened",
  /"set-notify"/.test(app.slice(app.indexOf("function showSetTab"), app.indexOf("function showSetTab") + 600)),
  "listed in showSetTab's allow list"
);

/* The report was specifically that it is still inside Personalisation. */
{
  const personal = setSection("set-personal");
  const notify = setSection("set-notify");
  check(
    "the sound panel is no longer rendered inside Personalisation",
    personal.length > 0 && notify.includes("notifySoundCardHtml()") &&
      !personal.includes("notifySoundCardHtml()"),
    "personal section is theme + appearance only, and the sounds live in their own tab"
  );
}

check(
  "the rail entry has an icon that exists",
  /bell:\s*'/.test(app),
  "a missing icon name renders an empty <svg>, which is how a rail entry ends up blank"
);

check(
  "the tab is titled in every language",
  [en, fa, ar].every((d) => d.notify && d.notify.title && d.rail && d.rail.notify_hint),
  [en, fa, ar].map((d) => d.notify.title).join(" / ")
);

/* The redesign: rows that carry a mark, a master volume with a mute, and a
   preview that cannot offer to play silence. */
check("each event is a row, not a stacked dropdown", /data-sndrow=/.test(app) && /snd-mark/.test(app));
check("there is a master volume with a mute", /id="snd-mute"/.test(app) && /id="snd-vol-read"/.test(app));
check(
  "a silent or muted row cannot offer a preview",
  /play\.disabled = off \|\| muted/.test(app),
  "preview disabled when the row is Silent or the desk is muted"
);
check(
  "unmuting returns to the level it was muted from",
  /mute\.dataset\.last/.test(app)
);
check(
  "every class the panel uses has a rule",
  [".snd-wrap", ".snd-card", ".snd-row", ".snd-mark", ".snd-text", ".snd-pick", ".snd-vol", ".snd-deliver"]
    .every((c) => css.includes(c)),
  "styled"
);

/* ============================== 2. colours and font in the theme builder */
{
  const t = loadTheme();
  t.api.set("neu");
  t.api.edit({ page: "#101820", panel: "#1b2530", ink: "#eef4ff", font: "mono" });
  const out = t.style.textContent;

  check("the page colour can be changed from the builder", /--bg:#101820/.test(out));
  check(
    "panels are rebuilt as a ladder, not as one flat colour",
    /--s1:/.test(out) && /--s9:/.test(out) &&
      (out.match(/--s1:([^;]*)/) || [])[1] !== (out.match(/--s9:([^;]*)/) || [])[1],
    `s1 ${(out.match(/--s1:([^;]*)/) || [])[1]} vs s9 ${(out.match(/--s9:([^;]*)/) || [])[1]}`
  );
  check("the text colour can be changed", /--ink:#eef4ff/.test(out));
  check(
    "secondary text is derived from the chosen text colour",
    /--muted:#[0-9a-f]{6}/.test(out) && !/--muted:#8b93a7/.test(out),
    (out.match(/--muted:[^;]*/) || [])[0]
  );
  check("the interface font can be changed", /--font:"IBM Plex Mono"/.test(out));

  /* A white wash over a light panel is invisible, so every hairline and
     hover would vanish. This is the check that catches it. */
  const light = loadTheme();
  light.api.set("neu");
  light.api.edit({ panel: "#f2f4f8" });
  check(
    "a light panel flips the wash so hairlines stay visible",
    /--wash:0 0 0/.test(light.style.textContent),
    (light.style.textContent.match(/--wash:[^;]*/) || [])[0]
  );

  /* The knobs and the colours share one declaration block; a missing
     separator silently voids the declaration on either side of it. */
  check(
    "the published rule is well formed where the knobs meet the colours",
    /--motion-scale:[\d.]+;--bg:/.test(t.style.textContent),
    (t.style.textContent.match(/--motion-scale:[^;]*;--bg/) || ["missing"])[0]
  );

  check(
    "colours belong to the theme being edited and reset with it",
    (() => {
      t.api.reset();
      return !/--bg:#101820/.test(t.style.textContent);
    })(),
    "cleared by reset"
  );

  check(
    "the builder warns about unreadable colours instead of forbidding them",
    /function warnOnContrast/.test(app) && /contrast_warn/.test(app),
    "warned, not blocked"
  );
  check(
    "an untouched swatch opens on the colour actually in use",
    /function themeColourNow/.test(app),
    "reads the computed value rather than defaulting to black"
  );
  check(
    "colour and font strings are translated",
    ["colours_title", "c_page", "c_panel", "c_ink", "c_clear", "font_title", "contrast_warn"]
      .every((k) => [en, fa, ar].every((d) => d.themes[k])),
    "all present"
  );
}

/* ========================= 3. ready-made backgrounds, with effects on top */
{
  const t = loadTheme();
  t.api.set("aurora");

  /* This began as a check that the backdrop dropdown had become a gallery.
     The drawn backdrops it offered have since been retired altogether, so
     the enduring point - that a background is chosen by looking at it, not
     by reading a list of adjectives - now rests on the wallpaper gallery,
     which is where the twenty photographs are chosen. */
  check(
    "backgrounds are chosen from a gallery, not from a list of adjectives",
    /data-wallpick=/.test(app) && /bgt-art/.test(app) &&
      !/id="knob-bg"/.test(app) && !/data-bgpick=/.test(app),
    "a gallery of pictures, and no dropdown"
  );
  check(
    "every built-in backdrop has a tile to paint it",
    t.api.BACKDROPS.filter((b) => b !== "photo")
      .every((b) => css.includes(`[data-bgart="${b}"]`)),
    t.api.BACKDROPS.filter((b) => b !== "photo").join(" ")
  );

  t.api.edit({ fx: "blur" });
  check(
    "an effect can be applied to a ready-made background",
    /--bg-fx:blur\(26px\)/.test(t.style.textContent),
    (t.style.textContent.match(/--bg-fx:[^;}]*/) || ["missing"])[0]
  );

  t.api.edit({ fx: "none" });
  check(
    "an effect can be taken off again",
    /--bg-fx:none/.test(t.style.textContent),
    "cleared"
  );

  check(
    "the effect is applied to the backdrop layer so it covers every background",
    /\.aurora\{\s*filter:var\(--bg-fx/.test(themesCss.replace(/\s+/g, " ").replace(/\.aurora\{ /g, ".aurora{")),
    "one rule, all backdrops"
  );

  check(
    "effects are offered in every language",
    Object.keys(t.api.FX).every((f) => [en, fa, ar].every((d) => d.themes["fx_" + f])),
    Object.keys(t.api.FX).join(" ")
  );
}

/* ================================================== 4. spacing, as a rule */
{
  /* Strip comments first: the section explains itself at length, and a
     grep that matches prose rather than a selector proves nothing. */
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, "");

  check(
    "stacked containers are separated by a rule, not by inline styles",
    /\.card \+ \.card/.test(bare) && /\.grid \+ \.card/.test(bare) && /\.card \+ \.grid/.test(bare),
    "card/grid adjacency covered"
  );

  check(
    "a button following text is given room",
    /\.card > p \+ \.btn/.test(bare) && /\.card > \.sub \+ \.row/.test(bare),
    "the reported 'stuck to the text above it'"
  );

  check(
    "a button at the foot of a card is not flush with the edge",
    /\.card > \.btn:last-child/.test(bare),
    "the reported 'stuck to the bottom'"
  );

  /* This used to assert that ".btn + .btn" appeared in the stylesheet, and
     it passed happily while that very rule was doubling the spacing in 38
     containers and pushing the emergency button off the side of a phone.
     Asserting a selector exists says nothing about what it does.

     Rows of controls are spaced by their container now. The detailed
     checks live in tests/header-spacing.test.js, which re-derives the
     gapped containers from this file rather than naming them. */
  check(
    "controls are spaced by their container, not by a blanket sibling margin",
    !/\.btn \+ \.btn\s*,?[\s\S]{0,200}?margin-inline-start:\s*var/.test(bare),
    "no blanket rule to double a container's gap"
  );

  check(
    "the one row of controls that had no container gap has been given one",
    /\.modal-actions\{[^}]*display:flex[^}]*\}/.test(bare.replace(/\s/g, "")) ||
      /\.modal-actions\s*\{[^}]*gap:/.test(bare),
    "the confirm dialog's buttons"
  );

  /* Logical properties, because the desk runs right-to-left in Persian and
     Arabic and margin-left would put the gap on the wrong side. */
  const section = bare.slice(bare.indexOf("--stack-gap:"));
  check(
    "the spacing rules are written logically so RTL stays correct",
    !/margin-top:|margin-left:|margin-right:|margin-bottom:/.test(section),
    "margin-block-start / margin-inline-start only"
  );

  /* The safety property: these rules only ever touch an element that has
     something before it, so no container's first or last child moves and
     nothing can be pushed out of its box. */
  check(
    "no spacing rule targets a first child, so container edges never shift",
    !/\+ \.card:first-child|:first-child\s*\{[^}]*margin-block-start/.test(section),
    "following siblings only"
  );

  check(
    "the gap shrinks on a narrow desk instead of eating the screen",
    /max-width:760px\)\{\s*:root\{\s*--stack-gap:/.test(section.replace(/\s+/g, " ").replace(/\{ /g, "{")),
    "responsive"
  );
}

console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail === 0 ? 0 : 1);
