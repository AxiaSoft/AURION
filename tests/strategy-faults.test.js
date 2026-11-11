/**
 * A strategy file that will not load has to be visible on the desk.
 *
 *     node tests/strategy-faults.test.js
 *
 * Reported, twice: a strategy was uploaded, accepted, and then was not
 * there. A file that fails to import is simply absent from the engine's
 * book, so the strategies page showed no card, no row and no error —
 * the upload looked lost rather than the code looking broken. The only
 * record was a line in a log nobody reads.
 *
 * The engine now publishes `strategy.faults`, and this is the card that
 * says it. Run for real: the card is sliced out of app.js, rendered in
 * JSDOM against a fake snapshot, and read back out of the DOM.
 */

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

let jsdom = null;
try { jsdom = require("jsdom"); } catch { /* optional */ }
if (!jsdom) { console.log("SKIP  strategy-faults (jsdom not installed)"); process.exit(0); }
const { JSDOM } = jsdom;

const ROOT = path.resolve(__dirname, "..");
const APP = fs.readFileSync(path.join(ROOT, "apps/web/js/app.js"), "utf8");
const CSS = fs.readFileSync(path.join(ROOT, "apps/web/css/app.css"), "utf8");
const FA = JSON.parse(fs.readFileSync(path.join(ROOT, "lang/fa.json"), "utf8"));
const EN = JSON.parse(fs.readFileSync(path.join(ROOT, "lang/en.json"), "utf8"));

let pass = 0;
const failures = [];
const check = (name, fn) => {
  try {
    const note = fn();
    pass++;
    console.log("ok   " + name + (note ? "  \u2014 " + note : ""));
  } catch (e) {
    failures.push(name);
    console.log("  x  " + name + "  \u2014 " + e.message);
  }
};
const must = (c, m) => { if (!c) throw new Error(m); };

/* ------------------------------------------------------- the rig ---- */

const slice = (from, to) => {
  const i = APP.indexOf(from);
  if (i < 0) throw new Error("cannot find in app.js: " + from);
  const j = APP.indexOf(to, i + from.length);
  if (j < 0) throw new Error("unterminated slice at: " + from);
  return APP.slice(i, j);
};

const FN = slice("function strategyFaultCards() {", "function strategyUploadCard() {");

// Run the real function against a fake snapshot.
const render = (faults, lang = EN) => {
  const sandbox = {
    S: { snap: { strategy: faults === null ? {} : { faults } } },
    I18N: { t: (k) => k.split(".").reduce((o, p) => (o || {})[p], lang) ?? k },
    esc: (s) => String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;"),
  };
  vm.createContext(sandbox);
  vm.runInContext(FN + "\nvar __out = strategyFaultCards();", sandbox);
  return sandbox.__out;
};

const dom = (html) => new JSDOM(`<!doctype html><body>${html}</body>`).window.document;

const ONE = [{ name: "bad", file: "bad.py", error: "'bad.py' failed while loading at line 2: ValueError: nope" }];

/* --------------------------------------------------------- checks ---- */

check("nothing is drawn when every strategy loaded", () => {
  must(render([]) === "", "an empty fault list still rendered a card");
  must(render(null) === "", "a snapshot with no faults key rendered a card");
  must(render(undefined) === "", "an undefined fault list rendered a card");
  return "silent when healthy";
});

check("a broken file is named, with its reason", () => {
  const d = dom(render(ONE));
  const card = d.getElementById("st-broken");
  must(card, "no card rendered");
  must(card.textContent.includes("bad.py"), "the file name is not shown");
  must(card.textContent.includes("line 2"), "the reason is not shown");
  must(card.textContent.includes("ValueError"), "the exception type is not shown");
  return "file + reason";
});

check("every broken file gets its own row", () => {
  const many = [
    { name: "a", file: "a.py", error: "boom a" },
    { name: "b", file: "b.py", error: "boom b" },
    { name: "c", file: "c.py", error: "boom c" },
  ];
  const d = dom(render(many));
  const rows = d.querySelectorAll(".st-broken-row");
  must(rows.length === 3, `rendered ${rows.length} rows, expected 3`);
  return "3 rows";
});

check("a row survives a missing file name", () => {
  const d = dom(render([{ name: "orphan", error: "boom" }]));
  must(d.querySelector(".st-broken-row"), "no row rendered");
  must(d.body.textContent.includes("orphan"), "fell back to nothing at all");
  return "falls back to the name";
});

check("the message cannot inject markup", () => {
  const nasty = [{ name: "x", file: "x.py", error: "<img src=x onerror=alert(1)>" }];
  const html = render(nasty);
  must(!html.includes("<img"), "an unescaped error string reached the page");
  const d = dom(html);
  must(d.querySelectorAll("img").length === 0, "the payload became a real element");
  return "escaped";
});

check("the copy is translated, not a raw key", () => {
  for (const [label, pack] of [["en", EN], ["fa", FA]]) {
    const text = dom(render(ONE, pack)).body.textContent;
    must(!text.includes("strategies.broken_title"), `${label}: the title key leaked`);
    must(!text.includes("strategies.broken_hint"), `${label}: the hint key leaked`);
    must(pack.strategies.broken_title, `${label}: no broken_title string`);
  }
  return "en + fa";
});

check("the Persian copy names no physical side and no instrument", () => {
  const text = `${FA.strategies.broken_title} ${FA.strategies.broken_hint}`;
  for (const word of ["چپ", "راست", "XAUUSD", "EURUSD"]) {
    must(!text.includes(word), `the copy says "${word}"`);
  }
  return "clean";
});

check("the card is wired into the strategies view", () => {
  const view = slice("  strategies() {", "\n  },");
  must(view.includes("strategyFaultCards()"), "the view never calls strategyFaultCards()");
  const faults = view.indexOf("strategyFaultCards()");
  const upload = view.indexOf("strategyUploadCard()");
  must(faults > -1 && upload > -1, "could not locate both cards");
  must(faults < upload, "the fault card should come before the uploader, not after");
  return "above the uploader";
});

check("the styles it uses exist and use tokens, not raw colour", () => {
  for (const sel of [".st-broken{", ".st-broken-row{", ".st-broken-why{"]) {
    must(CSS.includes(sel), "missing rule: " + sel);
  }
  const block = CSS.slice(CSS.indexOf(".st-broken{"), CSS.indexOf(".st-upload{"));
  must(/var\(--bad\)/.test(block), "the fault tone is not the semantic token");
  must(!/rgb\(var\(--bad\)\s*\//.test(block), "invalid rgb(var(--tok) / a) form");
  must(!/#[0-9a-f]{3,6}/i.test(block), "a raw hex colour was used instead of a token");
  must(/border-inline-start/.test(block), "a physical side was used instead of a logical one");
  return "tokens only";
});

/* ---------------------------------------------------------- report ---- */

console.log("");
if (failures.length) {
  console.log(`${failures.length} of ${pass + failures.length} checks failed`);
  process.exit(1);
}
console.log(`${pass} checks passed`);
