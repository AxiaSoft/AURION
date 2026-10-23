/**
 * Three faults that all came from data going to the wrong place.
 *
 *  - The Intelligence panel reads S.snap.ai_by_symbol when a chart is
 *    attached, but the live "ai" socket message only wrote S.snap.ai. Every
 *    live inference landed in a field nobody was reading, so the analysis
 *    sat frozen until something forced a full snapshot reload.
 *  - fetchLicense() gave up after one failed call. Right after an update the
 *    engine is still restarting, so that call fails, boot reads "no licence"
 *    and shows the key screen - while the gate's own poll succeeds a second
 *    later and prints "premium active" underneath it.
 *  - Nothing distinguished an update from a first install, so there was no
 *    honest way to say "the update worked" without also saying it to someone
 *    who had just installed AURION for the first time.
 */
const fs = require("node:fs");
const src = fs.readFileSync("apps/web/js/app.js", "utf8");

let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log("FAIL " + m); } else console.log("ok   " + m); };

const grab = (name) => {
  const i = src.indexOf("function " + name + "(");
  if (i < 0) return null;
  let d = 0;
  for (let k = src.indexOf("{", i); k < src.length; k++) {
    if (src[k] === "{") d++;
    else if (src[k] === "}") { d--; if (!d) return src.slice(i, k + 1); }
  }
  return null;
};

/* ---- the live AI read reaches the panel ---- */
const aiBranch = src.slice(src.indexOf('if (msg.type === "ai"'), src.indexOf('if (msg.type === "agents"'));
ok(aiBranch.includes("ai_by_symbol"),
  "a live ai message updates ai_by_symbol, the field the Intelligence panel actually reads");
ok(/findIndex/.test(aiBranch),
  "it replaces that symbol's entry rather than appending a duplicate every tick");
ok(/slice\(-12\)/.test(aiBranch),
  "the per-symbol list stays bounded");
ok(aiBranch.includes("scheduleSync()"),
  "and it still asks for a repaint");

/* ---- the licence is not read off a single failed call ---- */
const settled = grab("fetchLicenseSettled");
ok(settled, "there is a retrying licence lookup");
ok(settled && /for \(/.test(settled) && /setTimeout/.test(settled),
  "it retries with a wait between attempts");
const boot = grab("boot") || "";
ok(boot.includes("fetchLicenseSettled("),
  "boot uses the retrying lookup, so a still-starting engine is not read as 'no licence'");
ok(!/const lic = await fetchLicense\(\);/.test(boot),
  "boot no longer decides on one call");
ok(boot.indexOf("const welcome = playWelcome();") < boot.indexOf("await fetchLicenseSettled"),
  "the retries run under the welcome clip, so they cost no extra waiting");

/* ---- update vs fresh install ---- */
const chk = grab("updateCheck");
ok(chk, "there is an update check");
/* updateCheck reads a module-scope constant and swallows storage errors, so
   the harness must supply that constant - otherwise the ReferenceError is
   caught, "seen" stays empty and every run looks like a first install. */
const keyLine = src.match(/const LS_SEEN_VERSION = .*/)[0];
/* The stub must be looked up at CALL time, not when the function is built:
   each case below swaps in a fresh store. */
const uc = new Function(
  "const localStorage = { getItem: (k) => globalThis.__ls.getItem(k), setItem: (k, v) => globalThis.__ls.setItem(k, v) };"
  + keyLine + chk + "return updateCheck;")();
const mk = () => { const m = {}; return { getItem: (k) => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); } }; };

globalThis.__ls = mk();
ok(uc("1.4.0").updated === false, "a first install is not reported as an update");
ok(uc("1.4.0").updated === false, "the same version twice is still not an update");
const r = uc("1.5.0");
ok(r.updated === true, "a changed version is an update");
ok(r.from === "1.4.0", "and it remembers what it came from");
ok(uc("1.5.0").updated === false, "the update is announced once, not on every later launch");

globalThis.__ls = mk();
ok(uc("").updated === false, "an unknown version never claims an update");

globalThis.__ls = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };
let threw = false;
try { uc("1.5.0"); } catch (e) { threw = true; }
ok(!threw, "storage being unavailable does not break boot");

/* ---- what the trader is told ---- */
ok(grab("showUpdateWelcome"), "a premium machine gets an 'update finished' screen instead of the key gate");
ok((grab("paintGate") || "").includes("upd.updated_gate"),
  "a free machine is told the update worked on the key screen itself");

const en = JSON.parse(fs.readFileSync("lang/en.json", "utf8"));
for (const l of ["en", "fa", "ar"]) {
  const d = JSON.parse(fs.readFileSync(`lang/${l}.json`, "utf8"));
  const missing = Object.keys(en.upd || {}).filter((k) => !(d.upd || {})[k])
    .concat(Object.keys(en.bt || {}).filter((k) => !(d.bt || {})[k]))
    .concat(["switch_theme", "switch_mode", "switch_lang", "switch_wait"].filter((k) => !(d.ui || {})[k]));
  ok(!missing.length, `${l}: every new string is translated${missing.length ? " (missing " + missing.join(", ") + ")" : ""}`);
}

/* ---- the transition veil ---- */
const morph = grab("morphTheme") || "";
ok(morph.includes("return new Promise") && morph.includes("Promise.resolve()"),
  "the veil waits for asynchronous work, so a language change stays covered until it is done");
ok(morph.includes("is-busy"), "it shows the loading card while it waits");
ok(/reduce/.test(morph) && morph.indexOf("is-busy") < morph.length,
  "reduced motion keeps the message and drops only the fades");
const setLang = grab("setLang") || "";
ok(setLang.includes("morphTheme("), "a language change goes through the veil");
ok(!/await API\.post\("\/api\/auth\/language"/.test(setLang),
  "telling the engine is no longer awaited in front of the repaint");
ok(setLang.includes("repaintForLanguage()"), "the desk repaints as soon as the pack is in");
ok(boot.includes('"aurion:i18n"'), "a late pack refresh repaints too");

console.log(fails ? `\nlive/update: ${fails} FAILED` : "\nlive/update: all checks passed");
process.exit(fails ? 1 : 0);
