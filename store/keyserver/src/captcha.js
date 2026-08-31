"use strict";
// Anti-bot: one-time math captcha challenges + per-IP token buckets.

const crypto = require("crypto");

const CHALLENGES = new Map(); // id -> {answer, expires}
const BUCKETS = new Map(); // bucketKey -> {count, reset}
const CAPTCHA_TTL_MS = 10 * 60 * 1000;

const FA_DIGITS = ["۰", "۱", "۲", "۳", "۴", "۵", "۶", "۷", "۸", "۹"];
const faNum = (n) => String(n).split("").map((c) => FA_DIGITS[Number(c)] ?? c).join("");

function newChallenge() {
  const a = 1 + crypto.randomInt(9);
  const b = 1 + crypto.randomInt(9);
  const id = crypto.randomBytes(12).toString("hex");
  CHALLENGES.set(id, { answer: a + b, expires: Date.now() + CAPTCHA_TTL_MS });
  // Lazy GC so the map does not grow on spam.
  if (CHALLENGES.size > 2000) {
    for (const [k, v] of CHALLENGES) if (v.expires < Date.now()) CHALLENGES.delete(k);
  }
  return { id, question: `${faNum(a)} + ${faNum(b)} = ؟`, answer: a + b };
}

function checkChallenge(id, answer) {
  const row = CHALLENGES.get(String(id || ""));
  CHALLENGES.delete(String(id || "")); // one-time, right or wrong
  if (!row || row.expires < Date.now()) return false;
  const given = Number(String(answer || "").replace(/[۰-۹]/g, (c) => String(FA_DIGITS.indexOf(c))).replace(/[^\d-]/g, ""));
  return Number.isFinite(given) && given === row.answer;
}

function rateLimit(key, limit, windowMs) {
  const now = Date.now();
  let b = BUCKETS.get(key);
  if (!b || b.reset < now) { b = { count: 0, reset: now + windowMs }; BUCKETS.set(key, b); }
  b.count += 1;
  if (b.count > limit) return false;
  return true;
}

module.exports = { newChallenge, checkChallenge, rateLimit };
