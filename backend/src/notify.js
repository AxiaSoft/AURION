"use strict";

const { v4: uuid } = require("uuid");
const db = require("./db");

function nowIso() {
  return new Date().toISOString();
}

function list(userId, includeDismissed = false) {
  const sql = includeDismissed
    ? "SELECT * FROM notifications WHERE user_id = ? ORDER BY created DESC LIMIT 80"
    : "SELECT * FROM notifications WHERE user_id = ? AND dismissed = 0 ORDER BY created DESC LIMIT 80";
  return db.query(sql, [userId]);
}

function push(userId, { kind, title, body, payload }) {
  const existing = db.query(
    "SELECT id FROM notifications WHERE user_id = ? AND kind = ? AND dismissed = 0 AND payload = ? LIMIT 1",
    [userId, String(kind || ""), payload ? JSON.stringify(payload) : ""]
  );
  if (existing.length) return existing[0];
  const row = {
    id: uuid(),
    user_id: userId,
    kind: String(kind || "info"),
    title: String(title || "").slice(0, 160),
    body: String(body || "").slice(0, 800),
    created: nowIso(),
    payload: payload ? JSON.stringify(payload) : "",
  };
  db.exec(
    "INSERT INTO notifications(id, user_id, kind, title, body, created, dismissed, dismissed_at, payload) VALUES (?, ?, ?, ?, ?, ?, 0, NULL, ?)",
    [row.id, row.user_id, row.kind, row.title, row.body, row.created, row.payload]
  );
  return row;
}

function dismiss(userId, id) {
  db.exec(
    "UPDATE notifications SET dismissed = 1, dismissed_at = ? WHERE id = ? AND user_id = ? AND dismissed = 0",
    [nowIso(), id, userId]
  );
  return { ok: true };
}

function publicRow(row) {
  let payload = null;
  try { payload = row.payload ? JSON.parse(row.payload) : null; } catch { payload = null; }
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    body: row.body,
    created: row.created,
    dismissed: Boolean(Number(row.dismissed)),
    payload,
  };
}

module.exports = { list, push, dismiss, publicRow };
