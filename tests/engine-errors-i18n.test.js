/**
 * What the engine refuses, said in the reader's own language.
 *
 *     node tests/engine-errors-i18n.test.js
 *
 * Reported, repeatedly: English keeps appearing in the backtest view
 * and elsewhere on a Persian desk. The markup was never the problem -
 * every heading and label on that page goes through the language pack.
 * The English was the ENGINE's: it answers a refusal with a sentence
 * ("no bars in that period", "kill switch armed", "no AurionBridge on
 * that symbol — attach the EA first") and the desk printed that
 * sentence exactly as it arrived, in the middle of a Persian card.
 *
 * The sentence is deliberately still there. It is what goes into the
 * journal, into an exported result and into a bug report, and it must
 * read the same whoever is looking at the screen. What travels beside
 * it now is a stable `code`, with the facts of the sentence - a
 * symbol, a timeframe, the two dates the terminal holds - as `args`.
 * The desk translates the code and falls back to the sentence.
 *
 * Three things are pinned here:
 *   1. every code the engine can answer with has a sentence in all
 *      three packs, or the desk shows English again;
 *   2. the desk translates by code and does NOT swallow a refusal it
 *      has no sentence for;
 *   3. the places that used to print `r.error` raw now go through it.
 */

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const APP = read("apps/web/js/app.js");
const TRADER = read("engine/aurion/runtime/trader.py");
const PACKS = { en: null, fa: null, ar: null };
for (const lang of Object.keys(PACKS)) PACKS[lang] = JSON.parse(read(`lang/${lang}.json`));

let pass = 0;
const failures = [];
const check = (name, fn) => {
  try { const note = fn(); pass += 1; console.log(`ok   ${name}${note ? "  — " + note : ""}`); }
  catch (e) { failures.push(name + ": " + e.message); console.log(`FAIL ${name}  — ${e.message}`); }
};

/* ── 1. the engine's codes all have sentences ──────────────────────── */

/* Refusal codes only: `{"ok": False, "code": "..."}`. The analysis
   card's blockers carry a `code` too, but that is a different
   vocabulary with a different pack section, checked further down. */
const codes = [...new Set([
  ...[...TRADER.matchAll(/"ok":\s*False,\s*\n?\s*"code":\s*"([a-z0-9_]+)"/g)].map((m) => m[1]),
  ...[...TRADER.matchAll(/"ok":\s*False,\s*"code":\s*"([a-z0-9_]+)"/g)].map((m) => m[1]),
  "no_bars_in_period", "no_bars_in_period_have", "market_closed", "market_closed_weekend",
])];

check("the engine answers its refusals with a code, not only a sentence", () => {
  if (codes.length < 8) throw new Error("only " + codes.length + " coded refusals; the sweep was undone");
  for (const must of ["no_bars_in_period", "no_ea_symbol", "no_history", "backtest_busy"]) {
    if (!codes.includes(must)) throw new Error("the backtest path lost its " + must + " code");
  }
  return codes.length + " codes";
});

check("every code has a sentence in all three packs", () => {
  const missing = [];
  for (const code of codes) {
    for (const [lang, pack] of Object.entries(PACKS)) {
      if (typeof (pack.engerr || {})[code] !== "string") missing.push(`${lang}.${code}`);
    }
  }
  /* A code with no sentence is not a crash - errText falls through to
     the engine's English - which is exactly why it has to be caught
     here instead of on the trader's screen. */
  if (missing.length) throw new Error("no sentence for " + missing.join(", "));
  return "en/fa/ar complete";
});

check("the composed sentences keep the facts the engine sends", () => {
  /* {symbol}, {timeframe}, {oldest}, {newest} are substituted from
     `args`. A translation that drops them turns "this terminal holds
     1 March to 20 November" into "this terminal holds to", which is
     worse than the English it replaced. */
  const wants = {
    no_ea_symbol: ["{symbol}"],
    no_history: ["{symbol}", "{timeframe}"],
    no_bars_in_period_have: ["{symbol}", "{timeframe}", "{oldest}", "{newest}"],
    max_open: ["{n}"],
    market_closed_weekend: ["{opens}"],
  };
  for (const [code, slots] of Object.entries(wants)) {
    for (const [lang, pack] of Object.entries(PACKS)) {
      const text = (pack.engerr || {})[code] || "";
      for (const slot of slots) {
        if (!text.includes(slot)) throw new Error(`${lang}.${code} drops ${slot}`);
      }
    }
  }
  return "all placeholders survive translation";
});

check("no pack answers a refusal in English by accident", () => {
  /* The Persian and Arabic packs must not be the English string copied
     across - which is how this family of bugs usually comes back. */
  for (const lang of ["fa", "ar"]) {
    for (const [code, text] of Object.entries(PACKS[lang].engerr || {})) {
      if (text === PACKS.en.engerr[code]) throw new Error(`${lang}.${code} is still the English sentence`);
      if (!/[\u0600-\u06FF]/.test(text)) throw new Error(`${lang}.${code} has no Arabic-script text in it`);
    }
  }
  return "fa and ar are really translated";
});

/* ── 2. the desk translates by code, and never swallows ────────────── */

function liftErrText() {
  const at = APP.indexOf("function errText(");
  if (at < 0) throw new Error("errText is gone");
  let depth = 0;
  let i = APP.indexOf("{", at);
  const start = at;
  for (let k = i; k < APP.length; k += 1) {
    if (APP[k] === "{") depth += 1;
    else if (APP[k] === "}") { depth -= 1; if (!depth) { i = k + 1; break; } }
  }
  const src = APP.slice(start, i);
  const pack = PACKS.fa;
  const I18N = {
    has: (key) => {
      let node = pack;
      for (const part of key.split(".")) {
        if (!node || typeof node !== "object" || !(part in node)) return false;
        node = node[part];
      }
      return typeof node === "string";
    },
    t: (key, vars) => {
      let node = pack;
      for (const part of key.split(".")) {
        if (!node || typeof node !== "object" || !(part in node)) return key;
        node = node[part];
      }
      let text = String(node);
      if (vars) for (const [k, v] of Object.entries(vars)) text = text.replaceAll(`{${k}}`, v);
      return text;
    },
  };
  // eslint-disable-next-line no-new-func
  return new Function("I18N", src + "\nreturn errText;")(I18N);
}

const errText = liftErrText();

check("a coded refusal is read in the desk's language", () => {
  const out = errText({
    ok: false, code: "no_bars_in_period_have",
    args: { symbol: "XAUUSD", timeframe: "M15", oldest: "2026-03-01", newest: "2026-11-20" },
    error: "no bars in that period — this terminal only has M15 bars from 2026-03-01 to 2026-11-20 for XAUUSD",
  });
  if (/no bars in that period/.test(out)) throw new Error("the English sentence came through: " + out);
  if (!/XAUUSD/.test(out) || !/2026-03-01/.test(out) || !/2026-11-20/.test(out)) {
    throw new Error("the facts were lost in translation: " + out);
  }
  return out.slice(0, 48) + "…";
});

check("a bare token answer is translated too", () => {
  /* Several engine paths have always answered with a token and no
     sentence at all - "backtest_busy", "premium_required". Those read
     as debugging output wherever they were shown. */
  const out = errText({ ok: false, error: "backtest_busy" });
  if (out === "backtest_busy") throw new Error("the raw token reached the screen");
  return out;
});

check("an untranslated refusal is still shown, not swallowed", () => {
  /* A strategy's own fault message cannot be translated by anybody.
     Replacing it with a tidy "Request failed" would cost the trader
     the only sentence that says what is actually wrong. */
  const own = "line 42: EMA period must be a positive integer";
  if (errText({ ok: false, error: own }) !== own) throw new Error("a strategy's own message was replaced");
  if (errText({ ok: false, code: "something_nobody_translated", error: own }) !== own) {
    throw new Error("an unknown code discarded the message beside it");
  }
  return "falls through intact";
});

check("a refusal with nothing in it still says something", () => {
  const out = errText({ ok: false });
  if (!out || /^\s*$/.test(out)) throw new Error("an empty refusal rendered as nothing at all");
  return out;
});

/* ── 3. the call sites actually use it ─────────────────────────────── */

check("the backtest result card no longer prints the engine's English", () => {
  const at = APP.indexOf("function renderBacktestCard(");
  const body = APP.slice(at, APP.indexOf("\nfunction ", at + 10));
  if (/esc\(bt\.error/.test(body)) throw new Error("the raw error is still rendered");
  if (!/errText\(bt\)/.test(body)) throw new Error("the card does not translate the refusal");
  return "errText(bt)";
});

check("the raw pattern is gone from the desk", () => {
  /* `r.error || I18N.t("errors.generic")` was the shape, repeated
     three dozen times. Each one printed an English sentence and then
     claimed to have a fallback. */
  const left = APP.match(/r\.error\s*\|\|\s*I18N\.t\("errors\.generic"\)/g) || [];
  if (left.length) throw new Error(left.length + " call sites still print the engine's English");
  const used = (APP.match(/errText\(/g) || []).length;
  if (used < 20) throw new Error("only " + used + " call sites translate; the sweep was partial");
  return used + " call sites";
});

/* ── 3b. the card whose whole job is to explain ────────────────────── */

const BLOCKERS = [...new Set([...TRADER.matchAll(/^\s*"([a-z0-9_]+)": \("/gm)].map((m) => m[1]))];

check("every gate the engine can name has a translated explanation", () => {
  /* GATE_PLAIN is an English table inside the engine, and the
     Intelligence card printed it verbatim: the one card on the desk
     that exists to explain why nothing is trading was the most
     English thing on a Persian screen. */
  if (BLOCKERS.length < 6) throw new Error("GATE_PLAIN was not found in trader.py");
  const missing = [];
  for (const code of BLOCKERS.concat(["no_setup"])) {
    for (const [lang, pack] of Object.entries(PACKS)) {
      if (typeof (pack.blocker || {})[code] !== "string") missing.push(`${lang}.${code}`);
      if (typeof (pack.blocker || {})[code + "_fix"] !== "string") missing.push(`${lang}.${code}_fix`);
    }
  }
  if (missing.length) throw new Error("no sentence for " + missing.join(", "));
  return BLOCKERS.length + " gates, three packs";
});

check("the card translates by code and keeps a strategy's own words", () => {
  const at = APP.indexOf("const line = (b) =>");
  if (at < 0) throw new Error("the blocker line renderer is gone");
  const body = APP.slice(at, at + 1400);
  if (!/I18N\.t\("blocker\." \+ code\)/.test(body)) throw new Error("it still prints the engine's English");
  if (!/b\.text/.test(body)) throw new Error("a strategy's own refusal has nowhere to go");
  if (!/no_setup/.test(body)) {
    throw new Error("nothing distinguishes the strategy's own words from the engine's placeholder");
  }
  return "translated, with the strategy's own words preserved";
});

/* ── 3c. the Intelligence read ─────────────────────────────────────── */

check("the AI read is rebuilt in the reader's language, not quoted", () => {
  /* The engine composes the confidence explainer, the outlook line and
     the idle/learning reason as finished English prose. The desk used
     to print all three verbatim, so the Intelligence card - the most
     read card on the desk - was English on a Persian screen. */
  for (const [lang, pack] of Object.entries(PACKS)) {
    for (const key of ["why_text", "idle_reason", "learning_reason", "outlook_text", "outlook", "no_pattern", "unknown_regime"]) {
      if (typeof (pack.ai || {})[key] !== "string") throw new Error(`${lang}.ai.${key} is missing`);
    }
  }
  if (/confidence_why && [a-z]+\.confidence_why\.text/.test(APP) || /cw\.text \|\|/.test(APP)) {
    throw new Error("the engine's English explainer is still printed somewhere");
  }
  if (!/aiWhyText\(/.test(APP) || !/aiReasonText\(/.test(APP) || !/aiOutlookText\(/.test(APP)) {
    throw new Error("the three rebuilt sentences are not wired in");
  }
  if (/>outlook \$\{/.test(APP)) throw new Error("the outlook pill is still labelled in English");
  return "explainer, outlook and reason all composed from numbers";
});

check("the engine ships the counts those sentences are made of", () => {
  const AI = read("engine/aurion/ai/engine.py");
  if (!/"outlook_votes"/.test(AI)) throw new Error("per-symbol state drops the vote counts");
  if (!/"need"/.test(AI)) throw new Error("per-symbol state drops the bar target the learning line needs");
  return "outlook_votes and need travel with every symbol";
});

/* ── 4. the strays found in the same sweep ─────────────────────────── */

check("every label the desk asks for by a fixed key exists", () => {
  const strays = [["chart", "close"], ["ai", "range"], ["gate", "r_slots_full"],
    ["terminal", "restart_title"], ["bt", "side_buy"], ["bt", "why_tp"]];
  for (const [section, key] of strays) {
    for (const [lang, pack] of Object.entries(PACKS)) {
      if (typeof (pack[section] || {})[key] !== "string") throw new Error(`${lang}.${section}.${key} is missing`);
    }
  }
  return strays.length + " keys, three packs";
});

check("no English fallback is wired in beside a key any more", () => {
  /* `I18N.t("terminal.restart") || "Restart Terminals"` cannot fire -
     t() never returns empty - so the English beside it was dead text
     that only ever hid a missing key. */
  const bad = APP.match(/I18N\.t\("[a-z0-9_.]+"\)\s*\|\|\s*"[A-Z]/g) || [];
  if (bad.length) throw new Error(bad.length + " keys still carry a hard-coded English twin: " + bad[0]);
  return "none";
});

/* ----------------------------------------------------------- report */

if (failures.length) {
  console.error(`\nengine-errors-i18n: ${failures.length} FAILED of ${pass + failures.length}`);
  process.exit(1);
}
console.log(`\nengine-errors-i18n: ${pass} checks passed`);
