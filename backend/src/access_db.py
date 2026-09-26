#!/usr/bin/env python3
"""AURION desk access database (users, sessions, per-account settings).

SQLite file by default (data/aurion.access.db).
PostgreSQL when AURION_DATABASE_URL / DATABASE_URL / config.database.url is set.

    python access_db.py <sqlite-path> init
    python access_db.py <sqlite-path> dump
    python access_db.py <sqlite-path> info
    python access_db.py <sqlite-path> ping
    python access_db.py <sqlite-path> exec  '<sql>' '<params-json>'
    python access_db.py <sqlite-path> query '<sql>' '<params-json>'
    python access_db.py <sqlite-path> put_settings '<user-id>' '<json>'
    python access_db.py <sqlite-path> get_settings '<user-id>'

Never invents users. Passwords are bcrypt hashes written by Node.
MT5 passwords are never stored here.
"""
from __future__ import annotations

import json
import os
import re
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CONFIG = ROOT / "config" / "aurion.json"

USER_COLS = [
    ("display_name", "TEXT DEFAULT ''"),
    ("gmail", "TEXT DEFAULT ''"),
    ("phone", "TEXT DEFAULT ''"),
    ("gmail_verified", "INTEGER NOT NULL DEFAULT 0"),
    ("phone_verified", "INTEGER NOT NULL DEFAULT 0"),
    ("totp_secret", "TEXT DEFAULT ''"),
    ("totp_enabled", "INTEGER NOT NULL DEFAULT 0"),
    ("timezone", "TEXT DEFAULT 'Asia/Tehran'"),
]

SQLITE_SCHEMA = """
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  identity_type TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  language TEXT NOT NULL DEFAULT 'en',
  role TEXT NOT NULL DEFAULT 'trader',
  is_owner INTEGER NOT NULL DEFAULT 0,
  disabled INTEGER NOT NULL DEFAULT 0,
  created TEXT NOT NULL,
  updated TEXT NOT NULL,
  last_login TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  boot_id TEXT NOT NULL,
  issued TEXT NOT NULL,
  expires TEXT NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0,
  revoked_at TEXT,
  ip TEXT,
  user_agent TEXT
);

CREATE TABLE IF NOT EXISTS access_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  user_id TEXT,
  username TEXT,
  action TEXT NOT NULL,
  detail TEXT,
  ip TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  created TEXT NOT NULL,
  dismissed INTEGER NOT NULL DEFAULT 0,
  dismissed_at TEXT,
  payload TEXT
);

CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  plan TEXT NOT NULL,
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL,
  provider TEXT NOT NULL,
  authority TEXT,
  ref_id TEXT,
  status TEXT NOT NULL,
  created TEXT NOT NULL,
  updated TEXT NOT NULL,
  paid_at TEXT,
  fail_reason TEXT,
  key_prefix TEXT,
  key_hash TEXT
);

CREATE TABLE IF NOT EXISTS user_settings (
  user_id TEXT PRIMARY KEY,
  language TEXT DEFAULT 'en',
  timezone TEXT DEFAULT 'Asia/Tehran',
  last_view TEXT DEFAULT 'command',
  symbol TEXT DEFAULT '',
  timeframe TEXT DEFAULT 'M15',
  mt5_path TEXT DEFAULT '',
  mt5_login TEXT DEFAULT '',
  mt5_server TEXT DEFAULT '',
  prefs TEXT DEFAULT '{}',
  updated TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_boot ON sessions(boot_id);
CREATE INDEX IF NOT EXISTS idx_access_ts ON access_log(ts);
CREATE INDEX IF NOT EXISTS idx_notify_user ON notifications(user_id, dismissed, created);
CREATE INDEX IF NOT EXISTS idx_pay_user ON payments(user_id, created);
CREATE INDEX IF NOT EXISTS idx_pay_auth ON payments(authority);
"""

PG_STATEMENTS = [
    """CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  identity_type TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  language TEXT NOT NULL DEFAULT 'en',
  role TEXT NOT NULL DEFAULT 'trader',
  is_owner INTEGER NOT NULL DEFAULT 0,
  disabled INTEGER NOT NULL DEFAULT 0,
  created TEXT NOT NULL,
  updated TEXT NOT NULL,
  last_login TEXT
)""",
    """CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  boot_id TEXT NOT NULL,
  issued TEXT NOT NULL,
  expires TEXT NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0,
  revoked_at TEXT,
  ip TEXT,
  user_agent TEXT
)""",
    """CREATE TABLE IF NOT EXISTS access_log (
  id BIGSERIAL PRIMARY KEY,
  ts TEXT NOT NULL,
  user_id TEXT,
  username TEXT,
  action TEXT NOT NULL,
  detail TEXT,
  ip TEXT
)""",
    """CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
)""",
    """CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  created TEXT NOT NULL,
  dismissed INTEGER NOT NULL DEFAULT 0,
  dismissed_at TEXT,
  payload TEXT
)""",
    """CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  plan TEXT NOT NULL,
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL,
  provider TEXT NOT NULL,
  authority TEXT,
  ref_id TEXT,
  status TEXT NOT NULL,
  created TEXT NOT NULL,
  updated TEXT NOT NULL,
  paid_at TEXT,
  fail_reason TEXT,
  key_prefix TEXT,
  key_hash TEXT
)""",
    """CREATE TABLE IF NOT EXISTS user_settings (
  user_id TEXT PRIMARY KEY,
  language TEXT DEFAULT 'en',
  timezone TEXT DEFAULT 'Asia/Tehran',
  last_view TEXT DEFAULT 'command',
  symbol TEXT DEFAULT '',
  timeframe TEXT DEFAULT 'M15',
  mt5_path TEXT DEFAULT '',
  mt5_login TEXT DEFAULT '',
  mt5_server TEXT DEFAULT '',
  prefs TEXT DEFAULT '{}',
  updated TEXT NOT NULL
)""",
    "CREATE INDEX IF NOT EXISTS idx_users_username ON users(username)",
    "CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)",
    "CREATE INDEX IF NOT EXISTS idx_sessions_boot ON sessions(boot_id)",
    "CREATE INDEX IF NOT EXISTS idx_access_ts ON access_log(ts)",
    "CREATE INDEX IF NOT EXISTS idx_notify_user ON notifications(user_id, dismissed, created)",
    "CREATE INDEX IF NOT EXISTS idx_pay_user ON payments(user_id, created)",
    "CREATE INDEX IF NOT EXISTS idx_pay_auth ON payments(authority)",
]


def db_url() -> str:
    for key in ("AURION_DATABASE_URL", "DATABASE_URL"):
        val = str(os.environ.get(key) or "").strip()
        if val:
            return val
    try:
        cfg = json.loads(CONFIG.read_text(encoding="utf-8"))
        val = str(((cfg.get("database") or {}).get("url")) or "").strip()
        if val:
            return val
    except Exception:
        pass
    return ""


def want_postgres() -> bool:
    url = db_url().lower()
    return url.startswith("postgres://") or url.startswith("postgresql://")


def load_psycopg():
    try:
        import psycopg
        from psycopg.rows import dict_row

        return psycopg, dict_row
    except Exception as exc:  # noqa: BLE001
        raise RuntimeError("psycopg_missing") from exc


def adapt_sql(sql: str, kind: str) -> str:
    if kind != "pg":
        return sql
    text = " ".join(str(sql or "").split())
    match = re.match(
        r"INSERT OR REPLACE INTO (\w+)\(([^)]+)\) VALUES \((.+)\)\s*$",
        text,
        re.I,
    )
    if match:
        table, cols, vals = match.group(1), match.group(2), match.group(3)
        cols_l = [c.strip() for c in cols.split(",") if c.strip()]
        if table == "settings":
            conflict = "key"
        elif table == "user_settings":
            conflict = "user_id"
        else:
            conflict = cols_l[0] if cols_l else "id"
        updates = ", ".join(f"{c}=EXCLUDED.{c}" for c in cols_l if c != conflict) or f"{conflict}={conflict}"
        text = (
            f"INSERT INTO {table}({cols}) VALUES ({vals}) "
            f"ON CONFLICT ({conflict}) DO UPDATE SET {updates}"
        )
    return text.replace("?", "%s")


def open_db(sqlite_path: str):
    if want_postgres():
        psycopg, dict_row = load_psycopg()
        con = psycopg.connect(db_url(), row_factory=dict_row, connect_timeout=8)
        con.autocommit = False
        return con, "pg"
    Path(sqlite_path).parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(sqlite_path)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys=ON")
    return con, "sqlite"


def execute(con, kind: str, sql: str, params=None):
    return con.execute(adapt_sql(sql, kind), list(params or []))


def as_dict(row) -> dict:
    if row is None:
        return {}
    if isinstance(row, dict):
        return dict(row)
    return dict(row)


def column_names(con, kind: str, table: str) -> set[str]:
    if kind == "pg":
        cur = execute(
            con,
            kind,
            "SELECT column_name AS name FROM information_schema.columns WHERE table_name = ?",
            [table],
        )
        return {str(as_dict(r).get("name") or "") for r in cur.fetchall()}
    cur = con.execute(f"PRAGMA table_info({table})")
    return {str(r["name"]) for r in cur.fetchall()}


def ensure_schema(con, kind: str) -> None:
    if kind == "pg":
        for stmt in PG_STATEMENTS:
            con.execute(stmt)
    else:
        con.executescript(SQLITE_SCHEMA)
    have = column_names(con, kind, "users")
    for name, decl in USER_COLS:
        if name in have:
            continue
        con.execute(f"ALTER TABLE users ADD COLUMN {name} {decl}")
    have_set = column_names(con, kind, "user_settings")
    if "user_id" not in have_set:
        if kind == "pg":
            con.execute(PG_STATEMENTS[6])
        else:
            con.execute(
                """CREATE TABLE IF NOT EXISTS user_settings (
                  user_id TEXT PRIMARY KEY,
                  language TEXT DEFAULT 'en',
                  timezone TEXT DEFAULT 'Asia/Tehran',
                  last_view TEXT DEFAULT 'command',
                  symbol TEXT DEFAULT '',
                  timeframe TEXT DEFAULT 'M15',
                  mt5_path TEXT DEFAULT '',
                  mt5_login TEXT DEFAULT '',
                  mt5_server TEXT DEFAULT '',
                  prefs TEXT DEFAULT '{}',
                  updated TEXT NOT NULL
                )"""
            )
    for u in execute(con, kind, "SELECT id, username, identity_type, gmail, phone FROM users").fetchall():
        row = as_dict(u)
        gmail = str(row.get("gmail") or "")
        phone = str(row.get("phone") or "")
        if not gmail and str(row.get("identity_type") or "") == "gmail":
            execute(con, kind, "UPDATE users SET gmail = ? WHERE id = ?", [row.get("username") or "", row.get("id")])
        if not phone and str(row.get("identity_type") or "") == "phone":
            execute(con, kind, "UPDATE users SET phone = ? WHERE id = ?", [row.get("username") or "", row.get("id")])


def migrate_users_json(con, kind: str, db_path: str) -> None:
    row = execute(con, kind, "SELECT value FROM settings WHERE key = ?", ["users_json_migrated"]).fetchone()
    if row:
        return
    users_json = Path(db_path).resolve().parent / "users.json"
    if users_json.is_file():
        try:
            payload = json.loads(users_json.read_text(encoding="utf-8"))
        except Exception:
            payload = {"users": []}
        for u in payload.get("users") or []:
            uid = str(u.get("id") or "").strip()
            username = str(u.get("username") or "").strip()
            if not uid or not username:
                continue
            exists = execute(
                con, kind, "SELECT 1 AS n FROM users WHERE id = ? OR username = ?", [uid, username]
            ).fetchone()
            if exists:
                continue
            ident = str(u.get("identity_type") or "").strip() or (
                "gmail" if "@" in username else ("phone" if username.startswith("09") else "legacy")
            )
            role = str(u.get("role") or "admin")
            created = str(u.get("created") or "")
            execute(
                con,
                kind,
                """INSERT INTO users
                   (id, username, identity_type, password_hash, language, role, is_owner, disabled, created, updated, last_login)
                   VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?, NULL)""",
                [
                    uid,
                    username,
                    ident,
                    str(u.get("password") or ""),
                    str(u.get("language") or "en"),
                    role,
                    created,
                    created,
                ],
            )
    execute(con, kind, "INSERT OR REPLACE INTO settings(key, value) VALUES (?, ?)", ["users_json_migrated", "1"])


def init(path: str) -> dict:
    con, kind = open_db(path)
    try:
        ensure_schema(con, kind)
        migrate_users_json(con, kind, path)
        con.commit()
        return {"ok": True, "driver": kind}
    finally:
        con.close()


def dump(path: str) -> dict:
    con, kind = open_db(path)
    try:
        ensure_schema(con, kind)
        migrate_users_json(con, kind, path)
        con.commit()
        users = [as_dict(r) for r in execute(con, kind, "SELECT * FROM users ORDER BY created").fetchall()]
        sessions = [as_dict(r) for r in execute(con, kind, "SELECT * FROM sessions").fetchall()]
        settings = {
            as_dict(r)["key"]: as_dict(r)["value"]
            for r in execute(con, kind, "SELECT key, value FROM settings").fetchall()
        }
        logs = [as_dict(r) for r in execute(con, kind, "SELECT * FROM access_log ORDER BY id DESC LIMIT 300").fetchall()]
        return {
            "ok": True,
            "driver": kind,
            "users": users,
            "sessions": sessions,
            "settings": settings,
            "access_log": logs,
        }
    finally:
        con.close()


def run_sql(path: str, sql: str, params: list, many: bool) -> dict:
    con, kind = open_db(path)
    try:
        ensure_schema(con, kind)
        cur = execute(con, kind, sql, params)
        if many:
            rows = [as_dict(r) for r in cur.fetchall()]
            con.commit()
            return {"ok": True, "driver": kind, "rows": rows}
        con.commit()
        last_id = getattr(cur, "lastrowid", None)
        return {"ok": True, "driver": kind, "changes": 1, "last_id": last_id}
    finally:
        con.close()


def empty_settings(user_id: str) -> dict:
    return {
        "user_id": user_id,
        "language": "en",
        "timezone": "Asia/Tehran",
        "last_view": "command",
        "symbol": "",
        "timeframe": "M15",
        "mt5_path": "",
        "mt5_login": "",
        "mt5_server": "",
        "prefs": "{}",
        "updated": "",
    }


def get_settings(path: str, user_id: str) -> dict:
    con, kind = open_db(path)
    try:
        ensure_schema(con, kind)
        con.commit()
        row = execute(con, kind, "SELECT * FROM user_settings WHERE user_id = ?", [user_id]).fetchone()
        return {"ok": True, "driver": kind, "row": as_dict(row) if row else empty_settings(user_id)}
    finally:
        con.close()


def put_settings(path: str, user_id: str, payload: dict) -> dict:
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    prefs = payload.get("prefs")
    if not isinstance(prefs, str):
        prefs = json.dumps(prefs or {}, ensure_ascii=False)
    row = {
        "user_id": user_id,
        "language": str(payload.get("language") or "en")[:8],
        "timezone": str(payload.get("timezone") or "Asia/Tehran")[:64],
        "last_view": str(payload.get("last_view") or "command")[:32],
        "symbol": str(payload.get("symbol") or "")[:40],
        "timeframe": str(payload.get("timeframe") or "M15")[:8],
        "mt5_path": str(payload.get("mt5_path") or "")[:400],
        "mt5_login": str(payload.get("mt5_login") or "")[:32],
        "mt5_server": str(payload.get("mt5_server") or "")[:80],
        "prefs": prefs[:8000],
        "updated": now,
    }
    con, kind = open_db(path)
    try:
        ensure_schema(con, kind)
        existing = execute(con, kind, "SELECT * FROM user_settings WHERE user_id = ?", [user_id]).fetchone()
        if existing:
            prev = as_dict(existing)
            for key in ("language", "timezone", "last_view", "symbol", "timeframe", "mt5_path", "mt5_login", "mt5_server", "prefs"):
                if key not in payload and prev.get(key) not in (None, ""):
                    row[key] = prev.get(key)
        execute(
            con,
            kind,
            """INSERT OR REPLACE INTO user_settings
               (user_id, language, timezone, last_view, symbol, timeframe, mt5_path, mt5_login, mt5_server, prefs, updated)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            [
                row["user_id"],
                row["language"],
                row["timezone"],
                row["last_view"],
                row["symbol"],
                row["timeframe"],
                row["mt5_path"],
                row["mt5_login"],
                row["mt5_server"],
                row["prefs"],
                row["updated"],
            ],
        )
        con.commit()
        got = execute(con, kind, "SELECT * FROM user_settings WHERE user_id = ?", [user_id]).fetchone()
        return {"ok": True, "driver": kind, "row": as_dict(got) if got else row}
    finally:
        con.close()


def info(path: str) -> dict:
    url_set = bool(db_url())
    wanted = "postgres" if want_postgres() else "sqlite"
    try:
        con, kind = open_db(path)
        try:
            execute(con, kind, "SELECT 1 AS n").fetchone()
            return {"ok": True, "driver": kind, "wanted": wanted, "url_set": url_set}
        finally:
            con.close()
    except Exception as exc:  # noqa: BLE001
        return {
            "ok": False,
            "driver": "sqlite" if not want_postgres() else "postgres",
            "wanted": wanted,
            "url_set": url_set,
            "error": str(exc),
        }


def main() -> int:
    if len(sys.argv) < 3:
        print(json.dumps({"ok": False, "error": "usage"}))
        return 2
    path = sys.argv[1]
    cmd = sys.argv[2]
    try:
        if cmd == "init":
            out = init(path)
        elif cmd == "dump":
            out = dump(path)
        elif cmd == "info" or cmd == "ping":
            out = info(path)
        elif cmd == "get_settings":
            out = get_settings(path, sys.argv[3] if len(sys.argv) > 3 else "")
        elif cmd == "put_settings":
            uid = sys.argv[3] if len(sys.argv) > 3 else ""
            raw = sys.argv[4] if len(sys.argv) > 4 else "{}"
            payload = json.loads(raw) if raw else {}
            if not isinstance(payload, dict):
                payload = {}
            out = put_settings(path, uid, payload)
        elif cmd in {"exec", "query"}:
            # Prefer stdin JSON to avoid argv exposure in process list
            sql = ""
            params = []
            try:
                if not sys.stdin.isatty():
                    stdin_raw = sys.stdin.read()
                    if stdin_raw and stdin_raw.strip():
                        jd = json.loads(stdin_raw)
                        if isinstance(jd, dict) and "sql" in jd:
                            sql = str(jd.get("sql") or "")
                            params = jd.get("params") or []
                            if not isinstance(params, list):
                                params = []
                            out = run_sql(path, sql, params, many=(cmd == "query"))
                        else:
                            raise ValueError("invalid stdin")
                    else:
                        raise ValueError("empty stdin")
                else:
                    raise ValueError("no stdin")
            except Exception:
                # fallback to argv for backward compat
                sql = sys.argv[3] if len(sys.argv) > 3 else ""
                raw = sys.argv[4] if len(sys.argv) > 4 else "[]"
                try:
                    params = json.loads(raw) if raw else []
                except Exception:
                    params = []
                if not isinstance(params, list):
                    params = []
                out = run_sql(path, sql, params, many=(cmd == "query"))
        else:
            out = {"ok": False, "error": "unknown_cmd"}
    except Exception as exc:  # noqa: BLE001
        out = {"ok": False, "error": str(exc)}
    sys.stdout.write(json.dumps(out, ensure_ascii=False, default=str))
    sys.stdout.write("\n")
    return 0 if out.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
