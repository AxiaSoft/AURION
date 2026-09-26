// API smoke test: order/invoice numbers, support tickets, admin grant +
// reset-machines rebind, admin brute-force lockout, audit trail. Boots the
// real app on an ephemeral port with an isolated DATA_DIR.
// Run: node test/api-support.mjs
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "aurion-keys-test-"));
// RFC 8032 test seed/public pair (test-only issuer; keys.js honors AURION_KEY_PUBLIC_HEX).
process.env.AURION_KEY_PRIVATE_HEX = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";
process.env.AURION_KEY_PUBLIC_HEX = "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a";
process.env.ADMIN_TOKEN = "test-admin-token-123";
process.env.ADMIN_FAIL_LIMIT = "3";
process.env.JWT_SECRET = "test-jwt";
process.env.PORT = "0";
const DATA_DIR = process.env.DATA_DIR;

const { app } = await import("../src/index.js");
const server = await new Promise((resolve) => {
  const s = app.listen(0, () => resolve(s));
});
const base = `http://127.0.0.1:${server.address().port}`;
const ADMIN = "test-admin-token-123";

async function call(path, { method = "GET", token, admin, body } = {}) {
  const headers = { "content-type": "application/json" };
  if (token) headers.authorization = "Bearer " + token;
  if (admin) headers["x-admin-token"] = admin;
  const res = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return res.json();
}
async function registerAndVerify(identity) {
  const cap = await call("/api/captcha");
  // the math question is printed in Persian digits — normalize first
  const q = String(cap.question || "").replace(/[۰-۹]/g, (c) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(c)));
  const sum = (q.match(/\d+/g) || []).reduce((a, b) => a + Number(b), 0);
  let r = await call("/api/auth/register", { method: "POST", body: { identity, password: "pass12345", captcha_id: cap.id, captcha_answer: String(sum) } });
  assert.ok(r.ok && r.dev_code, `register ${identity}: ${r.error || "ok"}`);
  r = await call("/api/auth/verify", { method: "POST", body: { identity, code: r.dev_code } });
  assert.ok(r.ok && r.token, `verify ${identity}`);
  return r.token;
}

try {
  const token1 = await registerAndVerify("buyer1@gmail.com");
  const token2 = await registerAndVerify("buyer2@gmail.com");

  // --- order: unique order number even without a payment gateway ---------------
  let r = await call("/api/orders", { method: "POST", token: token1, body: { plan: "m1" } });
  assert.equal(r.error, "gateway_not_configured", "no sandbox gateway configured here");
  let me = await call("/api/me", { token: token1 });
  const ord = me.orders.find((o) => o.plan === "m1");
  assert.ok(/^AX-O-\d+$/.test(ord.order_no), "order has unique order_no " + ord.order_no);
  assert.equal(ord.invoice_no, "", "unpaid order has no invoice number");

  // --- customer tickets ---------------------------------------------------------
  r = await call("/api/support/tickets", { method: "POST", token: token1, body: { subject: "کلید فعال نمی‌شود", body: "سلام، کلیدم روی سیستمم فعال نمی‌شود.", order_no: ord.order_no } });
  assert.ok(r.ok && /^AX-T-\d+$/.test(r.ticket_no), "ticket created with unique number");
  const tId = r.id;
  r = await call("/api/support/tickets", { token: token1 });
  assert.equal(r.tickets.length, 1, "own tickets listed");
  r = await call("/api/support/reply", { method: "POST", token: token1, body: { id: tId, body: "سیستم را هم عوض کردم." } });
  assert.ok(r.ok, "customer reply ok");
  r = await call("/api/support/ticket?id=" + tId, { token: token2 });
  assert.equal(r.error, "ticket_not_found", "another user's ticket stays private");

  // --- admin: inbox, reply, close ------------------------------------------------
  r = await call("/api/admin/overview", { admin: ADMIN });
  assert.ok(r.ok && r.open_tickets === 1 && r.users === 2, "overview counts users + open tickets");
  r = await call("/api/admin/tickets", { admin: ADMIN });
  assert.equal(r.tickets.length, 1, "admin inbox sees the ticket");
  r = await call("/api/admin/tickets/reply", { method: "POST", admin: ADMIN, body: { id: tId, body: "کلیدتان را ریست کردیم، دوباره تلاش کنید." } });
  assert.ok(r.ok, "admin reply ok");
  r = await call("/api/support/ticket?id=" + tId, { token: token1 });
  assert.ok(r.ok && r.messages.length === 3 && r.status === "answered", "thread shows admin answer");
  r = await call("/api/admin/tickets/status", { method: "POST", admin: ADMIN, body: { id: tId, status: "closed" } });
  assert.ok(r.ok && r.status === "closed", "ticket closed");

  // --- admin grant: free key straight into the customer's account -----------------
  r = await call("/api/admin/grant", { method: "POST", admin: ADMIN, body: { identity: "buyer1@gmail.com", plan: "m3", note: "compensation" } });
  assert.ok(r.ok && r.key && /^AX-I-\d+$/.test(r.invoice_no), "grant issues key + invoice number");
  const grantKey = r.key;
  me = await call("/api/me", { token: token1 });
  const grant = me.orders.find((o) => o.grant);
  assert.ok(grant && grant.status === "paid" && grant.keys[0].key === grantKey, "customer account shows the granted key");

  // grant key activates on PC-A, refuses PC-B, rebinds after admin reset-machines
  r = await call("/api/desk/activate", { method: "POST", body: { key: grantKey, machine: "PC-A" } });
  assert.ok(r.ok, "grant key activates on the first machine");
  r = await call("/api/desk/activate", { method: "POST", body: { key: grantKey, machine: "PC-B" } });
  assert.equal(r.error, "machine_mismatch", "second machine refused while bound");
  r = await call("/api/admin/reset-machines", { method: "POST", admin: ADMIN, body: { key: grantKey } });
  assert.ok(r.ok, "admin resets machine binding");
  r = await call("/api/desk/activate", { method: "POST", body: { key: grantKey, machine: "PC-B" } });
  assert.ok(r.ok && r.rebind, "after reset, next activation rebinds (support PC-change flow)");

  // --- user disable blocks login --------------------------------------------------
  r = await call("/api/admin/user-disable", { method: "POST", admin: ADMIN, body: { identity: "buyer2@gmail.com", disabled: true } });
  assert.ok(r.ok && r.disabled, "user disabled");
  r = await call("/api/me", { token: token2 });
  assert.equal(r.error, "session_invalid", "disabled user's session is dead");
  r = await call("/api/admin/user-disable", { method: "POST", admin: ADMIN, body: { identity: "buyer2@gmail.com", disabled: false } });
  assert.ok(r.ok && !r.disabled, "user re-enabled");

  // --- audit trail recorded everything (checked before the lockout test, which
  // hard-locks this IP from ALL admin endpoints for 15 minutes) -----------------
  r = await call("/api/admin/audit", { admin: ADMIN });
  const actions = (r.audit || []).map((a) => a.action);
  for (const want of ["grant", "ticket_reply", "reset_machines", "user_disable"]) {
    assert.ok(actions.includes(want), `audit contains ${want}`);
  }

  // --- admin brute-force lockout ------------------------------------------------
  for (let i = 0; i < 3; i++) {
    r = await call("/api/admin/overview", { admin: "wrong-token-" + i });
    assert.equal(r.error, "forbidden", "wrong token rejected");
  }
  r = await call("/api/admin/overview", { admin: "wrong-token-x" });
  assert.equal(r.error, "admin_locked", "IP locked after ADMIN_FAIL_LIMIT wrong tokens");

  console.log("api-support OK — numbering, tickets, grant, rebind, lockout, user disable, audit");
} finally {
  await new Promise((resolve) => server.close(resolve));
  try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* */ }
}
