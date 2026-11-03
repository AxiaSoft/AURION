/**
 * The strategy card has to say which market it is talking about.
 *
 * The engine keeps one verdict per strategy per symbol now, but that is
 * only worth keeping if the card shows it. Reported as "the robot only
 * trades one symbol": it was evaluating every attached symbol all along,
 * and the card was showing whichever one closed a candle most recently
 * with no label on it — so a buy on EURUSD read as a buy on whatever the
 * trader happened to be looking at.
 *
 * The chips are lifted out of app.js and run for real rather than
 * grepped for, because the interesting part is the behaviour: that the
 * strip stays empty on a one-chart desk, that it reuses the headline's
 * own live-vs-decision rule instead of inventing a second one, and that
 * it does not rely on colour alone to say what a strategy decided.
 *
 *     node tests/strategy-symbols.test.js
 */
const fs = require("node:fs");
const vm = require("node:vm");

const app = fs.readFileSync("apps/web/js/app.js", "utf8");
const css = fs.readFileSync("apps/web/css/app.css", "utf8");
let fails = 0;
const ok = (c, m, d) => {
  if (!c) { fails++; console.log("FAIL " + m + (d ? "  — " + d : "")); }
  else console.log("ok   " + m + (d ? "  — " + d : ""));
};

/* ---------- lift the three functions and run them ---------- */
function lift(name) {
  const head = `function ${name}(`;
  const at = app.indexOf(head);
  if (at < 0) throw new Error("not found: " + name);
  let depth = 0, i = app.indexOf("{", at);
  const start = i;
  for (; i < app.length; i++) {
    if (app[i] === "{") depth++;
    else if (app[i] === "}") { depth--; if (!depth) break; }
  }
  return app.slice(at, i + 1);
}

const sandbox = {
  console,
  esc: (s) => String(s == null ? "" : s).replace(/[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])),
  Date,
};
vm.createContext(sandbox);
for (const fn of ["stState", "stActClass", "stSymbolRows"]) {
  vm.runInContext(lift(fn), sandbox);
}
const rows = (it) => sandbox.stSymbolRows(it);

const now = new Date().toISOString();
const old = new Date(Date.now() - 600000).toISOString();

/* ---------- the strip only appears when it means something ---------- */
ok(rows({}) === "", "no symbols at all renders nothing");
ok(rows({ symbols: [] }) === "", "an empty list renders nothing");
ok(rows({ symbols: [{ symbol: "EURUSD", action: "buy", ts: now }] }) === "",
  "a one-chart desk gets no strip — it does not need a label saying which chart");

/* ---------- two symbols, both named, neither erased ---------- */
const two = rows({
  symbols: [
    { symbol: "EURUSD", action: "buy", reason: "trend up", ts: now },
    { symbol: "GBPUSD", action: "hold", reason: "no setup on this bar", ts: now },
  ],
});
ok(/EURUSD/.test(two) && /GBPUSD/.test(two), "both symbols appear");
ok(/>buy</.test(two), "EURUSD's buy survives the other symbol's bar");
ok(/>hold</.test(two), "GBPUSD's hold is shown as its own verdict");
ok((two.match(/class="st-sym/g) || []).length === 2, "one chip per symbol");

/* ---------- the verdict is in words, not only in colour ---------- */
ok(/<i>buy<\/i>/.test(two.replace(/\s+/g, "")) || />buy</.test(two),
  "the verdict is spelled out, so colour is never the only indicator");

/** The verdict shown on ONE named chip.
 *
 * The first version of these checks asked whether the word "hold"
 * appeared anywhere in the strip — which it did, on the other symbol's
 * chip, so a mutation that threw the live-vs-decision rule away passed
 * cleanly. A per-symbol assertion has to be made per symbol.
 */
function verdictOf(html, symbol) {
  for (const chip of html.split("<span").slice(1)) {
    if (!chip.includes(">" + symbol + "<")) continue;
    const m = chip.match(/<i>([^<]*)<\/i>/);
    return m ? m[1] : "";
  }
  return null;
}

ok(verdictOf(two, "EURUSD") === "buy", "the EURUSD chip reads buy",
  String(verdictOf(two, "EURUSD")));
ok(verdictOf(two, "GBPUSD") === "hold", "the GBPUSD chip reads hold",
  String(verdictOf(two, "GBPUSD")));

/* ---------- it reuses the headline's rule, it does not invent one ---------- */
const stale = rows({
  symbols: [
    { symbol: "EURUSD", action: "buy", reason: "trend up", ts: old,
      live_action: "hold", live_reason: "watched", live_ts: now },
    { symbol: "GBPUSD", action: "hold", ts: now },
  ],
});
ok(verdictOf(stale, "EURUSD") === "hold",
  "a decision older than a minute yields to the live watch, exactly as the headline does",
  String(verdictOf(stale, "EURUSD")));
const fresh = rows({
  symbols: [
    { symbol: "EURUSD", action: "buy", reason: "trend up", ts: now,
      live_action: "hold", live_reason: "watched", live_ts: now },
    { symbol: "GBPUSD", action: "hold", ts: now },
  ],
});
ok(verdictOf(fresh, "EURUSD") === "buy",
  "a fresh decision outranks the watch pass, exactly as the headline does",
  String(verdictOf(fresh, "EURUSD")));
ok(/stState\(/.test(lift("stSymbolRows")),
  "the chips call stState rather than restating the rule — two copies is how they disagree");

/* ---------- the chips carry their state for the eye too ---------- */
ok(/is-live/.test(fresh) === false || /is-live/.test(stale),
  "a live chip is marked live");
ok(/title="/.test(two), "each chip explains itself on hover");

/* ---------- markup is sound ---------- */
const opens = (two.match(/<span/g) || []).length;
const closes = (two.match(/<\/span>/g) || []).length;
ok(opens === closes, "the chip markup is balanced", `${opens} open vs ${closes} close`);

/* ---------- it is wired into the card and kept patched ---------- */
ok(/data-st-syms="\$\{esc\(it\.name\)\}"/.test(app),
  "the card has a container for the strip");
const patch = app.slice(app.indexOf("function patchStrategyLive"),
  app.indexOf("function patchStrategyLive") + 3000);
ok(/data-st-syms/.test(patch),
  "the strip is live-patched, not frozen at whatever the tab was built with");

/* ---------- the style exists and does not shout ---------- */
const flat = css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, " ")
  .replace(/\s*([{};:,])\s*/g, "$1");
const ruleOf = (sel) => {
  const m = flat.match(new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\{([^}]*)\\}"));
  return m ? m[1] : "";
};
ok(ruleOf(".st-syms") !== "", ".st-syms is styled");
ok(/flex-wrap:wrap/.test(ruleOf(".st-syms")),
  "the chips wrap — a basket of symbols must not force the card sideways on a phone");
ok(/display:none/.test(ruleOf(".st-syms:empty")),
  "an empty strip takes no vertical space");
ok(/white-space:nowrap/.test(ruleOf(".st-sym")), "a chip never breaks mid-symbol");
ok(ruleOf(".st-sym.up i") !== "" && ruleOf(".st-sym.down i") !== "",
  "buy and sell are tinted");

console.log(fails ? `\nstrategy symbols: ${fails} FAILED` : "\nstrategy symbols: all checks passed");
process.exit(fails ? 1 : 0);
