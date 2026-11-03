/**
 * Updating from GitHub.
 *
 * The product used to update from admin/update-server: a service someone
 * had to be running for a fix to reach anyone. The source of truth was
 * already on GitHub, so the desk reads it directly.
 *
 * Nothing here touches the network. What is worth guarding is not that
 * an HTTP call works - it either does or the panel says why - but the two
 * things that are silent when wrong:
 *
 *   which files an update is allowed to write, and
 *   whether a blob SHA is computed the way git computes it.
 *
 * The first is a security boundary: the file list arrives from outside
 * and drives a write loop. The second is the entire comparison - get it
 * wrong by one byte of framing and every file looks changed forever, or
 * none ever do, and both failures look like a working updater.
 *
 *     node tests/github-update.test.js
 */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const results = [];
const say = (ok, m) => { results.push(Boolean(ok)); console.log((ok ? "PASS  " : "FAIL  ") + m); };

const gh = require(path.join(ROOT, "backend", "src", "github-update.js"));
const updaterSrc = fs.readFileSync(path.join(ROOT, "backend", "src", "updater.js"), "utf8");

console.log("=== a blob SHA is the one git would give ===");
{
  /* Checked against git itself rather than against a constant, so the
     test cannot drift into agreeing with a wrong implementation. */
  const sample = path.join(ROOT, "package.json");
  const mine = gh.localBlobSha("package.json");
  let theirs = "";
  try {
    theirs = execFileSync("git", ["hash-object", sample], { cwd: ROOT, encoding: "utf8" }).trim();
  } catch { /* git absent */ }
  if (theirs) say(mine === theirs, `package.json: ${String(mine).slice(0, 12)} == git hash-object`);
  else console.log("SKIP  git not available for cross-check");

  say(gh.blobSha(Buffer.from("")) === "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391",
      "the empty blob hashes to git's well-known empty-blob SHA");
  say(gh.blobSha(Buffer.from("hello\n")) === "ce013625030ba8dba906f756967f9e9ca394464a",
      'blob "hello\\n" matches git\'s documented value');
  say(gh.localBlobSha("no/such/file") === null, "a missing file hashes to null, not to a throw");
}

console.log("\n=== an update may only write the product ===");
{
  const ship = [
    "apps/web/js/app.js", "apps/web/css/app.css", "apps/web/index.html",
    "lang/fa.json", "backend/src/index.js", "engine/aurion/api/server.py",
    "engine/ea/AurionBridge.mq5", "scripts/copy-ea.ps1",
    "config/aurion.factory.json",
  ];
  for (const p of ship) say(gh.isShippable(p), `ships ${p}`);

  /* The machine's own state. A release that overwrote any of these would
     take the user's licence, logins or broker credentials with it. */
  const sacred = ["data/users.json", "data/license", "data/aurion.access.db",
                  "config/aurion.json", "config/news_calendar.csv"];
  for (const p of sacred) {
    say(gh.isProtected(p), `${p} is protected`);
    say(!gh.isShippable(p), `  and therefore never written by an update`);
  }

  /* Not part of a running installation. These exist in the repository
     and must not land on a trading machine. */
  const notShipped = ["tests/app.test.js", "apps/web/js/chart-ui.test.cjs",
                      "installer/build.ps1", "admin/update-server/src/index.js",
                      ".github/workflows/ci.yml", "README.md", "docs/x.md",
                      "engine/aurion/__pycache__/x.pyc", "backend/src/node_modules/x/i.js",
                      "apps/web/.env", "backend/src/x.log"];
  for (const p of notShipped) say(!gh.isShippable(p), `skips ${p}`);

  say(!gh.isShippable("../../etc/passwd") && !gh.isShippable(""),
      "a traversal path and an empty path are both refused");
}

console.log("\n=== the apply loop holds to that same set ===");
{
  /* The file list is read back from a state file on disk. If only the
     check filtered, anything that could write that file could name any
     path in the tree and have it copied over the installation. */
  say(/kind === "github" && !github\.isShippable\(p\)/.test(updaterSrc),
      "applyUpdate re-applies isShippable to every file before writing it");
  say(/path_traversal_blocked/.test(updaterSrc),
      "and still resolves each target under ROOT before writing");
  say(/if \(p === "data" \|\| p\.startsWith\("data\/"\)\) return false;/.test(updaterSrc),
      "the data\\/ config exclusions survive in the apply filter too");
}

console.log("\n=== GitHub is the default channel ===");
{
  say(typeof updaterSrc === "string" && /function getSourceKind\(/.test(updaterSrc),
      "updater exposes an explicit channel choice");
  const updater = require(path.join(ROOT, "backend", "src", "updater.js"));
  say(typeof updater.getSourceKind === "function", "and exports it");

  /* The decisive one: an installation whose config predates this change
     has no `source` key at all, and must land on GitHub rather than on a
     dead update server. */
  const noKey = /No explicit choice: GitHub/.test(updaterSrc) && /return "github";\s*\n\s*\} catch/.test(updaterSrc);
  say(noKey, "a config with no update_server.source falls through to GitHub");
  say(/if \(kind === "server" \|\| kind === "update_server"\) return "server";/.test(updaterSrc),
      'the private update server is still reachable by setting source="server"');

  const factory = JSON.parse(fs.readFileSync(path.join(ROOT, "config", "aurion.factory.json"), "utf8"));
  say(factory.update_server && factory.update_server.source === "github",
      "the shipped factory config says github");
  const g = factory.update_server && factory.update_server.github;
  say(g && g.owner === "AxiaSoft" && g.repo === "AURION",
      `and names the repository: ${g && g.owner}/${g && g.repo} (branch pinned in code)`);
}

console.log("\n=== the repository to ask ===");
{
  const d = gh.getSource({});
  say(d.owner === "AxiaSoft" && d.repo === "AURION" && d.branch === "main",
      `an empty config still resolves to ${d.owner}/${d.repo}@${d.branch}`);
  const o = gh.getSource({ update_server: { github: { owner: "x", repo: "y" } } });
  say(o.owner === "x" && o.repo === "y", "a configured fork overrides owner and repo");
  say(gh.describe(d) === "github.com/AxiaSoft/AURION@main",
      `the panel is told where it checked: "${gh.describe(d)}"`);
  say(!/[A-Za-z0-9_]{30,}/.test(JSON.stringify(gh.getSource({}))),
      "no credential is baked into the default source");
}

console.log("\n=== updates come from main; every other branch is development ===");
{
  say(gh.UPDATE_BRANCH === "main", "the update branch is main");

  /* The point of the pin. A config that names a development branch must
     not move a customer's auto-updater onto it - including the very
     branches this desk is built on, which are the newest thing in the
     repository most of the time. */
  for (const b of ["arena/d5fff7f0-aurion", "dev", "feature/x", "next", "master"]) {
    const g = gh.getSource({ update_server: { github: { branch: b } } });
    say(g.branch === "main", `a config asking for "${b}" still reads main`);
    say(g.ignored_branch === b, `  and says "${b}" was ignored rather than dropping it silently`);
  }
  const clean = gh.getSource({ update_server: { github: { branch: "main" } } });
  say(clean.ignored_branch === "", "asking for main is not reported as an ignored setting");

  const src = fs.readFileSync(path.join(ROOT, "backend", "src", "github-update.js"), "utf8");
  say(!/gh\.branch \|\| "main"/.test(src), "no branch default is read from config any more");
  say((src.match(/encodeURIComponent\(UPDATE_BRANCH\)/g) || []).length >= 2,
      "both the commit lookup and the containment check use the pinned branch");
  say(!/\$\{encodeURIComponent\(src\.branch\)\}/.test(src),
      "and no request interpolates a branch that came from configuration");

  const factory = JSON.parse(fs.readFileSync(path.join(ROOT, "config", "aurion.factory.json"), "utf8"));
  say(!("branch" in (factory.update_server.github || {})),
      "the shipped config carries no branch key, so there is nothing to set");
}

console.log("\n=== a release cut off main is not an update ===");
{
  /* releases/latest is the newest release in the repository and says
     nothing about the branch it was tagged on. Without a containment
     test, tagging a development branch would ship it to every customer. */
  const src = fs.readFileSync(path.join(ROOT, "backend", "src", "github-update.js"), "utf8");
  say(/async function containedInMain\(/.test(src), "resolveTarget tests containment before trusting a release");
  say(/rel\.tag_name && await containedInMain\(src, String\(rel\.tag_name\)\)/.test(src),
      "the release is only taken when main contains it");
  say(/return cmp\.ahead_by === 0;/.test(src),
      "containment is ahead_by === 0 - main already has every commit the tag has");
  say(/\/compare\/\$\{encodeURIComponent\(UPDATE_BRANCH\)\}\.\.\./.test(src),
      "and it compares against main, not against whatever was asked for");
  const fn = src.slice(src.indexOf("async function containedInMain("));
  const body = fn.slice(0, fn.indexOf("\n}\n"));
  say(/catch \{[\s\S]*return false;/.test(body),
      "a failed containment check answers 'not on main', so an outage cannot promote a release");
}

console.log("\n=== a public repository needs no token ===");
{
  const src = fs.readFileSync(path.join(ROOT, "backend", "src", "github-update.js"), "utf8");
  say(/rejectUnauthorized: true/.test(src) && !/rejectUnauthorized: false/.test(src),
      "TLS verification is on and never switched off");
  say(/minVersion: "TLSv1\.2"/.test(src), "TLS 1.2 floor");
  say(/if \(src\.token\) headers\["Authorization"\]/.test(src),
      "the Authorization header is sent only when a token exists");
  say(/github_rate_limited/.test(src),
      "a rate limit is reported as itself, not as a server error");
  say(/got !== sha\.toLowerCase\(\)/.test(src),
      "every downloaded blob is re-hashed and compared to the SHA it was requested by");
}

console.log("\n=== a repository with no releases still updates ===");
{
  const src = fs.readFileSync(path.join(ROOT, "backend", "src", "github-update.js"), "utf8");
  say(/releases\/latest/.test(src) && /commits\/\$\{encodeURIComponent\(UPDATE_BRANCH\)\}/.test(src),
      "resolveTarget tries the latest release, then the head of main");
  say(/if \(e\.message !== "github_not_found"\) throw e;/.test(src),
      "and only falls back on a 404 - a rate limit or outage is not mistaken for 'no releases'");
  say(/channel: "release"/.test(src) && /channel: "branch"/.test(src),
      "the answer says which of the two it used");
}

console.log("\n=== a re-check applies what it just fetched ===");
{
  /* applyUpdate re-checks when the requested id is not the one on disk,
     then reads the file list. It used to read it from the object it had
     captured before the re-check - so the one path that needed a fresh
     manifest was the one path that applied a stale one. */
  const fn = updaterSrc.slice(updaterSrc.indexOf("async function applyUpdate("));
  const body = fn.slice(0, fn.indexOf("\n}\n"));
  const recheck = body.indexOf("await checkForUpdates()");
  const reread = body.indexOf("state = readJsonSecure(UPDATE_STATE_FILE", recheck);
  const useFiles = body.indexOf("state.latest?.files");
  say(recheck >= 0 && reread > recheck && useFiles > reread,
      "the state is re-read after the re-check and before the file list is used");
  say(/let state = readJsonSecure\(UPDATE_STATE_FILE/.test(body),
      "which is possible because state is no longer a const");
}

console.log("\n=== what the update panel is told, and what it shows ===");
{
  const ghSrc = fs.readFileSync(path.join(ROOT, "backend", "src", "github-update.js"), "utf8");
  const appJs = fs.readFileSync(path.join(ROOT, "apps", "web", "js", "app.js"), "utf8");

  /* "main@a19a26b" named a commit. Nobody installing an update is asking
     which commit it is, and it cannot be read back to support. */
  say(!/version: UPDATE_BRANCH \+ "@"/.test(ghSrc),
      "the branch build no longer calls itself main@<sha>");
  say(/version: "",/.test(ghSrc) && /async function remoteVersion\(/.test(ghSrc),
      "the number comes from the release's own factory config instead");
  say(/const version = target\.version \|\| await remoteVersion\(cfg, factoryEntry\);/.test(ghSrc),
      "a release names itself by its tag; only a branch build has to be asked");
  say(/if \(rel === "config\/aurion\.factory\.json"\) factoryEntry = entry;/.test(ghSrc),
      "the factory config is noted whether or not it differs, so the version is always readable");
  say(/build_date: String\(when\)\.slice\(0, 10\)/.test(ghSrc),
      "an ISO build date travels on the wire, unformatted");

  /* The subject of whatever commit sits at the head of main is not
     release notes. It is usually "Merge pull request #N from ...". */
  const branchBlock = ghSrc.slice(ghSrc.indexOf('channel: "branch"'));
  say(/changelog: "",/.test(branchBlock.slice(0, 900)),
      "a branch build sends no changelog, so no commit subject reaches the panel");
  const relBlock = ghSrc.slice(ghSrc.indexOf('channel: "release"'));
  say(/changelog: String\(rel\.body \|\| rel\.name \|\| ""\)/.test(relBlock.slice(0, 700)),
      "a real release still passes its notes through - they were written to be read");

  /* The panel. */
  say(!/upd-source/.test(appJs), "the update source line is gone from the panel");
  say(!/upd\.files_changed/.test(appJs), "the changed-file count is gone");
  say(!/file-item/.test(appJs), "and so is the file list it introduced");
  say(/updateStamp\(/.test(appJs) && /changelogHtml\(/.test(appJs),
      "both render sites go through the one stamp and the one notes helper");
  for (const key of ["upd.source", "upd.branch_locked", "upd.files_changed"]) {
    const used = new RegExp(key.replace(".", "\\.")).test(appJs);
    const inLang = key.split(".")[1] in JSON.parse(fs.readFileSync(path.join(ROOT, "lang", "en.json"), "utf8")).upd;
    say(!used && !inLang, `${key} is gone from the code and from lang/`);
  }

  /* updateStamp, run rather than read. */
  const lift = (name) => {
    const at = appJs.indexOf("function " + name + "(");
    let i = appJs.indexOf("{", at), depth = 0, end = i;
    for (; end < appJs.length; end++) {
      if (appJs[end] === "{") depth++;
      else if (appJs[end] === "}") { depth--; if (!depth) { end++; break; } }
    }
    return appJs.slice(at, end);
  };
  const vm = require("node:vm");
  const box = { esc: (x) => String(x) };
  vm.createContext(box);
  vm.runInContext(lift("buildTag") + "\n" + lift("updateStamp") + "\n" + lift("changelogHtml"), box);

  const got = box.updateStamp({ version: "1.0.5", build_date: "2026-11-06" });
  say(got === "v1.0.5 DSK-061126", `v1.0.5 + 2026-11-06 renders as "${got}"`);
  say(box.updateStamp({ version: "v2.0.0", build_date: "2026-01-02" }) === "v2.0.0 DSK-020126",
      "a tag that already starts with v is not given a second one");
  say(box.updateStamp({ version: "1.0.0", build_date: "" }) === "v1.0.0",
      "no date, no empty stamp trailing the version");
  say(box.updateStamp({ version: "", build_date: "2026-11-06" }) === "DSK-061126",
      "no version, the build stamp still identifies the build exactly");
  say(box.updateStamp({}) === "-", "nothing at all degrades to a dash, not to 'undefined'");
  say(!/main@|@[0-9a-f]{7}/.test(box.updateStamp({ version: "1.0.0", build_date: "2026-11-06" })),
      "and no commit sha can appear in the result");

  say(box.changelogHtml({ changelog: "" }) === "", "an empty changelog draws no empty paragraph");
  say(/Real notes/.test(box.changelogHtml({ changelog: "Real notes" })),
      "a real one is still drawn");
}


console.log("\n=== the rate limit ===");
{
  const rd = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
  const ghSrc = rd("backend/src/github-update.js");
  const upd = rd("backend/src/updater.js");
  const app = rd("apps/web/js/app.js");
  const idx = rd("backend/src/index.js");

  /* Conditional requests are the whole fix: GitHub does not charge for
     a 304. Measured live - remaining went 4994 -> 4994 across a 200
     then a 304, and a warm check cost 0 of its 3 requests. */
  /* The phrase appears in the comment above too, so this has to pin
     the assignment - the first version of this check passed with the
     header deleted. */
  say(/headers\["If-None-Match"\]\s*=\s*hit\.etag/.test(ghSrc),
    "requests carry If-None-Match when an ETag is known");
  say(/res\.statusCode === 304/.test(ghSrc), "and 304 is handled rather than treated as an error");
  say(/headers\.etag/.test(ghSrc), "the ETag from a 200 is kept for next time");
  {
    const at = ghSrc.indexOf("if (res.statusCode === 304");
    const blk = ghSrc.slice(at, at + 400);
    say(/JSON\.parse\(hit\.body\)/.test(blk), "a 304 is answered from the cached body");
    /* The one rejection left is a cached body that will not parse,
       which is a corrupt cache and must be loud. What must never
       happen is a 304 being reported as a rate limit or an HTTP
       error - those are the paths below it. */
    say(!/rateLimitError|github_http_/.test(blk),
      "a 304 is never reported as a rate limit or an HTTP failure");
  }

  /* A cache that only lives in memory pays full price after a restart. */
  say(/CACHE_FILE/.test(ghSrc) && /github-cache\.json/.test(ghSrc), "the cache survives a restart");
  say(/mode: 0o600/.test(ghSrc), "and is written 0600, like every other data file");
  say(/CACHE_MAX_ENTRIES/.test(ghSrc) && /CACHE_MAX_BYTES/.test(ghSrc), "it is bounded, both ways");
  say(/renameSync/.test(ghSrc), "written atomically, so a crash cannot leave half a cache");

  /* Knowing the budget means not spending a round trip to be refused. */
  say(/function rateExhausted/.test(ghSrc), "the module knows when there is no budget left");
  say(/if \(rateExhausted\(\)\) \{ reject\(rateLimitError\(\)\); return; \}/.test(ghSrc),
    "and refuses before opening a socket");
  {
    const at = ghSrc.indexOf("function rateExhausted");
    const blk = ghSrc.slice(at, ghSrc.indexOf("\n}", at));
    say(/reset > Math\.floor\(Date\.now\(\) \/ 1000\)/.test(blk),
      "a stale zero from a previous hour does not keep blocking - the window must still be open");
  }
  say(/x-ratelimit-remaining/.test(ghSrc), "the remaining budget is read from the response");
  say(/x-ratelimit-reset/.test(ghSrc), "and so is the moment it refills");
  say(/res\.statusCode === 429/.test(ghSrc), "429 counts as rate limiting too, not just 403");
  say(/Number\(res\.headers\["x-ratelimit-remaining"\]\) === 0/.test(ghSrc),
    "and a 403 with budget left is not mistaken for one - that is a different fault");

  /* The error has to carry the one fact that makes it actionable. */
  say(/e\.resetAt/.test(ghSrc) && /retryAfterSeconds/.test(ghSrc), "the error says when it stops being true");
  say(/err === "github_rate_limited"/.test(upd), "the updater recognises it");
  say(/out\.last_known = prev/.test(upd), "and still reports the last answer that worked");
  say(/function updateErrorText/.test(app), "the desk turns the code into a sentence");
  say(/upd\.rate_limited/.test(app) && /upd\.rate_retry/.test(app), "naming the limit and when it clears");
  say(/if \(!res\.rate_authenticated\) text \+=/.test(app),
    "and only suggests a token to someone not already using one");

  /* A token is the real cure for a shared address. */
  say(/github_token/.test(upd), "a token can be stored");
  say(/delete merged\.github_token/.test(upd), "but is never handed back out");
  say(/github_token_set/.test(upd), "only whether one is set");
  say(/\("github_token" in safePatch\)/.test(upd),
    "an unrelated save keeps the stored token instead of wiping it");
  say(/id="upd-token"/.test(app) && /type="password"/.test(app), "there is a field for it");
  say(/body\.github_token !== undefined/.test(idx), "the route accepts it");
  say(/\{20,255\}\$\/\.test\(tok\)/.test(idx) && /invalid_token/.test(idx),
    "validating its shape, not merely naming the error");
  say(/req\.user\.role !== "owner"/.test(idx.slice(idx.indexOf("/system/update/settings"), idx.indexOf("/system/update/settings") + 300)),
    "and only an owner or admin may set one");

  const ignore = rd(".gitignore");
  say(/data\/github-cache\.json/.test(ignore), "the cache is not committed");
  say(/data\/update-settings\.json/.test(ignore), "nor is the file that can hold a token");
}

const bad = results.filter((r) => !r).length;
console.log("\ngithub-update: " + (bad ? bad + " FAILED of " + results.length : results.length + " checks passed"));
process.exit(bad ? 1 : 0);
