/**
 * The update screen, and the reason it was unreadable.
 *
 * Reported from an installed copy: the update section was printing
 * "upd.inst_restart_now" and names like it instead of sentences, and the
 * card they sat in stopped fitting, because a key is one unbreakable
 * 24-character word where a sentence would have wrapped.
 *
 * The cause is not in the screen. i18n.js caches the language pack in the
 * browser and decides whether the cache is current by comparing a build
 * token it reads out of index.html - so when index.html is the stale
 * thing, which is exactly what happens when the files under a running
 * desk are replaced by an update or by the recovery script, the token
 * matches a pack that is a build behind, nothing ever refreshes, and
 * every string the new code added renders as its own name. t() handed
 * missing keys straight back to the screen, so that is what was drawn.
 *
 * Two halves are pinned here:
 *
 *   1. The net. A pack is revalidated on every load rather than only when
 *      the token moved; a miss asks for a fresh pack once, answers from
 *      English in the meantime and from the key's own last words at
 *      worst. A dotted key must never reach the screen again.
 *
 *   2. The screen itself. It now states which build this machine is on -
 *      which the card's own description had always promised and the card
 *      had never shown - with a formatted date instead of an ISO string
 *      and one status chip instead of the same fact written three times.
 *
 * Run: npm run test:updscreen
 */

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

const APP = read("apps/web/js/app.js");
const I18N_SRC = read("apps/web/js/i18n.js");
const CSS = read("apps/web/css/app.css");
const HTML = read("apps/web/index.html");
const DEMO = read("apps/web/js/demo.js");
const PACKS = { en: JSON.parse(read("lang/en.json")), fa: JSON.parse(read("lang/fa.json")), ar: JSON.parse(read("lang/ar.json")) };

let pass = 0;
const failures = [];
/* Checks run in the order they are written, and an asynchronous one is
   awaited before the next starts: several of these watch what a repair
   does after a tick, and a runner that did not wait would report them
   all passing before any of them had happened. */
const queue = [];
function check(name, fn) {
  queue.push(async () => {
    try {
      const detail = await fn();
      pass++;
      console.log("ok   " + name + (detail ? "  \u2014 " + detail : ""));
    } catch (err) {
      failures.push(name);
      console.log("  x  " + name + "  \u2014 " + err.message);
    }
  });
}
const must = (cond, msg) => { if (!cond) throw new Error(msg); };

/* ------------------------------------------------------------------ *
 * A real I18N, in a sandbox, with the browser it needs stubbed out.
 * ------------------------------------------------------------------ */

function makeI18N(o) {
  const opts = o || {};
  const store = new Map();
  const calls = { fetch: [], events: [] };
  const ctx = {
    console,
    Date,
    JSON,
    Object,
    String,
    Number,
    navigator: { language: opts.navigator || "en" },
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    document: {
      documentElement: { classList: { toggle() {} } },
      body: null,
      querySelector: () => (opts.token === null ? null : { src: "js/i18n.js?v=" + (opts.token || "tok1") }),
      querySelectorAll: () => [],
    },
    window: {
      dispatchEvent: (e) => { calls.events.push(e && e.type); return true; },
    },
    CustomEvent: function (type, init) { this.type = type; this.detail = init && init.detail; },
    fetch: async (url, init) => {
      calls.fetch.push({ url: String(url), init: init || null });
      const answer = opts.serve ? opts.serve(String(url)) : null;
      if (!answer) return { ok: false, status: 404, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => answer };
    },
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  const I18N = vm.runInContext(I18N_SRC + "\n;I18N;", ctx);
  return { I18N, calls, store };
}

const PACK_FULL = { meta: { dir: "rtl", locale: "fa-IR" }, upd: { title: "آپدیت", inst_of: "{n} از {total}" } };
const PACK_THIN = { meta: { dir: "rtl", locale: "fa-IR" }, upd: { title: "آپدیت" } };
const settle = () => new Promise((r) => setTimeout(r, 30));

/* =================== 1. a key must never reach the screen ============== */

check("a missing key is not printed as a key", () => {
  const { I18N } = makeI18N();
  I18N.install("fa", PACK_THIN);
  const out = I18N.t("upd.inst_restart_now");
  must(out !== "upd.inst_restart_now", "t() handed the key back");
  must(!/[a-z]+\.[a-z_]+/.test(out), "the answer still looks like a key: " + out);
  return JSON.stringify(out);
});

check("...it reads as words, in the worst case the key's own last words", () => {
  const { I18N } = makeI18N();
  I18N.install("fa", PACK_THIN);
  must(I18N.t("upd.inst_restart_now") === "Inst restart now", "unexpected: " + I18N.t("upd.inst_restart_now"));
  must(I18N.t("sup.eos_title") === "Eos title", "unexpected: " + I18N.t("sup.eos_title"));
  return "Inst restart now";
});

check("English answers for the Persian pack while the repair is in flight", () => {
  const { I18N } = makeI18N();
  I18N.install("en", { upd: { inst_restart_now: "Restart now" } });
  I18N.install("fa", PACK_THIN);
  must(I18N.t("upd.inst_restart_now") === "Restart now", "the English pack was not consulted");
  return "English, not the key";
});

check("a fallback answer still takes its placeholders", () => {
  const { I18N } = makeI18N();
  I18N.install("en", { upd: { inst_of: "{n} of {total} files" } });
  I18N.install("fa", PACK_THIN);
  must(I18N.t("upd.inst_of", { n: 12, total: 37 }) === "12 of 37 files", "placeholders were not filled");
  return "12 of 37 files";
});

check("a key that IS in the pack is untouched", () => {
  const { I18N } = makeI18N();
  I18N.install("fa", PACK_FULL);
  must(I18N.t("upd.title") === "آپدیت", "a present key changed");
  must(I18N.t("upd.inst_of", { n: 1, total: 2 }) === "1 از 2", "placeholders broke");
  return "unchanged";
});

/* =================== 2. a miss repairs itself, within limits =========== */

check("a miss goes and asks for a fresh pack", async () => {
  const { I18N, calls } = makeI18N({ serve: () => ({ data: PACK_FULL }) });
  I18N.install("fa", PACK_THIN);
  I18N.t("upd.inst_restart_now");
  await settle();
  must(calls.fetch.length > 0, "nothing was fetched");
  return calls.fetch.length + " request(s)";
});

check("...bypassing the cache, because the cache is the thing in doubt", async () => {
  const { I18N, calls } = makeI18N({ serve: () => ({ data: PACK_FULL }) });
  I18N.install("fa", PACK_THIN);
  I18N.t("upd.inst_restart_now");
  await settle();
  const first = calls.fetch[0];
  must(first.init && first.init.cache === "no-store", "the repair was allowed to be answered from the HTTP cache");
  must(/[?&]t=\d/.test(first.url), "the repair URL is not cache-busted: " + first.url);
  return "no-store + busted URL";
});

check("...and the repaired pack goes into force, with a repaint asked for", async () => {
  const { I18N, calls } = makeI18N({ serve: () => ({ data: PACK_FULL }) });
  I18N.install("fa", PACK_THIN);
  I18N.t("upd.inst_restart_now");
  await settle();
  must(I18N.pack.upd.inst_of === "{n} از {total}", "the fresh pack was not installed");
  must(calls.events.includes("aurion:i18n"), "nothing asked the desk to repaint");
  return "installed + aurion:i18n";
});

check("a hundred misses do not become a hundred requests", async () => {
  const { I18N, calls } = makeI18N({ serve: () => null });   // nothing answers
  I18N.install("fa", PACK_THIN);
  for (let i = 0; i < 100; i++) I18N.t("upd.key_" + i);
  await settle();
  /* One repair, and a repair tries both sources - the engine, then the
     published file - so four is the ceiling with the English fallback
     counted in. The number that matters is that it does not scale with
     the number of misses. */
  must(calls.fetch.length <= 4, "a render loop became a request loop: " + calls.fetch.length);
  return calls.fetch.length + " request(s) for 100 misses";
});

check("lookups before any pack is in force are not treated as evidence", async () => {
  const { I18N, calls } = makeI18N({ serve: () => ({ data: PACK_FULL }) });
  must(I18N.ready === false, "the pack is marked ready before anything was installed");
  I18N.t("hdr.drawer");
  await settle();
  must(calls.fetch.length === 0, "boot-time lookups spent the repair budget");
  return "no request";
});

check("has() asks without missing", async () => {
  const { I18N, calls } = makeI18N({ serve: () => ({ data: PACK_FULL }) });
  I18N.install("fa", PACK_THIN);
  must(I18N.has("upd.title") === true, "a present key reads as absent");
  must(I18N.has("upd.inst_restart_now") === false, "an absent key reads as present");
  await settle();
  must(calls.fetch.length === 0, "asking whether a key exists triggered a repair");
  must(I18N.missed.length === 0, "asking whether a key exists counted as a miss");
  return "true/false, no request";
});

/* =================== 3. the cache is revalidated every load ============ */

check("a cached pack is revalidated even when the build token matches", async () => {
  const { I18N, calls, store } = makeI18N({ token: "tok1", serve: () => ({ data: PACK_FULL }) });
  store.set("aurion.pack.fa", JSON.stringify({ build: "tok1", pack: PACK_THIN }));
  await I18N.load("fa");
  await settle();
  must(calls.fetch.length > 0, "a matching token certified the cache and nothing was checked");
  return "revalidated";
});

check("...and the fresher pack replaces the stale one", async () => {
  const { I18N, store } = makeI18N({ token: "tok1", serve: () => ({ data: PACK_FULL }) });
  store.set("aurion.pack.fa", JSON.stringify({ build: "tok1", pack: PACK_THIN }));
  await I18N.load("fa");
  await settle();
  must(I18N.t("upd.inst_of", { n: 1, total: 2 }) === "1 از 2", "the desk kept the stale pack");
  return "replaced";
});

check("...but identical words do not cause a repaint", async () => {
  const { I18N, calls, store } = makeI18N({ token: "tok1", serve: () => ({ data: PACK_FULL }) });
  store.set("aurion.pack.fa", JSON.stringify({ build: "tok1", pack: PACK_FULL }));
  await I18N.load("fa");
  await settle();
  must(!calls.events.includes("aurion:i18n"), "the desk was repainted for no change");
  return "quiet";
});

check("a revalidation that fails leaves the cached pack in force", async () => {
  const { I18N, store } = makeI18N({ token: "tok1", serve: () => null });
  store.set("aurion.pack.fa", JSON.stringify({ build: "tok1", pack: PACK_FULL }));
  await I18N.load("fa");
  await settle();
  must(I18N.t("upd.title") === "آپدیت", "an unreachable pack blanked the desk");
  return "cache held";
});

/* =================== 4. callers of the old contract ==================== */

check("optional labels ask has(), not whether t() echoed the key", () => {
  for (const name of ["themeName", "accTypeLabel", "roleLabel", "profileLabel"]) {
    const i = APP.indexOf("function " + name + "(");
    must(i > 0, name + " is gone");
    const body = APP.slice(i, APP.indexOf("\n}", i));
    must(/I18N\.has\(/.test(body), name + " still detects a miss by comparing with the key");
    must(!/=== *key *\?/.test(body), name + " keeps the comparison that no longer detects anything");
  }
  return "4 call sites converted";
});

check("the chart files' tt() helpers keep their own fallback", () => {
  for (const f of ["apps/web/js/chart-tools.js", "apps/web/js/charts.js"]) {
    const src = read(f);
    must(/\.has *&& *!\w+\.has\(key\)/.test(src) || /if \(\w+\.has && !\w+\.has\(key\)\) return fallback/.test(src),
      f + " no longer falls back to its own word when the key is absent");
  }
  return "both";
});

check("an account type is looked up in the case the pack uses", () => {
  const i = APP.indexOf("function accTypeLabel(");
  const body = APP.slice(i, APP.indexOf("\n}", i));
  must(/toLowerCase\(\)/.test(body), '"Demo" from the engine missed "demo" in the pack');
  return "lower-cased";
});

/* =================== 5. the screen itself ============================== */

const panel = APP.slice(APP.indexOf('block("set-update"'), APP.indexOf('block("set-system"'));

check("the card says which build this machine is on", () => {
  must(/id="upd-current"/.test(panel), "the installed version is still not on the card");
  must(/upd\.current_build/.test(panel), "it is not labelled");
  const facts = APP.slice(APP.indexOf("function paintUpdateFacts("), APP.indexOf("async function bindUpdatePanel"));
  must(/S\.version/.test(facts), "it has no source for the version when the state file has none");
  return "labelled, with a fallback";
});

check("the last check is a date a person reads, not an ISO string", () => {
  const fn = APP.slice(APP.indexOf("function updWhen("), APP.indexOf("function paintUpdateFacts("));
  must(/toLocaleString\(I18N\.locale\(\)/.test(fn), "the timestamp is not localised");
  must(/never_checked/.test(fn), "a desk that has never checked prints an empty string");
  must(!/last_check\|\|'-'/.test(APP) && !/last_check \|\| '-'/.test(APP),
    "the raw state value is still being printed");
  return "medium date, short time";
});

check("the composed status sentence with its stray dash is gone", () => {
  must(!/upd\.last_check'\) *\+ *': ' *\+/.test(APP), "the panel still concatenates its own status line");
  must(!APP.includes("' - ' + (st.data.update_available"), 'the "- -" line is still there');
  return "replaced by two labelled facts";
});

check("one writer for the three facts", () => {
  const writers = APP.split("\n").filter((l) => /getElementById\(["']upd-(current|chip)["']\)/.test(l));
  must(writers.length === 2, "the facts are written from more than one place: " + writers.length);
  must(APP.indexOf("function paintUpdateFacts(") < APP.indexOf("async function bindUpdatePanel"),
    "the helper is declared after its users");
  return "paintUpdateFacts";
});

check("the chip has a state for each answer the server can give", () => {
  const facts = APP.slice(APP.indexOf("function paintUpdateFacts("), APP.indexOf("async function bindUpdatePanel"));
  for (const s of ["available", "uptodate", "error"]) must(facts.includes('"' + s + '"'), "no " + s + " state");
  must(/classList\.remove\(/.test(facts), "the previous state is not cleared, so chips stack up");
  const bind = APP.slice(APP.indexOf("async function bindUpdatePanel"), APP.indexOf("async function bindUpdatePanel") + 6000);
  must(/paintUpdateFacts\(\{ state: 'error' \}\)/.test(bind), "a failed check leaves the chip claiming the old answer");
  must(/paintUpdateFacts\(\{ state: 'checking' \}\)/.test(bind), "pressing check gives no immediate feedback");
  return "checking / uptodate / available / error";
});

check("pressing check answers with something new, not with the chip's words", () => {
  const bind = APP.slice(APP.indexOf("async function bindUpdatePanel"), APP.indexOf("async function bindUpdatePanel") + 6000);
  must(/upd\.check_none/.test(bind), "the result line repeats \"up to date\" under a chip that already says it");
  for (const code of ["en", "fa", "ar"]) must(typeof PACKS[code].upd.check_none === "string", code + " cannot say it");
  return "upd.check_none";
});

check("the same fact is not printed three times over", () => {
  const bind = APP.slice(APP.indexOf("async function bindUpdatePanel"), APP.indexOf("async function bindUpdatePanel") + 6000);
  must(!/statusEl\.innerHTML = '<p class="sub">' \+ I18N\.t\('upd\.none'\)/.test(bind),
    '"no update found" is still printed permanently beside the chip that says the same thing');
  /* The block has three outcomes now - an offer, "the branch moved and
     nothing was released", and nothing at all - so what is pinned is
     that it still has an empty case and still never restates the chip. */
  must(/statusEl\.innerHTML = '';/.test(bind), "there is no longer a case that prints nothing");
  must(/st\.data\.update_available && st\.data\.latest/.test(bind),
    "an offer is printed for anything that merely differs from the branch");
  return "chip only";
});

/* =================== 6. nothing can burst the card ===================== */

const cssRule = (sel) => {
  const stripped = CSS.replace(/\/\*[\s\S]*?\*\//g, "");
  const out = [];
  const re = new RegExp("(?:^|[}])\\s*" + sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*{([^}]*)}", "g");
  let m;
  while ((m = re.exec(stripped))) out.push(m[1]);
  return out;
};

check("a long version or error code wraps instead of widening the card", () => {
  must(cssRule(".upd-facts .kv b").some((b) => /overflow-wrap:\s*anywhere/.test(b)),
    "a 40-character build string cannot break");
  must(cssRule(".stx-result").some((b) => /overflow-wrap:\s*anywhere/.test(b)),
    "a server-sent error code cannot break");
  return "both break";
});

check("the chip's colours are mixed, not fed a hex to rgb()", () => {
  const rules = [".upd-chip.is-ok", ".upd-chip.is-new", ".upd-chip.is-bad"].flatMap((s) => cssRule(s));
  must(rules.length === 3, "a chip state has no colour: " + rules.length);
  for (const r of rules) must(!/rgb\(var\(--(ok|bad|accent)\)/.test(r), "rgb() around a hex token renders nothing");
  must(rules.every((r) => /color-mix|var\(--/.test(r)), "a chip colour is hard-coded");
  return "3 states, color-mix";
});

check("a Latin version inside a Persian line is isolated", () => {
  must(cssRule(".upd-facts .kv b").some((b) => /unicode-bidi:\s*plaintext/.test(b)),
    "v1.2.3 will be reordered by the surrounding right-to-left line");
  return "plaintext";
});

/* =================== 7. the packs ====================================== */

check("the new strings exist in all three languages", () => {
  for (const [code, pack] of Object.entries(PACKS)) {
    for (const k of ["current_build", "never_checked"]) {
      must(typeof pack.upd[k] === "string" && pack.upd[k].trim(), code + " is missing upd." + k);
    }
  }
  return "en / fa / ar";
});

check("no upd.* key exists in one pack and not another", () => {
  const keys = (p) => Object.keys(p.upd || {}).sort();
  const base = keys(PACKS.en);
  for (const code of ["fa", "ar"]) {
    const here = keys(PACKS[code]);
    const missing = base.filter((k) => !here.includes(k));
    must(!missing.length, code + " is missing: " + missing.join(", "));
  }
  return base.length + " keys, three packs";
});

check("every upd.* and sup.* key the code reads is in the packs", () => {
  const used = new Set();
  for (const f of ["apps/web/js/app.js", "apps/web/index.html"]) {
    const re = /["'`]((?:upd|sup)\.[a-zA-Z0-9_]+)["'`]/g;
    let m;
    const src = read(f);
    while ((m = re.exec(src))) used.add(m[1]);
  }
  const get = (o, k) => k.split(".").reduce((a, p) => (a && typeof a === "object" ? a[p] : undefined), o);
  for (const code of ["en", "fa", "ar"]) {
    const missing = [...used].filter((k) => typeof get(PACKS[code], k) !== "string");
    must(!missing.length, code + " cannot render: " + missing.join(", "));
  }
  return used.size + " keys";
});

check("the browser is made to fetch the files that changed", () => {
  for (const want of ["js/app.js?v=desk230", "css/app.css?v=desk230", "js/demo.js?v=desk222"]) {
    must(HTML.includes(want), "index.html still points at the old " + want);
  }
  const token = /js\/i18n\.js\?v=(lang[0-9a-f]+)/.exec(HTML);
  must(token, "the language token is gone from index.html");
  return token[1];
});

/* =================== 8. the demo's update screen ======================= */

check("the demo answers the update panel's two reads", () => {
  must(/p === "\/api\/system\/update\/settings"/.test(DEMO), "the settings read falls through to the catch-all");
  must(/p === "\/api\/system\/update\/state"/.test(DEMO), "the state read falls through to the catch-all");
  return "both answered";
});

check("...and a check, which has no effect in the world", () => {
  must(/p === "\/api\/system\/update\/check"/.test(DEMO), "the shop window still shows a red error chip");
  return "answered up-to-date";
});

check("...but installing one is still refused", () => {
  must(!/update\/apply/.test(DEMO), "the demo would run an install");
  must(/return READONLY;/.test(DEMO), "the demo no longer refuses writes");
  return "READONLY";
});

check("the demo state invents no version", () => {
  const i = DEMO.indexOf('p === "/api/system/update/state"');
  const body = DEMO.slice(i, i + 400);
  must(!/current_version/.test(body), "the demo makes up a build number for a real-looking screen");
  return "falls back to the desk's own";
});

/* ------------------------------------------------------------------ *
 * The development build is not something you can install from here
 *
 * The screen used to offer a button - "install this branch" - whenever
 * main was ahead of the last release. It was removed by request. An
 * update screen is for updates the owner decided to ship, and a
 * one-click path to unreleased code on a trading desk is a way to put a
 * half-finished strategy in front of real money.
 *
 * What stays is the sentence: this build is behind the branch, by this
 * many files. Knowing is not the same as installing.
 * ------------------------------------------------------------------ */

check("the update screen cannot install an unreleased build", () => {
  must(!/upd-dev-btn/.test(APP), "the button is back");
  must(!/install_branch_confirm/.test(APP), "its confirmation dialog is still wired up");
  return "no button, no handler";
});

check("...but still says what is on the branch", () => {
  const i = APP.indexOf("upd.behind_branch");
  must(i > 0, "the desk stopped saying it is behind the branch at all");
  must(/upd-unpub-detail/.test(APP), "the detail line went with the button");
  return "the file count and size are still shown";
});

/* ------------------------------------------------------------------ */

(async () => {
  for (const run of queue) await run();
  if (failures.length) {
    console.log("\nupdate-screen: " + failures.length + " FAILED of " + (pass + failures.length));
    process.exit(1);
  }
  console.log("\nupdate-screen: " + pass + " checks passed");
})();
