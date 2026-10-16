/**
 * The prop guide has to cover the prop page.
 *
 * The guide is useful exactly as long as it is complete: a page with
 * nineteen controls and eighteen explanations sends the reader looking
 * for a nineteenth that is not there, and they stop trusting the other
 * eighteen. So this reads the real ids out of propFormHtml() and
 * propStatusHtml() and insists each one has an entry.
 *
 * It also enforces the standing rule that no instrument is ever named in
 * the help text. The right number for a session hour or a lot cap
 * depends on the symbol, the broker and the account; a named example
 * gets copied by somebody trading something else.
 */

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

let failed = 0;
function check(name, ok, detail) {
  const good = ok === true;
  if (!good) failed++;
  console.log(`${good ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

// ── Load the guide the way the browser does ───────────────────────────
const sandbox = { window: {} };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(read("apps/web/js/prop-guide.js"), sandbox);
const GUIDE = sandbox.window.PROP_GUIDE;

check("the guide module defines PROP_GUIDE", !!GUIDE);
check("it has sections", Array.isArray(GUIDE.SECTIONS) && GUIDE.SECTIONS.length >= 4,
  `${GUIDE.SECTIONS.length} sections`);

const rows = GUIDE.SECTIONS.flatMap((s) => s.rows);
const covered = new Set(rows.map((r) => r.id));

// ── Every control on the prop page is explained ───────────────────────
const app = read("apps/web/js/app.js");

/** The body of one function, by brace counting from its declaration. */
function body(src, name) {
  const at = src.indexOf(`function ${name}(`);
  if (at < 0) return "";
  let i = src.indexOf("{", at);
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}") {
      depth--;
      if (depth === 0) return src.slice(i, j + 1);
    }
  }
  return "";
}

const form = body(app, "propFormHtml") + body(app, "propStatusHtml");
check("the prop form was found in app.js", form.length > 500, `${form.length} chars`);

// Ids the user can actually operate. The hidden mirror field, the symbol
// picker's own plumbing and the guide's search box are not settings.
const SKIP = new Set([
  "pr-id", "pr-syms-pick", "pr-syms-btn", "pr-syms-label", "pr-syms-panel",
  "pr-syms-q", "pr-syms-all", "pr-syms-none", "pr-syms-list", "pr-syms-foot",
  "pr-about", "prop-enable-sub", "risk-state", "risk-lock", "risk-dpl", "risk-dd",
  "prop-guide-q",
]);

const ids = new Set();
for (const m of form.matchAll(/id=\\?"(pr-[a-z0-9-]+|prop-[a-z0-9-]+)\\?"/g)) ids.add(m[1]);
for (const m of form.matchAll(/propNum\("([a-z0-9-]+)"/g)) ids.add(m[1]);
for (const m of form.matchAll(/propTime\("([a-z0-9-]+)"/g)) ids.add(m[1]);

const wanted = [...ids].filter((id) => !SKIP.has(id)).sort();
check("the page's controls were discovered", wanted.length >= 20, `${wanted.length} controls`);

const missing = wanted.filter((id) => !covered.has(id));
check("every prop control has a guide entry", missing.length === 0, missing.join(", "));

// ── Each entry is actually written, in Persian and in English ─────────
const thin = rows.filter((r) => !r.fa || r.fa.length < 40 || !r.en || r.en.length < 40);
check("every entry has real Persian and English text", thin.length === 0,
  thin.map((r) => r.id).join(", "));

const unlabelled = rows.filter((r) => !r.label || !r.label.fa || !r.label.en);
check("every entry has a label in both languages", unlabelled.length === 0,
  unlabelled.map((r) => r.id).join(", "));

const sectionless = GUIDE.SECTIONS.filter((s) => !s.title?.fa || !s.lede?.fa);
check("every section has a Persian title and lede", sectionless.length === 0,
  sectionless.map((s) => s.id).join(", "));

// ── The standing correction: name no instruments ──────────────────────
const INSTRUMENTS = /\b(EURUSD|GBPUSD|USDJPY|AUDUSD|USDCHF|NZDUSD|USDCAD|XAUUSD|XAGUSD|BTCUSD|ETHUSD|US30|US100|NAS100|SPX500|GER40|DAX|طلا|یورو|بیت ?کوین|الذهب)\b/i;
const named = [];
for (const sec of GUIDE.SECTIONS) {
  for (const key of ["fa", "en", "ar"]) {
    if (INSTRUMENTS.test(sec.title?.[key] || "")) named.push(`${sec.id}.title.${key}`);
    if (INSTRUMENTS.test(sec.lede?.[key] || "")) named.push(`${sec.id}.lede.${key}`);
  }
  for (const row of sec.rows) {
    for (const key of ["fa", "en", "ar"]) {
      if (INSTRUMENTS.test(row[key] || "")) named.push(`${row.id}.${key}`);
      if (INSTRUMENTS.test(row.label?.[key] || "")) named.push(`${row.id}.label.${key}`);
    }
  }
}
check("no instrument is named anywhere in the guide", named.length === 0, named.join(", "));

// ── It is wired into the page, not merely written ─────────────────────
check("the prop view renders the guide", app.includes("${propGuideHtml()}"));
check("the search box is bound", app.includes("bindPropGuide()"));
check("the page loads the module", read("apps/web/index.html").includes("js/prop-guide.js"));

for (const code of ["fa", "en", "ar"]) {
  const pack = JSON.parse(read(`lang/${code}.json`));
  const have = ["guide_title", "guide_lede", "guide_search", "guide_search_ph", "guide_empty"]
    .every((k) => typeof pack.risk?.[k] === "string" && pack.risk[k].length > 0);
  check(`the ${code} pack has the guide's labels`, have);
}

console.log(failed ? `\n${failed} FAILED` : "\nall good");
process.exit(failed ? 1 : 0);
