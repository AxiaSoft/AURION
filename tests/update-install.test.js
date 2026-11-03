/**
 * Installing an update, in front of the person waiting for it.
 *
 * Three faults were reported from a real desk, and they are one fault
 * wearing three coats.
 *
 * Pressing install disabled a button and went quiet for as long as the
 * download took, then offered a "restart" button the user had to find.
 * Pressing that navigated away on a three-and-a-half second timer and
 * hoped the engine had come back. When it had not, the service worker
 * answered the reload out of its cache - including the previous
 * index.html, whose language token still matched the cached pack, so the
 * pack was never refreshed and every string the update had just shipped
 * rendered as its own key. That is literally what the user saw on screen:
 *
 *     upd.rate_limited upd.rate_retry upd.rate_token_hint
 *
 * three keys in a row where a sentence about rate limiting should have
 * been. The keys were present in all three packs the whole time. (The
 * third has since been removed with the token field it advertised; the
 * guard below pins that it went from the packs and the code together.)
 *
 * So the guards here are about sequence, not about appearance: the page
 * must not reload until the engine has answered, the pack cache must not
 * be dropped until the same is true, and an install with nothing to do
 * must say so rather than fail.
 *
 *     node tests/update-install.test.js
 */

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const APP = read("apps/web/js/app.js");
const I18NSRC = read("apps/web/js/i18n.js");
const CSS = read("apps/web/css/app.css");

const results = [];
const check = (name, ok, note) => {
  results.push({ name, ok: Boolean(ok) });
  console.log((ok ? "ok   " : "  x  ") + name + (note ? "  \u2014 " + note : ""));
};

/** Pull one function out of app.js by brace matching, so it can be run. */
function liftFn(src, name) {
  const at = src.indexOf("function " + name + "(");
  if (at < 0) throw new Error("no such function: " + name);
  const start = src.startsWith("async ", at - 6) ? at - 6 : at;
  let depth = 0, i = src.indexOf("{", at);
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error("unbalanced: " + name);
}

console.log("=== the install screen ===");

check(
  "there is an install screen, not just a disabled button",
  /function runUpdateInstall\(/.test(APP),
  "runUpdateInstall"
);

const run = APP.slice(APP.indexOf("async function runUpdateInstall("));
const runBody = run.slice(0, run.indexOf("\n/**", 10));

check(
  "pressing install opens it",
  /await runUpdateInstall\(upd\)/.test(APP),
  "the apply button hands over to the screen"
);

check(
  "the old hand-rolled restart button is gone from the install flow",
  !/upd-restart['"]\)[\s\S]{0,120}restartSystem\(\)/.test(APP),
  "nothing left for the user to find and press"
);

check(
  "the browser's own confirm box is not used for the install",
  !/if\(!confirm\(I18N\.t\('upd\.confirm'\)/.test(APP),
  "askConfirm, like every other destructive action on the desk"
);

check(
  "it says which steps it is working through",
  /upd\.inst_download/.test(runBody) && /upd\.inst_write/.test(runBody)
    && /upd\.inst_restart/.test(runBody) && /upd\.inst_wait/.test(runBody),
  "fetching, replacing, restarting, waiting"
);

check(
  "it restarts the system itself",
  /API\.post\("\/api\/host\/restart"/.test(runBody),
  "no second button"
);

/* The ordering that matters. */
const iRestart = runBody.indexOf('/api/host/restart');
const iWait = runBody.indexOf("waitForEngine(");
const iClear = runBody.indexOf("I18N.clearCache()");
/* The failure branch offers its own reload button, so it is the LAST
   one - the success path - that has to come after the wait. */
const iReload = runBody.lastIndexOf("location.replace");

check(
  "it waits for the engine after asking for the restart",
  iRestart > 0 && iWait > iRestart,
  "restart, then wait"
);

check(
  "and only reloads once the engine has answered",
  iWait > 0 && iReload > iWait,
  "this is the fix for the keys on screen"
);

check(
  "the stale language pack is dropped only after the engine answers",
  iClear > iWait && iClear < iReload,
  "an empty cache with nothing to fetch would be worse than a stale one"
);

check(
  "a desk that never comes back is told so, with a way out",
  /upd\.inst_failed_wait/.test(runBody) && /upd-inst-reload/.test(runBody),
  "rather than spinning forever"
);

console.log("\n=== waiting for the engine, actually run ===");
{
  /* The function is lifted and driven, because its whole value is in a
     sequence that cannot be read off the source: it has to refuse to
     answer "back" until it has seen the server go away. */
  const src = liftFn(APP, "waitForEngine");
  const mk = (answers) => {
    const log = [];
    const ctx = {
      console,
      /* Time is removed: the real one waits two and a half seconds
         before the first poll and over a second between each. */
      setTimeout: (fn) => { fn(); return 0; },
      Date: { now: () => log.length * 1200 },
      fetch: async () => {
        const a = answers[Math.min(log.length, answers.length - 1)];
        log.push(a);
        if (a === "down") throw new Error("ECONNREFUSED");
        return { ok: true };
      },
      window: {},
    };
    vm.createContext(ctx);
    vm.runInContext(src + "\nwindow.w = waitForEngine;", ctx);
    return { ctx, log };
  };

  const down = mk(["down", "down", "down", "up"]);
  down.ctx.window.w(120000).then((ok) => {
    check("it answers 'back' once the server has gone and returned", ok === true,
      "the new process, not the old one finishing its reply");
  });

  const never = mk(["down"]);
  never.ctx.window.w(20000).then((ok) => {
    check("a server that never comes back times out instead of hanging", ok === false,
      "and the screen offers a reload");
  });

  const always = mk(["up"]);
  always.ctx.window.w(120000).then((ok) => {
    check("a server that never drops is accepted after a grace period", ok === true,
      "a restart quicker than the poll gap must not deadlock the desk");
  });
}

check(
  "health is asked without the cache in the way",
  /cache: "no-store"/.test(APP.slice(APP.indexOf("async function waitForEngine"))),
  "a service worker must not answer 'fine' from before the restart"
);

check(
  "it polls the one endpoint that needs no session",
  /\/api\/health\?t=/.test(APP),
  "the engine comes back before any login does"
);

console.log("\n=== already on the latest version ===");

check(
  "an install with nothing to do says so on the screen",
  /ar\.already_current/.test(runBody) && /upd\.already_current/.test(runBody),
  "no error, no restart"
);

check(
  "and it does not restart the machine to do nothing",
  runBody.indexOf("ar.already_current") < iRestart,
  "the already-current branch returns before the restart"
);

check(
  "pressing check when current already said so",
  /upd\.uptodate/.test(APP),
  "the regression this must not undo"
);

console.log("\n=== a failed install reads as a sentence ===");

check(
  "the failure goes through the same wording as the check box",
  /updateErrorText\(\{ ok: false, \.\.\.\(ar \|\| \{\}\) \}\)/.test(runBody),
  "so a rate limit reads as a rate limit, not as a code"
);

check(
  "and says how far it got",
  /upd\.install_partial/.test(runBody) && /ar\.applied_count/.test(runBody),
  "a part-finished install is a state the user needs to know about"
);

check(
  "updateErrorText still translates each part rather than naming keys",
  /text \+= " " \+ I18N\.t\("upd\.rate_retry"\)/.test(APP)
    && /I18N\.t\("upd\.rate_limited"\)/.test(APP),
  "the reported symptom was never the call site"
);

console.log("\n=== the pack cache ===");

check(
  "i18n can be told to forget its cached packs",
  /clearCache\(\) \{/.test(I18NSRC),
  "I18N.clearCache"
);

check(
  "it forgets every language, not only the active one",
  /\["en", "fa", "ar"\]/.test(I18NSRC.slice(I18NSRC.indexOf("clearCache()"), I18NSRC.indexOf("clearCache()") + 400)),
  "switching language after an update must not restore a stale pack"
);

check(
  "clearing the cache cannot throw and take the reload with it",
  /catch \(e\) \{ \/\* private mode/.test(I18NSRC.slice(I18NSRC.indexOf("clearCache()"), I18NSRC.indexOf("clearCache()") + 500)),
  "private mode has no localStorage"
);

check(
  "the token the pack cache is keyed on still changes with the packs",
  read("apps/web/index.html").includes('i18n.js?v=lang'),
  "scripts/sync-lang-token.mjs"
);

console.log("\n=== every string it shows exists in every language ===");
{
  const packs = {};
  for (const code of ["en", "fa", "ar"]) packs[code] = JSON.parse(read(`lang/${code}.json`));
  const get = (pack, key) => key.split(".").reduce((n, p) => (n && typeof n === "object" ? n[p] : undefined), pack);

  const used = [...new Set(
    [...runBody.matchAll(/I18N\.t\("([a-z0-9_]+\.[a-z0-9_]+)"/g)].map((m) => m[1])
  )];
  check("the screen uses translated strings at all", used.length >= 8, used.length + " keys");

  let missing = [];
  for (const key of used) {
    for (const code of ["en", "fa", "ar"]) {
      if (typeof get(packs[code], key) !== "string") missing.push(code + ":" + key);
    }
  }
  check("and every one of them resolves in en, fa and ar", missing.length === 0,
    missing.length ? missing.join(", ") : "no key can render as itself");

  /* The exact shape of the reported bug: a placeholder that differs
     between packs leaves "{n}" sitting in the sentence. */
  let mismatched = [];
  for (const key of [...used, "upd.rate_retry", "upd.inst_changed", "upd.install_partial"]) {
    const sets = ["en", "fa", "ar"].map((c) => {
      const v = get(packs[c], key);
      return typeof v === "string" ? [...v.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",") : null;
    });
    if (sets[0] !== null && new Set(sets).size > 1) mismatched.push(key);
  }
  check("the placeholders match across the three packs", mismatched.length === 0,
    mismatched.length ? mismatched.join(", ") : "{n}, {total}, {time}");

  /* The keys from the report, pinned by name. The third of them,
     upd.rate_token_hint, has since been removed along with the token
     field it advertised - so what is pinned about that one is that it
     is gone from the packs AND from the code, together. */
  for (const key of ["upd.rate_limited", "upd.rate_retry"]) {
    const ok = ["en", "fa", "ar"].every((c) => typeof get(packs[c], key) === "string");
    check("the reported key " + key + " is present in all three packs", ok);
  }
  check(
    "the token hint is gone from every pack, not just from the code",
    ["en", "fa", "ar"].every((c) => get(packs[c], "upd.rate_token_hint") === undefined)
      && !/rate_token_hint/.test(read("apps/web/js/app.js")),
    "a string nothing renders is a string nobody maintains"
  );
  check(
    "and the update panel offers no token field to point at",
    !/upd-token/.test(read("apps/web/js/app.js"))
      && ["en", "fa", "ar"].every((c) => get(packs[c], "upd.token") === undefined),
    "the desk holds no secret of its own"
  );
}

console.log("\n=== how it looks ===");
{
  const bare = CSS.replace(/\/\*[\s\S]*?\*\//g, "");
  const rule = (sel) => {
    const out = [];
    const re = new RegExp("(?:^|[}])\\s*" + sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\{([^}]*)\\}", "g");
    let m;
    while ((m = re.exec(bare))) out.push(m[1]);
    return out;
  };

  check("the screen covers the desk", rule(".upd-install").some((b) => /position:fixed/.test(b) && /inset:0/.test(b)));
  check(
    "and sits above the 'update finished' screen it hands over to",
    rule(".upd-install").some((b) => /z-index:1000[1-9]/.test(b)),
    "10001 against 10000"
  );
  check(
    "it is painted in fixed colours, not theme tokens",
    rule(".upd-install").some((b) => /#06070b/.test(b)),
    "the update replaces the stylesheet underneath it while it is up"
  );
  check(
    "a spinner that cannot be stopped is not forced on anyone",
    /prefers-reduced-motion:reduce\)\{[^}]*\.upd-install-spin\{animation:none/.test(bare.replace(/\s+/g, "")),
    "reduced motion"
  );
  check(
    "the steps read in the reading direction, whichever it is",
    rule(".upd-install-steps").some((b) => /text-align:start/.test(b)),
    "not text-align:left"
  );
  check(
    "the step list is a list",
    /<ol class="upd-install-steps">/.test(APP),
    "and the screen reports itself to a screen reader"
  );
  check(
    "the screen announces itself",
    /role", "status"/.test(runBody) && /aria-live", "polite"/.test(runBody),
    "a blind user is waiting for the same restart"
  );
}

const failed = results.filter((r) => !r.ok);
setTimeout(() => {
  const f2 = results.filter((r) => !r.ok);
  console.log(`\nupdate-install: ${results.length - f2.length} of ${results.length}`);
  if (f2.length) process.exit(1);
}, 50);
void failed;
