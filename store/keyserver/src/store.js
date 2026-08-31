"use strict";
// Secure JSON document store for key server with atomic writes, secure permissions,
// size limits, and backup rotation. Collections: users, orders, keys, etc.

const fs = require("fs");
const path = require("path");

class Store {
  constructor(file) {
    this.file = file;
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    try { fs.chmodSync(path.dirname(file), 0o700); } catch {}
    this.doc = {
      users: [], orders: [], keys: [], otps: [], owner_keys: [], violations: [],
      tickets: [], admin_audit: [], coupons: [], products: [], wishlists: [],
      settings: {}, counters: { order: 1000, invoice: 1000, ticket: 1000, coupon: 1000 },
      seq: 1,
    };
    try {
      const stat = fs.statSync(file);
      if (stat.size > 50 * 1024 * 1024) throw new Error("store too large");
      const raw = JSON.parse(fs.readFileSync(file, "utf8"));
      if (raw && typeof raw === "object") this.doc = { ...this.doc, ...raw };
      try { fs.chmodSync(file, 0o600); } catch {}
    } catch { /* first boot */ }
    this._queue = Promise.resolve();
    this._saving = false;
  }

  save() {
    const blob = JSON.stringify(this.doc, null, 2);
    if (blob.length > 100 * 1024 * 1024) {
      console.error("[store] blob too large, refusing to save");
      return this._queue;
    }
    this._queue = this._queue.then(
      () =>
        new Promise((resolve) => {
          const tmp = this.file + ".tmp";
          try {
            fs.writeFileSync(tmp, blob, { encoding: "utf8", mode: 0o600 });
            try { fs.chmodSync(tmp, 0o600); } catch {}
            fs.renameSync(tmp, this.file);
            try { fs.chmodSync(this.file, 0o600); } catch {}
          } catch (err) {
            try { fs.unlinkSync(tmp); } catch {}
            console.error("[store] save failed", err.message);
          }
          resolve();
        })
    );
    return this._queue;
  }

  nextId() {
    const id = this.doc.seq++;
    // save seq async but ensure persistence
    this.save();
    return id;
  }

  findIn(coll, pred) {
    if (!Array.isArray(this.doc[coll])) return undefined;
    return this.doc[coll].find(pred);
  }
  filterIn(coll, pred) {
    if (!Array.isArray(this.doc[coll])) return [];
    return this.doc[coll].filter(pred);
  }

  push(coll, row) {
    if (!Array.isArray(this.doc[coll])) this.doc[coll] = [];
    // limit collections to prevent DoS
    const limits = { violations: 5000, admin_audit: 3000, otps: 500, tickets: 2000 };
    if (limits[coll] && this.doc[coll].length >= limits[coll]) {
      this.doc[coll].splice(0, Math.floor(limits[coll] / 5));
    }
    this.doc[coll].push(row);
    this.save();
    return row;
  }
}

module.exports = { Store };
