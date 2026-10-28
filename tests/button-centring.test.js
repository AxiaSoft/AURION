/**
 * Button labels that sit off to one side instead of in the middle.
 *
 * Reported from the desk: "the text in some buttons is not centred, a few
 * of them in the personalisation section". The cause is one specific and
 * easy mistake, and it is worth naming precisely because the obvious fix
 * does not work:
 *
 *   A button laid out as a ROW flex container, which is wider than its
 *   contents, and which does not set justify-content, packs its contents
 *   against the leading edge. `text-align:center` does not help - that
 *   aligns text inside a flex item, not the items inside the row - so a
 *   rule can look centred and not be.
 *
 * It is specifically a row-direction problem. In a COLUMN flex container
 * justify-content governs the vertical axis, and horizontal centring comes
 * from align-items (default: stretch) plus text-align on the stretched
 * item, which is why the wallpaper tiles and theme cards are fine despite
 * matching the same crude text search. An earlier pass of this audit
 * flagged 39 buttons; checking the axis that actually governs the
 * horizontal brought it down to the 3 that were really wrong.
 *
 * This renders every desk view with the real stylesheets and asks the
 * cascade, rather than grepping the CSS, because whether a rule is in
 * force depends on what else matched.
 *
 *     node tests/button-centring.test.js
 */

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const WEB = path.join(ROOT, "apps", "web");
const results = [];

function check(name, fn) {
  return Promise.resolve().then(fn)
    .then(() => { results.push(true); console.log("PASS  " + name); })
    .catch((e) => { results.push(false); console.log("FAIL  " + name + "\n      " + String(e && e.message).replace(/\n/g, "\n      ")); });
}

let jsdom;
try { jsdom = require(require.resolve("jsdom")); } catch {
  console.log("SKIP  jsdom is not installed");
  process.exit(0);
}
const { JSDOM, VirtualConsole } = jsdom;

/* Buttons that are deliberately not centred, each with the reason. A list
   of exceptions is only honest if every entry says why it is there. */
const ALIGNED_ON_PURPOSE = [
  { sel: ".set-jump", why: "the settings rail is a navigation list: icon, title and subtitle read from the start edge" },
  { sel: ".nav", why: "the sidebar is a navigation list, not a row of buttons" },
];

(async () => {
  const vc = new VirtualConsole();
  const dom = new JSDOM(fs.readFileSync(path.join(WEB, "index.html"), "utf8"), {
    url: "http://localhost/", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole: vc,
  });
  const win = dom.window, doc = win.document;

  /* The page links its stylesheets; jsdom does not fetch them, so they are
     inlined here. Without this every computed value is the initial one and
     the whole suite passes on nothing. */
  for (const f of ["css/app.css", "css/themes.css", "css/skins.css", "css/chart.css"]) {
    const st = doc.createElement("style");
    st.textContent = fs.readFileSync(path.join(WEB, f), "utf8");
    doc.head.appendChild(st);
  }

  win.fetch = async (u) => {
    const m = /\/lang\/([a-z]{2})\.json/.exec(String(u));
    if (m) return { ok: true, json: async () => JSON.parse(fs.readFileSync(path.join(ROOT, "lang", m[1] + ".json"), "utf8")) };
    return { ok: true, status: 404, json: async () => ({ ok: true, data: {} }), arrayBuffer: async () => new ArrayBuffer(0) };
  };
  win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  win.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  win.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
  win.URL.createObjectURL = () => "blob:stub";

  const bundle = ["js/themes.js", "js/skins.js", "js/i18n.js", "js/api.js", "js/calendar.js", "js/charts.js", "js/app.js"]
    .map((f) => fs.readFileSync(path.join(WEB, f), "utf8")).join("\n;\n");
  win.eval(bundle + ";window.__T = { views, S, I18N, appearanceCardsHtml, notifySoundCardHtml };");
  await new Promise((r) => setTimeout(r, 200));
  const T = win.__T;
  await T.I18N.load("en");

  T.S.snap = { ticks: {}, positions: [], agents: [], strategy: {}, market: {}, mt5: {}, prop: {} };
  T.S.notes = []; T.S.plans = []; T.S.pays = [];

  const host = doc.createElement("div");
  doc.body.appendChild(host);

  /** Every button the desk can render, with the layout it ends up with. */
  function sweep() {
    const found = [];
    const panels = { ...T.views, _appearance: T.appearanceCardsHtml, _sounds: T.notifySoundCardHtml };
    for (const name of Object.keys(panels)) {
      let html;
      try { html = panels[name](); } catch { continue; }
      if (typeof html !== "string") continue;
      host.innerHTML = html;
      for (const b of host.querySelectorAll("button")) {
        const cs = win.getComputedStyle(b);
        found.push({
          view: name,
          cls: b.className || "(none)",
          display: cs.display,
          dir: cs.flexDirection || "row",
          justify: cs.justifyContent || "",
          grow: parseFloat(cs.flexGrow || "0") || 0,
          width: cs.width || "",
          text: (b.textContent || "").trim().replace(/\s+/g, " ").slice(0, 28),
          excused: ALIGNED_ON_PURPOSE.find((x) => b.closest(x.sel)),
        });
      }
    }
    return found;
  }

  const all = sweep();

  await check("the sweep actually rendered buttons with styles applied", () => {
    if (all.length < 80) throw new Error("only " + all.length + " buttons rendered; the sweep is not covering the desk");
    if (!all.some((b) => b.display.includes("flex"))) {
      throw new Error("no button computed to a flex display - the stylesheets did not apply");
    }
  });

  /**
   * Can this button be wider than its contents?
   *
   * A shrink-to-fit button cannot: inline-flex with an automatic width
   * hugs whatever is inside it, so there is no spare space for the
   * contents to be pushed to one side of, and justify-content changes
   * nothing. The fault only shows on a button that is stretched - a
   * block-level flex container, a flex item that grows, or one given an
   * explicit width.
   */
  const canStretch = (b) =>
    b.display === "flex" || b.grow > 0 || /%|px/.test(b.width);

  await check("no button label is pushed off-centre by a flex row", () => {
    const bad = all.filter((b) =>
      /flex/.test(b.display) &&
      (b.dir === "row" || b.dir === "") &&
      !b.justify &&
      canStretch(b) &&
      !b.excused &&
      b.text.length > 0);
    if (bad.length) {
      const lines = bad.map((b) => `  ${b.view}  .${b.cls}  "${b.text}"`);
      throw new Error(`${bad.length} button(s) with no justify-content:\n` + lines.join("\n"));
    }
  });

  await check("the pills in the personalisation section are centred", () => {
    /* The reported case, named directly so the regression is obvious if
       it comes back: the theme pills and the performance pills. */
    host.innerHTML = T.appearanceCardsHtml();
    const pills = [...host.querySelectorAll(".lang-pills button")];
    if (pills.length < 3) throw new Error("the performance pills did not render");
    for (const p of pills) {
      const cs = win.getComputedStyle(p);
      if (cs.justifyContent !== "center") {
        throw new Error(`"${p.textContent.trim()}" computes justify-content:${cs.justifyContent || "(unset)"}`);
      }
    }
  });

  await check("a pill with an icon still centres the pair", () => {
    /* These pills gained an icon when the sun and moon emoji were removed,
       which is what turned them into flex containers in the first place. */
    host.innerHTML = '<div class="lang-pills"><button type="button">' +
      '<svg viewBox="0 0 24 24"></svg><span>Light</span></button></div>';
    const cs = win.getComputedStyle(host.querySelector("button"));
    if (cs.display !== "inline-flex") throw new Error("display is " + cs.display);
    if (cs.justifyContent !== "center") throw new Error("justify-content is " + (cs.justifyContent || "(unset)"));
    if (cs.alignItems !== "center") throw new Error("align-items is " + (cs.alignItems || "(unset)"));
  });

  await check("the deliberately start-aligned lists say so in their own rules", () => {
    /* An exception that is only recorded in this file would let a genuine
       fault hide behind it. Each one has to be explicit in the CSS too. */
    const css = fs.readFileSync(path.join(WEB, "css", "app.css"), "utf8").replace(/\s*\n\s*/g, "");
    for (const ex of ALIGNED_ON_PURPOSE) {
      const name = ex.sel.replace(/^\./, "");
      const re = new RegExp("\\." + name + "[^{}]*\\{[^}]*text-align:\\s*start");
      if (!re.test(css)) {
        throw new Error(`${ex.sel} is excused here but its stylesheet never says it is start-aligned`);
      }
    }
  });

  await check("every ordinary button centres its label", () => {
    /* .btn is the workhorse: if this ever loses its justification, most of
       the desk goes off-centre at once. */
    host.innerHTML = '<button class="btn">Save</button>';
    const cs = win.getComputedStyle(host.querySelector("button"));
    if (cs.justifyContent !== "center") throw new Error(".btn computes " + (cs.justifyContent || "(unset)"));
  });

  const failed = results.filter((r) => !r).length;
  console.log(`\nbutton-centring: ${results.length - failed} of ${results.length} checks passed`);
  /* Explicit: the desk's polling timers keep the loop alive otherwise. */
  process.exit(failed ? 1 : 0);
})();
