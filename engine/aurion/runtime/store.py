from __future__ import annotations

import json
import sqlite3
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from ..config import ROOT, load
from ..util.clock import utc_iso

SCHEMA = """
CREATE TABLE IF NOT EXISTS ticks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    symbol TEXT NOT NULL,
    bid REAL, ask REAL, last REAL, volume REAL, spread REAL
);
CREATE TABLE IF NOT EXISTS candles (
    symbol TEXT NOT NULL,
    timeframe TEXT NOT NULL,
    ts TEXT NOT NULL,
    open REAL, high REAL, low REAL, close REAL, volume REAL, spread REAL,
    PRIMARY KEY (symbol, timeframe, ts)
);
CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    level TEXT,
    lang_key TEXT,
    message TEXT,
    payload TEXT
);
CREATE TABLE IF NOT EXISTS trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    ticket INTEGER,
    symbol TEXT,
    side TEXT,
    volume REAL,
    price REAL,
    sl REAL,
    tp REAL,
    profit REAL,
    swap REAL,
    commission REAL,
    comment TEXT,
    raw TEXT,
    strategy TEXT,
    kind TEXT,
    entry TEXT
);
CREATE TABLE IF NOT EXISTS equity (
    ts TEXT PRIMARY KEY,
    balance REAL,
    equity REAL,
    margin REAL,
    profit REAL,
    drawdown REAL
);
CREATE TABLE IF NOT EXISTS signals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    source TEXT,
    symbol TEXT,
    timeframe TEXT,
    direction TEXT,
    confidence REAL,
    reason TEXT,
    payload TEXT
);
CREATE TABLE IF NOT EXISTS ai_models (
    name TEXT PRIMARY KEY,
    updated TEXT,
    samples INTEGER,
    metrics TEXT,
    path TEXT
);
CREATE INDEX IF NOT EXISTS idx_ticks_ts ON ticks(ts);
CREATE INDEX IF NOT EXISTS idx_trades_ts ON trades(ts);
CREATE INDEX IF NOT EXISTS idx_trades_ticket ON trades(ticket);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
"""

STRATEGY_TAGS = ("ema_rsi", "price_action", "atr_breakout", "scalp_impulse")
_SKIP_TAGS = {"", "desk", "manual", "robot", "close", "flatten", "order", "aurion"}


def parse_strategy_tag(comment: str) -> str:
    """Pull the strategy id out of an MT5 comment (max 31 chars)."""
    raw = str(comment or "").strip()
    if not raw:
        return ""
    low = raw.lower().replace("-", "_")
    parts = low.replace("/", " ").replace(":", " ").split()
    if parts and parts[0] == "aurion" and len(parts) >= 2:
        tag = parts[1].strip("._")
        if tag not in _SKIP_TAGS:
            return tag
    compact = low.replace(" ", "_")
    for tag in STRATEGY_TAGS:
        if tag in compact:
            return tag
    return ""


def _is_close_row(kind: str, entry: str, profit: Any) -> bool:
    kind_l = str(kind or "").lower()
    entry_l = str(entry or "").lower()
    if kind_l in {"entry", "in"} or entry_l == "in":
        return False
    if kind_l in {"close", "out", "inout"} or entry_l in {"out", "inout"}:
        return True
    # Legacy rows had no kind: treat a non-zero P/L as a closed trade.
    try:
        return abs(float(profit or 0)) > 1e-12
    except (TypeError, ValueError):
        return False


class Store:
    def __init__(self, path: Path | None = None) -> None:
        cfg = load()
        data_dir = ROOT / cfg["paths"]["data"]
        data_dir.mkdir(parents=True, exist_ok=True)
        self.path = path or (data_dir / "aurion.engine.db")
        self._lock = threading.RLock()
        self._conn = sqlite3.connect(self.path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA synchronous=NORMAL")
        self._conn.executescript(SCHEMA)
        self._migrate()
        self._conn.commit()

    def _migrate(self) -> None:
        cols = {row["name"] for row in self._conn.execute("PRAGMA table_info(trades)").fetchall()}
        if "strategy" not in cols:
            self._conn.execute("ALTER TABLE trades ADD COLUMN strategy TEXT")
        if "kind" not in cols:
            self._conn.execute("ALTER TABLE trades ADD COLUMN kind TEXT")
        if "entry" not in cols:
            self._conn.execute("ALTER TABLE trades ADD COLUMN entry TEXT")
        self._conn.execute("CREATE INDEX IF NOT EXISTS idx_trades_ticket ON trades(ticket)")

    def close(self) -> None:
        with self._lock:
            try:
                self._conn.close()
            except Exception:
                pass

    def recreate(self) -> None:
        """Drop the live book and open a fresh empty database."""
        with self._lock:
            try:
                self._conn.close()
            except Exception:
                pass
            for extra in ("", "-wal", "-shm"):
                target = Path(str(self.path) + extra) if extra else self.path
                try:
                    if target.exists():
                        target.unlink()
                except Exception:
                    pass
            self.path.parent.mkdir(parents=True, exist_ok=True)
            self._conn = sqlite3.connect(self.path, check_same_thread=False)
            self._conn.row_factory = sqlite3.Row
            self._conn.execute("PRAGMA journal_mode=WAL")
            self._conn.execute("PRAGMA synchronous=NORMAL")
            self._conn.executescript(SCHEMA)
            self._migrate()
            self._conn.commit()

    def execute(self, sql: str, params: tuple[Any, ...] = ()) -> None:
        with self._lock:
            self._conn.execute(sql, params)
            self._conn.commit()

    def query(self, sql: str, params: tuple[Any, ...] = ()) -> list[dict[str, Any]]:
        with self._lock:
            cur = self._conn.execute(sql, params)
            return [dict(row) for row in cur.fetchall()]

    def log_event(self, level: str, message: str, lang_key: str = "", payload: dict[str, Any] | None = None) -> None:
        self.execute(
            "INSERT INTO events(ts, level, lang_key, message, payload) VALUES (?,?,?,?,?)",
            (utc_iso(), level, lang_key, message, json.dumps(payload or {}, ensure_ascii=False)),
        )

    def record_tick(self, tick: dict[str, Any]) -> None:
        self.execute(
            "INSERT INTO ticks(ts, symbol, bid, ask, last, volume, spread) VALUES (?,?,?,?,?,?,?)",
            (
                tick.get("time") or utc_iso(),
                tick.get("symbol"),
                tick.get("bid"),
                tick.get("ask"),
                tick.get("last"),
                tick.get("volume"),
                tick.get("spread"),
            ),
        )

    def upsert_candle(self, c: dict[str, Any]) -> None:
        self.execute(
            """INSERT INTO candles(symbol, timeframe, ts, open, high, low, close, volume, spread)
               VALUES (?,?,?,?,?,?,?,?,?)
               ON CONFLICT(symbol, timeframe, ts) DO UPDATE SET
                 open=excluded.open, high=excluded.high, low=excluded.low,
                 close=excluded.close, volume=excluded.volume, spread=excluded.spread""",
            (
                c.get("symbol"),
                c.get("timeframe"),
                c.get("time"),
                c.get("open"),
                c.get("high"),
                c.get("low"),
                c.get("close"),
                c.get("volume"),
                c.get("spread") or 0,
            ),
        )

    def record_equity(self, account: dict[str, Any], drawdown: float) -> None:
        self.execute(
            """INSERT INTO equity(ts, balance, equity, margin, profit, drawdown)
               VALUES (?,?,?,?,?,?)
               ON CONFLICT(ts) DO UPDATE SET
                 balance=excluded.balance, equity=excluded.equity,
                 margin=excluded.margin, profit=excluded.profit, drawdown=excluded.drawdown""",
            (
                utc_iso(),
                account.get("balance"),
                account.get("equity"),
                account.get("margin"),
                account.get("profit"),
                drawdown,
            ),
        )

    def record_trade(self, trade: dict[str, Any]) -> bool:
        ticket = trade.get("ticket")
        try:
            ticket_i = int(ticket) if ticket not in (None, "") else 0
        except (TypeError, ValueError):
            ticket_i = 0
        kind = str(trade.get("kind") or "")
        entry = str(trade.get("entry") or "")
        strategy = str(trade.get("strategy") or parse_strategy_tag(str(trade.get("comment") or "")))
        if _is_close_row(kind, entry, trade.get("profit")) and ticket_i:
            existing = self.query(
                """SELECT id FROM trades
                   WHERE ticket=? AND (
                     lower(coalesce(kind,'')) IN ('close','out','inout')
                     OR lower(coalesce(entry,'')) IN ('out','inout')
                   )
                   LIMIT 1""",
                (ticket_i,),
            )
            if existing:
                return False
        self.execute(
            """INSERT INTO trades(ts, ticket, symbol, side, volume, price, sl, tp, profit, swap, commission, comment, raw, strategy, kind, entry)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                trade.get("time") or utc_iso(),
                ticket_i or ticket,
                trade.get("symbol"),
                trade.get("type") or trade.get("side"),
                trade.get("volume"),
                trade.get("price"),
                trade.get("sl"),
                trade.get("tp"),
                trade.get("profit"),
                trade.get("swap"),
                trade.get("commission"),
                trade.get("comment"),
                json.dumps(trade, ensure_ascii=False),
                strategy or None,
                kind or None,
                entry or None,
            ),
        )
        return True

    def record_signal(self, signal: dict[str, Any]) -> None:
        self.execute(
            "INSERT INTO signals(ts, source, symbol, timeframe, direction, confidence, reason, payload) VALUES (?,?,?,?,?,?,?,?)",
            (
                signal.get("ts") or utc_iso(),
                signal.get("source") or "ai",
                signal.get("symbol"),
                signal.get("timeframe"),
                signal.get("direction"),
                signal.get("confidence"),
                signal.get("reason"),
                json.dumps(signal, ensure_ascii=False),
            ),
        )

    def recent_events(self, limit: int = 300) -> list[dict[str, Any]]:
        rows = self.query("SELECT * FROM events ORDER BY id DESC LIMIT ?", (limit,))
        for row in rows:
            if row.get("payload"):
                try:
                    row["payload"] = json.loads(row["payload"])
                except Exception:
                    pass
        return list(reversed(rows))

    def history(self, limit: int = 500, closed_only: bool = True) -> list[dict[str, Any]]:
        rows = self.query("SELECT * FROM trades ORDER BY id DESC LIMIT ?", (max(int(limit or 500) * 3, 80),))
        out: list[dict[str, Any]] = []
        for row in rows:
            if not row.get("strategy"):
                row["strategy"] = parse_strategy_tag(str(row.get("comment") or ""))
            if closed_only and not _is_close_row(row.get("kind"), row.get("entry"), row.get("profit")):
                continue
            out.append(row)
            if len(out) >= int(limit or 500):
                break
        return out

    def strategy_stats(self, names: list[str] | None = None) -> dict[str, dict[str, Any]]:
        out: dict[str, dict[str, Any]] = {}
        for name in names or []:
            out[str(name)] = {"trades": 0, "wins": 0, "losses": 0, "net": 0.0, "win_rate": 0.0}
        try:
            rows = self.query("SELECT ticket, profit, comment, strategy, kind, entry FROM trades")
        except Exception:
            rows = self.query("SELECT ticket, profit, comment FROM trades")
        for row in rows:
            if not _is_close_row(row.get("kind"), row.get("entry"), row.get("profit")):
                continue
            tag = str(row.get("strategy") or "").strip() or parse_strategy_tag(str(row.get("comment") or ""))
            if tag.startswith("@"):
                pass
            elif tag:
                tag = tag.lower().replace("-", "_")
                if tag.endswith(".py"):
                    tag = tag[:-3]
            if not tag:
                tag = "other"
            rec = out.setdefault(tag, {"trades": 0, "wins": 0, "losses": 0, "net": 0.0, "win_rate": 0.0})
            try:
                profit = float(row.get("profit") or 0)
            except (TypeError, ValueError):
                profit = 0.0
            rec["trades"] += 1
            rec["net"] += profit
            if profit > 0:
                rec["wins"] += 1
            elif profit < 0:
                rec["losses"] += 1
        for rec in out.values():
            n = int(rec["trades"] or 0)
            rec["net"] = round(float(rec["net"]), 2)
            rec["win_rate"] = round((float(rec["wins"]) / n) * 100.0, 1) if n else 0.0
        return out

    def equity_series(self, limit: int = 2000) -> list[dict[str, Any]]:
        return self.query("SELECT * FROM equity ORDER BY ts DESC LIMIT ?", (limit,))[::-1]

    def candles(self, symbol: str, timeframe: str, limit: int = 800) -> list[dict[str, Any]]:
        return self.query(
            "SELECT * FROM candles WHERE symbol=? AND timeframe=? ORDER BY ts DESC LIMIT ?",
            (symbol, timeframe, limit),
        )[::-1]

    def signals(self, limit: int = 200) -> list[dict[str, Any]]:
        return self.query("SELECT * FROM signals ORDER BY id DESC LIMIT ?", (limit,))

    def archive_and_reset(self, days: int = 30) -> dict[str, Any]:
        """Archive the AURION ledger, then wipe dashboard trade history.

        Candles stay — the robot learns from live bars, not from this reset.
        MetaTrader deal history is never imported into this table.
        """
        cfg = load()
        archive_dir = ROOT / cfg["paths"]["archive"]
        archive_dir.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        dest = archive_dir / f"aurion-{stamp}.db"
        try:
            with self._lock:
                self._conn.commit()
                backup = sqlite3.connect(dest)
                self._conn.backup(backup)
                backup.close()
                # Wipe the dashboard book. Do not touch candles (AI tape).
                self._conn.execute("DELETE FROM trades")
                self._conn.execute("DELETE FROM signals")
                self._conn.execute("DELETE FROM events")
                self._conn.execute("DELETE FROM ticks")
                self._conn.execute("DELETE FROM equity")
                try:
                    self._conn.execute("VACUUM")
                except Exception:
                    pass
                self._conn.commit()
            return {"ok": True, "archive": str(dest), "wiped": "ledger"}
        except Exception as exc:
            return {"ok": False, "error": str(exc)}
