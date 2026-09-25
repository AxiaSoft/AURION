"use strict";
// AURION license keys — asymmetric Ed25519 edition. Byte-exact port of
// engine/aurion/license/guard.py + ed25519.py, proven by test/key-parity.mjs
// against the official RFC 8032 vectors (both implementations must agree).
//
//   Customer:  AXIA-M1-XXXX-XXXX-XXXX-XXXX-Sx6groups      (short server-verified tag)
//   Owner:     AXI-DEV-XXXX-XXXX-XXXX-XXXX-Sx26groups     (full Ed25519 signature)
//
// The private signing seed NEVER ships in the client repo — it lives only in
// this server's env (AURION_KEY_PRIVATE_HEX) and the owner mint CLI. The
// public key in the engine can verify owner keys but cannot mint ANY key.

const crypto = require("crypto");
const ed = require("./ed25519");

const PRODUCT = "AURION";
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const PLANS = ["m1", "m3", "m6", "y1"];
const PLAN_DAYS = { m1: 30, m3: 90, m6: 180, y1: 365 };
const PLAN_LABEL = { m1: "1 month", m3: "3 months", m6: "6 months", y1: "12 months", developer: "developer" };

// Public half of the issuer pair — safe to ship (matches engine material.py).
// AURION_KEY_PUBLIC_HEX overrides it (tests only — production never sets it).
const ED25519_PUBLIC_HEX = "c914c8f0b049760bf07fb71e61829dae157c31edeea7182aadacdf1fca75096d";
const PUB_HEX = String(process.env.AURION_KEY_PUBLIC_HEX || "").trim() || ED25519_PUBLIC_HEX;
const PUB = Buffer.from(PUB_HEX, "hex");

function b32(dataBuf, n) {
  // Matches guard.py _b32: LSB-first emission.
  let num = BigInt("0x" + dataBuf.toString("hex"));
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(ALPHABET[Number(num % 32n)]);
    num = num / 32n;
  }
  return out.join("");
}

function b32dec(s, nbytes) {
  // Inverse of b32 (LSB-first): matches guard.py _b32dec.
  let num = 0n;
  for (let i = 0; i < s.length; i++) {
    const idx = ALPHABET.indexOf(s[i]);
    if (idx < 0) throw new Error("bad base32");
    num += BigInt(idx) * 32n ** BigInt(i);
  }
  return Buffer.from(num.toString(16).padStart(nbytes * 2, "0"), "hex");
}

function privBytes(hex) {
  const buf = Buffer.from(String(hex || "").trim(), "hex");
  if (buf.length !== 32) throw new Error("AURION_KEY_PRIVATE_HEX must be a 32-byte seed (64 hex chars)");
  return buf;
}

function tagFor(body, privHex) {
  const sig = ed.sign(privBytes(privHex), Buffer.from(body, "utf8"));
  return b32(sig.subarray(0, 15), 24);
}

function mint(plan, privHex) {
  plan = String(plan || "").toLowerCase();
  if (plan !== "developer" && !PLANS.includes(plan)) throw new Error("plan must be one of " + PLANS.join(", ") + " or developer");
  const nonce = crypto.randomBytes(8).toString("hex").toUpperCase();
  const body = `${PRODUCT}|${plan}|${nonce}`;
  const ngroups = [nonce.slice(0, 4), nonce.slice(4, 8), nonce.slice(8, 12), nonce.slice(12, 16)];
  if (plan === "developer") {
    const sig = b32(ed.sign(privBytes(privHex), Buffer.from(body, "utf8")), 103);
    const sgroups = [];
    for (let i = 0; i < sig.length; i += 4) sgroups.push(sig.slice(i, i + 4));
    return "AXI-DEV-" + ngroups.concat(sgroups).join("-");
  }
  const sig = b32(ed.sign(privBytes(privHex), Buffer.from(body, "utf8")).subarray(0, 15), 24);
  const sgroups = [];
  for (let i = 0; i < 24; i += 4) sgroups.push(sig.slice(i, i + 4));
  return "AXIA-" + [plan.toUpperCase()].concat(ngroups, sgroups).join("-");
}

function normalizeKey(key) {
  return String(key || "").toUpperCase().replace(/[^A-Z0-9\-]/g, "");
}

function decodeKey(key, privHex) {
  const k = normalizeKey(key);
  const parts = k.split("-");
  if (k.startsWith("AXI-DEV-")) {
    const rest = parts.slice(2);
    if (rest.length !== 30) return null;
    const nonce = rest.slice(0, 4).join("");
    const sigS = rest.slice(4).join("");
    if (nonce.length !== 16 || sigS.length !== 103) return null;
    let raw;
    try { raw = b32dec(sigS, 64); } catch { return null; }
    const body = `${PRODUCT}|developer|${nonce}`;
    if (!ed.verify(raw, Buffer.from(body, "utf8"), PUB)) return null;
    return { plan: "developer", nonce, key: k, verified: true };
  }
  if (!k.startsWith("AXIA-")) return null;
  if (parts.length !== 12) return null;
  const plan = parts[1].toLowerCase();
  if (!PLANS.includes(plan)) return null;
  const rest = parts.slice(2);
  const nonce = rest.slice(0, 4).join("");
  const sig = rest.slice(4).join("");
  if (nonce.length !== 16 || sig.length !== 24) return null;
  let expect;
  try { expect = tagFor(`${PRODUCT}|${plan}|${nonce}`, privHex); } catch { return null; }
  if (!crypto.timingSafeEqual(Buffer.from(expect), Buffer.from(sig))) return null;
  return { plan, nonce, key: k, verified: true };
}

function expiresAt(activatedIso, plan) {
  const t = new Date(activatedIso).getTime() + PLAN_DAYS[plan] * 86400000;
  return new Date(t).toISOString();
}

module.exports = { mint, decodeKey, normalizeKey, PLANS, PLAN_DAYS, PLAN_LABEL, expiresAt, ED25519_PUBLIC_HEX };
