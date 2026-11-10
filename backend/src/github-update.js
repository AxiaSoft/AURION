"use strict";
/**
 * Updates, straight from GitHub.
 *
 * The product used to update from a private "update server": a Node service
 * in admin/update-server that an operator published builds into, which the
 * desk then polled. That meant a release could only reach a customer if that
 * machine was running, reachable and publishing — a second piece of
 * infrastructure to keep alive for every shipped fix.
 *
 * The source of truth is already on GitHub. This reads it directly, over the
 * public REST API, with no server in between.
 *
 * How a "version" is decided, in order:
 *
 *   1. the latest published release, provided main contains it — tag,
 *      notes and date are exactly what the desk's update panel displays;
 *   2. otherwise the head commit of main, with the commit subject standing
 *      in for the release notes.
 *
 * Both read main and nothing else. Every other branch in the repository is
 * development and is never a source of updates.
 *
 * WHAT COUNTS AS AN UPDATE, and what counts as a new VERSION
 * ---------------------------------------------------------
 * These were the same thing and should never have been. main is the
 * release branch: nothing reaches it except through a pull request the
 * owner merged, so anything on it is shipped work, down to a one-line
 * fix. Development lives on the other branches, which this file cannot
 * see at all. Requiring a tag before a customer could receive a merged
 * fix meant the fix sat on main, visible to the desk, named in the
 * panel, and un-installable — reported by the owner, who could see
 * "1 file differs" and had no way to take it.
 *
 * So an update is: main has a shipped file this machine does not. That
 * is all. `update_available` is the file list and nothing else.
 *
 * A VERSION is a separate statement, and only the builder makes it: the
 * number in config/aurion.factory.json, which changes when a build is
 * cut and never because a commit landed. `version_changed` says whether
 * the number being offered differs from the number installed.
 *
 * The distinction is load-bearing, because the end-of-support clock
 * reads it. Five days after a NEW VERSION the desk locks; a merged fix
 * that leaves the version alone is delivered, installable, and starts
 * no clock at all. Without that split, "deliver every merge" would mean
 * "lock every customer out five days after every merge".
 *
 * Which files differ is not guessed from the version. The tree API lists
 * every tracked path with its blob SHA, and a git blob SHA is computable
 * locally — sha1("blob <bytelength>\0" + bytes). So the comparison is exact,
 * file by file, against the real contents of the release, and an update is
 * offered only when some file genuinely differs. A re-tag with no code
 * change correctly reports nothing to do.
 *
 * Contents come from the blobs API rather than raw.githubusercontent.com:
 * one host to reach instead of two, it is the host already being used for
 * the tree, and it carries the blob SHA back so every downloaded file is
 * verified against the identifier it was requested by.
 */

const fs = require("fs");
const path = require("path");
const https = require("https");
const crypto = require("crypto");
const zlib = require("zlib");

const { ROOT, DATA } = require("./paths");

const API_HOST = "api.github.com";

/* ---- the rate limit -------------------------------------------------
 *
 * Unauthenticated GitHub allows 60 requests an hour, counted per IP
 * address rather than per installation - so a desk behind a shared or
 * carrier-grade NAT is spending a budget it does not own. One check
 * costs four calls (the release, the commit, the tree, and the factory
 * config blob) and applying an update costs one more per changed file,
 * which is how a machine that was working fine starts answering
 * github_rate_limited.
 *
 * Three things fix it, in this order of effect:
 *
 *   1. Conditional requests. Every response carries an ETag; sending it
 *      back as If-None-Match returns 304 with no body, and GitHub does
 *      not charge for a 304. Measured against the live API: remaining
 *      went 4994 -> 4994 across a 200 followed by a 304. A re-check
 *      that finds nothing new therefore costs nothing at all, which is
 *      the common case for a desk that polls every six hours.
 *
 *   2. Knowing the budget. Every response states what is left and when
 *      it resets. Once that is zero there is no point sending another
 *      request to be refused - the failure is reported from the cached
 *      numbers instead, with the time the trader can try again.
 *
 *   3. A token. Optional, and the only real cure for a shared address:
 *      it raises the ceiling from 60 an hour to 5000 and makes the
 *      budget personal rather than communal.
 */
const CACHE_FILE = path.join(DATA, "github-cache.json");

/* 304s are only free if the body is still here to reuse, so the cache
   is on disk: a restarted backend would otherwise pay full price for
   every path again. Kept small - these are a handful of JSON documents
   and the trees are the only large ones. */
const CACHE_MAX_ENTRIES = 64;
const CACHE_MAX_BYTES = 8 * 1024 * 1024;

let cacheMem = null;

function cacheLoad() {
  if (cacheMem) return cacheMem;
  try {
    const raw = fs.readFileSync(CACHE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    cacheMem = (parsed && typeof parsed === "object" && parsed.paths) ? parsed : { paths: {}, rate: {} };
  } catch {
    cacheMem = { paths: {}, rate: {} };
  }
  if (!cacheMem.paths) cacheMem.paths = {};
  if (!cacheMem.rate) cacheMem.rate = {};
  return cacheMem;
}

function cacheSave() {
  if (!cacheMem) return;
  try {
    const paths = cacheMem.paths || {};
    /* Oldest out first, so a long-lived desk does not accumulate the
       tree of every release it has ever been offered. */
    const keys = Object.keys(paths).sort((a, b) => (paths[b].at || 0) - (paths[a].at || 0));
    let bytes = 0;
    const kept = {};
    for (const k of keys) {
      const size = String(paths[k].body || "").length;
      if (Object.keys(kept).length >= CACHE_MAX_ENTRIES) break;
      if (bytes + size > CACHE_MAX_BYTES) continue;
      bytes += size;
      kept[k] = paths[k];
    }
    cacheMem.paths = kept;
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    const tmp = CACHE_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(cacheMem), { mode: 0o600 });
    fs.renameSync(tmp, CACHE_FILE);
  } catch { /* a cache that cannot be written is slow, not broken */ }
}

/** What the last response said was left, and when the hour rolls over. */
function rateState() {
  const c = cacheLoad();
  const r = c.rate || {};
  return {
    limit: Number(r.limit) || 0,
    remaining: Number.isFinite(Number(r.remaining)) ? Number(r.remaining) : null,
    reset: Number(r.reset) || 0,
    authenticated: Boolean(r.authenticated),
  };
}

function noteRate(headers, authenticated) {
  const c = cacheLoad();
  const lim = Number(headers["x-ratelimit-limit"]);
  const rem = Number(headers["x-ratelimit-remaining"]);
  const rst = Number(headers["x-ratelimit-reset"]);
  if (Number.isFinite(rem)) {
    c.rate = {
      limit: Number.isFinite(lim) ? lim : 0,
      remaining: rem,
      reset: Number.isFinite(rst) ? rst : 0,
      authenticated: Boolean(authenticated),
    };
  }
}

/** A rate-limit error that says when it stops being true. */
function rateLimitError() {
  const { reset } = rateState();
  const e = new Error("github_rate_limited");
  if (reset > 0) {
    e.resetAt = new Date(reset * 1000).toISOString();
    e.retryAfterSeconds = Math.max(0, reset - Math.floor(Date.now() / 1000));
  }
  return e;
}

/**
 * Is there budget to spend?
 *
 * Sending a request that is certain to be refused wastes the round trip
 * and tells the trader nothing they could not be told instantly. The
 * exception is when the hour has already rolled over, in which case the
 * stored zero is stale and the only way to learn the new figure is to
 * ask.
 */
function rateExhausted() {
  const { remaining, reset } = rateState();
  if (remaining === null || remaining > 0) return false;
  return reset > Math.floor(Date.now() / 1000);
}

/**
 * The one branch an installation may update from.
 *
 * Every other branch in the repository is development: work in progress,
 * experiments, and the per-session branches this desk is itself built on.
 * None of them are a release, several of them do not run, and any of them
 * could be the newest thing in the repository at any moment - so "the
 * newest commit" is not a safe answer to "what should a customer install".
 * main is.
 *
 * Pinned in code rather than defaulted in config. A default is something
 * an edit can move, and the edit that moves it points a customer's
 * auto-updater at a development branch. Nothing reads a branch name from
 * configuration any more, so there is no value to set.
 */
const UPDATE_BRANCH = "main";
const MAX_FILES = 600;
const MAX_BLOB = 25 * 1024 * 1024;

/* The product, as a set of paths.
 *
 * Deliberately a list of directories rather than "the whole repository":
 * an update must not drag tests, build rigs, the admin server or the
 * installer onto a trading machine. Everything the running desk actually
 * loads is here, and nothing else is.
 *
 * apps/web is included whole rather than apps/web/js alone, which is what
 * the old manifest shipped. A stylesheet, a lang file or index.html is as
 * much a part of a release as a script, and leaving them out meant an
 * update could change a template while the CSS that lays it out stayed at
 * the previous version. */
const INCLUDE_DIRS = [
  "backend/src",
  "engine/aurion",
  "engine/ea",
  "apps/web",
  "lang",
  "scripts",
];

/* Single files that are part of the release but live beside things that
   are not. config/ holds the machine's live configuration and its fetched
   news calendar, neither of which a release may touch - but the factory
   defaults next to them are the product's own, and leaving them behind
   meant a release could add a setting the shipped default never gained. */
const INCLUDE_FILES = ["config/aurion.factory.json"];

/* Never, whatever a release contains.
 *
 * data/** is the machine's own state — users, the JWT secret, databases,
 * logs and the licence. config/aurion.json is the live configuration: MT5
 * credentials, licence OTP, the operator's settings. Both would be
 * destroyed by a file copy, and neither belongs to the release. The same
 * three exclusions the previous updater applied, kept verbatim. */
function isProtected(rel) {
  const p = String(rel || "").replace(/\\/g, "/");
  if (!p) return true;
  if (p === "data" || p.startsWith("data/")) return true;
  if (p === "config/aurion.json") return true;
  if (p.startsWith("config/news_calendar")) return true;
  return false;
}

function isShippable(rel) {
  const p = String(rel || "").replace(/\\/g, "/");
  if (isProtected(p)) return false;
  const inTree = INCLUDE_DIRS.some((d) => p === d || p.startsWith(d + "/"));
  if (!inTree && !INCLUDE_FILES.includes(p)) return false;
  if (p.includes("/node_modules/") || p.includes("/__pycache__/")) return false;
  if (/(^|\/)\./.test(p)) return false;            // dotfiles and dot-dirs
  if (/\.(log|pyc|pyo)$/.test(p)) return false;
  if (/\.test\.(js|cjs|mjs)$/.test(p)) return false;
  return true;
}

/**
 * Where to look: owner and repo. The branch is not negotiable.
 *
 * owner and repo are read from config.update_server.github when present,
 * so an operator can point a build at a fork without touching code, and
 * otherwise they are the product's own repository. The branch is always
 * main - see UPDATE_BRANCH.
 *
 * A token is optional and only raises the rate limit — a public
 * repository needs none, which is the point: a customer's machine
 * updates with no credential of any kind.
 */
function getSource(cfg) {
  const gh = (cfg && cfg.update_server && cfg.update_server.github) || {};
  const owner = String(gh.owner || "AxiaSoft").trim();
  const repo = String(gh.repo || "AURION").trim();
  const token = String(process.env.AURION_GITHUB_TOKEN || gh.token || "").trim();
  /* A branch key left over in an old config is reported, not obeyed.
     Silently ignoring a setting someone wrote is how a machine ends up
     doing the opposite of what its configuration appears to say. */
  const asked = String(gh.branch || "").trim();
  const ignored_branch = asked && asked !== UPDATE_BRANCH ? asked : "";
  return { owner, repo, branch: UPDATE_BRANCH, token, ignored_branch };
}

function describe(src) {
  return `github.com/${src.owner}/${src.repo}@${UPDATE_BRANCH}`;
}

function request(src, pathname, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    /* Refuse before spending the round trip, and say when it clears. */
    if (rateExhausted()) { reject(rateLimitError()); return; }
    const cache = cacheLoad();
    /* Keyed with the token's identity folded in, so a desk that gains or
       loses a token cannot be served a body fetched under the other. */
    const key = (src.token ? "t:" : "a:") + src.owner + "/" + src.repo + pathname;
    const hit = cache.paths[key];
    const headers = {
      "Accept": "application/vnd.github+json",
      "User-Agent": "AURION-Updater/2.0",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    if (hit && hit.etag) headers["If-None-Match"] = hit.etag;
    if (src.token) headers["Authorization"] = "Bearer " + src.token;
    const req = https.request({
      hostname: API_HOST,
      port: 443,
      path: pathname,
      method: "GET",
      headers,
      timeout: timeoutMs,
      rejectUnauthorized: true,
      minVersion: "TLSv1.2",
    }, (res) => {
      let data = "";
      let total = 0;
      res.on("data", (chunk) => {
        total += chunk.length;
        if (total > 40 * 1024 * 1024) { req.destroy(new Error("response_too_large")); return; }
        data += chunk;
      });
      res.on("end", () => {
        noteRate(res.headers, Boolean(src.token));

        /* Not modified: GitHub charges nothing for this, and the body
           we already hold is by definition still current. This is the
           whole reason a six-hourly check costs no budget at all. */
        if (res.statusCode === 304 && hit) {
          try { resolve(JSON.parse(hit.body)); }
          catch { reject(new Error("invalid_json")); }
          hit.at = Date.now();
          cacheSave();
          return;
        }

        /* A rate limit is not a server error and must not be reported as
           one: it is the single most likely failure on an unauthenticated
           machine that checks often, and "try again later" is advice the
           user can act on, where "github_403" is not.

           403 and 429 both carry it, and the distinguishing header is
           x-ratelimit-remaining: 0 - a 403 for any other reason (a bad
           token, say) leaves budget on the clock. */
        const spent = Number(res.headers["x-ratelimit-remaining"]) === 0;
        if ((res.statusCode === 403 || res.statusCode === 429) && (spent || /rate limit/i.test(data))) {
          cacheSave();
          reject(rateLimitError());
          return;
        }
        if (res.statusCode === 404) { reject(new Error("github_not_found")); return; }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error("github_http_" + res.statusCode));
          return;
        }
        let parsed;
        try { parsed = JSON.parse(data); }
        catch { reject(new Error("invalid_json")); return; }
        const etag = res.headers.etag || "";
        if (etag && data.length <= CACHE_MAX_BYTES) {
          cache.paths[key] = { etag, body: data, at: Date.now() };
        }
        cacheSave();
        resolve(parsed);
      });
    });
    /* Keep the cause. A bare "network_error" is the same word for a
       machine with no route, a corporate TLS proxy whose CA the runtime
       does not trust, and a DNS failure - three different fixes, and the
       panel shows this string to the person who has to pick one. */
    req.on("error", (e) => reject(new Error("network_error" + (e && e.code ? ":" + e.code : ""))));
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.end();
  });
}

/** sha1("blob <len>\0" + bytes) — the identifier git itself gives a file. */
function blobSha(buf) {
  return crypto.createHash("sha1")
    .update("blob " + buf.length + "\0", "utf8")
    .update(buf)
    .digest("hex");
}

function localBlobSha(rel) {
  try {
    const full = path.join(ROOT, rel);
    const st = fs.statSync(full);
    if (!st.isFile() || st.size > MAX_BLOB) return null;
    return blobSha(fs.readFileSync(full));
  } catch { return null; }
}

/**
 * The release to compare against: a published release if there is one,
 * otherwise the head of the tracked branch.
 *
 * The fallback is not a nicety. A repository that has never cut a release
 * answers 404 on releases/latest, and an updater that stopped there would
 * report "no updates" forever while the branch moved underneath it — a
 * check that always says yes, which is the failure the single-check
 * rewrite existed to remove in the first place.
 */
/**
 * Is this ref part of main, or off on its own?
 *
 * releases/latest answers with the newest published release in the whole
 * repository, and says nothing about which branch it was cut from. A
 * release tagged on a development branch is therefore a perfectly valid
 * answer to "the latest release" and a completely invalid answer to
 * "what should this customer install".
 *
 * compare gives the exact test. ahead_by counts the commits the candidate
 * has that main does not; zero means main already contains every one of
 * them, which is what "it is on main" means. A tag on main reads
 * identical or behind; anything cut elsewhere reads ahead or diverged.
 */
async function containedInMain(src, ref) {
  try {
    const cmp = await request(
      src,
      `/repos/${src.owner}/${src.repo}/compare/${encodeURIComponent(UPDATE_BRANCH)}...${encodeURIComponent(ref)}?per_page=1`,
      30000
    );
    if (!cmp || typeof cmp.ahead_by !== "number") return false;
    return cmp.ahead_by === 0;
  } catch {
    /* Could not establish that it is on main, so it is not treated as
       being on main. The branch head is always a safe answer. */
    return false;
  }
}

async function resolveTarget(src) {
  try {
    const rel = await request(src, `/repos/${src.owner}/${src.repo}/releases/latest`);
    if (rel && rel.tag_name && await containedInMain(src, String(rel.tag_name))) {
      const when = rel.published_at || rel.created_at || "";
      return {
        channel: "release",
        /* The one fact the rest of the system is allowed to act on. A
           release is something a person decided to publish; everything
           else in this function is the state of a branch. */
        published: true,
        ref: String(rel.tag_name),
        id: String(rel.tag_name),
        version: String(rel.tag_name).replace(/^v/i, ""),
        /* A release's notes were written to be read by whoever installs
           it, so they are passed through. */
        changelog: String(rel.body || rel.name || "").slice(0, 4000),
        published_at: when,
        build_date: String(when).slice(0, 10),
        html_url: rel.html_url || "",
      };
    }
  } catch (e) {
    if (e.message !== "github_not_found") throw e;
  }
  /* Here for one of three reasons: the repository publishes no releases,
     the newest one is not on main, or the lookup 404'd. All three mean the
     same thing - the head of main is what this installation should be at. */
  const head = await request(src, `/repos/${src.owner}/${src.repo}/commits/${encodeURIComponent(UPDATE_BRANCH)}`);
  const sha = String((head && head.sha) || "");
  if (!sha) throw new Error("no_commit");
  const commit = (head && head.commit) || {};
  const when = (commit.committer && commit.committer.date) || (commit.author && commit.author.date) || "";
  return {
    channel: "branch",
    /* Not a published release - and that is a statement about where
       the NOTES and the version number come from, not about whether
       this may be installed.
       It used to mean both, and the second meaning was wrong: main is
       the release branch, so a merged pull request is shipped work and
       a customer is entitled to it whether or not anyone cut a tag.
       What this flag still governs is the support clock, which may
       only be started by a new version number from the builder - see
       version_changed in check(). The original fault it was added for
       (a five-day countdown to locking the desk, started by an
       ordinary commit) therefore stays fixed. */
    published: false,
    ref: sha,
    id: sha.slice(0, 12),
    /* Filled in by check() from the release's own factory config - see
       remoteVersion. "main@a19a26b" named the commit, which answers
       "which commit is this" and not "which version am I being offered". */
    version: "",
    /* Deliberately empty. The subject of whatever commit happens to be
       at the head of main is not release notes: most of the time it is
       "Merge pull request #4 from ...", which tells the person deciding
       whether to install precisely nothing. Notes come from a release,
       and a branch build has none. The panel says so in words and
       shows the file count and size instead, which are measured facts
       rather than a sentence nobody wrote for this purpose. */
    changelog: "",
    published_at: when,
    build_date: String(when).slice(0, 10),
    html_url: head.html_url || "",
  };
}

/**
 * The version number the release calls itself.
 *
 * Taken from the release's own config/aurion.factory.json rather than
 * from this machine's config, because the question the panel is asking
 * is "what am I being offered", and the local file answers "what do I
 * already have" - the same number every time, including when an update
 * is waiting.
 *
 * The blob SHA is already in hand from the tree listing, so this is one
 * more blob fetch and no extra search. Returns "" rather than a guess if
 * the file cannot be read: a wrong version number on an install prompt is
 * worse than none, and the build stamp beside it still identifies the
 * build exactly.
 */
/**
 * The version number THIS machine calls itself.
 *
 * Read from the installed config/aurion.factory.json, which is the
 * builder's file: the installer writes it and nothing at runtime
 * touches it. config/aurion.json is the live configuration and is
 * deliberately not consulted - an operator editing their settings must
 * not be able to move the version and, through it, the support clock.
 *
 * Returns "" when it cannot be read, and every caller treats "" as
 * "no statement", never as "different".
 */
function localFactoryVersion() {
  try {
    const raw = fs.readFileSync(path.join(ROOT, "config", "aurion.factory.json"), "utf8");
    const v = String((JSON.parse(raw) || {}).version || "").trim();
    return /^[0-9][0-9A-Za-z.\-+]{0,30}$/.test(v) ? v : "";
  } catch { return ""; }
}

async function remoteVersion(cfg, entry) {
  if (!entry || !entry.sha) return "";
  try {
    const { buffer } = await fetchFile(cfg, { hash: entry.sha, filePath: "config/aurion.factory.json" });
    const parsed = JSON.parse(buffer.toString("utf8"));
    const v = String((parsed && parsed.version) || "").trim();
    return /^[0-9][0-9A-Za-z.\-+]{0,30}$/.test(v) ? v : "";
  } catch { return ""; }
}

/**
 * What differs between this machine and that release.
 *
 * A file is offered when the release has it and the local copy's blob SHA
 * is different or the file is absent. Files the release no longer carries
 * are reported but never deleted: an update that removes files from a
 * running installation can take a customer's own additions with it, and
 * nothing in the desk needs a deletion to work.
 */
async function check(cfg) {
  const src = getSource(cfg);
  const target = await resolveTarget(src);
  const tree = await request(
    src,
    `/repos/${src.owner}/${src.repo}/git/trees/${encodeURIComponent(target.ref)}?recursive=1`,
    30000
  );
  if (!tree || !Array.isArray(tree.tree)) throw new Error("bad_tree");

  const files = [];
  let truncatedScan = false;
  let factoryEntry = null;
  for (const entry of tree.tree) {
    if (!entry || entry.type !== "blob") continue;
    const rel = String(entry.path || "").replace(/\\/g, "/");
    if (!isShippable(rel)) continue;
    /* Noted whether or not it differs - the version is read from the
       release's copy every time, not only when that file changed. */
    if (rel === "config/aurion.factory.json") factoryEntry = entry;
    if (files.length >= MAX_FILES) { truncatedScan = true; break; }
    const mine = localBlobSha(rel);
    if (mine === entry.sha) continue;
    files.push({
      id: String(entry.sha),
      filePath: rel,
      hash: String(entry.sha),
      size: Number(entry.size || 0),
      status: mine ? "changed" : "added",
    });
  }

  /* A release names itself by its tag; a branch build has to be asked. */
  const version = target.version || await remoteVersion(cfg, factoryEntry);
  const published = target.published === true;
  /* Did the BUILDER move the number? Only a real difference counts, and
     only when both ends could be read - an unreadable file on either
     side is silence, and silence must never start a clock. */
  const localVersion = localFactoryVersion();
  const versionChanged = Boolean(version) && Boolean(localVersion) && version !== localVersion;
  /* What this update changes, in bytes, taken from the sizes the tree
     listing already carried. It is not the size of the transfer - the
     install fetches the whole build as one compressed archive, whose
     length codeload does not declare in advance - and it is not
     labelled as one. It is the exact number of bytes that will be
     written to disk, which is the question "how big is this update"
     actually asks. The transfer is measured while it happens. */
  const downloadBytes = files.reduce((n, f) => n + (Number(f.size) || 0), 0);

  return {
    ok: true,
    source: describe(src),
    channel: target.channel,
    published,
    /* Differs from what is on this machine. Kept separate from
       update_available on purpose: it is true for any commit on the
       tracked branch, and nothing in the product may act on it. */
    behind: files.length > 0,
    /* An offer: main carries a shipped file this machine does not.
       main is the release branch - a merged pull request is shipped
       work - so every difference is offered, down to a single file.
       It is NOT what the support clock runs on; see version_changed. */
    update_available: files.length > 0,
    /* The builder's statement, and the only thing that may lock a desk.
       Kept out of update_available on purpose: delivering a fix and
       threatening to stop the desk over it are different decisions,
       and only the second one needs a new version number. */
    version_changed: versionChanged,
    local_version: localVersion,
    update: {
      id: target.id,
      ref: target.ref,
      version,
      published,
      /* Carried on the target as well as beside it, because the state
         file keeps the target and the support policy reads the file. */
      version_changed: versionChanged,
      local_version: localVersion,
      build_date: target.build_date || "",
      changelog: target.changelog,
      published_at: target.published_at,
      html_url: target.html_url,
      file_count: files.length,
      download_bytes: downloadBytes,
      files,
    },
    truncated: truncatedScan || Boolean(tree.truncated),
  };
}

/**
 * Every shipped file in one download, for nothing.
 *
 * The blobs API is correct and ruinously expensive: one request per file,
 * against a ceiling of sixty an hour on a machine with no token. A desk
 * that had fallen a few commits behind therefore asked for more requests
 * than it was allowed and stopped halfway with "github_rate_limited" —
 * reported from the field, and the reason this exists.
 *
 * The archive endpoint hands over the whole tree at a named ref as one
 * zip. It redirects to codeload.github.com, which is NOT the API host and
 * does NOT draw on the hourly budget: measured against this repository,
 * the remaining count was identical before and after (4990 both times) for
 * a 10 MB archive fetched in about two seconds. So an install of any size,
 * from one changed file to all of them, now costs ZERO requests and one
 * round trip, where it used to cost one request per changed file.
 *
 * The bytes are still checked. Each entry is hashed as git hashes a blob
 * and compared with the SHA the tree listed, so the archive is a transport
 * and never a source of truth — a file that does not match is not written.
 */
const MAX_ARCHIVE = 60 * 1024 * 1024;

/** GET that follows GitHub's redirect to codeload and keeps the bytes. */
function download(src, url, timeoutMs, hops = 0, onBytes = null) {
  return new Promise((resolve, reject) => {
    if (hops > 5) { reject(new Error("too_many_redirects")); return; }
    const u = new URL(url);
    /* Only ever GitHub's own hosts: a Location header is attacker-shaped
       input if the answer is trusted blindly. */
    if (u.protocol !== "https:" || !/(^|\.)github\.com$/.test(u.hostname)) {
      reject(new Error("bad_redirect"));
      return;
    }
    const headers = {
      "Accept": "application/vnd.github+json",
      "User-Agent": "AURION-Updater/2.0",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    /* The token authorises the API host. codeload answers a signed URL and
       does not need it, and sending credentials on a redirect is how they
       leak, so it stops at the first hop. */
    if (src.token && u.hostname === API_HOST) headers["Authorization"] = "Bearer " + src.token;
    const req = https.request({
      hostname: u.hostname,
      port: 443,
      path: u.pathname + u.search,
      method: "GET",
      headers,
      timeout: timeoutMs,
      rejectUnauthorized: true,
      minVersion: "TLSv1.2",
    }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        resolve(download(src, new URL(res.headers.location, url).toString(), timeoutMs, hops + 1, onBytes));
        return;
      }
      const chunks = [];
      let total = 0;
      res.on("data", (chunk) => {
        total += chunk.length;
        if (total > MAX_ARCHIVE) { req.destroy(new Error("archive_too_large")); return; }
        chunks.push(chunk);
        /* The only honest download figure there is. codeload sends the
           archive chunked, with no Content-Length and no answer to a
           Range request - measured, both times - so how big the
           transfer will be is genuinely unknown until it has happened.
           What IS knowable is how much has arrived, so that is what the
           install screen shows while it waits. */
        if (onBytes) { try { onBytes(total); } catch (e) { /* reporting must not stop a download */ } }
      });
      res.on("end", () => {
        if (u.hostname === API_HOST) noteRate(res.headers, Boolean(src.token));
        const spent = Number(res.headers["x-ratelimit-remaining"]) === 0;
        if ((res.statusCode === 403 || res.statusCode === 429) && spent) { reject(rateLimitError()); return; }
        if (res.statusCode === 404) { reject(new Error("github_not_found")); return; }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error("github_http_" + res.statusCode));
          return;
        }
        resolve(Buffer.concat(chunks));
      });
    });
    req.on("error", (e) => reject(new Error("network_error" + (e && e.code ? ":" + e.code : ""))));
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.end();
  });
}

/**
 * Read a zip into path -> bytes.
 *
 * Driven from the central directory rather than by walking local headers,
 * because an entry streamed into the archive carries its sizes in a
 * trailing descriptor that the local header does not have. Only the two
 * methods GitHub actually emits are accepted; anything else is refused
 * rather than guessed at.
 */
function readZip(buf) {
  let eocd = -1;
  const floor = Math.max(0, buf.length - 66000);
  for (let i = buf.length - 22; i >= floor; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("bad_archive");
  let count = buf.readUInt16LE(eocd + 10);
  let start = buf.readUInt32LE(eocd + 16);
  /* A tree big enough to saturate the 32-bit fields keeps its real ones
     in the zip64 record that sits just before the end of directory. */
  if (start === 0xffffffff || count === 0xffff) {
    const loc = eocd - 20;
    if (loc < 0 || buf.readUInt32LE(loc) !== 0x07064b50) throw new Error("bad_archive");
    const z64 = Number(buf.readBigUInt64LE(loc + 8));
    if (z64 < 0 || z64 + 56 > buf.length || buf.readUInt32LE(z64) !== 0x06064b50) throw new Error("bad_archive");
    count = Number(buf.readBigUInt64LE(z64 + 32));
    start = Number(buf.readBigUInt64LE(z64 + 48));
  }
  const out = new Map();
  let off = start;
  for (let i = 0; i < count; i++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) throw new Error("bad_archive");
    const method = buf.readUInt16LE(off + 10);
    const csize = buf.readUInt32LE(off + 20);
    const nlen = buf.readUInt16LE(off + 28);
    const elen = buf.readUInt16LE(off + 30);
    const clen = buf.readUInt16LE(off + 32);
    const lho = buf.readUInt32LE(off + 42);
    const name = buf.toString("utf8", off + 46, off + 46 + nlen);
    off += 46 + nlen + elen + clen;
    if (name.endsWith("/")) continue;
    if (lho + 30 > buf.length || buf.readUInt32LE(lho) !== 0x04034b50) throw new Error("bad_archive");
    const dataAt = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
    if (dataAt + csize > buf.length) throw new Error("bad_archive");
    const raw = buf.subarray(dataAt, dataAt + csize);
    if (method === 0) out.set(name, Buffer.from(raw));
    else if (method === 8) out.set(name, zlib.inflateRawSync(raw));
    else throw new Error("bad_archive");
  }
  return out;
}

/**
 * The tree at `ref`, keyed by repository-relative path.
 *
 * GitHub wraps the archive in a single "<owner>-<repo>-<sha>/" folder; the
 * caller wants "apps/web/js/app.js", so that one leading segment comes off.
 */
async function fetchSnapshot(cfg, ref, onBytes) {
  const src = getSource(cfg);
  if (!/^[A-Za-z0-9._\/-]{1,120}$/.test(String(ref || ""))) throw new Error("bad_ref");
  const buf = await download(
    src,
    `https://${API_HOST}/repos/${src.owner}/${src.repo}/zipball/${encodeURIComponent(ref)}`,
    120000,
    0,
    typeof onBytes === "function" ? onBytes : null
  );
  const entries = readZip(buf);
  const files = new Map();
  for (const [name, bytes] of entries) {
    const cut = name.indexOf("/");
    if (cut < 0) continue;
    files.set(name.slice(cut + 1), bytes);
  }
  if (!files.size) throw new Error("bad_archive");
  return files;
}

/**
 * One file's bytes, verified against the SHA it was asked for.
 *
 * The blobs API answers base64 for anything it will serve, so the content
 * is decoded and then re-hashed as git would. A mismatch means the bytes
 * are not the bytes the tree listed, and the apply stops rather than
 * writing them.
 */
async function fetchFile(cfg, file) {
  const src = getSource(cfg);
  const sha = String((file && file.hash) || (file && file.id) || "");
  if (!/^[0-9a-f]{40}$/i.test(sha)) throw new Error("bad_blob_id");
  const blob = await request(src, `/repos/${src.owner}/${src.repo}/git/blobs/${sha}`, 60000);
  if (!blob || typeof blob.content !== "string" || blob.encoding !== "base64") {
    throw new Error("bad_blob");
  }
  const buffer = Buffer.from(blob.content, "base64");
  if (buffer.length > MAX_BLOB) throw new Error("file_too_large");
  const got = blobSha(buffer);
  if (got !== sha.toLowerCase()) throw new Error("hash_mismatch");
  return { buffer, filePath: String(file.filePath || ""), hash: got };
}

module.exports = {
  UPDATE_BRANCH,
  remoteVersion,
  containedInMain,
  INCLUDE_DIRS,
  INCLUDE_FILES,
  getSource,
  describe,
  isShippable,
  isProtected,
  blobSha,
  localBlobSha,
  resolveTarget,
  check,
  fetchFile,
  fetchSnapshot,
  readZip,
  rateState,
  rateExhausted,
  rateLimitError,
};
