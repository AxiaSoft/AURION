"use strict";

const dns = require("dns").promises;

const IR_PHONE = /^(?:0098|\+98|98)?9\d{9}$/;
const GMAIL = /^[a-z0-9](?:[a-z0-9._%+\-]{4,28}[a-z0-9])@(?:gmail|googlemail)\.com$/i;
const IR_PREFIX = /^09(0[1-5]|1[0-9]|2[0-3]|3[0-9]|9[0-9])\d{7}$/;
const USERNAME = /^[a-z][a-z0-9_]{2,23}$/i;
const RESERVED = new Set([
  "admin", "owner", "aurion", "root", "system", "support", "operator",
  "null", "undefined", "login", "register", "profile", "settings",
]);

function normalizeUsername(raw) {
  const s = String(raw || "").trim().toLowerCase();
  if (!s || !USERNAME.test(s) || RESERVED.has(s)) return null;
  return { type: "username", value: s };
}

function normalizeIdentity(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  const compact = s.replace(/[\s\-]/g, "");
  let phone = compact;
  if (phone.startsWith("0098")) phone = "+98" + phone.slice(4);
  if (/^98\d{10}$/.test(phone)) phone = "+" + phone;
  if (/^09\d{9}$/.test(phone)) {
    if (!IR_PREFIX.test(phone)) return null;
    return { type: "phone", value: phone };
  }
  if (/^\+989\d{9}$/.test(phone)) {
    const local = "0" + phone.slice(3);
    if (!IR_PREFIX.test(local)) return null;
    return { type: "phone", value: local };
  }
  if (IR_PHONE.test(compact.replace(/^\+/, ""))) {
    const digits = compact.replace(/\D/g, "");
    const local = digits.startsWith("98") ? "0" + digits.slice(2) : digits;
    if (IR_PREFIX.test(local)) return { type: "phone", value: local };
    return null;
  }
  const email = s.toLowerCase();
  if (email.includes("..") || email.startsWith(".") || email.includes("@.")) return null;
  if (GMAIL.test(email)) return { type: "gmail", value: email.replace("@googlemail.com", "@gmail.com") };
  return null;
}

function normalizeLogin(raw) {
  return normalizeIdentity(raw) || normalizeUsername(raw);
}

function identityError(raw) {
  if (normalizeLogin(raw)) return null;
  return "identity";
}

function maskGmail(value) {
  const s = String(value || "");
  const at = s.indexOf("@");
  if (at < 1) return "";
  return s.slice(0, Math.min(2, at)) + "***@" + s.slice(at + 1);
}

function maskPhone(value) {
  const s = String(value || "");
  if (s.length < 7) return s;
  return s.slice(0, 4) + "***" + s.slice(-2);
}

async function proveExists(raw) {
  const ident = typeof raw === "object" && raw ? raw : normalizeIdentity(raw);
  if (!ident) return { ok: false, error: "identity" };
  if (ident.type === "phone") {
    if (!IR_PREFIX.test(ident.value)) return { ok: false, error: "phone_prefix" };
    return { ok: true, type: "phone", value: ident.value, need_otp: true };
  }
  if (ident.type !== "gmail") return { ok: false, error: "identity" };
  const domain = ident.value.split("@")[1] || "gmail.com";
  try {
    const mx = await dns.resolveMx(domain);
    if (!mx || !mx.length) return { ok: false, error: "mx" };
  } catch {
    return { ok: false, error: "mx" };
  }
  const local = ident.value.split("@")[0] || "";
  if (local.length < 6 || local.length > 30) return { ok: false, error: "identity" };
  return { ok: true, type: "gmail", value: ident.value, need_otp: true };
}

module.exports = {
  normalizeIdentity,
  normalizeUsername,
  normalizeLogin,
  identityError,
  proveExists,
  maskGmail,
  maskPhone,
  IR_PREFIX,
  USERNAME,
};
