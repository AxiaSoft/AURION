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

const bad = results.filter((r) => !r).length;
console.log("\ngithub-update: " + (bad ? bad + " FAILED of " + results.length : results.length + " checks passed"));
process.exit(bad ? 1 : 0);
