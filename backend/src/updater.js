"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const https = require("https");
const http = require("http");

const { ROOT, DATA } = require("./paths");
const { load: loadConfig } = require("./config");
const github = require("./github-update");

const UPDATE_SETTINGS_FILE = path.join(DATA, "update-settings.json");
const UPDATE_STATE_FILE = path.join(DATA, "update-state.json");
const MANIFEST_FILE = path.join(DATA, "local-manifest.json");

function ensureDirSecure(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch {}
}

function readJsonSecure(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const raw = fs.readFileSync(file, "utf8");
    if (raw.length > 5 * 1024 * 1024) return fallback;
    return JSON.parse(raw);
  } catch { return fallback; }
}

function writeSecure(file, data) {
  ensureDirSecure(path.dirname(file));
  const tmp = file + ".tmp";
  const json = JSON.stringify(data, null, 2);
  fs.writeFileSync(tmp, json, { encoding: "utf8", mode: 0o600 });
  try { fs.chmodSync(tmp, 0o600); } catch {}
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch {}
}

/**
 * Which channel this installation updates from.
 *
 * GitHub unless the configuration explicitly says otherwise. The private
 * update server in admin/update-server still works and is still reachable
 * by setting update_server.source to "server" — it is how an operator
 * ships a build that is not public — but it is no longer what a plain
 * installation uses, because it required a second service to be running
 * somewhere for any fix to reach anyone.
 */
function getSourceKind() {
  try {
    const cfg = loadConfig() || {};
    const kind = String((cfg.update_server && cfg.update_server.source) || "").trim().toLowerCase();
    if (kind === "server" || kind === "update_server") return "server";
    if (kind === "github") return "github";
    /* No explicit choice: GitHub, which needs nothing configured. */
    return "github";
  } catch { return "github"; }
}

function liveConfig() {
  let cfg;
  try { cfg = loadConfig() || {}; } catch { cfg = {}; }
  /* The desk no longer holds a token of its own.
     
     One was offered in the update panel, to raise the GitHub ceiling
     from 60 requests an hour to 5000. It is not needed any more: a
     check costs three requests cold and none when nothing has moved,
     and an install costs none at all since it started taking the whole
     tree from the archive endpoint. Four checks a day against a limit
     of sixty an hour is not a budget worth asking a trader to manage a
     secret for.
     
     What is left is the machine's own: AURION_GITHUB_TOKEN in the
     environment, or update_server.github.token in config/aurion.json,
     which is the operator's live config and is never shipped. Neither
     can be set from the dashboard, so no secret is typed into, stored
     by, or returned from the desk. */
  purgeStoredToken();
  return cfg;
}

/**
 * Remove a token an older build let somebody type into the desk.
 *
 * The field is gone, so nothing can clear it any more - and a secret
 * sitting in a file that the product no longer has any way to manage is
 * worse than one that is merely unnecessary. It is deleted the first
 * time this runs, in place, with the same 0600 write as everything else
 * in that file.
 *
 * Only the desk's copy. A token in the environment or in the operator's
 * own config is theirs, is not a thing the dashboard can reach, and is
 * left exactly where they put it.
 */
let tokenPurged = false;
function purgeStoredToken() {
  if (tokenPurged) return false;
  tokenPurged = true;
  try {
    const stored = readJsonSecure(UPDATE_SETTINGS_FILE, {});
    if (!("github_token" in stored)) return false;
    delete stored.github_token;
    writeSecure(UPDATE_SETTINGS_FILE, stored);
    return true;
  } catch {
    return false;
  }
}

function getSourceUrl() {
  // Source-defined URL: config/aurion.json -> update_server.url (authoritative, not editable from dashboard)
  try {
    const cfgPath = path.join(ROOT, "config", "aurion.json");
    if (fs.existsSync(cfgPath)) {
      const raw = fs.readFileSync(cfgPath, "utf8");
      const cfg = JSON.parse(raw);
      const url = cfg && cfg.update_server && cfg.update_server.url ? String(cfg.update_server.url).trim() : "";
      if (url) return url;
    }
  } catch {}
  try {
    const live = loadConfig();
    if (live && live.update_server && live.update_server.url) {
      return String(live.update_server.url).trim();
    }
  } catch {}
  return "";
}

function getSettings() {
  const defaults = {
    update_server_url: "",
    auto_check_enabled: false,
    auto_check_interval_hours: 6,
    last_check: null,
    last_check_result: null,
  };
  const stored = readJsonSecure(UPDATE_SETTINGS_FILE, {});
  const merged = { ...defaults, ...stored };
  /* Belt and braces. Nothing writes a token here any more, but a file
     left over from an older build might still carry one, and a secret
     must not travel back out on a settings read on its way to being
     deleted. */
  delete merged.github_token;

  /* On GitHub there is no server URL to show, and showing an empty one
     read as "updates are not configured" when they are. The panel gets
     the repository it will actually ask, in the same field. */
  merged.source_kind = getSourceKind();
  if (merged.source_kind === "github") {
    const src = github.getSource(liveConfig());
    merged.update_server_url = github.describe(src);
    merged.source_url = merged.update_server_url;
    merged.source_defined = true;
    merged.github = {
      owner: src.owner,
      repo: src.repo,
      branch: src.branch,
      branch_locked: true,
      /* Empty unless a config names some other branch. Carried through so
         the panel can say it is being ignored rather than leaving someone
         to wonder why their edit did nothing. */
      ignored_branch: src.ignored_branch || "",
      authenticated: Boolean(src.token),
    };
    return merged;
  }

  const sourceUrl = getSourceUrl();
  // Authoritative source URL overrides any dashboard stored value
  if (sourceUrl) {
    merged.update_server_url = sourceUrl;
    merged.source_url = sourceUrl;
    merged.source_defined = true;
  } else {
    merged.source_defined = false;
    merged.source_url = "";
  }
  return merged;
}

function saveSettings(patch) {
  // Disallow editing update_server_url from dashboard - source defined only
  const safePatch = { ...(patch || {}) };
  if ("update_server_url" in safePatch) delete safePatch.update_server_url;
  if ("source_url" in safePatch) delete safePatch.source_url;
  const current = getSettings();
  const next = { ...current, ...safePatch };
  /* A token cannot arrive here: the route does not accept one and the
     panel has no field. Dropped rather than ignored, so a caller that
     passes one anyway cannot write a secret into this file. */
  delete safePatch.github_token;
  delete next.github_token;
  // Ensure source URL remains authoritative
  const src = getSourceUrl();
  if (src) {
    next.update_server_url = src;
    next.source_url = src;
    next.source_defined = true;
  }
  writeSecure(UPDATE_SETTINGS_FILE, {
    auto_check_enabled: next.auto_check_enabled,
    auto_check_interval_hours: next.auto_check_interval_hours,
    last_check: next.last_check,
    last_check_result: next.last_check_result,
    // do not persist url from dashboard, only from source; keep placeholder for compatibility
    _note: "update_server_url is source-defined in config/aurion.json",
  });
  return getSettings();
}

function computeFileHash(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) return null;
    if (stat.size > 50 * 1024 * 1024) return null;
    const buf = fs.readFileSync(filePath);
    return crypto.createHash("sha256").update(buf).digest("hex");
  } catch { return null; }
}

function collectLocalManifest() {
  // collect important files for diff check
  const files = [];
  const includeDirs = [
    path.join(ROOT, "backend", "src"),
    path.join(ROOT, "engine", "aurion"),
    path.join(ROOT, "apps", "web", "js"),
    // The MetaTrader experts travel with the update too.
    //
    // They were left out, so an update could change the protocol the desk
    // speaks while the .mq5 on disk stayed at the old version - and the
    // user had no new file to compile even if they wanted to. Shipping
    // them is half the fix; the desk comparing versions is the other half.
    path.join(ROOT, "engine", "ea"),
  ];
  const maxFiles = 500;
  let count = 0;

  function walk(dir, base) {
    if (count >= maxFiles) return;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const e of entries) {
        if (count >= maxFiles) break;
        if (e.name.startsWith(".") || e.name === "node_modules" || e.name === "__pycache__") continue;
        const full = path.join(dir, e.name);
        const rel = path.relative(ROOT, full).replace(/\\/g, "/");
        if (e.isDirectory()) {
          walk(full, base);
        } else if (e.isFile()) {
          if (full.endsWith(".log") || full.endsWith(".pyc")) continue;
          const hash = computeFileHash(full);
          if (hash) {
            files.push({ path: rel, hash });
            count++;
          }
        }
      }
    } catch {}
  }

  for (const d of includeDirs) {
    if (fs.existsSync(d)) walk(d, d);
  }

  // also version from config
  try {
    const cfg = loadConfig();
    const version = cfg.version || "1.0.0";
    writeSecure(MANIFEST_FILE, { version, files, generated_at: new Date().toISOString() });
    return { version, files };
  } catch {
    const version = "1.0.0";
    writeSecure(MANIFEST_FILE, { version, files, generated_at: new Date().toISOString() });
    return { version, files };
  }
}

function httpsJson(url, body, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    try {
      const u = new URL(url);
      const isHttps = u.protocol === "https:";
      const lib = isHttps ? https : http;
      const payload = body ? JSON.stringify(body) : null;
      const opts = {
        hostname: u.hostname,
        port: u.port || (isHttps ? 443 : 80),
        path: u.pathname + (u.search || ""),
        method: body ? "POST" : "GET",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json",
          "User-Agent": "AURION-Updater/1.0",
        },
        timeout: timeoutMs,
      };
      if (isHttps) {
        opts.rejectUnauthorized = true;
        opts.minVersion = "TLSv1.2";
      }
      if (payload) opts.headers["Content-Length"] = Buffer.byteLength(payload);

      const req = lib.request(opts, (res) => {
        let data = "";
        let total = 0;
        res.on("data", chunk => {
          total += chunk.length;
          if (total > 5 * 1024 * 1024) {
            req.destroy(new Error("response_too_large"));
            return;
          }
          data += chunk;
        });
        res.on("end", () => {
          try {
            const json = JSON.parse(data);
            resolve({ status: res.statusCode, json, headers: res.headers });
          } catch (e) {
            reject(new Error("invalid_json"));
          }
        });
      });
      req.on("error", reject);
      req.on("timeout", () => { req.destroy(new Error("timeout")); });
      if (payload) req.write(payload);
      req.end();
    } catch (e) { reject(e); }
  });
}

/**
 * Press "check for updates", ask GitHub.
 *
 * The answer is shaped exactly like the update server's, because the
 * route, the panel, the licence box and the About page all read that
 * shape already and none of them should have to know where the bytes
 * come from. The only addition is `source`, so the panel can say which
 * repository it just asked rather than leaving the user to trust it.
 */
async function checkGithub() {
  try {
    const res = await github.check(liveConfig());
    /* Three different things, kept apart:
         update_available - a published release this machine does not have.
                            The only one the desk announces and the only one
                            the support clock is allowed to read.
         behind           - the tracked branch has moved. True after any
                            commit; a development fact, not an offer.
         latest           - the target either way, so the owner can still
                            install the branch build deliberately. */
    const behind = !!res.behind || !!res.update_available;
    const state = {
      last_check: new Date().toISOString(),
      update_available: !!res.update_available,
      latest: behind ? res.update : null,
      unpublished: behind && !res.published,
      source: res.source,
      channel: res.channel,
    };
    writeSecure(UPDATE_STATE_FILE, state);
    saveSettings({ last_check: state.last_check, last_check_result: state });
    return { ok: true, ...state };
  } catch (e) {
    const err = (e && e.message) || "network_error";
    /* A rate limit is temporary, and the one fact that makes it
       actionable is when it stops being true. Carried out to the panel
       alongside the last answer that did work, so the section still
       shows what this desk is running instead of going blank over a
       failure that will clear by itself. */
    const out = { ok: false, error: err };
    if (err === "github_rate_limited") {
      const rate = github.rateState();
      if (e.resetAt) out.reset_at = e.resetAt;
      if (Number.isFinite(e.retryAfterSeconds)) out.retry_after_seconds = e.retryAfterSeconds;
      out.rate_limit = rate.limit || 0;
      out.rate_authenticated = Boolean(rate.authenticated);
      const prev = getUpdateState();
      if (prev && prev.last_check) out.last_known = prev;
    }
    return out;
  }
}

async function checkForUpdates() {
  if (getSourceKind() === "github") return checkGithub();
  const settings = getSettings();
  if (!settings.update_server_url) {
    return { ok: false, error: "update_server_not_configured" };
  }
  const manifest = collectLocalManifest();
  const url = String(settings.update_server_url).replace(/\/+$/, "") + "/api/updates/check";
  try {
    const result = await httpsJson(url, {
      current_version: manifest.version,
      files: manifest.files,
    }, 20000);
    const data = result.json;
    if (!data || !data.ok) {
      return { ok: false, error: data?.error || "server_error" };
    }
    // save state
    const state = {
      last_check: new Date().toISOString(),
      update_available: !!data.update_available,
      latest: data.update || null,
    };
    writeSecure(UPDATE_STATE_FILE, state);
    saveSettings({ last_check: state.last_check, last_check_result: state });

    return { ok: true, ...state };
  } catch (e) {
    return { ok: false, error: e.message || "network_error" };
  }
}

async function downloadUpdateFile(updateId, fileId, serverUrl) {
  const url = String(serverUrl).replace(/\/+$/, "") + `/api/updates/file/${encodeURIComponent(updateId)}/${encodeURIComponent(fileId)}`;
  return new Promise((resolve, reject) => {
    try {
      const u = new URL(url);
      const isHttps = u.protocol === "https:";
      const lib = isHttps ? https : http;
      const opts = {
        hostname: u.hostname,
        port: u.port || (isHttps ? 443 : 80),
        path: u.pathname,
        method: "GET",
        headers: { "User-Agent": "AURION-Updater/1.0", "Accept": "application/octet-stream" },
        timeout: 30000,
      };
      if (isHttps) {
        opts.rejectUnauthorized = true;
        opts.minVersion = "TLSv1.2";
      }
      const req = lib.request(opts, (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`http_${res.statusCode}`));
          return;
        }
        const chunks = [];
        let total = 0;
        res.on("data", chunk => {
          total += chunk.length;
          if (total > 50 * 1024 * 1024) {
            req.destroy(new Error("file_too_large"));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          const buf = Buffer.concat(chunks);
          const filePath = res.headers["x-file-path"];
          const fileHash = res.headers["x-file-hash"];
          const hash = crypto.createHash("sha256").update(buf).digest("hex");
          if (fileHash && hash !== fileHash) {
            reject(new Error("hash_mismatch"));
            return;
          }
          resolve({ buffer: buf, filePath, hash });
        });
      });
      req.on("error", reject);
      req.on("timeout", () => req.destroy(new Error("timeout")));
      req.end();
    } catch (e) { reject(e); }
  });
}

/**
 * Where the running install has got to.
 *
 * An install is one POST that can take the better part of a minute, and
 * a screen that cannot say anything about it has to either lie with an
 * animation or show nothing. Neither is necessary: the apply loop knows
 * exactly how many files there are and exactly how many it has written,
 * so it publishes that and the desk polls it.
 *
 * Deliberately a plain object and not persisted. It describes a thing
 * happening in this process right now; after a restart there is nothing
 * to report, and a stale figure read off a file would be worse than no
 * figure at all.
 */
let applyProgress = { active: false, phase: "idle", done: 0, total: 0, file: "", bytes: 0, change_bytes: 0, started: 0 };

function setProgress(patch) {
  applyProgress = { ...applyProgress, ...patch };
}

/** What the desk polls while it waits for the apply to come back. */
function getApplyProgress() {
  return { ...applyProgress };
}

/**
 * A file out of the downloaded archive, or null to go and ask for it.
 *
 * The archive is a transport, not an authority: the bytes are hashed the
 * way git hashes a blob and compared with the SHA the tree listed. A file
 * that is missing from it, or whose content does not match, falls through
 * to the per-file request rather than being written on trust.
 */
function takeFromSnapshot(snapshot, f) {
  const rel = String(f.filePath || "").replace(/\\/g, "/");
  const want = String(f.hash || f.id || "").toLowerCase();
  const buffer = snapshot.get(rel);
  if (!buffer || !/^[0-9a-f]{40}$/.test(want)) return null;
  if (github.blobSha(buffer) !== want) return null;
  return { buffer, filePath: rel, hash: want };
}

async function applyUpdate(updateId, serverUrl) {
  const kind = getSourceKind();
  // only apply if published and exists
  const settings = getSettings();
  /* GitHub needs no URL: the repository is the address. */
  const url = kind === "github"
    ? ""
    : String(serverUrl || settings.update_server_url).replace(/\/+$/, "");
  if (kind !== "github" && !url) return { ok: false, error: "no_server" };

  let state = readJsonSecure(UPDATE_STATE_FILE, {});
  const latest = state.latest;
  if (!latest || latest.id !== updateId) {
    // re-check
    const check = await checkForUpdates();
    if (!check.ok || !check.latest || check.latest.id !== updateId) {
      return { ok: false, error: "update_not_found" };
    }
    /* Re-read it. The file list below came from `state`, and before this
       a re-check refreshed the file on disk while the stale object stayed
       in hand - so the one path that had to fetch a fresh manifest was
       the one path that then applied the old one. */
    state = readJsonSecure(UPDATE_STATE_FILE, {});
  }

  // Never let a remote manifest overwrite user state:
  //   data/**            -> users.json, jwt.secret, DBs, logs AND the license
  //                         (data/license) — the license must survive updates
  //   config/aurion.json -> the user's live config (mt5 credentials, license
  //                         otp, settings); the factory copy is authoritative
  //   config/news_calendar* -> runtime calendar fetched from the news feed
  const files = (state.latest?.files || []).filter(f => {
    const p = String(f?.filePath || "").replace(/\\/g, "/");
    if (!p) return false;
    if (p === "data" || p.startsWith("data/")) return false;
    if (p === "config/aurion.json") return false;
    if (p.startsWith("config/news_calendar")) return false;
    /* On the GitHub channel, hold the write to the same set the check
       was allowed to read. The state file is the only thing standing
       between a file list and a write loop, and a list that named
       installer/ or tests/ would otherwise be honoured. */
    if (kind === "github" && !github.isShippable(p)) return false;
    return true;
  });
  /* Nothing to do is not a failure. The check leaves out every file whose
     content already matches the remote one, so an empty list means this
     desk is already running the build it was asked to install, and the
     panel should say exactly that instead of reporting an error. */
  if (!files.length) {
    setProgress({ active: false, phase: "done", done: 0, total: 0, file: "" });
    return { ok: true, already_current: true, applied: [], version: state.latest?.version || "" };
  }

  const backupDir = path.join(DATA, "update_backups", updateId + "_" + Date.now());
  ensureDirSecure(backupDir);

  /* One download for the whole tree, instead of one request per file.
     The blobs API costs a request each, against sixty an hour without a
     token, so an install of any real size used to run out of budget part
     way through and stop with "github_rate_limited" - reported from the
     field. The archive comes from codeload, which does not draw on that
     budget at all, so this costs nothing and one round trip. Every file
     taken out of it is still hashed against the SHA the tree listed.

     If it cannot be had, the per-file path below still works; it is just
     the expensive way round. */
  setProgress({
    active: true, phase: "download", done: 0, total: files.length, file: "",
    bytes: 0,
    /* What the update writes, which the check counted exactly. Not the
       size of the transfer: the archive's length is not declared in
       advance by the host that serves it. */
    change_bytes: Number(state.latest?.download_bytes) || 0,
    started: Date.now(),
  });

  let snapshot = null;
  if (kind === "github" && state.latest?.ref) {
    try {
      /* Reported as it arrives, so the screen can show a real number
         during the one phase whose length nothing can predict. */
      snapshot = await github.fetchSnapshot(liveConfig(), state.latest.ref, (n) => setProgress({ bytes: n }));
    } catch (e) {
      snapshot = null;
    }
  }

  setProgress({ phase: "apply" });
  const applied = [];
  try {
    for (const f of files) {
      const fromArchive = snapshot ? takeFromSnapshot(snapshot, f) : null;
      const dl = fromArchive
        ? fromArchive
        : kind === "github"
          ? await github.fetchFile(liveConfig(), f)
          : await downloadUpdateFile(updateId, f.id, url);
      const targetPath = path.join(ROOT, dl.filePath);
      const safeRoot = path.resolve(ROOT);
      const safeTarget = path.resolve(targetPath);
      if (!safeTarget.startsWith(safeRoot)) {
        throw new Error("path_traversal_blocked: " + dl.filePath);
      }
      // backup old file if exists
      if (fs.existsSync(safeTarget)) {
        const backupPath = path.join(backupDir, dl.filePath);
        ensureDirSecure(path.dirname(backupPath));
        fs.copyFileSync(safeTarget, backupPath);
      }
      ensureDirSecure(path.dirname(safeTarget));
      // atomic write
      const tmp = safeTarget + ".tmp." + Date.now();
      fs.writeFileSync(tmp, dl.buffer, { mode: 0o600 });
      try { fs.chmodSync(tmp, 0o600); } catch {}
      fs.renameSync(tmp, safeTarget);
      try { fs.chmodSync(safeTarget, 0o600); } catch {}
      applied.push(dl.filePath);
      setProgress({ done: applied.length, file: dl.filePath });
    }

    // update version in config if needed
    try {
      const cfgPath = path.join(ROOT, "config", "aurion.json");
      if (fs.existsSync(cfgPath)) {
        const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
        cfg.version = state.latest.version || cfg.version;
        const tmp = cfgPath + ".tmp";
        fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
        fs.renameSync(tmp, cfgPath);
      }
    } catch {}

    // Did this update touch MetaTrader? Nothing here can recompile an
    // expert inside a terminal, so the one useful thing to do is say it
    // plainly and keep saying it until the chart reports the new version.
    const eaFiles = applied.filter((p) => String(p).replace(/\\/g, "/").startsWith("engine/ea/"));
    if (eaFiles.length) copyExpertsToTerminals();

    writeSecure(path.join(DATA, "last-update.json"), {
      update_id: updateId,
      version: state.latest.version,
      applied_at: new Date().toISOString(),
      files: applied,
      backup_dir: backupDir,
      ea_files: eaFiles,
      ea_changed: eaFiles.length > 0,
    });

    /* This installation is now the version it was being offered, so the
       stored answer to "is an update available" is stale and saying yes.
       Left alone it would keep the end-of-support lock closed over an
       update that has just been installed, until the next check happened
       to run. Cleared here, at the moment it stopped being true. */
    writeSecure(UPDATE_STATE_FILE, {
      last_check: new Date().toISOString(),
      update_available: false,
      latest: null,
      installed_version: state.latest.version || "",
      installed_at: new Date().toISOString(),
    });

    setProgress({ active: false, phase: "done", done: applied.length, file: "" });
    return {
      ok: true,
      applied,
      backup_dir: backupDir,
      version: state.latest.version,
      ea_changed: eaFiles.length > 0,
      ea_files: eaFiles,
    };
  } catch (e) {
    /* Say how far it got. An install that stops part way has left the
       machine in a mixed state, and "github_rate_limited" on its own
       tells the user neither that anything was written nor when they
       may try again. The remaining count and the reset time come
       straight from the headers of the response that refused. */
    setProgress({ active: false, phase: "failed", file: "" });
    const rate = github.rateState ? github.rateState() : null;
    const out = { ok: false, error: e.message, applied, applied_count: applied.length, remaining: files.length - applied.length };
    if (e.message === "github_rate_limited") {
      const reset = e.resetAt || (rate && rate.reset > 0 ? new Date(rate.reset * 1000).toISOString() : "");
      if (reset) out.reset_at = reset;
      if (e.retryAfterSeconds != null) out.retry_after_seconds = e.retryAfterSeconds;
      if (rate) out.rate_authenticated = Boolean(rate.authenticated);
    }
    return out;
  }
}

/**
 * Push the freshly updated experts next to MetaTrader, right away.
 *
 * "Everything updates together" is only half true for MetaTrader: the file
 * can be put where the terminal will find it, but compiling it and
 * re-attaching it to the chart is a human action inside MetaEditor. Doing
 * the half that is possible, at the moment of the update rather than at the
 * next start, is what makes the desk's warning actionable: the new file is
 * already there, so the user only has to press F7.
 *
 * Best effort by design - a failure here must never fail an update, and on
 * anything but Windows there is no terminal to copy into.
 */
function copyExpertsToTerminals() {
  if (process.platform !== "win32") return false;
  try {
    const script = path.join(ROOT, "scripts", "copy-ea.ps1");
    if (!fs.existsSync(script)) return false;
    const { spawnSync } = require("child_process");
    spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script], {
      timeout: 20000,
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

function getUpdateState() {
  const state = readJsonSecure(UPDATE_STATE_FILE, { last_check: null, update_available: false, latest: null });
  /* Sanitise a file written before an update was defined as "a release
     somebody published".
     
     Those files claim update_available for whatever the tracked branch
     happened to contain at the time, which is how an installation whose
     owner had released nothing was told to update - and then warned it
     had five days left. The claim is dropped here, on the read, so every
     caller is corrected at once and without waiting for the next check;
     the file itself is rewritten the next time one runs. */
  if (state && state.latest && state.latest.published !== true && state.update_available) {
    state.update_available = false;
    state.unpublished = true;
  }
  // Carry the last applied update with it, so the desk can tell the user
  // "the experts changed in this update" without a second request.
  const last = readJsonSecure(path.join(DATA, "last-update.json"), null);
  if (last) {
    state.last_applied = {
      version: last.version || "",
      applied_at: last.applied_at || "",
      ea_changed: !!last.ea_changed,
      ea_files: last.ea_files || [],
    };
  }
  return state;
}

let autoCheckTimer = null;
function startAutoChecker() {
  if (autoCheckTimer) clearInterval(autoCheckTimer);
  const settings = getSettings();
  if (!settings.auto_check_enabled) return;
  if (getSourceKind() !== "github" && !settings.update_server_url) return;
  const hours = Math.max(1, Math.min(168, Number(settings.auto_check_interval_hours) || 6));
  const ms = hours * 3600 * 1000;
  autoCheckTimer = setInterval(async () => {
    try { await checkForUpdates(); } catch {}
  }, ms);
  // also check shortly after start
  setTimeout(async () => { try { await checkForUpdates(); } catch {} }, 30000);
}

function stopAutoChecker() {
  if (autoCheckTimer) { clearInterval(autoCheckTimer); autoCheckTimer = null; }
}

/* On the way up, every time.
 *
 * The purge above runs whenever the updater reads its config, which
 * covers opening the panel or checking for an update - but a desk whose
 * owner does neither again would keep carrying the token it can no
 * longer manage. Doing it at boot makes the removal certain, and the
 * flag inside means it costs one file read per process. */
try { purgeStoredToken(); } catch { /* never block startup over this */ }

module.exports = {
  copyExpertsToTerminals,
  purgeStoredToken,
  getSourceKind,
  getSettings,
  saveSettings,
  checkForUpdates,
  applyUpdate,
  getUpdateState,
  getApplyProgress,
  collectLocalManifest,
  startAutoChecker,
  stopAutoChecker,
};
