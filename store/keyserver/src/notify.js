"use strict";
// OTP delivery: Gmail over SMTP (SMTP_* envs, nodemailer) or Iranian mobile over
// Kavenegar (KAVENEGAR_API_KEY). If neither is configured, DEV_OTP_FALLBACK=1
// exposes the code in the API response + server log so you can test end-to-end.

const crypto = require("crypto");

function mask(identity) {
  if (identity.includes("@")) {
    const [u, d] = identity.split("@");
    return (u.slice(0, 2) + "***@" + d);
  }
  return identity.slice(0, 4) + "***" + identity.slice(-2);
}

async function sendGmailOtp(env, email, code) {
  if (!env.SMTP_HOST || !env.SMTP_USER) return false;
  const nodemailer = require("nodemailer");
  const transport = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: Number(env.SMTP_PORT || 465),
    secure: Number(env.SMTP_PORT || 465) === 465,
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
  });
  await transport.sendMail({
    from: env.SMTP_FROM || env.SMTP_USER,
    to: email,
    subject: "AURION Keys — verification code / کد تأیید",
    text: `Your AURION verification code: ${code}\nکد تأیید آوریون شما: ${code}\nIt expires in 10 minutes. / تا ۱۰ دقیقه معتبر است.`,
  });
  return true;
}

async function sendPhoneOtp(env, phone, code) {
  if (!env.KAVENEGAR_API_KEY) return false;
  const url = `https://api.kavenegar.com/v1/${env.KAVENEGAR_API_KEY}/verify/lookup.json`;
  const body = new URLSearchParams({ receptor: phone, token: code, template: env.KAVENEGAR_TEMPLATE || "verify" });
  const res = await fetch(url, { method: "POST", body });
  const json = await res.json().catch(() => ({}));
  const st = json && json.return && json.return.status;
  return res.ok && st && st >= 200 && st < 300;
}

async function deliverOtp(env, identityKind, identity, code) {
  const via = identityKind === "gmail" ? await sendGmailOtp(env, identity, code) : await sendPhoneOtp(env, identity, code);
  if (via) return { delivered: true };
  if (String(env.DEV_OTP_FALLBACK || "1") === "1") {
    console.log(`[dev-otp] ${mask(identity)} -> ${code}`);
    return { delivered: false, dev_code: code };
  }
  const err = new Error("otp delivery is not configured");
  err.status = 503;
  throw err;
}

function genCode() { return String(crypto.randomInt(100000, 999999)); }

// Best-effort plain notice (ticket answered, key granted). Email only; never
// throws — a missing/broken SMTP must not break admin work.
async function sendNotice(env, identityKind, identity, subject, text) {
  try {
    if (identityKind === "gmail" && env.SMTP_HOST && env.SMTP_USER) {
      const nodemailer = require("nodemailer");
      const transport = nodemailer.createTransport({
        host: env.SMTP_HOST,
        port: Number(env.SMTP_PORT || 465),
        secure: Number(env.SMTP_PORT || 465) === 465,
        auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
      });
      await transport.sendMail({ from: env.SMTP_FROM || env.SMTP_USER, to: identity, subject, text });
      return true;
    }
  } catch { /* best-effort */ }
  return false;
}

module.exports = { deliverOtp, genCode, mask, sendNotice };
