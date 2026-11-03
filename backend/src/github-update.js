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

const { ROOT } = require("./paths");

const API_HOST = "api.github.com";

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
    const headers = {
      "Accept": "application/vnd.github+json",
      "User-Agent": "AURION-Updater/2.0",
      "X-GitHub-Api-Version": "2022-11-28",
    };
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
        /* A rate limit is not a server error and must not be reported as
           one: it is the single most likely failure on an unauthenticated
           machine that checks often, and "try again later" is advice the
           user can act on, where "github_403" is not. */
        if (res.statusCode === 403 && /rate limit/i.test(data)) {
          reject(new Error("github_rate_limited"));
          return;
        }
        if (res.statusCode === 404) { reject(new Error("github_not_found")); return; }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error("github_http_" + res.statusCode));
          return;
        }
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error("invalid_json")); }
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
       and a branch build has none. */
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

  return {
    ok: true,
    source: describe(src),
    channel: target.channel,
    update_available: files.length > 0,
    update: {
      id: target.id,
      ref: target.ref,
      version,
      build_date: target.build_date || "",
      changelog: target.changelog,
      published_at: target.published_at,
      html_url: target.html_url,
      files,
    },
    truncated: truncatedScan || Boolean(tree.truncated),
  };
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
};
