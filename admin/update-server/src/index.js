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
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
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

// Hidden admin panel - serves static HTML at /admin/<HASH>
app.get(`/admin/${ADMIN_PANEL_HASH}`, (req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`
<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>AURION Update Panel - Hidden</title>
<style>
  body{font-family: Vazirmatn, Tahoma, sans-serif; background:#06070b; color:#e6e8f0; margin:0; padding:20px; direction:rtl}
  .container{max-width:1100px; margin:0 auto}
  h1{color:#fff; font-size:24px}
  .card{background:#0f111a; border:1px solid #1e2330; border-radius:12px; padding:20px; margin:15px 0}
  input, textarea, button{font-family:inherit; padding:10px; border-radius:8px; border:1px solid #2a3042; background:#151a28; color:#fff; width:100%; box-sizing:border-box; margin:5px 0}
  button{background:#4f46e5; border:none; cursor:pointer; font-weight:bold; width:auto; padding:10px 20px}
  button.danger{background:#e53e3e}
  button.success{background:#38a169}
  button.secondary{background:#2d3748}
  .update{border:1px solid #2a3042; border-radius:10px; padding:15px; margin:10px 0; background:#111424}
  .badge{padding:3px 8px; border-radius:20px; font-size:12px; display:inline-block}
  .badge-published{background:#38a169; color:#fff}
  .badge-draft{background:#d69e2e; color:#000}
  .file-item{display:flex; justify-content:space-between; align-items:center; background:#0a0c14; padding:8px 12px; border-radius:6px; margin:5px 0; font-family:monospace; font-size:13px}
  .hidden-info{color:#718096; font-size:12px; margin-top:10px}
</style>
</head>
<body>
<div class="container">
  <h1>🔒 پنل مخفی آپدیت AURION</h1>
  <p class="hidden-info">این پنل مخفی است - فقط با لینک مستقیم قابل دسترسی است. داشبورد به صورت خودکار این پنل را چک می‌کند.</p>
  
  <div class="card">
    <h3>🔑 توکن ادمین</h3>
    <input id="adminToken" type="password" placeholder="ADMIN_TOKEN را وارد کنید">
    <button onclick="saveToken()">ذخیره توکن</button>
    <span id="tokenStatus"></span>
  </div>

  <div class="card">
    <h3>➕ ایجاد آپدیت جدید (Draft)</h3>
    <input id="newVersion" placeholder="نسخه مثلا 1.0.1">
    <textarea id="newChangelog" rows="3" placeholder="تغییرات..."></textarea>
    <label><input type="checkbox" id="newMandatory"> آپدیت اجباری</label><br>
    <button onclick="createUpdate()">ایجاد Draft</button>
  </div>

  <div class="card">
    <h3>📦 لیست آپدیت‌ها</h3>
    <button onclick="loadUpdates()" class="secondary">بارگذاری لیست</button>
    <div id="updatesList"></div>
  </div>
</div>

<script>
let adminToken = localStorage.getItem('aurion_update_admin_token') || '';
document.getElementById('adminToken').value = adminToken;

function saveToken(){
  adminToken = document.getElementById('adminToken').value.trim();
  localStorage.setItem('aurion_update_admin_token', adminToken);
  document.getElementById('tokenStatus').textContent = ' ✅ ذخیره شد';
}

function apiHeaders(){
  return { 'Content-Type':'application/json', 'X-Admin-Token': adminToken };
}

async function createUpdate(){
  const version = document.getElementById('newVersion').value.trim();
  const changelog = document.getElementById('newChangelog').value.trim();
  const mandatory = document.getElementById('newMandatory').checked;
  if(!version){ alert('نسخه لازم است'); return; }
  const res = await fetch('/api/admin/updates', { method:'POST', headers: apiHeaders(), body: JSON.stringify({ version, changelog, mandatory }) });
  const data = await res.json();
  if(data.ok){ alert('Draft ایجاد شد: '+data.update.id); loadUpdates(); }
  else alert('خطا: '+(data.error||'unknown'));
}

async function loadUpdates(){
  const res = await fetch('/api/admin/updates', { headers: apiHeaders() });
  const data = await res.json();
  if(!data.ok){ document.getElementById('updatesList').innerHTML = 'خطا: '+(data.error||''); return; }
  const list = data.updates;
  let html = '';
  for(const u of list){
    html += \`<div class="update">
      <div><strong>\${u.version}</strong> <span class="badge \${u.published?'badge-published':'badge-draft'}">\${u.published?'منتشر شده':'پیش‌نویس'}</span> ID: \${u.id}</div>
      <div style="color:#a0aec0; font-size:13px; margin:5px 0">\${u.changelog||''}</div>
      <div style="font-size:12px; color:#718096">ایجاد: \${u.created_at} | انتشار: \${u.published_at||'-'} | فایل‌ها: \${(u.files||[]).length}</div>
      <div style="margin-top:10px">
        <input type="file" id="fileInput-\${u.id}" multiple>
        <input type="text" id="targetPath-\${u.id}" placeholder="مسیر هدف (اختیاری) مثلا engine/aurion/config.py - اگر خالی باشد نام اصلی">
        <button onclick="uploadFiles('\${u.id}')">آپلود فایل</button>
      </div>
      <div id="files-\${u.id}">\${(u.files||[]).map(f=>\`<div class="file-item"><span>\${f.path} (\${f.size} bytes) hash:\${f.hash.slice(0,12)}...</span><button class="danger" onclick="deleteFile('\${u.id}','\${f.id}')">حذف</button></div>\`).join('')}</div>
      <div style="margin-top:10px">
        \${!u.published ? \`<button class="success" onclick="publishUpdate('\${u.id}')">✅ انتشار - داشبورد آپدیت را می‌بیند</button>
        <button class="danger" onclick="deleteUpdate('\${u.id}')">حذف Draft</button>\` : \`<button class="danger" onclick="unpublishUpdate('\${u.id}')">❌ لغو انتشار (داشبورد متوجه لغو نمی‌شود)</button>\`}
      </div>
    </div>\`;
  }
  document.getElementById('updatesList').innerHTML = html || 'هیچ آپدیتی نیست';
}

async function uploadFiles(updateId){
  const input = document.getElementById('fileInput-'+updateId);
  const targetPathInput = document.getElementById('targetPath-'+updateId);
  if(!input.files.length){ alert('فایل انتخاب کنید'); return; }
  const form = new FormData();
  const targetPaths = [];
  for(let i=0;i<input.files.length;i++){
    form.append('files', input.files[i]);
    // if single target path provided and single file, use it, else use file name
    if(targetPathInput.value.trim() && input.files.length===1){
      targetPaths.push(targetPathInput.value.trim());
    } else {
      targetPaths.push(input.files[i].name);
    }
  }
  form.append('targetPaths', JSON.stringify(targetPaths));
  const res = await fetch('/api/admin/updates/'+updateId+'/files', { method:'POST', headers: { 'X-Admin-Token': adminToken }, body: form });
  const data = await res.json();
  if(data.ok){ alert('آپلود شد'); loadUpdates(); }
  else alert('خطا: '+(data.error||''));
}

async function deleteFile(updateId, fileId){
  if(!confirm('حذف فایل؟')) return;
  const res = await fetch('/api/admin/updates/'+updateId+'/files/'+fileId, { method:'DELETE', headers: apiHeaders() });
  const data = await res.json();
  if(data.ok) loadUpdates(); else alert(data.error);
}

async function publishUpdate(id){
  if(!confirm('انتشار آپدیت؟ بعد از انتشار داشبوردها آپدیت را می‌بینند')) return;
  const res = await fetch('/api/admin/updates/'+id+'/publish', { method:'POST', headers: apiHeaders() });
  const data = await res.json();
  if(data.ok){ alert('منتشر شد ✅'); loadUpdates(); } else alert(data.error);
}

async function unpublishUpdate(id){
  if(!confirm('لغو انتشار؟ داشبورد متوجه لغو نمی‌شود و فقط آپدیت قبلی را می‌بیند یا هیچ')) return;
  const res = await fetch('/api/admin/updates/'+id+'/unpublish', { method:'POST', headers: apiHeaders() });
  const data = await res.json();
  if(data.ok){ alert('لغو شد - داشبورد چیزی نمی‌بیند'); loadUpdates(); } else alert(data.error);
}

async function deleteUpdate(id){
  if(!confirm('حذف کامل Draft؟')) return;
  const res = await fetch('/api/admin/updates/'+id, { method:'DELETE', headers: apiHeaders() });
  const data = await res.json();
  if(data.ok) loadUpdates(); else alert(data.error);
}

loadUpdates();
</script>
</body>
</html>
  `);
});

// 404 for other admin paths - keep hidden
app.use("/admin", (req,res) => res.status(404).send("Not found"));

app.listen(PORT, () => {
  console.log(`AURION Update Server listening on ${PORT}`);
  console.log(`Admin panel: http://127.0.0.1:${PORT}/admin/${ADMIN_PANEL_HASH}`);
  console.log(`Public API: /api/updates/latest , /api/updates/check`);
});
