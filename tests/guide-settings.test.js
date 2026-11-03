/**
 * The settings guide has to agree with the settings.
 *
 * A reference that states a default is only useful if the default is
 * right, and a hand-written one starts right and drifts the first time
 * somebody changes a number. A guide that confidently states the wrong
 * value is worse than one that says nothing, because the reader has no
 * way to tell which half to trust.
 *
 * So the block is generated from config/aurion.factory.json by
 * scripts/build-settings-guide.py, and this checks the generated output
 * still matches the file it was generated from. If it fails, run the
 * script.
 */

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

let failed = 0;
function check(name, ok, detail) {
  const good = ok === true;
  if (!good) failed++;
  console.log(`${good ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

const cfg = JSON.parse(read("config/aurion.factory.json"));
const guide = read("apps/web/guide.html");
const rootGuide = read("AURION-GUIDE.html");

/** The value at a dotted path, or undefined. */
function dig(obj, dotted) {
  return dotted.split(".").reduce((o, k) => (o && k in o ? o[k] : undefined), obj);
}

/**
 * Read a printed default back, and compare by value.
 *
 * Comparing the two as text cannot work: Python writes a float zero as
 * "0.0" and JavaScript writes it as "0", and neither is wrong. What
 * matters is that the guide and the config hold the same value, so the
 * printed form is parsed back and compared rather than matched.
 */
function sameValue(printed, actual) {
  if (printed === "—") return actual === undefined || actual === null;
  if (printed === "<i>(empty)</i>") return actual === "";

  const text = printed.replace(/&quot;/g, '"').replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">");

  let parsed;
  try { parsed = JSON.parse(text); } catch { return false; }
  return JSON.stringify(parsed) === JSON.stringify(actual);
}

check("the guide carries a generated settings reference",
  guide.includes("settings-reference:start"));

check("in all three languages",
  (guide.match(/settings-reference:start/g) || []).length === 3);

check("and the root copy has it too",
  rootGuide.includes("settings-reference:start"));

// ---------------------------------------------------------------------------
// Every documented key exists, and every default shown is the real one.
// ---------------------------------------------------------------------------

const rows = [...guide.matchAll(
  /<tr><td><code>([a-z0-9_.]+)<\/code><\/td><td><code>(.*?)<\/code><\/td>/g)];

check("the reference has rows to check", rows.length > 90, `${rows.length} rows`);

const unknown = [];
const wrong = [];
for (const [, key, printed] of rows) {
  const actual = dig(cfg, key);
  if (actual === undefined) { unknown.push(key); continue; }
  if (!sameValue(printed, actual)) {
    wrong.push(`${key}: guide says ${printed}, config holds ${JSON.stringify(actual)}`);
  }
}

check("every key documented actually exists in the config",
  unknown.length === 0, unknown.length ? [...new Set(unknown)].join(", ") : "all found");

check("every default shown is the one in the config",
  wrong.length === 0, wrong.length ? [...new Set(wrong)].slice(0, 4).join("; ") : "all match");

// ---------------------------------------------------------------------------
// The settings a trader is most likely to be looking for must be in there.
// ---------------------------------------------------------------------------

const mustCover = [
  "runtime.auto_trade",
  "runtime.trade_style",
  "runtime.max_open_trades",
  "runtime.risk_free.enabled",
  "runtime.risk_free.trigger_pct",
  "runtime.risk_free.lock_pct",
  "runtime.danger_guard.enabled",
  "runtime.auto_entry.enabled",
  "runtime.require_ai_agree",
  "ai.enabled",
  "execution.flatten_on_disconnect",
  "execution.magic",
  "prop.enabled",
  "mt5.ea_listen_port",
  "telegram.enabled",
];

const documented = new Set(rows.map(([, key]) => key));
const missing = mustCover.filter((k) => !documented.has(k));
check("the settings people actually ask about are covered",
  missing.length === 0, missing.length ? missing.join(", ") : `${mustCover.length} checked`);

// ---------------------------------------------------------------------------
// Explanations, not just a key dump.
// ---------------------------------------------------------------------------

// A reference whose rows say "enables the thing" is a key dump with
// extra steps. Worked examples are the part that answers "what number
// should I put here".
const examples = (guide.match(/<b>مثال:<\/b>|<b>Example:<\/b>/g) || []).length;
check("the reference works through real examples", examples >= 20, `${examples} examples`);

check("and it is reachable from the contents",
  guide.includes('"#fa-16"') && guide.includes('"#en-16"') && guide.includes('"#ar-16"'));

// ---------------------------------------------------------------------------
// Regenerating must be safe to do twice.
// ---------------------------------------------------------------------------

check("the generated block appears once per language, not twice",
  (guide.match(/id="fa-16"/g) || []).length === 1 &&
  (guide.match(/id="en-16"/g) || []).length === 1 &&
  (guide.match(/id="ar-16"/g) || []).length === 1);

check("the articles are still balanced",
  (guide.match(/<article/g) || []).length === (guide.match(/<\/article>/g) || []).length);

console.log(failed === 0
  ? "\nguide settings: all checks passed"
  : `\n${failed} check(s) failed — run python3 scripts/build-settings-guide.py`);
process.exit(failed === 0 ? 0 : 1);
