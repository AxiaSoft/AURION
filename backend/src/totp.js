"use strict";

const crypto = require("crypto");

const ALPH = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function b32encode(buf) {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPH[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPH[(value << (5 - bits)) & 31];
  return out;
}

function b32decode(str) {
  const input = String(str || "").toUpperCase().replace(/\s/g, "");
  const noPad = input.replace(/=+$/g, "");
  if (!noPad) throw new Error("empty base32");
  // strict: only allowed chars
  if (!/^[A-Z2-7]+$/.test(noPad)) {
    throw new Error("invalid base32 character");
  }
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of noPad) {
    const idx = ALPH.indexOf(ch);
    if (idx < 0) throw new Error("invalid base32");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function hotp(secret, counter) {
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const hmac = crypto.createHmac("sha1", secret).update(buf).digest();
  const off = hmac[hmac.length - 1] & 0xf;
  const code = ((hmac[off] & 0x7f) << 24 | hmac[off + 1] << 16 | hmac[off + 2] << 8 | hmac[off + 3]) % 1000000;
  return String(code).padStart(6, "0");
}

function totpAt(secret, step = 30, at = Date.now()) {
  return hotp(secret, Math.floor(at / 1000 / step));
}

function generateSecret() {
  return b32encode(crypto.randomBytes(20));
}

function verify(secretB32, code, window = 1) {
  let secret;
  try {
    secret = b32decode(secretB32);
  } catch {
    return false;
  }
  if (!secret.length) return false;
  const want = String(code || "").replace(/\s/g, "");
  if (!/^\d{6}$/.test(want)) return false;
  const t = Math.floor(Date.now() / 1000 / 30);
  for (let w = -window; w <= window; w++) {
    const cand = totpAt(secret, 30, (t + w) * 30000);
    // timingSafeEqual requires same length buffers
    const a = Buffer.from(cand, "utf8");
    const b = Buffer.from(want, "utf8");
    if (a.length !== b.length) continue;
    if (crypto.timingSafeEqual(a, b)) return true;
  }
  return false;
}

function otpauth(secretB32, account, issuer = "AURION") {
  const label = encodeURIComponent(issuer + ":" + account);
  const q = new URLSearchParams({ secret: secretB32, issuer, algorithm: "SHA1", digits: "6", period: "30" });
  return `otpauth://totp/${label}?${q.toString()}`;
}

function deriveKey(material) {
  // PBKDF2 with fixed salt for deterministic unwrap, 100k iterations
  const salt = Buffer.from("aurion-totp-v1-fixed-salt-2024", "utf8");
  return crypto.pbkdf2Sync(String(material || "aurion"), salt, 100000, 32, "sha256");
}

function wrapSecret(plain, material) {
  const key = deriveKey(material);
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([c.update(String(plain), "utf8"), c.final()]);
  return iv.toString("hex") + "." + c.getAuthTag().toString("hex") + "." + enc.toString("hex");
}

function unwrapSecret(blob, material) {
  const parts = String(blob || "").split(".");
  if (parts.length !== 3) return String(blob || "");
  try {
    const key = deriveKey(material);
    const iv = Buffer.from(parts[0], "hex");
    const tag = Buffer.from(parts[1], "hex");
    const enc = Buffer.from(parts[2], "hex");
    if (iv.length !== 12 || tag.length !== 16) return "";
    const d = crypto.createDecipheriv("aes-256-gcm", key, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(enc), d.final()]).toString("utf8");
  } catch {
    return "";
  }
}

module.exports = { generateSecret, verify, otpauth, wrapSecret, unwrapSecret, b32encode, b32decode };
