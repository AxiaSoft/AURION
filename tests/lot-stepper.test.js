/**
 * The lot in Settings can be set with buttons, not only by typing.
 *
 *     node tests/lot-stepper.test.js
 *
 * Asked for directly: "in Settings, in the lot section, let me set the
 * lot size with + and - buttons." The chart ticket has had that pair
 * since the ticket was written; the Settings field was a bare number
 * box, which on a phone means opening a numeric keypad, clearing what is
 * in it, and getting a decimal point right to move from 0.10 to 0.11.
 *
 * Both controls now go through one function, which is the part worth
 * testing: the two must not disagree about what a step is, where the
 * floor is, or what the field does afterwards. Two arithmetic traps live
 * in there as well -- 0.1 + 0.01 is 0.11000000000000001 in binary
 * floating point, and a lot is not allowed to walk down to zero.
 */

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const WEB = path.join(ROOT, "apps", "web");

let jsdom;
try { jsdom = require("jsdom"); } catch {
  console.log("SKIP  lot-stepper (jsdom is not installed)");
  process.exit(0);
}
const { JSDOM, VirtualConsole } = jsdom;

const results = [];
const check = (name, fn) => Promise.resolve().then(fn).then((note) => {
  results.push(true);
  console.log("ok   " + name + (note ? "  \u2014 " + note : ""));
}).catch((e) => {
  results.push(false);
  console.log("  x  " + name + "  \u2014 " + e.message);
});
const must = (c, m) => { if (!c) throw new Error(m); };

const appJs = fs.readFileSync(path.join(WEB, "js", "app.js"), "utf8");
const appCss = fs.readFileSync(path.join(WEB, "css", "app.css"), "utf8");

/* ----------------------------------------------------------------- boot --
   The whole desk is evaluated, as the other behavioural suites do, so the
   function under test is the shipped one and not a copy. */
async function boot() {
  const dom = new JSDOM(fs.readFileSync(path.join(WEB, "index.html"), "utf8"), {
    url: "http://localhost/", runScripts: "outside-only", pretendToBeVisual: true,
    virtualConsole: new VirtualConsole(),
  });
  const win = dom.window;
  win.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, data: [] }), text: async () => "{}" });
  win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  win.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  win.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
  win.AudioContext = class { constructor() { this.state = "running"; this.destination = {}; } resume() { return Promise.resolve(); } };
  const bundle = ["js/themes.js", "js/skins.js", "js/i18n.js", "js/api.js", "js/calendar.js", "js/charts.js", "js/app.js"]
    .map((f) => fs.readFileSync(path.join(WEB, f), "utf8")).join("\n;\n");
  win.eval(bundle + "\n;window.__T = { stepLotField, bindLotSteppers, S };");
  await new Promise((r) => setTimeout(r, 40));
  return { win, doc: win.document, T: win.__T };
}

/** The lot field as Settings renders it, with its own min/max/step. */
function lotField(doc, value) {
  const wrap = doc.createElement("div");
  wrap.id = "vol-field";
  wrap.innerHTML =
    '<button type="button" class="ct-pm" data-lot-step="-1" data-lot-for="st-vol">-</button>' +
    `<input id="st-vol" type="number" step="0.01" min="0.01" max="1000" value="${value}" />` +
    '<button type="button" class="ct-pm" data-lot-step="1" data-lot-for="st-vol">+</button>';
  doc.body.appendChild(wrap);
  return { wrap, input: wrap.querySelector("input") };
}

(async () => {
  const { win, doc, T } = await boot();

  await check("plus and minus move the lot by one step of the field", () => {
    const { input } = lotField(doc, "0.10");
    T.stepLotField(input, 1);
    must(input.value === "0.11", "up gave " + input.value);
    T.stepLotField(input, -1);
    must(input.value === "0.1", "down gave " + input.value);
    input.parentElement.remove();
    return "0.10 -> 0.11 -> 0.10";
  });

  await check("the number never comes back as 0.11000000000000001", () => {
    const { input } = lotField(doc, "0.10");
    for (let i = 0; i < 7; i++) T.stepLotField(input, 1);
    must(!/\d{6}/.test(input.value), "floating point leaked: " + input.value);
    must(Number(input.value).toFixed(2) === "0.17", "seven steps gave " + input.value);
    input.parentElement.remove();
    return input.value;
  });

  await check("it cannot be walked down to zero or below", () => {
    const { input } = lotField(doc, "0.02");
    T.stepLotField(input, -1);
    T.stepLotField(input, -1);
    T.stepLotField(input, -1);
    must(Number(input.value) === 0.01, "it went to " + input.value);
    input.parentElement.remove();
    return "floors at the field's min";
  });

  await check("it stops at the field's maximum", () => {
    const { input } = lotField(doc, "999.995");
    T.stepLotField(input, 1);
    T.stepLotField(input, 1);
    must(Number(input.value) <= 1000, "it went to " + input.value);
    input.parentElement.remove();
    return input.value;
  });

  await check("an empty field starts from the smallest lot, not from zero", () => {
    const { input } = lotField(doc, "");
    T.stepLotField(input, 1);
    must(Number(input.value) > 0, "a cleared field stepped to " + input.value);
    input.parentElement.remove();
    return input.value;
  });

  await check("a press tells the page, so the money line and the save both run", () => {
    const { input } = lotField(doc, "0.10");
    const seen = [];
    input.addEventListener("input", () => seen.push("input"));
    input.addEventListener("change", () => seen.push("change"));
    T.stepLotField(input, 1);
    must(seen.includes("input"), "no input event: the money-at-lot line would not follow");
    must(seen.includes("change"), "no change event: the new lot would never be saved");
    input.parentElement.remove();
    return seen.join(" + ");
  });

  await check("the buttons are wired to the field they name", () => {
    const { wrap, input } = lotField(doc, "0.10");
    T.bindLotSteppers(wrap);
    wrap.querySelector('[data-lot-step="1"]').dispatchEvent(new win.Event("click", { bubbles: true }));
    must(input.value === "0.11", "the plus button did nothing: " + input.value);
    wrap.querySelector('[data-lot-step="-1"]').dispatchEvent(new win.Event("click", { bubbles: true }));
    must(input.value === "0.1", "the minus button did nothing: " + input.value);
    wrap.remove();
    return "bound by data-lot-for";
  });

  /* ------------------------------------------------- what Settings ships */

  await check("Settings renders the pair around the real lot input", () => {
    const card = appJs.slice(appJs.indexOf('id="vol-field"') - 400, appJs.indexOf('id="vol-sub"'));
    must(/data-lot-step="-1"/.test(card) && /data-lot-step="1"/.test(card), "the buttons are not in the lot card");
    must(/data-lot-for="st-vol"/.test(card), "the buttons do not name the lot field");
    must(/id="st-vol"/.test(card), "the lot field lost its id, and everything else reads it by id");
    must(/inputmode="decimal"/.test(card), "a phone gets a full keyboard for a number");
    return "two buttons + the field";
  });

  await check("the buttons are labelled for a screen reader, in three languages", () => {
    for (const lang of ["en", "fa", "ar"]) {
      const pack = JSON.parse(fs.readFileSync(path.join(ROOT, "lang", lang + ".json"), "utf8"));
      for (const key of ["lot_up", "lot_down"]) {
        const v = pack.exec && pack.exec[key];
        must(typeof v === "string" && v.trim(), `${lang}: exec.${key} is missing`);
        must(!/^exec\./.test(v), `${lang}: exec.${key} is the key itself`);
      }
    }
    must(/aria-label="\$\{esc\(I18N\.t\("exec\.lot_(up|down)"\)\)\}"/.test(appJs), "the labels are not translated in the markup");
    return "en, fa, ar";
  });

  await check("the ticket and Settings share one implementation", () => {
    const ticket = appJs.slice(appJs.indexOf("function bindChartTicket("), appJs.indexOf("function bindChartTicket(") + 1200);
    must(/stepLotField\(/.test(ticket), "the chart ticket kept a stepper of its own");
    const count = (appJs.match(/function stepLotField\(/g) || []).length;
    must(count === 1, "there are " + count + " step implementations");
    return "one stepLotField";
  });

  await check("holding the button down does not save once per tap", () => {
    /* Each save re-renders the settings page, which moves the button out
       from under the finger. The presses are collected and sent once. */
    const bind = appJs.slice(appJs.indexOf('const stVol = $("st-vol");'), appJs.indexOf('const news = $("st-news");'));
    must(/_lotSaveTimer/.test(bind), "every press saves immediately");
    must(/addEventListener\("change", commitSoon\)/.test(bind), "the deferred save is not the one wired up");
    must(/"Enter"[\s\S]{0,200}commit\(\)/.test(bind), "Enter no longer saves at once");
    return "debounced, Enter still immediate";
  });

  await check("the control has styling, and a thumb-sized target on touch", () => {
    must(/\.ct-step\{/.test(appCss), "no .ct-step rule");
    must(/\.ct-pm\{/.test(appCss), "no .ct-pm rule");
    const coarse = appCss.slice(appCss.search(/@media\s*\(pointer:\s*coarse\)/));
    const m = /\.ct-step \.ct-pm\{width:44px;height:44px\}/.exec(coarse);
    must(m, "the stepper buttons are not 44px on a touch screen");
    must(/\.ct-pm:disabled\{/.test(appCss), "a disabled stepper looks enabled");
    /* The buttons are seated physically, like the digits between them:
       minus left, plus right, on a Persian desk as well. Letting the
       page direction flip them puts "more" where the eye has learnt
       "less". */
    // Sliced by the rule's own braces: ".ct-step input{" also appears in
    // the coarse-pointer block ABOVE this rule, and slicing to it gave an
    // empty string that passed nothing.
    const at = appCss.indexOf(".ct-step{");
    const step = appCss.slice(at, appCss.indexOf("}", at));
    must(/direction:ltr/.test(step), "the +/- pair flips with the page, so plus lands on the left in Persian");
    return "44x44 on coarse pointers, minus-left in every language";
  });

  const failed = results.filter((r) => !r).length;
  console.log(`\nlot-stepper: ${results.length - failed} of ${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
})();
