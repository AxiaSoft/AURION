/* The strategy card has to say what is known about the strategy.
 *
 *   node tests/strategy-evidence.test.js
 *
 * Three built-in robots were listed side by side with nothing to tell
 * them apart but a one-line description, which reads as an endorsement
 * of all three. It is not one: measured out of sample, atr_breakout
 * returns about +0.53R a trade, ema_rsi about +0.32R, and price_action
 * loses money in every arm anyone has tried. That is knowable before a
 * trader finds out with their own account, so BaseStrategy.evidence
 * carries it and the card prints it.
 *
 * What is pinned here is the part that can rot quietly: that the
 * built-ins still declare evidence, that a losing strategy is still
 * labelled as one, that the banner renders the right tone and really
 * does carry the warning, and that the copy exists in every language
 * pack rather than falling back to a humanised key.
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const APP = fs.readFileSync(path.join(ROOT, "apps", "web", "js", "app.js"), "utf8");
const CSS = fs.readFileSync(path.join(ROOT, "apps", "web", "css", "app.css"), "utf8");
const BUILTIN = path.join(ROOT, "engine", "aurion", "strategy", "builtin");

let pass = 0;
let total = 0;
function check(name, cond, detail) {
  total += 1;
  if (cond) {
    pass += 1;
    console.log("ok   " + name);
  } else {
    console.log("FAIL " + name + (detail ? " — " + detail : ""));
  }
}

/* ---------------------------------------------------------------- engine */

const STATES = new Set(["measured", "negative", "unmeasured"]);

function evidenceOf(file) {
  const src = fs.readFileSync(path.join(BUILTIN, file), "utf8");
  const at = src.indexOf("    evidence = {");
  if (at < 0) return null;
  const end = src.indexOf("\n    }", at);
  const block = src.slice(at, end);
  const out = {};
  for (const m of block.matchAll(/"(\w+)":\s*("([^"]*)"|-?[\d.]+)/g)) {
    out[m[1]] = m[3] !== undefined ? m[3] : Number(m[2]);
  }
  return out;
}

for (const file of ["ema_rsi.py", "atr_breakout.py", "price_action.py"]) {
  const ev = evidenceOf(file);
  check(file + " declares evidence", !!ev, "no `evidence = {` block");
  if (!ev) continue;
  check(file + " evidence state is a known one", STATES.has(ev.state), String(ev.state));
  check(file + " says what was measured", String(ev.basis || "").length > 30,
    "basis is how a figure stops being quotable as something it is not");
  check(file + " carries a sample size", Number(ev.trades) > 0, String(ev.trades));
}

check(
  "a strategy that loses money is labelled as one",
  (evidenceOf("price_action.py") || {}).state === "negative",
  "price_action has never measured positive; the card must not imply it has",
);
check(
  "the basis admits costs are not modelled",
  /not modelled/.test((evidenceOf("price_action.py") || {}).basis || ""),
  "a backtest figure without that sentence overstates itself",
);
check(
  "the base class ships the field so an uploaded strategy is not silently endorsed",
  /evidence: dict\[str, Any\] = \{"state": "unmeasured"/.test(
    fs.readFileSync(path.join(ROOT, "engine", "aurion", "strategy", "base.py"), "utf8"),
  ),
  "BaseStrategy.evidence default",
);
check(
  "describe() passes evidence to the desk",
  /"evidence": dict\(getattr\(self, "evidence"/.test(
    fs.readFileSync(path.join(ROOT, "engine", "aurion", "strategy", "base.py"), "utf8"),
  ),
  "the card reads inst.describe()",
);

/* ------------------------------------------------------------------- copy */

const KEYS = ["ev_measured", "ev_negative", "ev_unmeasured", "ev_stats", "ev_warn", "ev_basis_hint"];
const packs = {};
for (const code of ["en", "fa", "ar"]) {
  packs[code] = JSON.parse(fs.readFileSync(path.join(ROOT, "lang", code + ".json"), "utf8"));
  const st = packs[code].strategies || {};
  for (const key of KEYS) {
    check(
      `${code}: strategies.${key}`,
      typeof st[key] === "string" && st[key].trim().length > 0,
      "missing copy falls back to a humanised key, which is English in a Persian desk",
    );
  }
}
check(
  "the stats line uses the same placeholders in every pack",
  ["en", "fa", "ar"].every((c) => {
    const s = packs[c].strategies.ev_stats;
    return ["{n}", "{win}", "{pf}", "{e}"].every((v) => s.includes(v));
  }),
  "a dropped placeholder prints a raw brace at the trader",
);
check(
  "no pack names a physical side or an instrument in the warning",
  ["en", "fa", "ar"].every((c) => !/\b(left|right|EURUSD|XAUUSD|US30)\b/.test(packs[c].strategies.ev_warn)),
  "mirrored layouts and symbol-free guidance",
);

/* --------------------------------------------------------------- the card */

const fnAt = APP.indexOf("function evidenceHtml(it) {");
check("app.js defines evidenceHtml", fnAt >= 0);
const fnEnd = APP.indexOf("\n}\n", fnAt);
const sandbox = {
  I18N: {
    t(key, vars) {
      const leaf = key.split(".").pop();
      let text = packs.en.strategies[leaf];
      if (text === undefined) text = key;
      if (vars) for (const [k, v] of Object.entries(vars)) text = text.replaceAll(`{${k}}`, v);
      return text;
    },
  },
  esc: (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"),
  fmt: (n, d = 2) => Number(n).toFixed(d),
};
vm.createContext(sandbox);
vm.runInContext(APP.slice(fnAt, fnEnd + 2), sandbox);
const render = (ev) => sandbox.evidenceHtml({ name: "price_action", evidence: ev });

check("no evidence renders nothing at all", render(undefined) === "", render(undefined));
check("an empty state renders nothing at all", render({ state: "" }) === "");

const bad = render({ state: "negative", trades: 590, win: 0.388, pf: 0.81, expectancy: -0.099,
  basis: "seeded synthetic market, costs not modelled" });
check("a losing strategy gets the warning tone", /class="st-ev st-ev-bad"/.test(bad), bad);
check("a losing strategy carries the warning in words",
  bad.includes(packs.en.strategies.ev_warn.slice(0, 24)),
  "the tint alone is not a sentence anybody can act on");
check("the sample size is shown, not just the verdict", /590 trades/.test(bad), bad);
check("the win rate is a percentage", /38\.8% won/.test(bad), bad);
check("a negative expectancy keeps its sign", /-0\.099R/.test(bad), bad);
check("the basis is reachable without leaving the card", /title="[^"]*costs not modelled/.test(bad), bad);
check("the basis tooltip also carries the standing caveat",
  bad.includes(sandbox.esc(packs.en.strategies.ev_basis_hint.slice(0, 30))), bad);

const good = render({ state: "measured", trades: 2273, win: 0.672, pf: 2.67, expectancy: 0.533, basis: "x" });
check("a measured strategy gets the positive tone", /class="st-ev st-ev-ok"/.test(good), good);
check("a positive expectancy is shown as positive", /\+0\.533R/.test(good), good);
check("a measured strategy is not given the warning copy",
  !good.includes(packs.en.strategies.ev_warn.slice(0, 24)),
  "the warning belongs to the one that loses");

const unknown = render({ state: "unmeasured", basis: "" });
check("an unmeasured strategy says so", /class="st-ev st-ev-warn"/.test(unknown), unknown);
check("an unmeasured strategy shows no made-up numbers", !/trades/.test(unknown), unknown);

check("the card is rendered inside the strategy card",
  /\$\{evidenceHtml\(it\)\}/.test(APP),
  "defined but never called is the same as absent");

/* -------------------------------------------------------------------- css */

for (const cls of ["st-ev-ok", "st-ev-bad", "st-ev-warn"]) {
  check("app.css styles ." + cls, CSS.includes("." + cls + "{"), "an unstyled banner is a bare paragraph");
}
check(
  "the tints use color-mix, not rgb() of a hex token",
  !/\.st-ev-(ok|bad|warn)\{[^}]*rgb\(var\(/.test(CSS),
  "--ok/--bad/--warning are hex literals; rgb(var(--ok) / .12) is dropped by the parser",
);
check(
  "the banner text is not dimmed with the rest of a disabled card",
  /\.st-card\.is-off \.st-ev\{opacity:1\}/.test(CSS),
  "the warning matters most on a card that is still switched off",
);

console.log(`\n${pass} of ${total} checks passed`);
process.exit(pass === total ? 0 : 1);
