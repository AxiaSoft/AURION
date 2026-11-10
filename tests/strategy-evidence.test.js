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

/* --------------------------------------------------------------- the card
 *
 * REVERSED, and the reason is kept here rather than deleted.
 *
 * This section used to render evidenceHtml() in a sandbox and pin every
 * part of a coloured badge on the strategy card: the tone class, the
 * sample size, the win rate, the signed expectancy, the basis tooltip
 * and the warning sentence on the losing one.
 *
 * The badge was removed on request - take the backtest-status tag off
 * the cards. So what is pinned now is the removal, and the three ways
 * it could quietly come back: the function, the call site, and the
 * stylesheet. A badge that returns as dead CSS plus a one-line call is
 * exactly how this kind of thing grows back.
 *
 * Everything ABOVE this line is untouched and still runs. The
 * measurement is a property of the strategy, not of the card: the
 * built-ins still declare it, BaseStrategy still defaults an upload to
 * "unmeasured", describe() still hands it to the desk, and the copy
 * still exists in all three packs. None of that depended on the badge,
 * and none of it goes away with it.
 */

check(
  "evidenceHtml is gone, not merely unused",
  APP.indexOf("function evidenceHtml(it) {") < 0,
  "the function that drew the badge is still in app.js",
);
check(
  "nothing calls it from the strategy card",
  !/\$\{evidenceHtml\(it\)\}/.test(APP) && !/evidenceHtml\(/.test(APP),
  "the call site survived the removal",
);
check(
  "the strategy card still renders without it",
  /function strategyLiveCards\(\)/.test(APP) && /class="card st-card/.test(APP),
  "the card markup was damaged by the removal",
);
check(
  "the removal is explained where somebody would put it back",
  /The backtest badge is gone from the strategy cards/.test(APP),
  "an unexplained deletion is re-added by the next person to read the file",
);

/* -------------------------------------------------------------------- css */

for (const cls of ["st-ev", "st-ev-ok", "st-ev-bad", "st-ev-warn"]) {
  check(
    "app.css no longer styles ." + cls,
    !CSS.includes("." + cls + "{"),
    "an orphan rule is an invitation to put the badge back",
  );
}
check(
  "and the stylesheet says why the rules went",
  /The \.st-ev strip is gone with the backtest badge/.test(CSS),
  "a silent deletion in CSS is indistinguishable from an accident",
);

console.log(`\n${pass} of ${total} checks passed`);
process.exit(pass === total ? 0 : 1);
