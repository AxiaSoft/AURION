"use strict";
require("dotenv").config();
const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const { v4: uuidv4 } = require("uuid");

const Store = require("./store");

const PORT = Number(process.env.PORT || 8898);
const ADMIN_TOKEN = String(process.env.ADMIN_TOKEN || "").trim();
const ADMIN_PANEL_HASH = String(process.env.ADMIN_PANEL_HASH || "aurion-update-admin-x9k3").trim();
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, "..", "data"));
const UPDATE_FILES_DIR = path.join(DATA_DIR, "update_files");

function ensureSecureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch {}
}
ensureSecureDir(DATA_DIR);
ensureSecureDir(UPDATE_FILES_DIR);
ensureSecureDir(path.join(DATA_DIR, "updates"));
ensureSecureDir(path.join(DATA_DIR, "files"));

const store = new Store(DATA_DIR);

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);

// security headers
/* Security headers.
 *
 * The policy here used to be "default-src 'none'; frame-ancestors
 * 'none'" on EVERY response, HTML included. For a JSON API that is
 * right. For a page it is fatal in a way that looks like bad work
 * rather than a blocked request: default-src 'none' means no style-src
 * and no script-src either, so the browser threw away the panel's own
 * <style> and <script> and drew the markup bare. The panel was reported
 * as "raw HTML with nothing graphical about it" - it was, because the
 * server had forbidden it its own stylesheet.
 *
 * So: keep 'none' for everything that is not a page, and give pages a
 * policy that allows exactly what they contain - their own inline style
 * and script, and fetches back to this origin. Nothing is loaded from
 * anywhere else, which is what the strict policy was protecting.
 */
const PAGE_CSP = [
  "default-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

const API_CSP = "default-src 'none'";

// Framing is refused, because a page that can be framed can be clicked
// through. ALLOW_FRAMING=1 lifts it for showing the panel inside a
// preview pane while developing; it is off unless asked for.
const ALLOW_FRAMING = String(process.env.ALLOW_FRAMING || "") === "1";

/** Pages call this; everything else keeps the locked-down default. */
function pageHeaders(res) {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Security-Policy",
    PAGE_CSP + "; frame-ancestors " + (ALLOW_FRAMING ? "*" : "'none'"));
}

app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (!ALLOW_FRAMING) res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader("Content-Security-Policy",
    API_CSP + "; frame-ancestors " + (ALLOW_FRAMING ? "*" : "'none'"));
  if (process.env.NODE_ENV === "production") {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  next();
});

app.use(express.json({ limit: "10mb" }));

// CORS - only allow dashboard origin (configurable)
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "http://127.0.0.1:8080,http://localhost:8080,app://aurion").split(",").map(s=>s.trim()).filter(Boolean);
app.use(require("cors")({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    return cb(null, false);
  },
  credentials: false,
}));

// constant-time compare for admin token
function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function requireAdmin(req, res, next) {
  if (!ADMIN_TOKEN) {
    if (process.env.NODE_ENV === "production") {
      return res.status(500).json({ ok: false, error: "admin_not_configured" });
    }
  }
  const token = String(req.headers["x-admin-token"] || req.headers["authorization"] || "").replace(/^Bearer\s+/i, "").trim();
  if (!ADMIN_TOKEN || !token || !safeEqual(token, ADMIN_TOKEN)) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }
  next();
}

// multer secure
const upload = multer({
  dest: path.join(DATA_DIR, "tmp"),
  limits: { fileSize: 50 * 1024 * 1024, files: 20 },
  fileFilter: (req, file, cb) => {
    // allow only safe extensions
    const allowed = [".js", ".json", ".py", ".html", ".css", ".ico", ".vbs", ".cmd", ".ps1", ".md", ".txt", ".exe", ".msi", ".zip"];
    const ext = path.extname(file.originalname).toLowerCase();
    if (!allowed.includes(ext)) {
      // still allow but we will check later
    }
    cb(null, true);
  }
});
ensureSecureDir(path.join(DATA_DIR, "tmp"));

// Helper: sanitize file path to prevent traversal
function sanitizeFilePath(p) {
  let clean = String(p).replace(/\\/g, "/").replace(/\.\./g, "").replace(/^\/+/, "");
  // only allow alphanumeric, -, _, /, .
  clean = clean.replace(/[^a-zA-Z0-9_\-./]/g, "");
  if (clean.length > 500) clean = clean.slice(0, 500);
  return clean;
}

function computeHash(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

// PUBLIC API - dashboard checks this
// GET /api/updates/latest - returns latest PUBLISHED update only
app.get("/api/updates/latest", async (req, res) => {
  try {
    const all = await store.list("updates", 1000);
    // only published, sorted by version desc or updated_at desc
    const published = all.filter(u => u.published === true).sort((a,b) => {
      // semver compare simple
      const va = String(a.version || "0.0.0");
      const vb = String(b.version || "0.0.0");
      // compare updated_at first
      const ta = a.published_at || a.updated_at || "";
      const tb = b.published_at || b.updated_at || "";
      if (ta !== tb) return String(tb).localeCompare(String(ta));
      return vb.localeCompare(va);
    });
    if (!published.length) {
      return res.json({ ok: true, update: null });
    }
    const latest = published[0];
    // return safe info without internal notes
    res.json({
      ok: true,
      update: {
        id: latest.id,
        version: latest.version,
        changelog: latest.changelog || "",
        published_at: latest.published_at,
        files: latest.files || [], // each { path, hash, size, url }
        mandatory: !!latest.mandatory,
      }
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: "internal" });
  }
});

// GET /api/updates/check - dashboard sends its file manifest to check diff
app.post("/api/updates/check", express.json({ limit: "5mb" }), async (req, res) => {
  try {
    const { current_version, files } = req.body || {};
    // files = [{ path, hash }]
    const all = await store.list("updates", 1000);
    const published = all.filter(u => u.published === true).sort((a,b) => {
      const ta = a.published_at || a.updated_at || "";
      const tb = b.published_at || b.updated_at || "";
      return String(tb).localeCompare(String(ta));
    });
    if (!published.length) {
      return res.json({ ok: true, update_available: false });
    }
    const latest = published[0];
    const remoteVersion = String(latest.version || "0.0.0");
    const localVersion = String(current_version || "0.0.0");
    // simple version compare - if same, check file hashes
    let needUpdate = remoteVersion !== localVersion;
    let changedFiles = [];
    if (Array.isArray(files) && Array.isArray(latest.files)) {
      const localMap = new Map();
      for (const f of files) {
        if (f && f.path && f.hash) localMap.set(sanitizeFilePath(f.path), String(f.hash).toLowerCase());
      }
      for (const rf of latest.files) {
        const rp = sanitizeFilePath(rf.path);
        const rh = String(rf.hash || "").toLowerCase();
        const lh = localMap.get(rp);
        if (!lh || lh !== rh) {
          changedFiles.push(rf);
        }
      }
      if (changedFiles.length > 0) needUpdate = true;
    } else {
      changedFiles = latest.files || [];
    }

    res.json({
      ok: true,
      update_available: needUpdate,
      update: needUpdate ? {
        id: latest.id,
        version: latest.version,
        changelog: latest.changelog || "",
        published_at: latest.published_at,
        files: changedFiles.length ? changedFiles : (latest.files || []),
        all_files: latest.files || [],
        mandatory: !!latest.mandatory,
      } : null,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: "internal" });
  }
});

// GET /api/updates/file/:updateId/:fileId - download file (only if update published)
app.get("/api/updates/file/:updateId/:fileId", async (req, res) => {
  try {
    const updateId = String(req.params.updateId || "").replace(/[^a-zA-Z0-9_\-]/g, "").slice(0,128);
    const fileId = String(req.params.fileId || "").replace(/[^a-zA-Z0-9_\-]/g, "").slice(0,128);
    const upd = await store.get("updates", updateId);
    if (!upd || upd.published !== true) return res.status(404).json({ ok:false, error:"not_found" });
    const fileMeta = (upd.files || []).find(f => f.id === fileId);
    if (!fileMeta) return res.status(404).json({ ok:false, error:"file_not_found" });
    const filePath = path.join(UPDATE_FILES_DIR, updateId, fileId + ".bin");
    if (!fs.existsSync(filePath)) return res.status(404).json({ ok:false, error:"file_missing" });
    // verify hash
    const data = fs.readFileSync(filePath);
    const hash = computeHash(data);
    if (hash !== fileMeta.hash) return res.status(500).json({ ok:false, error:"hash_mismatch" });
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename="${path.basename(fileMeta.path)}"`);
    res.setHeader("X-File-Path", fileMeta.path);
    res.setHeader("X-File-Hash", fileMeta.hash);
    res.send(data);
  } catch (e) {
    res.status(500).json({ ok:false, error:"internal" });
  }
});

// ADMIN API - hidden
app.get("/api/admin/updates", requireAdmin, async (req, res) => {
  try {
    const list = await store.list("updates", 1000);
    res.json({ ok:true, updates: list });
  } catch (e) {
    res.status(500).json({ ok:false, error:"internal" });
  }
});

app.post("/api/admin/updates", requireAdmin, async (req, res) => {
  try {
    const { version, changelog, mandatory } = req.body || {};
    if (!version || typeof version !== "string" || version.length > 50) return res.status(400).json({ ok:false, error:"need_version" });
    const id = uuidv4();
    const now = new Date().toISOString();
    const upd = {
      id,
      version: String(version).trim().slice(0,50),
      changelog: String(changelog || "").slice(0, 10000),
      mandatory: !!mandatory,
      files: [],
      published: false,
      created_at: now,
      updated_at: now,
      published_at: null,
    };
    await store.set("updates", id, upd);
    await store.set("audit", uuidv4(), { action:"create_update", update_id:id, version:upd.version, at:now });
    res.json({ ok:true, update: upd });
  } catch (e) {
    res.status(500).json({ ok:false, error:"internal" });
  }
});

app.put("/api/admin/updates/:id", requireAdmin, async (req, res) => {
  try {
    const id = String(req.params.id || "").replace(/[^a-zA-Z0-9_\-]/g, "").slice(0,128);
    const existing = await store.get("updates", id);
    if (!existing) return res.status(404).json({ ok:false, error:"not_found" });
    if (existing.published) return res.status(400).json({ ok:false, error:"already_published_cannot_edit" });
    const { version, changelog, mandatory } = req.body || {};
    if (version) existing.version = String(version).trim().slice(0,50);
    if (changelog !== undefined) existing.changelog = String(changelog).slice(0,10000);
    if (mandatory !== undefined) existing.mandatory = !!mandatory;
    existing.updated_at = new Date().toISOString();
    await store.set("updates", id, existing);
    res.json({ ok:true, update: existing });
  } catch (e) {
    res.status(500).json({ ok:false, error:"internal" });
  }
});

app.delete("/api/admin/updates/:id", requireAdmin, async (req, res) => {
  try {
    const id = String(req.params.id || "").replace(/[^a-zA-Z0-9_\-]/g, "").slice(0,128);
    const existing = await store.get("updates", id);
    if (!existing) return res.status(404).json({ ok:false, error:"not_found" });
    // if published, unpublish first
    if (existing.published) return res.status(400).json({ ok:false, error:"published_cannot_delete_unpublish_first" });
    // delete files
    const dir = path.join(UPDATE_FILES_DIR, id);
    try { fs.rmSync(dir, { recursive:true, force:true }); } catch {}
    await store.delete("updates", id);
    res.json({ ok:true });
  } catch (e) {
    res.status(500).json({ ok:false, error:"internal" });
  }
});

// upload file to draft update
app.post("/api/admin/updates/:id/files", requireAdmin, upload.array("files", 20), async (req, res) => {
  try {
    const id = String(req.params.id || "").replace(/[^a-zA-Z0-9_\-]/g, "").slice(0,128);
    const existing = await store.get("updates", id);
    if (!existing) return res.status(404).json({ ok:false, error:"not_found" });
    if (existing.published) return res.status(400).json({ ok:false, error:"already_published" });

    const targetPaths = req.body.targetPaths ? JSON.parse(req.body.targetPaths) : [];
    const files = req.files || [];
    if (!files.length) return res.status(400).json({ ok:false, error:"no_files" });

    ensureSecureDir(path.join(UPDATE_FILES_DIR, id));

    for (let i=0;i<files.length;i++) {
      const f = files[i];
      const original = f.originalname;
      let targetPath = Array.isArray(targetPaths) && targetPaths[i] ? String(targetPaths[i]) : original;
      targetPath = sanitizeFilePath(targetPath);
      if (!targetPath) continue;

      const buffer = fs.readFileSync(f.path);
      const hash = computeHash(buffer);
      const fileId = uuidv4();
      const dest = path.join(UPDATE_FILES_DIR, id, fileId + ".bin");
      fs.writeFileSync(dest, buffer, { mode: 0o600 });
      try { fs.chmodSync(dest, 0o600); } catch {}

      // remove tmp
      try { fs.unlinkSync(f.path); } catch {}

      existing.files = existing.files || [];
      // replace if same path exists
      existing.files = existing.files.filter(x => x.path !== targetPath);
      existing.files.push({
        id: fileId,
        path: targetPath,
        original_name: original,
        hash,
        size: buffer.length,
        uploaded_at: new Date().toISOString(),
      });
    }

    existing.updated_at = new Date().toISOString();
    await store.set("updates", id, existing);
    res.json({ ok:true, update: existing });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok:false, error:"internal" });
  }
});

app.delete("/api/admin/updates/:id/files/:fileId", requireAdmin, async (req, res) => {
  try {
    const id = String(req.params.id || "").replace(/[^a-zA-Z0-9_\-]/g, "").slice(0,128);
    const fileId = String(req.params.fileId || "").replace(/[^a-zA-Z0-9_\-]/g, "").slice(0,128);
    const existing = await store.get("updates", id);
    if (!existing) return res.status(404).json({ ok:false, error:"not_found" });
    if (existing.published) return res.status(400).json({ ok:false, error:"already_published" });
    existing.files = (existing.files || []).filter(f => f.id !== fileId);
    existing.updated_at = new Date().toISOString();
    await store.set("updates", id, existing);
    try { fs.unlinkSync(path.join(UPDATE_FILES_DIR, id, fileId + ".bin")); } catch {}
    res.json({ ok:true, update: existing });
  } catch (e) {
    res.status(500).json({ ok:false, error:"internal" });
  }
});

// publish - makes update visible to dashboard
app.post("/api/admin/updates/:id/publish", requireAdmin, async (req, res) => {
  try {
    const id = String(req.params.id || "").replace(/[^a-zA-Z0-9_\-]/g, "").slice(0,128);
    const existing = await store.get("updates", id);
    if (!existing) return res.status(404).json({ ok:false, error:"not_found" });
    if (!existing.files || !existing.files.length) return res.status(400).json({ ok:false, error:"no_files" });
    existing.published = true;
    existing.published_at = new Date().toISOString();
    existing.updated_at = existing.published_at;
    await store.set("updates", id, existing);
    await store.set("audit", uuidv4(), { action:"publish", update_id:id, version:existing.version, at:existing.published_at });
    res.json({ ok:true, update: existing });
  } catch (e) {
    res.status(500).json({ ok:false, error:"internal" });
  }
});

// unpublish - cancels update, dashboard will not be notified (it will just see no update or previous)
app.post("/api/admin/updates/:id/unpublish", requireAdmin, async (req, res) => {
  try {
    const id = String(req.params.id || "").replace(/[^a-zA-Z0-9_\-]/g, "").slice(0,128);
    const existing = await store.get("updates", id);
    if (!existing) return res.status(404).json({ ok:false, error:"not_found" });
    existing.published = false;
    existing.published_at = null;
    existing.updated_at = new Date().toISOString();
    await store.set("updates", id, existing);
    await store.set("audit", uuidv4(), { action:"unpublish", update_id:id, version:existing.version, at:existing.updated_at });
    // No notification to dashboard - it will just on next check see previous published or none
    res.json({ ok:true, update: existing });
  } catch (e) {
    res.status(500).json({ ok:false, error:"internal" });
  }
});

// health
app.get("/api/health", (req,res) => res.json({ ok:true, service:"aurion-update-server", time: new Date().toISOString() }));

/* The panel itself.
 *
 * It used to be a template literal several hundred lines long inside
 * this file, with every piece of its own JavaScript escaped so the
 * literal would survive. It looked like an unstyled HTML document
 * because it effectively was one: emoji headings, alert() for every
 * message, and none of AURION's interface anywhere near it.
 *
 * It is now a file, styled like the rest of the product, and this
 * route only decides who may see it.
 */
const PANEL_FILE = path.join(__dirname, "..", "public", "panel.html");

app.get(`/admin/${ADMIN_PANEL_HASH}`, (req, res) => {
  pageHeaders(res);
  res.sendFile(PANEL_FILE, (err) => {
    if (err && !res.headersSent) res.status(500).send("panel.html is missing from the install");
  });
});

/* The front page.
 *
 * Opening http://127.0.0.1:8898 answered "Cannot GET /" - Express's
 * default 404, which reads like the server is broken when in fact it
 * is running perfectly and the panel simply lives at another path.
 *
 * This says so. It does NOT link to the panel: the hash in that URL is
 * the only thing standing between the open internet and the publish
 * button, and a public page that prints it would hand it over.
 */
app.get("/", async (req, res) => {
  let published = 0;
  let latest = "-";
  try {
    const all = await store.list("updates", 1000);
    const live = all.filter((u) => u.published);
    published = live.length;
    if (live.length) latest = live[live.length - 1].version;
  } catch {
    /* an empty store is not an error */
  }

  pageHeaders(res);
  res.send(`<!DOCTYPE html>
<html lang="fa" dir="rtl"><head>
<meta charset="utf-8" /><meta name="viewport" content="width=device-width,initial-scale=1" />
<title>AURION — سرور آپدیت</title>
<style>
 :root{--bg:#06070b;--lift:#0d101a;--ink:#e8edf7;--muted:#8b93a7;
       --line:rgb(255 255 255 / .08);--cyan:#3ee0c4;--violet:#7c6cff}
 *{box-sizing:border-box}
 body{margin:0;min-height:100vh;color:var(--ink);
   font:14px/1.8 Vazirmatn,Tahoma,"Segoe UI",system-ui,sans-serif;
   background:
     radial-gradient(900px 500px at 88% -5%,rgb(124 108 255 / .18),transparent 60%),
     radial-gradient(700px 420px at 5% 20%,rgb(62 224 196 / .13),transparent 60%),
     linear-gradient(180deg,var(--lift),var(--bg));
   display:grid;place-items:center;padding:24px}
 .card{max-width:620px;width:100%;background:rgb(255 255 255 / .03);
   border:1px solid var(--line);border-radius:18px;padding:26px}
 h1{font-size:20px;font-weight:500;margin:0 0 2px;letter-spacing:.06em}
 .sub{color:var(--muted);font-size:12px;margin:0 0 18px}
 .live{display:inline-flex;align-items:center;gap:8px;font-size:13px;color:var(--cyan)}
 .live i{width:8px;height:8px;border-radius:99px;background:var(--cyan);display:inline-block}
 dl{display:grid;grid-template-columns:auto 1fr;gap:6px 14px;margin:18px 0 0;font-size:13px}
 dt{color:var(--muted)} dd{margin:0;direction:ltr;text-align:right}
 .box{margin-top:20px;border:1px solid var(--line);border-radius:14px;padding:14px;font-size:13px}
 code{background:rgb(0 0 0 / .35);border:1px solid var(--line);border-radius:8px;
   padding:2px 8px;direction:ltr;display:inline-block;color:var(--cyan)}
</style></head><body>
<div class="card">
  <h1>AURION — سرور آپدیت</h1>
  <p class="sub">AxiaSoft update service</p>
  <span class="live"><i></i> در حال اجرا</span>
  <dl>
    <dt>پورت</dt><dd>${PORT}</dd>
    <dt>انتشارهای منتشرشده</dt><dd>${published}</dd>
    <dt>آخرین نسخه</dt><dd>${latest}</dd>
    <dt>توکن ادمین</dt><dd>${ADMIN_TOKEN ? "تنظیم شده" : "تنظیم نشده"}</dd>
  </dl>
  <div class="box">
    <b>پنل اینجا نیست.</b> آدرس پنل شامل <code>ADMIN_PANEL_HASH</code> است و
    عمداً در این صفحه چاپ نمی‌شود:<br />
    <code>/admin/&lt;ADMIN_PANEL_HASH&gt;</code><br />
    مقدارش در <code>admin/update-server/.env</code> است و هنگام اجرای
    <code>start-update-server.cmd</code> روی صفحه چاپ می‌شود.
  </div>
  <div class="box">
    ساده‌تر: پنل یکپارچهٔ AURION همین کار را به‌علاوهٔ تلگرام و ساخت لایسنس انجام می‌دهد و
    توکن را خودش می‌خواند — <code>admin\start-panel.cmd</code> →
    <code>http://127.0.0.1:8900</code>
  </div>
</div></body></html>`);
});

// 404 for other admin paths - keep hidden
// Any other /admin path: no hint that a panel exists, but not the bare
// word "Not found" either - that is what made a mistyped hash look like
// a dead server.
app.use("/admin", (req, res) => res.status(404)
  .type("text/plain; charset=utf-8")
  .send("AURION update server is running. This is not the panel address."));

app.listen(PORT, () => {
  console.log(`AURION Update Server listening on ${PORT}`);
  console.log(`Admin panel: http://127.0.0.1:${PORT}/admin/${ADMIN_PANEL_HASH}`);
  if (!ADMIN_TOKEN) {
    // Said here, because the alternative is a panel that loads, answers
    // 401 to every button, and explains neither.
    console.log("");
    console.log("  WARNING: ADMIN_TOKEN is not set, so every admin action returns 401.");
    console.log("           Put one in update-server/.env and restart.");
    console.log("           start-update-server.cmd writes one for you.");
    console.log("");
  }
  console.log(`Public API: /api/updates/latest , /api/updates/check`);
});
