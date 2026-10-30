/**
 * The cover over a theme, appearance or language change must lift onto a
 * desk that has already finished changing.
 *
 * Three rounds of this. The veil first lifted when `apply()` returned,
 * which is before the browser has even recalculated style. Then it
 * waited on document.fonts.ready and two frames, which still missed the
 * two things a theme actually has to go and fetch - the typeface and the
 * wallpaper - and still ran a deliberate 500ms `.theming` dissolve
 * underneath the fade, so the loading state ended and the desk then
 * changed colour in front of the trader.
 *
 * None of that is visible to a source regex: every step looked correct.
 * So this drives the real morphTheme with controllable font and image
 * loading and asserts the ORDER - that the cover is still opaque while
 * each resource is outstanding, and only lifts once both have landed.
 *
 *     node tests/theme-veil.test.js
 */

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const WEB = path.join(ROOT, "apps", "web");
const read = (p) => fs.readFileSync(path.join(WEB, p), "utf8");

const results = [];
function check(name, pass, note) {
  results.push(Boolean(pass));
  console.log((pass ? "PASS  " : "FAIL  ") + name + (note ? "  — " + note : ""));
}

let jsdom = null;
try { jsdom = require(require.resolve("jsdom")); } catch { /* optional */ }
if (!jsdom) { console.log("SKIP  theme veil (jsdom not installed)"); process.exit(0); }
const { JSDOM, VirtualConsole } = jsdom;

/* The document deliberately sits one path segment deep, so that
   resolving the wallpaper against the stylesheet and against the
   document give different answers and the test can tell them apart. */
function boot() {
  const dom = new JSDOM(read("index.html"), {
    url: "http://localhost/app/", runScripts: "outside-only",
    pretendToBeVisual: true, virtualConsole: new VirtualConsole(),
  });
  const win = dom.window, doc = win.document;
  const log = [];
  win.fetch = async () => ({ ok: true, json: async () => ({ ok: true, data: {} }) });
  win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  win.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  win.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
  win.URL.createObjectURL = () => "blob:stub";
  win.AudioContext = class { createGain() { return { connect() {}, gain: {} }; } };
  win.HTMLCanvasElement.prototype.getContext = () => null;

  let fontWaiters = [], releaseImg = null;
  Object.defineProperty(doc, "fonts", { configurable: true, value: {
    load(spec, text) { log.push({ t: "font", weight: spec.split(" ")[0], text });
      return new Promise((r) => fontWaiters.push(r)); },
    get ready() { return Promise.resolve(); },
  } });
  win.Image = class {
    set src(v) { log.push({ t: "img", src: v }); releaseImg = () => this.onload && this.onload(); }
    decode() { log.push({ t: "decode" }); return Promise.resolve(); }
  };
  let rafQ = [];
  win.requestAnimationFrame = (fn) => rafQ.push(fn);

  const bundle = ["js/themes.js", "js/skins.js", "js/i18n.js", "js/api.js",
                  "js/calendar.js", "js/charts.js", "js/app.js"].map(read).join("\n;\n");
  win.eval(bundle + "\n;window.__T = { morphTheme, I18N };");

  const tick = () => new Promise((r) => setImmediate(r));
  const frames = async () => {
    for (let i = 0; i < 8; i++) { const q = rafQ; rafQ = []; q.forEach((f) => f(0)); await tick(); }
  };
  return {
    win, doc, log, tick, frames,
    veil: doc.getElementById("theme-veil"),
    releaseFonts: () => fontWaiters.splice(0).forEach((r) => r([1])),
    releaseImage: () => releaseImg && releaseImg(),
  };
}

(async () => {
  const k = boot();
  const { doc, veil, log } = k;
  const op = () => veil.style.opacity;

  /* A theme that carries one of the shipped wallpapers, spelled the way
     themes.css spells them: relative to the STYLESHEET. */
  doc.documentElement.style.setProperty("--theme-bg", 'url("../assets/bg/frost-dark.jpg")');
  doc.body.style.fontFamily = "Outfit, Vazirmatn, system-ui, sans-serif";

  let applied = false;
  k.win.__T.morphTheme(() => { applied = true; }, { title: "t" });

  check("the cover goes up before anything is touched", op() === "1" && !applied,
        "opacity=" + op());
  check("it blocks the desk while it is up", veil.classList.contains("is-busy"));

  await new Promise((r) => setTimeout(r, 260));
  await k.tick();
  check("the change is applied behind the cover", applied && op() === "1");

  await k.frames();
  check("the cover holds while the typeface is still loading", op() === "1");

  const fonts = log.filter((e) => e.t === "font");
  check("the typeface is asked for by name, not merely awaited",
        fonts.length === 3, fonts.map((f) => f.weight).join("/"));
  check("the sample text spans both unicode-range subsets",
        fonts.length > 0 && /[A-Z]/.test(fonts[0].text) && /[\u0600-\u06FF]/.test(fonts[0].text),
        fonts[0] && JSON.stringify(fonts[0].text));

  const img = log.find((e) => e.t === "img");
  check("the wallpaper is fetched too", Boolean(img), img && img.src);
  check("its URL is resolved against the stylesheet, not the document",
        Boolean(img) && img.src === "http://localhost/app/assets/bg/frost-dark.jpg",
        img && img.src);

  k.releaseFonts();
  await k.tick(); await k.frames();
  check("the cover still holds while only the wallpaper is outstanding", op() === "1");

  k.releaseImage();
  await k.tick(); await k.frames(); await k.tick(); await k.frames();
  check("the wallpaper is decoded, not just downloaded", log.some((e) => e.t === "decode"));
  check("the cover lifts only once every resource has landed", op() === "0");

  /* The dissolve that used to run under the fade. */
  check("no transition is left running as the cover comes off",
        !doc.documentElement.classList.contains("theming"));
  const css = read("css/app.css");
  check("the .theming dissolve is gone from the stylesheet too",
        !/^html\.theming\b/m.test(css) && !/html\.theming \*/.test(css));
  const js = read("js/app.js");
  check("and nothing adds the class any more", !/classList\.add\("theming"\)/.test(js));

  const bad = results.filter((r) => !r).length;
  console.log("\ntheme-veil: " + (bad ? bad + " FAILED of " : "") + results.length + (bad ? "" : " checks passed"));
  process.exit(bad ? 1 : 0);
})();
