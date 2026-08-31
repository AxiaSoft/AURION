"use strict";

const https = require("https");
const { v4: uuid } = require("uuid");
const { load } = require("./config");
const db = require("./db");
const notify = require("./notify");
const mailer = require("./mailer");
const engine = require("./engine");

const PLAN_IDS = ["m1", "m3", "m6", "y1"];

function nowIso() {
  return new Date().toISOString();
}

function billingCfg() {
  const cfg = load();
  return cfg.billing || {};
}

function catalog(lang = "en") {
  const b = billingCfg();
  const plans = b.plans || {};
  return PLAN_IDS.map((id) => {
    const p = plans[id] || {};
    const labels = p.label || {};
    return {
      id,
      days: Number(p.days || (id === "y1" ? 365 : id === "m6" ? 180 : id === "m3" ? 90 : 30)),
      amount: Number(p.amount || 0),
      currency: b.currency || "IRR",
      label: labels[lang] || labels.en || id,
    };
  });
}

function planOf(id) {
  return catalog().find((p) => p.id === id) || null;
}

function configured() {
  const z = billingCfg().zarinpal || {};
  return Boolean(String(z.merchant_id || "").trim());
}

function support() {
  return String(billingCfg().support || "support@axiasoft");
}

function httpsJson(url, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = JSON.stringify(body);
    const req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname,
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
        timeout: 15000,
        rejectUnauthorized: true,
        minVersion: "TLSv1.2",
      },
      (res) => {
        let s = "";
        res.on("data", (c) => { s += c; });
        res.on("end", () => {
          try {
            if (s.length > 1024 * 1024) return reject(new Error("response too large"));
            resolve(JSON.parse(s));
          } catch { reject(new Error(s.slice(0, 200))); }
        });
      }
    );
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(new Error("timeout")); });
    req.write(data);
    req.end();
  });
}

function publicBase() {
  const cfg = load();
  const pub = String((cfg.backend && cfg.backend.public_url) || "").replace(/\/$/, "");
  if (pub) return pub;
  const port = Number((cfg.backend && cfg.backend.port) || 8080);
  return `http://127.0.0.1:${port}`;
}

function publicPay(row) {
  return {
    id: row.id,
    plan: row.plan,
    amount: row.amount,
    currency: row.currency,
    status: row.status,
    created: row.created,
    paid_at: row.paid_at || null,
    fail_reason: row.fail_reason || "",
    key_prefix: row.key_prefix || "",
    ref_id: row.ref_id || "",
  };
}

async function checkout(user, planId, req) {
  const plan = planOf(planId);
  if (!plan) return { ok: false, error: "plan" };
  if (!plan.amount) return { ok: false, error: "amount_unset" };
  if (!configured()) return { ok: false, error: "gateway_unconfigured" };
  const z = billingCfg().zarinpal || {};
  const merchant = String(z.merchant_id || "").trim();
  const sandbox = z.sandbox !== false;
  const id = uuid();
  const callback = publicBase() + "/api/billing/callback";
  const host = sandbox ? "sandbox.zarinpal.com" : "api.zarinpal.com";
  const startHost = sandbox ? "sandbox.zarinpal.com" : "www.zarinpal.com";
  let authority = "";
  let url = "";
  try {
    const res = await httpsJson(`https://${host}/pg/v4/payment/request.json`, {
      merchant_id: merchant,
      amount: plan.amount,
      callback_url: callback,
      description: `AURION ${plan.id} ${user.username}`,
      metadata: { email: user.gmail || "", mobile: user.phone || "" },
    });
    const data = res && res.data;
    if (!data || data.code !== 100 || !data.authority) {
      return { ok: false, error: "gateway", detail: data && data.message };
    }
    authority = data.authority;
    url = `https://${startHost}/pg/StartPay/${authority}`;
  } catch (err) {
    return { ok: false, error: "gateway", detail: err.message };
  }
  db.exec(
    `INSERT INTO payments(id, user_id, plan, amount, currency, provider, authority, ref_id, status, created, updated, paid_at, fail_reason, key_prefix, key_hash)
     VALUES (?, ?, ?, ?, ?, 'zarinpal', ?, NULL, 'pending', ?, ?, NULL, NULL, NULL, NULL)`,
    [id, user.id, plan.id, plan.amount, plan.currency, authority, nowIso(), nowIso()]
  );
  return { ok: true, data: { id, url, authority, plan: plan.id, amount: plan.amount, currency: plan.currency } };
}

function findByAuthority(authority) {
  const rows = db.query("SELECT * FROM payments WHERE authority = ? ORDER BY created DESC LIMIT 1", [String(authority || "")]);
  return rows[0] || null;
}

function findById(id) {
  const rows = db.query("SELECT * FROM payments WHERE id = ? LIMIT 1", [id]);
  return rows[0] || null;
}

async function fulfill(row, user) {
  const issued = await engine.proxy("POST", "/v1/license/issue", {
    plan: row.plan,
    identity: user.gmail || user.phone || user.username,
    note: `paid:${row.id}`,
  });
  if (!issued || !issued.ok || !issued.key) {
    return { ok: false, error: "issue_failed", detail: issued && issued.error };
  }
  const key = issued.key;
  const act = await engine.proxy("POST", "/v1/license/activate", {
    key,
    identity: user.gmail || user.phone || user.username,
  });
  if (!act || !act.ok) {
    return { ok: false, error: "activate_failed", detail: act && act.error, key };
  }
  const prefix = String(key).slice(0, 12) + "…";
  db.exec(
    "UPDATE payments SET status = ?, paid_at = ?, updated = ?, key_prefix = ? WHERE id = ?",
    ["paid", nowIso(), nowIso(), prefix, row.id]
  );
  const text = `AURION plan ${row.plan} is active.\nActivation key: ${key}\nKeep this key. It cannot be reused after activation.`;
  await mailer.deliver({
    gmail: user.gmail_verified ? user.gmail : (String(user.username || "").includes("@") ? user.username : ""),
    phone: user.phone_verified ? user.phone : (String(user.username || "").startsWith("09") ? user.username : ""),
    subject: "AURION activation key",
    text,
  });
  notify.push(user.id, {
    kind: "payment_ok",
    title: "Plan activated",
    body: `Plan ${row.plan} is active. The key was sent to your verified Gmail and/or mobile.`,
    payload: { payment: row.id, plan: row.plan },
  });
  return { ok: true, key, prefix, license: act.license || act.data };
}

async function failPayment(row, reason, user) {
  db.exec(
    "UPDATE payments SET status = ?, fail_reason = ?, updated = ? WHERE id = ?",
    ["failed", String(reason || "failed").slice(0, 200), nowIso(), row.id]
  );
  if (user) {
    notify.push(user.id, {
      kind: "payment_fail",
      title: "Payment failed",
      body: `No activation key was issued. If money left your account, wait up to 72 hours for a refund. Then write ${support()}.`,
      payload: { payment: row.id },
    });
  }
  return { ok: false, error: "payment_failed", refund_hours: 72, support: support() };
}

async function handleCallback(query) {
  const authority = String(query.Authority || query.authority || "");
  const status = String(query.Status || query.status || "");
  const row = findByAuthority(authority);
  if (!row) return { ok: false, error: "missing", html: failHtml("missing") };
  const users = db.query("SELECT * FROM users WHERE id = ?", [row.user_id]);
  const user = users[0] || { id: row.user_id, username: "" };
  if (status !== "OK") {
    await failPayment(row, "gateway_cancel", user);
    return { ok: false, error: "payment_failed", html: failHtml("cancel"), payment: publicPay(findById(row.id)) };
  }
  if (row.status === "paid") {
    return { ok: true, already: true, html: okHtml(row.plan, row.key_prefix), payment: publicPay(row) };
  }
  const z = billingCfg().zarinpal || {};
  const merchant = String(z.merchant_id || "").trim();
  const sandbox = z.sandbox !== false;
  const host = sandbox ? "sandbox.zarinpal.com" : "api.zarinpal.com";
  try {
    const res = await httpsJson(`https://${host}/pg/v4/payment/verify.json`, {
      merchant_id: merchant,
      amount: Number(row.amount),
      authority,
    });
    const data = res && res.data;
    const code = data && data.code;
    if (code !== 100 && code !== 101) {
      await failPayment(row, "verify_" + String(code || "fail"), user);
      return { ok: false, error: "payment_failed", html: failHtml("verify"), payment: publicPay(findById(row.id)) };
    }
    db.exec("UPDATE payments SET ref_id = ?, updated = ? WHERE id = ?", [String(data.ref_id || ""), nowIso(), row.id]);
    const done = await fulfill(findById(row.id), user);
    if (!done.ok) {
      await failPayment(row, done.error, user);
      return { ok: false, error: done.error, html: failHtml("issue"), payment: publicPay(findById(row.id)) };
    }
    const fresh = findById(row.id);
    return { ok: true, key: done.key, html: okHtml(row.plan, done.prefix, done.key), payment: publicPay(fresh) };
  } catch (err) {
    await failPayment(row, err.message, user);
    return { ok: false, error: "gateway", html: failHtml("gateway"), payment: publicPay(findById(row.id)) };
  }
}

function okHtml(plan, prefix, key) {
  const shown = key || prefix || "";
  return `<!doctype html><meta charset="utf-8"><title>AURION paid</title>
<body style="font-family:system-ui;background:#06070b;color:#e8edf7;display:grid;place-items:center;min-height:100vh">
<script>location.replace("/?paid=ok&plan=${encodeURIComponent(plan)}&v="+Date.now());</script>
<p>Payment successful. Plan ${plan}. ${shown}</p></body>`;
}

function failHtml(why) {
  return `<!doctype html><meta charset="utf-8"><title>AURION payment</title>
<body style="font-family:system-ui;background:#06070b;color:#e8edf7;display:grid;place-items:center;min-height:100vh">
<script>location.replace("/?paid=fail&why=${encodeURIComponent(why)}&v="+Date.now());</script>
<p>Payment failed. No activation key was sent.</p></body>`;
}

function history(userId) {
  return db.query("SELECT * FROM payments WHERE user_id = ? ORDER BY created DESC LIMIT 40", [userId]).map(publicPay);
}

function warnExpiry(user, license) {
  if (!user || !license || !license.expires || license.developer) return;
  const days = Number(license.days_left);
  if (!Number.isFinite(days)) return;
  const marks = (billingCfg().expire_warn_days || [14, 7, 3, 1]).map(Number).sort((a, b) => b - a);
  const hit = marks.find((d) => days <= d);
  if (hit == null) return;
  notify.push(user.id, {
    kind: "plan_expiring",
    title: "Plan ending soon",
    body: `Your Axiasoft plan has ${days} day(s) left. Renew whenever you want.`,
    payload: { days: hit },
  });
}

module.exports = {
  catalog,
  planOf,
  configured,
  support,
  checkout,
  handleCallback,
  history,
  findById,
  publicPay,
  warnExpiry,
};
