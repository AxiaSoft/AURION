/**
 * A backtest must run the strategy that was picked, builtin or uploaded.
 *
 *     node tests/backtest-strategy-kind.test.js
 *
 * Reported: a trader uploaded a strategy, the desk accepted it, the
 * card appeared and the robot armed it — and asking for a backtest
 * answered "unknown builtin strategy 'aurion_strategy_template'".
 *
 * The dropdown lists every strategy in the book, built-in and uploaded
 * alike, but the request was hard-coded:
 *
 *     strategy: { kind: "builtin", name }
 *
 * So an uploaded file was always asked for as a built-in, and the
 * loader refused it by name. The engine's snapshot has carried each
 * strategy's `kind` all along; the desk simply dropped it.
 *
 * Run for real rather than grepped: the option markup is sliced out of
 * app.js, rendered into JSDOM and read back through the same
 * `options[selectedIndex].dataset.kind` the handler uses, so a change
 * that stops emitting the attribute fails here even if the handler
 * still mentions it. The POST body is pinned separately, because
 * ordering and literals are the one thing only a source check sees.
 */

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

let jsdom = null;
try { jsdom = require("jsdom"); } catch { /* optional */ }
if (!jsdom) { console.log("SKIP  backtest-strategy-kind (jsdom not installed)"); process.exit(0); }
const { JSDOM } = jsdom;

const ROOT = path.resolve(__dirname, "..");
const APP = fs.readFileSync(path.join(ROOT, "apps/web/js/app.js"), "utf8");

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

// The one line of the backtest view that builds the strategy picker.
// Sliced by its id so a moved view does not break the test.
const sliceSelect = () => {
  const marker = '<select class="ctrl" id="bt-st">';
  const i = APP.indexOf(marker);
  if (i < 0) throw new Error("cannot find the #bt-st select in app.js");
  const j = APP.indexOf("</select>", i);
  if (j < 0) throw new Error("unterminated #bt-st select");
  return APP.slice(i, j + "</select>".length);
};

// Render it with the fake book the engine would publish.
const render = (items) => {
  const tpl = sliceSelect();
  const sandbox = {
    stItems: items,
    esc: (s) => String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;"),
  };
  vm.createContext(sandbox);
  return vm.runInContext("`" + tpl + "`", sandbox);
};

// What the engine's _sync_book_meta publishes: every strategy, with its kind.
const BOOK = [
  { name: "ema_rsi", kind: "builtin", enabled: false },
  { name: "price_action", kind: "builtin", enabled: false },
  { name: "atr_breakout", kind: "builtin", enabled: false },
  { name: "smart_money", kind: "builtin", enabled: false },
  { name: "aurion_strategy_template", kind: "file", enabled: true },
];

const pick = (html, value) => {
  const dom = new JSDOM(`<!doctype html><body>${html}</body>`);
  const sel = dom.window.document.getElementById("bt-st");
  if (!sel) throw new Error("the select did not render");
  sel.value = value;
  const opt = sel.options[sel.selectedIndex];
  if (!opt) throw new Error("no option selected for " + value);
  // Exactly what the click handler reads.
  return {
    name: String(sel.value || "ema_rsi"),
    kind: String((opt.dataset && opt.dataset.kind) || "builtin"),
    count: sel.options.length,
  };
};

/* --------------------------------------------------------- checks ---- */

check("the picker lists every strategy in the book", () => {
  const got = pick(render(BOOK), "ema_rsi");
  must(got.count === BOOK.length, `rendered ${got.count} options, expected ${BOOK.length}`);
  return `${got.count} options`;
});

check("an uploaded strategy is reported as a file, not a builtin", () => {
  const got = pick(render(BOOK), "aurion_strategy_template");
  must(got.name === "aurion_strategy_template", "wrong name: " + got.name);
  must(got.kind === "file", `kind was "${got.kind}" — this is the reported bug`);
  return got.name + " -> " + got.kind;
});

check("a builtin is still reported as a builtin", () => {
  for (const name of ["ema_rsi", "price_action", "atr_breakout", "smart_money"]) {
    const got = pick(render(BOOK), name);
    must(got.kind === "builtin", `${name} came back as "${got.kind}"`);
  }
  return "4 builtins";
});

check("a book with no kind falls back to builtin", () => {
  // strategyItems() has a hard-coded fallback list with no kind on it,
  // and an older engine would not send one either.
  const legacy = [{ name: "ema_rsi" }, { name: "price_action" }];
  const got = pick(render(legacy), "ema_rsi");
  must(got.kind === "builtin", `fallback gave "${got.kind}"`);
  return "defaults to builtin";
});

check("a hostile strategy name cannot break out of the attribute", () => {
  const nasty = [{ name: 'x" onmouseover="alert(1)', kind: "file" }];
  const html = render(nasty);
  must(!html.includes('onmouseover="alert(1)"'), "an unescaped name escaped the attribute");
  must(html.includes("&quot;"), "the name was not escaped at all");
  return "escaped";
});

/* ------------------------------- the request body, by source position */

const handler = (() => {
  const i = APP.indexOf('const goBt = $("h-bt");');
  if (i < 0) throw new Error("cannot find the backtest button handler");
  const j = APP.indexOf('if (view === "history")', i);
  return APP.slice(i, j < 0 ? APP.length : j);
})();

check("the request no longer hard-codes builtin", () => {
  must(
    !/strategy:\s*\{\s*kind:\s*["']builtin["']/.test(handler),
    'the POST body still sends kind: "builtin" for every strategy'
  );
  return "literal gone";
});

check("the request sends the kind that was read from the option", () => {
  must(/strategy:\s*\{\s*kind\s*,\s*name\s*\}/.test(handler),
    "the POST body does not pass the kind variable");
  must(/dataset\s*&&\s*\w+\.dataset\.kind/.test(handler) || /dataset\.kind/.test(handler),
    "the handler never reads data-kind off the selected option");
  return "kind carried";
});

check("the kind is read before the request is sent", () => {
  const read = handler.indexOf("dataset.kind");
  const post = handler.indexOf("/api/backtest");
  must(read > -1 && post > -1, "could not locate both halves");
  must(read < post, "the kind is read after the request is already built");
  return "ordered";
});

/* ---------------------------------------------------------- report ---- */

console.log("");
if (failures.length) {
  console.log(`${failures.length} of ${pass + failures.length} checks failed`);
  process.exit(1);
}
console.log(`${pass} checks passed`);
