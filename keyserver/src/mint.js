"use strict";
// Owner key-mint CLI (owner machine only — never expose as an HTTP endpoint).
//
//   npm run mint -- developer [note]   → one AXI-DEV owner key (unlimited use,
//                                        machine-capped + revocable on this server)
//   npm run mint -- m3 [note]          → one customer key (for manual sales)
//   npm run mint -- --keygen           → fresh Ed25519 pair (rotation drill)
//
// Reads AURION_KEY_PRIVATE_HEX from keyserver/.env (or the environment).

const fs = require("fs");
const path = require("path");

(function loadEnv() {
  const file = path.join(__dirname, "..", ".env");
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || m[1].startsWith("#")) continue;
    if (!(m[1] in process.env)) process.env[m[1]] = m[2];
  }
})();

const keys = require("./keys");
const ed = require("./ed25519");
const crypto = require("crypto");

const args = process.argv.slice(2);

if (args[0] === "--keygen") {
  const seed = crypto.randomBytes(32);
  console.log("private seed (KEEP SECRET → keyserver .env AURION_KEY_PRIVATE_HEX):", seed.toString("hex"));
  console.log("public key  (ships in engine material.py + keys.js):          ", ed.publickey(seed).toString("hex"));
  process.exit(0);
}

const plan = String(args[0] || "developer").toLowerCase();
const note = String(args[1] || "cli");
const priv = String(process.env.AURION_KEY_PRIVATE_HEX || "").trim();
if (!priv) {
  console.error("error: AURION_KEY_PRIVATE_HEX is not set (put it in keyserver/.env) — minting is owner-only");
  process.exit(3);
}
try {
  const key = keys.mint(plan, priv);
  if (plan === "developer") {
    const { Store } = require("./store");
    const store = new Store(path.resolve(__dirname, "..", String(process.env.DATA_DIR || "./data"), "keyserver.json"));
    if (!store.findIn("owner_keys", (k) => k.key === key)) {
      store.push("owner_keys", {
        id: store.nextId(), key, machines: [], revoked: false,
        note: note || "owner mint", created_at: new Date().toISOString(), last_seen: "",
      });
    }
  }
  console.log(key);
} catch (e) {
  console.error("error:", e.message);
  process.exit(2);
}
