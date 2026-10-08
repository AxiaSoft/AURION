from __future__ import annotations

import json
import os
import sqlite3
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from ..config import DATA_DIR, ROOT, load
from ..strategy.loader import BUILTIN_NAMES, LEGACY_BUILTINS
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
CREATE TABLE IF NOT EXISTS strategy_ledger (
    strategy TEXT PRIMARY KEY,
    trades INTEGER NOT NULL DEFAULT 0,
    wins INTEGER NOT NULL DEFAULT 0,
    losses INTEGER NOT NULL DEFAULT 0,
    net REAL NOT NULL DEFAULT 0,
    gross_profit REAL NOT NULL DEFAULT 0,
    gross_loss REAL NOT NULL DEFAULT 0,
    best REAL NOT NULL DEFAULT 0,
    worst REAL NOT NULL DEFAULT 0,
    first_ts TEXT,
    last_ts TEXT
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

# Parsed out of MT5 comments, so this is a *historical* list, not the list of
# strategies that currently ship: trades opened by scalp_impulse before it was
# retired still carry its tag, and a history that silently stopped attributing
# them would quietly rewrite the record.
STRATEGY_TAGS = tuple(BUILTIN_NAMES) + tuple(LEGACY_BUILTINS)
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


def normalise_strategy_tag(tag: str) -> str:
    """One spelling per strategy.

    Tags arrive from MT5 comments, from uploaded file names and from the desk,
    in every combination of case, dashes and a trailing .py. Without a single
    normaliser the same strategy accumulates two or three separate records and
    each card shows a fraction of its own history.
    """
    name = str(tag or "").strip()
    if not name:
        return "other"
    if name.startswith("@"):          # reserved desk tags keep their marker
        return name
    name = name.lower().replace("-", "_").replace(" ", "_")
    if name.endswith(".py"):
        name = name[:-3]
    return name or "other"


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
        data_dir = DATA_DIR if os.environ.get("AURION_DATA_DIR") else ROOT / cfg["paths"]["data"]
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
        if _is_close_row(kind, entry, trade.get("profit")):
            # The per-strategy record is kept in its own ledger, updated here
            # because every close - EA, native sync or desk - passes through
            # this one function. Deriving it from the trades table instead is
            # what made clearing the history erase a strategy's whole record.
            self._bump_strategy_ledger(strategy, trade)

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

    def pending_reconcile(self, limit: int = 40) -> list[dict[str, Any]]:
        """Closed rows whose figures came from the last floating price.

        A position can vanish from the book a second or two before its deal
        reaches MT5's history. Rather than block the close, the desk records
        what it knows and marks the row; these are the rows to go back for.
        """
        rows = self.query(
            """SELECT id, ticket, raw FROM trades
               WHERE lower(coalesce(kind,'')) IN ('close','out','inout')
               ORDER BY id DESC LIMIT ?""",
            (int(limit or 40),),
        )
        out: list[dict[str, Any]] = []
        for row in rows:
            try:
                raw = json.loads(row.get("raw") or "{}")
            except Exception:
                raw = {}
            if str(raw.get("source") or "") == "estimate":
                out.append({"id": row.get("id"), "ticket": row.get("ticket")})
        return out

    def apply_reconciliation(self, row_id: int, totals: dict[str, Any]) -> bool:
        """Replace an estimated close with MetaTrader's own figures."""
        rows = self.query("SELECT raw FROM trades WHERE id=? LIMIT 1", (int(row_id),))
        if not rows:
            return False
        try:
            raw = json.loads(rows[0].get("raw") or "{}")
        except Exception:
            raw = {}
        raw.update({
            "profit": totals.get("profit"),
            "swap": totals.get("swap"),
            "commission": totals.get("commission"),
            "net": totals.get("net"),
            "parts": totals.get("parts"),
            "source": "mt5",
        })
        self.execute(
            """UPDATE trades SET profit=?, swap=?, commission=?, price=?, raw=? WHERE id=?""",
            (
                totals.get("profit"),
                totals.get("swap"),
                totals.get("commission"),
                totals.get("price") or None,
                json.dumps(raw, ensure_ascii=False),
                int(row_id),
            ),
        )
        return True

    def _bump_strategy_ledger(self, strategy: str, trade: dict[str, Any]) -> None:
        """Fold one closed trade into a strategy's running record.

        Uses net - profit plus swap and commission - because that is what the
        account balance did. A strategy whose gross wins are eaten by swap is
        not a winning strategy, and the card should not claim otherwise.
        """
        tag = normalise_strategy_tag(strategy or parse_strategy_tag(str(trade.get("comment") or "")))
        try:
            profit = float(trade.get("profit") or 0)
            swap = float(trade.get("swap") or 0)
            commission = float(trade.get("commission") or 0)
        except (TypeError, ValueError):
            return
        net_raw = trade.get("net")
        try:
            net = float(net_raw) if net_raw not in (None, "") else profit + swap + commission
        except (TypeError, ValueError):
            net = profit + swap + commission
        net = round(net, 2)
        stamp = str(trade.get("time") or trade.get("ts") or utc_iso())

        self.execute(
            """INSERT INTO strategy_ledger(strategy, trades, wins, losses, net,
                   gross_profit, gross_loss, best, worst, first_ts, last_ts)
               VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(strategy) DO UPDATE SET
                   trades = trades + 1,
                   wins = wins + excluded.wins,
                   losses = losses + excluded.losses,
                   net = round(net + excluded.net, 2),
                   gross_profit = round(gross_profit + excluded.gross_profit, 2),
                   gross_loss = round(gross_loss + excluded.gross_loss, 2),
                   best = max(best, excluded.best),
                   worst = min(worst, excluded.worst),
                   last_ts = excluded.last_ts""",
            (
                tag,
                1 if net > 0 else 0,
                1 if net < 0 else 0,
                net,
                net if net > 0 else 0.0,
                net if net < 0 else 0.0,
                net,
                net,
                stamp,
                stamp,
            ),
        )

    def strategy_ledger(self, names: list[str] | None = None) -> dict[str, dict[str, Any]]:
        """Every strategy's record, including ones with no trades yet.

        A card reading 0 trades is information; a card with no numbers at all
        looks broken, which is why requested names are always present.
        """
        out: dict[str, dict[str, Any]] = {}
        for name in names or []:
            out[normalise_strategy_tag(name)] = {
                "trades": 0, "wins": 0, "losses": 0, "net": 0.0,
                "gross_profit": 0.0, "gross_loss": 0.0, "best": 0.0, "worst": 0.0,
                "win_rate": 0.0, "profit_factor": 0.0, "avg": 0.0, "last_ts": None,
            }
        for row in self.query("SELECT * FROM strategy_ledger"):
            tag = normalise_strategy_tag(str(row.get("strategy") or ""))
            trades = int(row.get("trades") or 0)
            wins = int(row.get("wins") or 0)
            gross_profit = float(row.get("gross_profit") or 0)
            gross_loss = abs(float(row.get("gross_loss") or 0))
            net = float(row.get("net") or 0)
            out[tag] = {
                "trades": trades,
                "wins": wins,
                "losses": int(row.get("losses") or 0),
                "net": round(net, 2),
                "gross_profit": round(gross_profit, 2),
                "gross_loss": round(gross_loss, 2),
                "best": round(float(row.get("best") or 0), 2),
                "worst": round(float(row.get("worst") or 0), 2),
                "win_rate": round(wins / trades * 100, 1) if trades else 0.0,
                # Undefined rather than infinite when nothing has lost yet.
                "profit_factor": round(gross_profit / gross_loss, 2) if gross_loss else None,
                "avg": round(net / trades, 2) if trades else 0.0,
                "last_ts": row.get("last_ts"),
            }
        return out

    def backfill_strategy_ledger(self) -> int:
        """Seed the ledger from existing history, once.

        An install that already has months of trades should not start from zero
        the day this ships. Runs only while the ledger is empty, so a later
        history reset cannot trigger a re-import of rows that are gone.
        """
        existing = self.query("SELECT COUNT(*) AS n FROM strategy_ledger")
        if existing and int(existing[0].get("n") or 0):
            return 0
        rows = self.query("SELECT * FROM trades ORDER BY id ASC")
        seeded = 0
        for row in rows:
            if not _is_close_row(row.get("kind"), row.get("entry"), row.get("profit")):
                continue
            self._bump_strategy_ledger(
                str(row.get("strategy") or ""),
                {
                    "profit": row.get("profit"),
                    "swap": row.get("swap"),
                    "commission": row.get("commission"),
                    "comment": row.get("comment"),
                    "time": row.get("ts"),
                },
            )
            seeded += 1
        return seeded

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
                # Wipe the dashboard book. Do not touch candles (AI tape),
                # and deliberately not strategy_ledger either: a strategy's
                # record is its track record. Clearing the trade list is a
                # housekeeping action, not a reason to forget that a strategy
                # has taken 300 trades at a 54% win rate.
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
