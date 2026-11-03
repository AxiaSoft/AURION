/**
 * End of support: five days after a newer version is published, the old
 * one stops working.
 *
 * The thing being guarded here is a lockout, which is the most hostile
 * behaviour this product has, so most of these checks are not about
 * whether it fires. They are about whether it fires ONLY when it should,
 * and whether the way out stays open when it does.
 *
 * Four properties the implementation is built on, each pinned below:
 *
 *   1. The clock starts at PUBLICATION, not at discovery. A machine that
 *      was switched off for a week must not win a fresh five days for
 *      having missed the announcement, so the deadline is derived from
 *      latest.published_at and never from last_check.
 *
 *   2. It fails OPEN. No update, no date, an unreadable state file, a
 *      check that never succeeded - every one of those leaves the desk
 *      working. A lock is only ever the conclusion of a dated fact.
 *
 *   3. The exit is never barred. The update routes, the restart, the
 *      kill switch and "close everything" keep answering while locked.
 *      A maintenance policy that can trap somebody inside an open
 *      position is not a maintenance policy, it is a hazard.
 *
 *   4. The robot stops with the desk. A locked screen does not stop a
 *      separate engine process, so expiry disarms auto-trading - and
 *      does it again on every boot, so restarting is not a way around.
 *
 *     node tests/support-window.test.js
 */

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

const SUP = require("../backend/src/support-window.js");
const SUPSRC = read("backend/src/support-window.js");
const INDEX = read("backend/src/index.js");
const UPDATER = read("backend/src/updater.js");
const APP = read("apps/web/js/app.js");
const APISRC = read("apps/web/js/api.js");
const CSS = read("apps/web/css/app.css");

const results = [];
const check = (name, ok, note) => {
  results.push({ name, ok: Boolean(ok) });
  console.log((ok ? "ok   " : "  x  ") + name + (note ? "  \u2014 " + note : ""));
};

const DAY = 24 * 60 * 60 * 1000;
const at = (iso) => Date.parse(iso);
const offered = (publishedIso, extra) => ({
  last_check: "2030-01-01T00:00:00Z",
  update_available: true,
  latest: { version: "9.9.9", published_at: publishedIso, ...(extra || {}) },
});

/* ------------------------------------------------------------------ */
console.log("=== the policy is five days, and it is one number ===");

check(
  "the grace period is five days",
  SUP.SUPPORT_GRACE_DAYS === 5,
  "the one number the policy is made of"
);
check(
  "and the millisecond form is derived from it, not typed twice",
  SUP.GRACE_MS === SUP.SUPPORT_GRACE_DAYS * DAY
    && /GRACE_MS\s*=\s*SUPPORT_GRACE_DAYS\s*\*\s*DAY_MS/.test(SUPSRC),
  "a second literal would let the two drift apart"
);
check(
  "every status carries the number with it",
  SUP.evaluate(null, at("2030-01-01T00:00:00Z")).grace_days === 5
    && SUP.evaluate(offered("2030-01-01T00:00:00Z"), at("2030-01-02T00:00:00Z")).grace_days === 5,
  "so the screen states the policy the server is enforcing, not its own copy"
);

/* ------------------------------------------------------------------ */
console.log("\n=== the clock starts when the update was published ===");

{
  const now = at("2030-01-10T00:00:00Z");
  const fresh = SUP.evaluate(offered("2030-01-09T00:00:00Z"), now);
  const stale = SUP.evaluate(offered("2030-01-01T00:00:00Z"), now);
  check("one day after publication, still supported", fresh.supported && !fresh.expired);
  check("nine days after publication, support has ended", stale.expired && !stale.supported);
  check(
    "the deadline is publication plus five days",
    fresh.deadline === new Date(at("2030-01-14T00:00:00Z")).toISOString()
  );
  check(
    "a machine that was switched off does not get a fresh five days",
    SUP.evaluate(
      { last_check: "2030-01-10T00:00:00Z", update_available: true,
        latest: { version: "9.9.9", published_at: "2030-01-01T00:00:00Z" } },
      now
    ).expired,
    "the deadline is read from the release date, not from when this desk noticed"
  );
  check(
    "last_check is never used to compute the deadline",
    !/last_check/.test(SUPSRC.replace(/\/\*[\s\S]*?\*\//g, "")),
    "the only date the policy may read is the publication date"
  );
}

{
  /* The boundary, from both sides and exactly on it. */
  const pub = "2030-03-01T12:00:00Z";
  const deadline = at(pub) + 5 * DAY;
  check(
    "one second before the deadline it is still supported",
    SUP.evaluate(offered(pub), deadline - 1000).supported
  );
  check(
    "at the deadline it has expired",
    SUP.evaluate(offered(pub), deadline).expired,
    "ms_left <= 0, so the instant itself is over the line"
  );
  check(
    "days_left counts down and never goes negative",
    SUP.evaluate(offered(pub), at(pub)).days_left === 5
      && SUP.evaluate(offered(pub), deadline + 99 * DAY).days_left === 0
  );
  check(
    "the last day is reported in hours",
    SUP.evaluate(offered(pub), deadline - 9 * 60 * 60 * 1000).hours_left === 9,
    "\"1 day\" is not a useful thing to tell somebody with nine hours left"
  );
}

/* ------------------------------------------------------------------ */
console.log("\n=== it fails open ===");

check(
  "no update known: supported",
  SUP.evaluate({ last_check: "2030-01-01T00:00:00Z", update_available: false }, Date.now()).supported
);
check(
  "no state file at all: supported",
  SUP.evaluate(null, Date.now()).supported && SUP.evaluate(undefined, Date.now()).supported,
  "a desk that has never managed to check must keep working"
);
check(
  "update_available true but no release attached: supported",
  SUP.evaluate({ update_available: true, latest: null }, Date.now()).supported
);
check(
  "an update with no usable date is never enforced",
  (() => {
    const st = SUP.evaluate(offered(""), Date.now());
    return st.supported && st.reason === "no_release_date" && st.deadline === "";
  })(),
  "guessing a publication date would mean inventing the deadline"
);
check(
  "a garbage date is treated as no date, not as the epoch",
  SUP.evaluate(offered("not a date"), Date.now()).supported,
  "Date.parse of nonsense is NaN; falling back to 0 would expire every desk at once"
);
check(
  "a release dated in the future is supported",
  SUP.evaluate(offered(new Date(Date.now() + 30 * DAY).toISOString()), Date.now()).supported
);
check(
  "build_date is the fallback when published_at is missing",
  SUP.evaluate(
    { update_available: true, latest: { version: "9.9.9", build_date: "2030-01-01" } },
    at("2030-01-20T00:00:00Z")
  ).expired
);
check(
  "a read failure cannot lock the desk",
  /catch\s*{[\s\S]{0,120}return next\(\);/.test(SUPSRC),
  "the gate calls next() when the status cannot be computed"
);

/* ------------------------------------------------------------------ */
console.log("\n=== the way out stays open ===");

const allowed = [
  ["POST", "/system/update/check"],
  ["POST", "/system/update/apply"],
  ["GET", "/system/update/progress"],
  ["GET", "/system/update/state"],
  ["GET", "/system/update/settings"],
  ["GET", "/system/support"],
  ["POST", "/host/restart"],
  ["POST", "/auth/language"],
  ["GET", "/profile"],
  ["GET", "/license"],
];
for (const [m, p] of allowed) {
  check(`${m} ${p} still answers while locked`, SUP.isAllowedWhileExpired(m, p));
}
check(
  "closing every position still answers while locked",
  SUP.isAllowedWhileExpired("POST", "/flatten") && SUP.isAllowedWhileExpired("POST", "/kill"),
  "a policy must not be able to trap somebody inside a trade"
);

const blocked = [
  ["GET", "/snapshot"],
  ["POST", "/order"],
  ["POST", "/strategies/apply"],
  ["POST", "/strategies/toggle"],
  ["POST", "/auto"],
  ["GET", "/history"],
  ["GET", "/candles"],
  ["POST", "/config"],
  ["POST", "/backtest"],
  ["GET", "/users"],
];
for (const [m, p] of blocked) {
  check(`${m} ${p} is refused while locked`, !SUP.isAllowedWhileExpired(m, p));
}
check(
  "a trailing slash does not smuggle a blocked route past the list",
  !SUP.isAllowedWhileExpired("POST", "/order/"),
  "the path is normalised before it is matched"
);
check(
  "a prefix match cannot be widened by a lookalike path",
  !SUP.isAllowedWhileExpired("GET", "/system/updatesomething")
    && !SUP.isAllowedWhileExpired("GET", "/licenses"),
  "/system/update/ matches with its slash; /license matches exactly"
);

/* ------------------------------------------------------------------ */
console.log("\n=== the gate itself ===");

function runGate(reqPath, method, state) {
  const calls = { next: 0, status: 0, body: null, expired: 0 };
  const mw = SUP.middleware({
    status: () => SUP.evaluate(state, Date.now()),
    onExpired: () => { calls.expired++; },
  });
  const req = { method, path: reqPath };
  const res = {
    locals: {},
    status(code) { calls.status = code; return this; },
    json(b) { calls.body = b; return this; },
  };
  mw(req, res, () => { calls.next++; });
  calls.locals = res.locals;
  return calls;
}

{
  const live = offered(new Date(Date.now() - DAY).toISOString());
  const dead = offered(new Date(Date.now() - 30 * DAY).toISOString());

  const ok = runGate("/snapshot", "GET", live);
  check("inside the grace period every request passes", ok.next === 1 && !ok.status);
  check(
    "and the status is handed to the route that follows",
    ok.locals.support && ok.locals.support.update_available === true,
    "res.locals.support, so the snapshot can carry the countdown for free"
  );

  const no = runGate("/snapshot", "GET", dead);
  check("once expired a blocked request is refused", no.next === 0 && no.status === 403);
  check(
    "the refusal names itself",
    no.body && no.body.ok === false && no.body.error === "support_expired"
  );
  check(
    "and carries the facts the lock screen needs",
    no.body && no.body.support && no.body.support.expired === true
      && no.body.support.grace_days === 5 && no.body.support.deadline,
    "the request that would have fetched them is one of the ones being refused"
  );

  const out = runGate("/system/update/apply", "POST", dead);
  check("the update route is still served when expired", out.next === 1 && !out.status);

  check("expiry notifies the caller so it can stop the robot", no.expired === 1 && out.expired === 1);
  check("and nothing is notified while still supported", ok.expired === 0);
}

/* ------------------------------------------------------------------ */
console.log("\n=== wired into the desk ===");

check(
  "the gate is mounted on the guarded router",
  /guarded\.use\(support\.middleware\(/.test(INDEX)
);
check(
  "after authentication, so the 403 is for a known user",
  INDEX.indexOf("guarded.use(auth.middleware)") < INDEX.indexOf("guarded.use(support.middleware("),
);
check(
  "before any route is declared on that router",
  INDEX.indexOf("guarded.use(support.middleware(") < INDEX.indexOf('guarded.get("/snapshot"'),
  "a gate declared after a route never sees that route's traffic"
);
check(
  "expiry disarms auto-trading",
  /engine\.proxy\("POST", "\/v1\/auto", \{ enabled: false \}\)/.test(INDEX),
  "a locked screen does not stop a separate engine process"
);
check(
  "and does it once per process, not once per request",
  /if \(tradingHaltedForSupport\) return;\s*tradingHaltedForSupport = true;/.test(INDEX)
);
check(
  "halting never blocks the response",
  /engine\.proxy\("POST", "\/v1\/auto"[^\n]*\)\.catch\(/.test(INDEX),
  "not awaited, and a failure is swallowed"
);
{
  /* The watch must not be conditional on the user's auto-check switch:
     enforcement cannot depend on a setting owned by the thing being
     enforced upon. */
  const atWatch = INDEX.indexOf("async function supportWatchTick");
  const body = INDEX.slice(atWatch, INDEX.indexOf("\n}", atWatch));
  check(
    "the support clock is wound by its own timer",
    atWatch > 0 && /setInterval\(\(\) => \{ supportWatchTick\(\); \}, SUPPORT_WATCH_MS\)/.test(INDEX)
  );
  check(
    "which runs whether or not the user enabled automatic checks",
    !/auto_check_enabled/.test(body)
      && !/startAutoChecker[\s\S]{0,200}supportWatchTick/.test(INDEX),
    "a lockout the user can switch off is not a lockout"
  );
  check(
    "and it re-disarms the robot on an expired desk at boot",
    /if \(support\.status\(\)\.expired\) haltTradingForSupport\(\)/.test(body),
    "otherwise restarting the machine is a way to keep trading behind the lock"
  );
}
check(
  "the countdown rides on the snapshot the desk already polls",
  /data\.support = res\.locals\.support \|\| support\.status\(\)/.test(INDEX),
  "no extra request for a number that changes once a day"
);
{
  /* Scoped to the route body. A fixed character window runs straight
     into the next route, whose own role check would answer this. */
  const start = INDEX.indexOf('guarded.get("/system/support"');
  const body = start < 0 ? "" : INDEX.slice(start, INDEX.indexOf("\n});", start));
  check(
    "and there is a route to ask directly, open to every role",
    /support\.status\(\)/.test(body) && !/role !==/.test(body) && !/requireRole/.test(body),
    "the lock falls on the trader too; they must be able to ask why"
  );
}

check(
  "a successful install clears the stored \"update available\"",
  /writeSecure\(UPDATE_STATE_FILE, \{[\s\S]{0,200}update_available: false/.test(UPDATER),
  "otherwise the lock would stay shut over an update that has just been installed"
);
{
  const applyAt = UPDATER.indexOf("async function applyUpdate(");
  const clearAt = UPDATER.indexOf("update_available: false", applyAt);
  const okAt = UPDATER.indexOf("return {\n      ok: true,", applyAt);
  const failAt = UPDATER.indexOf("ok: false, error: e.message", applyAt);
  check(
    "and it is cleared on the success path, not the failure one",
    applyAt > 0 && okAt > applyAt && clearAt > applyAt && clearAt < okAt && failAt > okAt,
    "a part-applied install must keep saying an update is available"
  );
}

/* ------------------------------------------------------------------ */
console.log("\n=== what the user sees ===");

check(
  "a 403 of this kind raises an event the desk can act on",
  /error === "support_expired"[\s\S]{0,260}aurion:support-expired/.test(APISRC),
  "whatever request was in flight becomes the trigger for the screen"
);
check(
  "the event carries the server's own facts",
  /new CustomEvent\("aurion:support-expired", \{ detail: json\.support/.test(APISRC)
);
check(
  "the desk listens for it",
  /addEventListener\("aurion:support-expired"/.test(APP)
);
check(
  "and reads the countdown off the snapshot poll as well",
  /if \(r && r\.support\) applySupportState\(r\.support\)/.test(APP)
);
check(
  "there is a locked screen",
  /function showSupportLock\(/.test(APP) && /id = "sup-lock"/.test(APP)
);
{
  const atFn = APP.indexOf("function showSupportLock(");
  const body = APP.slice(atFn, APP.indexOf("\nasync function boot()", atFn));
  check(
    "it cannot be dismissed",
    !/Escape/.test(body) && !/sup-lock-close/.test(body) && !/host\.remove\(\)/.test(body),
    "the desk behind it answers 403 to almost everything; closing it would only show a broken desk"
  );
  check(
    "it offers the install",
    /checkForUpdate\(\)/.test(body) && /runUpdateInstall\(res\.latest\)/.test(body)
  );
  check(
    "it offers to close every position",
    /await flattenAll\("support_expired"\)/.test(body),
    "the one route besides the update that stays open, and the reason it does"
  );
  check(
    "through the desk's single flatten path, not a second copy of it",
    !/API\.post\("\/api\/flatten"/.test(body) && !/window\.confirm/.test(body),
    "flattenAll already confirms, reports and refreshes"
  );
  check(
    "a non-owner is told who to ask instead of given a button that will fail",
    /isOwner/.test(body) && /sup\.eos_owner_only/.test(body),
    "installing is owner-only on the server"
  );
  check(
    "but an unknown role still gets the button",
    /const knownRole = Boolean\(S\.user && S\.user\.role\);/.test(body)
      && /const isOwner = !knownRole \|\|/.test(body),
    "this screen can appear before the profile has loaded; the owner must not be stranded by it"
  );
  check(
    "and a refusal from the server replaces it with the note",
    /res\.error === "owner_only" \|\| res\.error === "forbidden"[\s\S]{0,160}sup\.eos_owner_only/.test(body)
  );
  check(
    "it says the robot has been stopped",
    /sup\.eos_halted/.test(body),
    "the single most important consequence of the lock"
  );
  check(
    "and it states both versions and the date support ended",
    /sup\.eos_installed/.test(body) && /sup\.eos_latest/.test(body) && /sup\.eos_deadline/.test(body)
  );
  check(
    "an already-current machine reloads rather than silently unlocking",
    /res\.available[\s\S]{0,260}location\.replace/.test(body),
    "the lock was standing on a stale answer; a reload re-reads everything"
  );
}
{
  const atFn = APP.indexOf("function paintSupportBar(");
  const body = APP.slice(atFn, APP.indexOf("\n/**", atFn));
  check("there is a countdown bar during the grace period", atFn > 0);
  check(
    "it is dismissible while there is more than a day left",
    /S\._supBarOff = true/.test(body),
    "nothing is broken yet, and a trader working a position should not be nagged"
  );
  check(
    "and stops being dismissible inside the last day",
    /const urgent = [^\n]*hours_left[^\n]*<= 24/.test(body)
      && /if \(S\._supBarOff && !urgent\)/.test(body)
      && /\$\{urgent \? "" :/.test(body),
    "on the last day the warning has stopped being advice"
  );
  check(
    "it disappears when there is nothing to warn about",
    /if \(!st \|\| !st\.update_available \|\| !st\.deadline\) \{[\s\S]{0,120}existing\.remove\(\)/.test(body)
  );
}
check(
  "the policy is stated in the update panel, before it ever bites",
  /id="upd-policy"[\s\S]{0,140}sup\.policy/.test(APP)
);
check(
  "the number shown is the server's, not a second copy of the policy",
  /function supportGraceDays\(\)/.test(APP) && !/sup\.policy", \{ n: fmtNum\(5/.test(APP)
);

/* ------------------------------------------------------------------ */
console.log("\n=== it stacks in the right order ===");

function ruleFor(sel) {
  const clean = CSS.replace(/\/\*[\s\S]*?\*\//g, "");
  const out = [];
  const re = new RegExp("(?:^|[}])\\s*" + sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\{([^}]*)\\}", "g");
  let m;
  while ((m = re.exec(clean))) out.push(m[1]);
  return out;
}
const zOf = (sel) => {
  const m = ruleFor(sel).join(";").match(/z-index:\s*(\d+)/);
  return m ? Number(m[1]) : null;
};
check(
  "the install screen sits on top of the locked screen",
  zOf(".sup-lock") !== null && zOf(".upd-install") !== null && zOf(".sup-lock") < zOf(".upd-install"),
  "pressing \"update now\" must show progress, not hide it"
);
check(
  "the countdown bar sits under the toasts and over the desk",
  zOf(".sup-bar") !== null && zOf(".toast-wrap") !== null
    && zOf(".sup-bar") < zOf(".toast-wrap") && zOf(".sup-bar") > 1,
  "it must never cover an answer the user asked for"
);
check(
  "the locked screen stops the page behind it scrolling",
  /html\.sup-locked\{[^}]*overflow:hidden/.test(CSS.replace(/\s*\n\s*/g, ""))
    || /html\.sup-locked\{overflow:hidden\}/.test(CSS)
);
check(
  "both animations are dropped under reduced motion",
  /@media \(prefers-reduced-motion:reduce\)\{[^}]*\.sup-bar\{animation:none\}/.test(
    CSS.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s*\n\s*/g, "")
  )
);
check(
  "every button on the locked screen is reachable by thumb",
  /\.sup-lock-actions \.btn\{min-block-size:44px\}/.test(CSS.replace(/\s*\n\s*/g, "")),
  "44px, like everything else on this desk"
);
check(
  "the bar steps aside for the settings sheet it points at",
  /html\.set-sheet-open \.sup-bar\{/.test(CSS)
);

/* ------------------------------------------------------------------ */
console.log("\n=== it speaks all three languages ===");

const packs = {};
for (const lang of ["en", "fa", "ar"]) packs[lang] = JSON.parse(read(`lang/${lang}.json`));
const needed = [
  "warn_days", "warn_hours", "warn_body", "warn_action", "warn_dismiss",
  "eos_title", "eos_body", "eos_installed", "eos_latest", "eos_latest_head",
  "eos_deadline", "eos_halted", "eos_action", "eos_checking", "eos_already",
  "eos_owner_only", "eos_flatten", "eos_flatten_confirm", "eos_flatten_done",
  "eos_flatten_fail", "policy",
];
for (const lang of ["en", "fa", "ar"]) {
  const sup = packs[lang].sup || {};
  const missing = needed.filter((k) => !sup[k] || !String(sup[k]).trim());
  check(`${lang} carries every sup.* string`, missing.length === 0, missing.join(", "));
}
check(
  "the three packs agree on exactly which keys exist",
  ["fa", "ar"].every((l) =>
    JSON.stringify(Object.keys(packs[l].sup).sort()) === JSON.stringify(Object.keys(packs.en.sup).sort())),
  "a key present in one pack and absent in another renders as its own name"
);
check(
  "the placeholders survive translation",
  ["en", "fa", "ar"].every((l) =>
    packs[l].sup.warn_days.includes("{n}")
    && packs[l].sup.warn_hours.includes("{n}")
    && packs[l].sup.warn_body.includes("{date}")
    && packs[l].sup.eos_body.includes("{n}")
    && packs[l].sup.policy.includes("{n}")),
  "a dropped {n} prints the sentence with the number missing"
);
check(
  "no sup.* string names an instrument or a price",
  !JSON.stringify(packs).match(/sup[\s\S]{0,4000}?(EURUSD|XAUUSD|GBPUSD)/),
);

const failed = results.filter((r) => !r.ok);
console.log(`\nsupport-window: ${results.length - failed.length} of ${results.length}`);
if (failed.length) process.exit(1);
