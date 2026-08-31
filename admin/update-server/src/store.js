"use strict";
const fs = require("fs");
const path = require("path");

const MAX_READ_BYTES = 50 * 1024 * 1024;
const MAX_WRITE_BYTES = 100 * 1024 * 1024;
const COLLECTION_LIMITS = {
  updates: 1000,
  files: 5000,
  audit: 3000,
};

function ensureDirSecure(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch {}
}

function sanitizeCollectionName(name) {
  const clean = String(name).replace(/[^a-z0-9_\-]/gi, "");
  if (!clean) throw new Error("bad_collection");
  return clean.slice(0, 64);
}

function sanitizeId(id) {
  const clean = String(id).replace(/[^a-zA-Z0-9_\-]/g, "");
  if (!clean) throw new Error("bad_id");
  return clean.slice(0, 128);
}

class Store {
  constructor(dir) {
    this.dir = path.resolve(dir);
    ensureDirSecure(this.dir);
    this._queue = Promise.resolve();
  }

  _run(fn) {
    const p = this._queue.then(() => fn()).catch(() => fn());
    this._queue = p.catch(() => {});
    return p;
  }

  _file(collection, id) {
    const col = sanitizeCollectionName(collection);
    const safeId = sanitizeId(id);
    const dir = path.join(this.dir, col);
    ensureDirSecure(dir);
    return path.join(dir, safeId + ".json");
  }

  async _readFile(file) {
    try {
      const stat = fs.statSync(file);
      if (stat.size > MAX_READ_BYTES) throw new Error("file_too_large");
      const raw = fs.readFileSync(file, "utf8");
      if (raw.length > MAX_READ_BYTES) throw new Error("file_too_large");
      return JSON.parse(raw);
    } catch (e) {
      if (e.code === "ENOENT") return null;
      throw e;
    }
  }

  async _writeFile(file, data) {
    const json = JSON.stringify(data);
    if (Buffer.byteLength(json, "utf8") > MAX_WRITE_BYTES) throw new Error("write_too_large");
    const tmp = file + ".tmp." + Date.now();
    fs.writeFileSync(tmp, json, { encoding: "utf8", mode: 0o600 });
    try { fs.chmodSync(tmp, 0o600); } catch {}
    fs.renameSync(tmp, file);
    try { fs.chmodSync(file, 0o600); } catch {}
  }

  async get(collection, id) {
    return this._run(async () => {
      const file = this._file(collection, id);
      return this._readFile(file);
    });
  }

  async set(collection, id, data) {
    return this._run(async () => {
      const file = this._file(collection, id);
      const col = sanitizeCollectionName(collection);
      // rotation check
      const dir = path.join(this.dir, col);
      ensureDirSecure(dir);
      const limit = COLLECTION_LIMITS[col];
      if (limit) {
        try {
          const entries = fs.readdirSync(dir).filter(f => f.endsWith(".json")).map(f => {
            const fp = path.join(dir, f);
            try { return { fp, mtime: fs.statSync(fp).mtimeMs }; } catch { return null; }
          }).filter(Boolean).sort((a,b) => a.mtime - b.mtime);
          if (entries.length >= limit) {
            const toRemove = entries.length - limit + 1;
            for (let i=0;i<toRemove;i++) {
              try { fs.unlinkSync(entries[i].fp); } catch {}
            }
          }
        } catch {}
      }
      await this._writeFile(file, data);
      return data;
    });
  }

  async delete(collection, id) {
    return this._run(async () => {
      const file = this._file(collection, id);
      try { fs.unlinkSync(file); } catch (e) { if (e.code !== "ENOENT") throw e; }
    });
  }

  async list(collection, limit = 1000) {
    return this._run(async () => {
      const col = sanitizeCollectionName(collection);
      const dir = path.join(this.dir, col);
      try {
        ensureDirSecure(dir);
        const files = fs.readdirSync(dir).filter(f => f.endsWith(".json")).slice(0, limit);
        const out = [];
        for (const f of files) {
          const fp = path.join(dir, f);
          try {
            const data = await this._readFile(fp);
            if (data) out.push(data);
          } catch {}
        }
        // sort by created_at desc if present
        out.sort((a,b) => {
          const at = a.updated_at || a.created_at || "";
          const bt = b.updated_at || b.created_at || "";
          return String(bt).localeCompare(String(at));
        });
        return out;
      } catch (e) {
        if (e.code === "ENOENT") return [];
        throw e;
      }
    });
  }
}

module.exports = Store;
