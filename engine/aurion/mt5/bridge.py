from __future__ import annotations

import asyncio
import contextlib
import json
import os
import socket
import time
from collections import defaultdict, deque
from pathlib import Path
from typing import Any, Awaitable, Callable

from ..config import ROOT, load
from ..util.clock import utc_iso
from ..util.log import get
from .native import AVAILABLE as NATIVE_AVAILABLE
from .native import NativeMT5
from .protocol import decode_buffer, encode, parse_ea_json
from .types import Account, Candle, ChartAgent, Deal, PendingOrder, Position, Tick, classify_account, timeframe_from_minutes

log = get("mt5")

EventHandler = Callable[[str, dict[str, Any]], Awaitable[None] | None]


def _new_tape() -> dict[str, Any]:
    """One isolated view of terminal state (live chart or tester chart)."""
    return {
        "ticks": {},
        "candles": defaultdict(lambda: deque(maxlen=3000)),
        "positions": [],
        "orders": [],
        "deals": [],
        "account": Account(),
        "last_tick_at": "",
    }


class MT5Bridge:
    """Single source of truth for live terminal state.

    Data only enters this object from:
      1. The official MetaTrader5 package (same machine as the terminal)
      2. AurionBridge.mq5 (TCP 18766 or HTTP POST /v1/ea/ingest)

    There is no simulator, no replay clock, and no placeholder candles.
    """

    def __init__(self) -> None:
        self.native = NativeMT5()
        self._server: asyncio.AbstractServer | None = None
        self._ea_clients: dict[asyncio.StreamWriter, dict[str, Any]] = {}
        self._handlers: list[EventHandler] = []
        self._lock = asyncio.Lock()
        # Terminal state is kept strictly per tape: "live" is the real chart,
        # "tester" is the Strategy Tester chart. The desk, the robot and the
        # risk engine only ever read the ACTIVE tape, so an AurionBridge
        # running inside the Strategy Tester can never overwrite live prices,
        # positions or the account — and vice versa.
        self._tapes: dict[str, dict[str, Any]] = {"live": _new_tape(), "tester": _new_tape()}
        self._tape_hint = "live"
        self.agents: dict[int, ChartAgent] = {}
        self.symbols: list[str] = []
        self.last_error: str = ""
        self.connected = False
        self.source: str = ""
        self.latency_ms: float = 0.0
        self._native_task: asyncio.Task[None] | None = None
        self._started = False
        self._ea_grace_until = 0.0
        self._order_waiters: list[asyncio.Future] = []
        self._hist_waiters: dict[tuple[str, str], list[asyncio.Future]] = defaultdict(list)
        self._agent_owner: dict[int, asyncio.StreamWriter | None] = {}
        self._purge_gen: dict[int, int] = {}
        self._http_seen: dict[int, float] = {}
        self._http_inbox: dict[int, list[dict[str, Any]]] = defaultdict(list)
        self._http_task: asyncio.Task[None] | None = None
        self._file_task: asyncio.Task[None] | None = None
        self._file_off: dict[str, int] = {}
        self._last_ingest_at: str = ""
        self._last_hello_at: str = ""
        self._last_file_inbox: str = ""
        self._ingest_count: int = 0
        self._http_post_at: dict[int, float] = {}
        self._ingest_seen: dict[str, float] = {}
        self._last_pos_mark = 0.0
        self._agent_beat: dict[int, float] = {}
        self.AGENT_LIVE_SEC = 18.0

    def on_event(self, handler: EventHandler) -> None:
        self._handlers.append(handler)

    async def emit(self, kind: str, payload: dict[str, Any]) -> None:
        for handler in list(self._handlers):
            try:
                result = handler(kind, payload)
                if asyncio.iscoroutine(result):
                    await result
            except Exception:
                log.exception("event handler failed")

    # ------------------------------------------------------------------
    # Tape separation (live chart vs Strategy Tester chart)
    # ------------------------------------------------------------------
    def _compute_tape(self) -> str:
        if self.native.connected:
            return "live"
        live_hit = False
        tester_hit = False
        for agent in self.agents.values():
            if agent.status == "offline" or not agent.symbol:
                continue
            if not self._fresh_beat(int(agent.chart_id)):
                continue
            if self._is_tester_agent(agent):
                tester_hit = True
            else:
                live_hit = True
        if live_hit:
            return "live"
        if tester_hit:
            return "tester"
        return ""

    def active_tape(self) -> str:
        tape = self._compute_tape()
        if tape:
            self._tape_hint = tape
            return tape
        # Nothing online right now — keep showing the last tape we had so the
        # desk does not flicker to empty values during a reconnect gap.
        return self._tape_hint or "live"

    def _tape_store(self, tape: str | None = None) -> dict[str, Any]:
        key = tape if tape in self._tapes else self.active_tape()
        return self._tapes[key]

    def _msg_tape(self, message: dict[str, Any]) -> str:
        """Attribute one EA message to the live or the tester tape."""
        if isinstance(message, dict):
            if "tester" in message:
                return "tester" if message.get("tester") else "live"
            mode = str(message.get("mode") or "").lower()
            if mode in {"tester", "backtest"}:
                return "tester"
            if mode in {"live", "real"}:
                return "live"
            cid = self._cid(message.get("chart_id"))
            agent = self.agents.get(cid) if cid else None
            if agent is not None and agent.symbol:
                return "tester" if self._is_tester_agent(agent) else "live"
        return self.active_tape()

    def active_agents(self) -> list[ChartAgent]:
        tape = self.active_tape()
        want_tester = tape == "tester"
        return [a for a in self.online_agents(include_tester=True) if self._is_tester_agent(a) == want_tester]

    async def _refresh_tape_view(self, prev: str) -> None:
        """Re-publish the full board when the active tape flips."""
        now = self.active_tape()
        if not prev or now == prev:
            return
        log.info("active tape switched %s -> %s", prev, now)
        await self.emit("ticks", {k: v.to_dict() for k, v in self.public_ticks().items()})
        await self.emit("account", self.account.to_dict())
        await self.emit("positions", [p.to_dict() for p in self.positions])
        await self.emit("orders", [o.to_dict() for o in self.orders])
        await self.emit("deals", [d.to_dict() for d in self.deals[-400:]])
        for (symbol, tf), rows in self.candles.items():
            if rows:
                await self.emit("candles", {"symbol": symbol, "timeframe": tf, "bars": [c.to_dict() for c in rows]})
        await self.emit("agents", {"items": [a.to_dict() for a in self.online_agents()]})
        await self.emit("status", self.snapshot_status)

    # Active-tape views. The trader, the API and the native poller keep using
    # these names; they always resolve to whichever tape the desk is showing.
    @property
    def account(self) -> Account:
        return self._tape_store()["account"]

    @account.setter
    def account(self, value: Account) -> None:
        self._tape_store()["account"] = value

    @property
    def ticks(self) -> dict[str, Tick]:
        return self._tape_store()["ticks"]

    @ticks.setter
    def ticks(self, value: dict[str, Tick]) -> None:
        self._tape_store()["ticks"] = value

    @property
    def candles(self) -> dict[tuple[str, str], deque[Candle]]:
        return self._tape_store()["candles"]

    @candles.setter
    def candles(self, value: Any) -> None:
        self._tape_store()["candles"] = value

    @property
    def positions(self) -> list[Position]:
        return self._tape_store()["positions"]

    @positions.setter
    def positions(self, value: list[Position]) -> None:
        self._tape_store()["positions"] = value

    @property
    def orders(self) -> list[PendingOrder]:
        return self._tape_store()["orders"]

    @orders.setter
    def orders(self, value: list[PendingOrder]) -> None:
        self._tape_store()["orders"] = value

    @property
    def deals(self) -> list[Deal]:
        return self._tape_store()["deals"]

    @deals.setter
    def deals(self, value: list[Deal]) -> None:
        self._tape_store()["deals"] = value

    @property
    def last_tick_at(self) -> str:
        return str(self._tape_store()["last_tick_at"] or "")

    @last_tick_at.setter
    def last_tick_at(self, value: str) -> None:
        self._tape_store()["last_tick_at"] = str(value or "")

    @property
    def snapshot_status(self) -> dict[str, Any]:
        live = (
            self.connected
            or (self._ea_grace_until > time.time())
            or bool(self._ea_clients)
            or self._http_live()
            or self.native.connected
        )
        return {
            "connected": live,
            "source": self.source,
            "native_package": NATIVE_AVAILABLE,
            "account": self.account.to_dict(),
            "symbols": sorted(self.online_symbols()),
            "last_tick_at": self.last_tick_at,
            "latency_ms": self.latency_ms,
            "ea_charts": len(self.online_agents()),
            "live_charts": len(self.online_agents(include_tester=False)),
            "tester_charts": len([a for a in self.online_agents(include_tester=True) if self._is_tester_agent(a)]),
            "last_error": self.last_error,
            "ea_last_ingest": self._last_ingest_at,
            "ea_last_hello": self._last_hello_at,
            "ea_file_inbox": self._last_file_inbox,
            "ea_ingest_count": self._ingest_count,
            "tape": self.tape_mode(),
            "open_positions": len(self.positions),
            "pending_orders": len(self.orders),
        }

    def snapshot_full(self) -> dict[str, Any]:
        candles = {
            f"{sym}:{tf}": [c.to_dict() for c in rows]
            for (sym, tf), rows in self.candles.items()
        }
        return {
            "status": self.snapshot_status,
            "ticks": {k: v.to_dict() for k, v in self.ticks.items()},
            "candles": candles,
            "positions": [p.to_dict() for p in self.positions],
            "orders": [o.to_dict() for o in self.orders],
            "deals": [d.to_dict() for d in self.deals[-400:]],
            "agents": [a.to_dict() for a in self.agents.values()],
        }

    def candles_of(self, symbol: str, timeframe: str) -> list[Candle]:
        return list(self.candles.get((symbol, timeframe), ()))

    def _is_tester_agent(self, agent: ChartAgent | None) -> bool:
        if not agent:
            return False
        params = agent.params or {}
        return bool(params.get("tester") or str(params.get("mode") or "").lower() in {"tester", "backtest"})

    def _fresh_beat(self, chart_id: int) -> bool:
        last = float(self._agent_beat.get(int(chart_id), 0) or 0)
        return last > 0 and (time.time() - last) <= float(self.AGENT_LIVE_SEC)

    def tape_mode(self) -> str:
        return self._compute_tape() or "idle"

    def online_agents(self, include_tester: bool = True) -> list[ChartAgent]:
        out: list[ChartAgent] = []
        for agent in self.agents.values():
            if agent.status == "offline" or not agent.symbol:
                continue
            if not self._fresh_beat(int(agent.chart_id)):
                continue
            if (not include_tester) and self._is_tester_agent(agent):
                continue
            out.append(agent)
        return out

    def online_symbols(self) -> set[str]:
        # Only the ACTIVE tape feeds the desk: a tester chart on the same
        # symbol must not hijack live prices, and a live chart must not leak
        # into a backtest view.
        return {a.symbol for a in self.active_agents()}

    def is_ea_symbol(self, symbol: str) -> bool:
        want = str(symbol or "").strip()
        if not want:
            return False
        return any(self._sym_match(want, a.symbol) for a in self.active_agents())

    def public_agents(self) -> list[ChartAgent]:
        # Only charts that actually have AurionBridge attached. Leftover ticks
        # must not invent a broken market-watch card.
        return self.online_agents()

    def public_ticks(self) -> dict[str, Tick]:
        online = self.online_symbols()
        keep = set(online) | {p.symbol for p in self.positions if p.symbol and p.symbol in online}
        if not keep:
            return {}
        return {k: v for k, v in self.ticks.items() if k in keep}

    def _cid(self, raw: Any, fallback: int = 0) -> int:
        if isinstance(raw, bool):
            raw = fallback
        if raw is None or raw == "":
            raw = fallback
        if isinstance(raw, int):
            return raw
        if isinstance(raw, float):
            try:
                return int(raw)
            except (OverflowError, ValueError):
                return int(fallback or 0)
        s = str(raw).strip().strip("\"'")
        if not s:
            return int(fallback or 0)
        if s.lstrip("-").isdigit():
            try:
                return int(s)
            except ValueError:
                return int(fallback or 0)
        return int(fallback or 0)

    @staticmethod
    def _inum(raw: Any, default: int = 0) -> int:
        try:
            if raw is None or raw is False or raw == "":
                return default
            return int(raw)
        except (TypeError, ValueError):
            return default

    @staticmethod
    def _fnum(raw: Any, default: float = 0.0) -> float:
        try:
            if raw is None or raw is False or raw == "":
                return default
            return float(raw)
        except (TypeError, ValueError):
            return default

    async def _touch_agent(
        self,
        chart_id: int,
        symbol: str = "",
        timeframe: str = "",
        writer: asyncio.StreamWriter | None = None,
        emit: bool = True,
    ) -> ChartAgent | None:
        cid = self._cid(chart_id)
        symbol = str(symbol or "").strip()
        timeframe = self._norm_tf(timeframe) if timeframe else ""
        if cid <= 0 and symbol:
            for existing in self.agents.values():
                if existing.symbol and self._sym_match(existing.symbol, symbol):
                    cid = int(existing.chart_id)
                    break
        if cid <= 0 and symbol:
            cid = (abs(hash(symbol)) % 1_000_000_000) + 1
        if cid <= 0:
            return None
        created = cid not in self.agents
        agent = self.agents.get(cid)
        if not agent:
            agent = ChartAgent(
                chart_id=cid,
                symbol=symbol,
                timeframe=timeframe or "M15",
                ea_name="AurionBridge",
                version="",
                status="online",
                last_seen=utc_iso(),
            )
            self.agents[cid] = agent
            created = True
        else:
            agent.status = "online"
            agent.last_seen = utc_iso()
            if symbol:
                agent.symbol = symbol
            if timeframe:
                agent.timeframe = timeframe
        self._agent_beat[cid] = time.time()
        self._http_seen[cid] = time.time()
        self.connected = True
        if writer is not None:
            self._agent_owner[cid] = writer
        if emit and created:
            log.info("EA chart visible %s %s id=%s", agent.symbol, agent.timeframe, cid)
            await self.emit("agents", {"items": [a.to_dict() for a in self.online_agents()]})
            await self.emit("status", self.snapshot_status)
        return agent

    def _put_candle(self, candle: Candle, tape: str = "") -> None:
        if not candle.symbol or not candle.close:
            return
        bucket = self._tape_store(tape or None)["candles"][(candle.symbol, candle.timeframe)]
        for i, old in enumerate(bucket):
            if old.time == candle.time:
                bucket[i] = candle
                return
        bucket.append(candle)
        if len(bucket) >= 2 and str(bucket[-1].time) < str(bucket[-2].time):
            ordered = sorted(bucket, key=lambda c: (str(c.time), int(c.time_msc or 0)))
            bucket.clear()
            bucket.extend(ordered)

    async def _mark_positions_from_tick(self, tick: Tick) -> None:
        if not self.positions or not tick.symbol:
            return
        changed = False
        for pos in self.positions:
            if not self._sym_match(pos.symbol, tick.symbol):
                continue
            px = tick.bid if pos.type == "buy" else tick.ask
            if not px:
                px = tick.last or tick.bid or tick.ask
            if not px:
                continue
            old = float(pos.price_current or 0)
            if old and abs(px - old) < 1e-12:
                continue
            sign = 1.0 if pos.type == "buy" else -1.0
            open_px = float(pos.price_open or 0)
            if old and open_px and abs(old - open_px) > 1e-12:
                denom = (old - open_px) * sign
                if abs(denom) > 1e-12:
                    unit = float(pos.profit) / denom
                    pos.profit = unit * (px - open_px) * sign
            pos.price_current = px
            changed = True
        if changed:
            now = time.time()
            if now - float(getattr(self, "_last_pos_mark", 0) or 0) < 0.25:
                return
            self._last_pos_mark = now
            await self.emit("positions", [p.to_dict() for p in self.positions])

    def _dup_ingest(self, msg: dict[str, Any]) -> bool:
        kind = str(msg.get("type") or "")
        if kind in {"hello", "bye", "result"}:
            return False
        try:
            raw = json.dumps(msg, sort_keys=True, default=str)[:2400]
        except Exception:
            return False
        import hashlib

        digest = hashlib.sha1(raw.encode("utf-8", errors="ignore")).hexdigest()
        now = time.time()
        last = self._ingest_seen.get(digest, 0)
        if now - last < 1.6:
            return True
        self._ingest_seen[digest] = now
        if len(self._ingest_seen) > 500:
            cut = now - 4.0
            self._ingest_seen = {k: v for k, v in self._ingest_seen.items() if v >= cut}
        return False

    @staticmethod
    def _norm_tf(tf: str) -> str:
        t = str(tf or "M15").strip().upper()
        aliases = {"1": "M1", "5": "M5", "15": "M15", "30": "M30", "60": "H1", "240": "H4", "1440": "D1"}
        return aliases.get(t, t)

    def _candles_for(self, symbol: str, timeframe: str) -> list[Candle]:
        tf = self._norm_tf(timeframe)
        exact = self.candles_of(symbol, tf)
        if exact:
            return exact
        for (sym, t), rows in self.candles.items():
            if self._norm_tf(t) == tf and self._sym_match(sym, symbol) and rows:
                return list(rows)
        return []

    def _resolve_hist(self, symbol: str, timeframe: str) -> None:
        tf = self._norm_tf(timeframe)
        rows = self._candles_for(symbol, tf)
        if not rows:
            return
        payload = [c.to_dict() for c in rows]
        for key in list(self._hist_waiters.keys()):
            if self._norm_tf(key[1]) == tf and self._sym_match(key[0], symbol):
                waiters = self._hist_waiters.pop(key, [])
                for fut in waiters:
                    if not fut.done():
                        fut.set_result(payload)

    async def _request_ea_history(self, symbol: str, timeframe: str, timeout: float = 8.0) -> list[Candle]:
        tf = self._norm_tf(timeframe)
        if not self._ea_clients and not self._http_live():
            return []
        loop = asyncio.get_running_loop()
        fut: asyncio.Future = loop.create_future()
        key = (symbol, tf)
        already = bool(self._hist_waiters.get(key))
        self._hist_waiters[key].append(fut)
        minutes = {"M1": 1, "M5": 5, "M15": 15, "M30": 30, "H1": 60, "H4": 240, "D1": 1440, "W1": 10080, "MN1": 43200}.get(tf, 15)
        if not already:
            n = await self.broadcast_ea(
                {
                    "type": "request_history",
                    "symbol": symbol,
                    "timeframe": minutes,
                    "timeframe_name": tf,
                    "count": 800,
                },
                symbol=symbol,
                any_ok=False,
                once=True,
            )
            if n <= 0:
                waiters = self._hist_waiters.get(key) or []
                if fut in waiters:
                    waiters.remove(fut)
                if not waiters:
                    self._hist_waiters.pop(key, None)
                return []
            log.info("requested EA history %s %s via %s chart(s)", symbol, tf, n)
        try:
            await asyncio.wait_for(asyncio.shield(fut), timeout=timeout)
        except asyncio.TimeoutError:
            log.warning("EA history timeout %s %s after %.1fs", symbol, tf, timeout)
        finally:
            waiters = self._hist_waiters.get(key) or []
            if fut in waiters:
                waiters.remove(fut)
            if not waiters:
                self._hist_waiters.pop(key, None)
        return self._candles_for(symbol, tf)

    async def start(self) -> None:
        if self._started:
            return
        self._started = True
        cfg = load()
        host = cfg["mt5"]["ea_listen_host"]
        port = int(cfg["mt5"]["ea_listen_port"])
        self._server = await asyncio.start_server(self._handle_ea, host, port)
        if self._http_task is None or self._http_task.done():
            self._http_task = asyncio.create_task(self._http_sweep_loop(), name="aurion-ea-http")
        if self._file_task is None or self._file_task.done():
            self._file_task = asyncio.create_task(self._file_sweep_loop(), name="aurion-ea-file")
        inbox = ", ".join(str(p) for p in self._inbox_dirs()[:3])
        log.info("EA socket listening on %s:%s (HTTP /v1/ea/ingest + file inbox %s)", host, port, inbox)
        await self.emit("log", {"level": "info", "lang_key": "logs.connected", "message": f"EA socket {host}:{port}"})

    async def stop(self) -> None:
        if self._http_task:
            self._http_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._http_task
            self._http_task = None
        if self._file_task:
            self._file_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._file_task
            self._file_task = None
        if self._native_task:
            self._native_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._native_task
        if self._server:
            self._server.close()
            await self._server.wait_closed()
        for writer in list(self._ea_clients):
            writer.close()
            with contextlib.suppress(Exception):
                await writer.wait_closed()
        self.native.shutdown()
        self.connected = False
        self.source = ""
        self._started = False

    async def connect_native(self, credentials: dict[str, Any] | None = None) -> dict[str, Any]:
        cfg = load()
        creds = credentials or {}
        path = creds.get("terminal_path") or cfg["mt5"].get("terminal_path") or ""
        login = int(creds.get("login") or cfg["mt5"].get("login") or 0)
        password = creds.get("password") if creds.get("password") is not None else cfg["mt5"].get("password") or ""
        server = creds.get("server") or cfg["mt5"].get("server") or ""
        timeout = int(cfg["mt5"].get("timeout_ms") or 10000)
        portable = bool(cfg["mt5"].get("portable"))
        ok, message = await asyncio.to_thread(
            self.native.initialize, path, login, password, server, timeout, portable
        )
        if not ok:
            self.last_error = message
            log.warning("native MT5 connect failed: %s", message)
            return {"ok": False, "error": message}
        prev_tape = self.active_tape()
        self.connected = True
        self.source = "native"
        self.last_error = ""
        await self._refresh_native()
        if self._native_task is None or self._native_task.done():
            self._native_task = asyncio.create_task(self._native_loop(), name="aurion-native-mt5")
        await self._refresh_tape_view(prev_tape)
        await self.emit("status", self.snapshot_status)
        await self.emit("log", {"level": "info", "lang_key": "logs.connected", "message": "native MT5 connected"})
        return {"ok": True, "account": self.account.to_dict()}

    async def disconnect_native(self) -> None:
        prev_tape = self.active_tape()
        if self._native_task:
            self._native_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._native_task
            self._native_task = None
        self.native.shutdown()
        live_store = self._tape_store("live")
        live_store["account"] = Account()
        live_store["positions"] = []
        live_store["orders"] = []
        live_store["ticks"] = {}
        live_store["last_tick_at"] = ""
        if not self._ea_clients and not self._http_live():
            self.connected = False
            self.source = ""
        await self._refresh_tape_view(prev_tape)
        await self.emit("status", self.snapshot_status)

    async def _native_loop(self) -> None:
        while True:
            try:
                await self._refresh_native()
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("native poll failed")
            await asyncio.sleep(0.4)

    async def _refresh_native(self) -> None:
        if not self.native.connected:
            return
        t0 = time.perf_counter()
        account = await asyncio.to_thread(self.native.account)
        positions = await asyncio.to_thread(self.native.positions)
        orders = await asyncio.to_thread(self.native.orders)
        self.latency_ms = (time.perf_counter() - t0) * 1000.0
        cfg = load()
        live_store = self._tape_store("live")
        wanted = list(cfg["mt5"].get("symbols") or [])
        if not wanted:
            wanted = list(self.online_symbols())
        wanted = [s for s in dict.fromkeys(wanted) if s and self.is_ea_symbol(s)]
        ticks_changed: list[Tick] = []
        for symbol in dict.fromkeys(wanted):
            if not symbol:
                continue
            tick = await asyncio.to_thread(self.native.tick, symbol)
            if tick:
                prev = live_store["ticks"].get(symbol)
                live_store["ticks"][symbol] = tick
                live_store["last_tick_at"] = tick.time
                if not prev or prev.time_msc != tick.time_msc or prev.bid != tick.bid or prev.ask != tick.ask:
                    ticks_changed.append(tick)
        live_store["account"] = account
        live_store["positions"] = positions
        live_store["orders"] = orders
        self.symbols = sorted(self.online_symbols())
        self.connected = True
        if self.source != "ea":
            self.source = "native"
        if self.active_tape() != "live":
            return
        for tick in ticks_changed:
            await self.emit("tick", tick.to_dict())
        await self.emit("account", account.to_dict())
        await self.emit("positions", [p.to_dict() for p in positions])
        await self.emit("orders", [o.to_dict() for o in orders])

    async def pull_candles(self, symbol: str, timeframe: str, count: int = 800) -> list[dict[str, Any]]:
        symbol = str(symbol or "").strip()
        tf = self._norm_tf(timeframe)
        if not symbol:
            return []
        cached = self._candles_for(symbol, tf)
        if not self.is_ea_symbol(symbol):
            return []
        rows: list[Candle] = []
        if self.native.connected and self.is_ea_symbol(symbol):
            rows = await asyncio.to_thread(self.native.candles, symbol, tf, count)
            if rows:
                bucket = self._tape_store("live")["candles"][(symbol, tf)]
                bucket.clear()
                bucket.extend(rows)
        if not rows:
            rows = cached
        if len(rows) < 20 and self.is_ea_symbol(symbol):
            fetched = await self._request_ea_history(symbol, tf, timeout=8.0)
            if fetched:
                rows = fetched
            else:
                rows = self._candles_for(symbol, tf)
        await self.emit("candles", {"symbol": symbol, "timeframe": tf, "bars": [c.to_dict() for c in rows]})
        return [c.to_dict() for c in rows]

    async def _prime_agent(self, agent: ChartAgent) -> None:
        symbol = str(agent.symbol or "")
        tf = self._norm_tf(agent.timeframe)
        if not symbol or not self.native.connected:
            return
        if self._is_tester_agent(agent):
            return
        try:
            live_store = self._tape_store("live")
            tick = await asyncio.to_thread(self.native.tick, symbol)
            if tick:
                live_store["ticks"][symbol] = tick
                live_store["last_tick_at"] = tick.time
                await self.emit("tick", tick.to_dict())
            rows = await asyncio.to_thread(self.native.candles, symbol, tf, 800)
            if rows:
                bucket = live_store["candles"][(symbol, tf)]
                bucket.clear()
                bucket.extend(rows)
                await self.emit("candles", {"symbol": symbol, "timeframe": tf, "bars": [c.to_dict() for c in rows]})
                self._resolve_hist(symbol, tf)
        except Exception:
            log.exception("prime agent %s %s failed", symbol, tf)

    async def pull_deals(self, date_from, date_to) -> list[dict[str, Any]]:
        if self.native.connected:
            rows = await asyncio.to_thread(self.native.deals, date_from, date_to)
            if rows:
                self._tapes["live"]["deals"] = rows
        return [d.to_dict() for d in self.deals]

    async def _handle_ea(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        peer = writer.get_extra_info("peername")
        sock = writer.get_extra_info("socket")
        if sock is not None:
            with contextlib.suppress(OSError):
                sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            with contextlib.suppress(OSError):
                sock.setsockopt(socket.SOL_SOCKET, socket.SO_KEEPALIVE, 1)
        self._ea_clients[writer] = {"peer": peer, "charts": []}
        buffer = bytearray()
        log.info("EA connected from %s", peer)
        try:
            # Do not write first. Some MT5 builds return 5273 on SocketSend
            # if the peer already pushed data before the EA read.
            while True:
                chunk = await reader.read(65536)
                if not chunk:
                    break
                buffer.extend(chunk)
                messages, buffer = decode_buffer(buffer)
                for message in messages:
                    try:
                        await self._on_ea_message(writer, message)
                    except Exception:
                        log.exception("EA message %s failed from %s", message.get("type"), peer)
        except asyncio.CancelledError:
            raise
        except (ConnectionResetError, BrokenPipeError, asyncio.IncompleteReadError) as exc:
            log.warning("EA socket closed from %s: %s", peer, exc)
        except Exception:
            log.exception("EA socket error from %s", peer)
        finally:
            meta = self._ea_clients.pop(writer, {})
            writer.close()
            with contextlib.suppress(Exception):
                await writer.wait_closed()
            for chart_id in meta.get("charts", []):
                cid = int(chart_id)
                if self._agent_owner.get(cid) is not writer:
                    continue
                await self._mark_agent_offline(cid)
            if not self._ea_clients and not self._http_live() and not self.native.connected:
                self._ea_grace_until = time.time() + 2.0
                asyncio.create_task(self._drop_after_grace())
            await self.emit("status", self.snapshot_status)
            log.info("EA disconnected %s", peer)

    async def _drop_after_grace(self) -> None:
        await asyncio.sleep(2.2)
        if self._ea_clients or self._http_live() or self.native.connected:
            self._ea_grace_until = 0.0
            return
        if time.time() < self._ea_grace_until:
            return
        self.connected = False
        if not self.source.startswith("native"):
            self.source = ""
        await self.emit("status", self.snapshot_status)

    async def _on_ea_message(self, writer: asyncio.StreamWriter | None, message: dict[str, Any]) -> None:
        kind = str(message.get("type") or "")
        if kind == "hello":
            minutes = self._inum(message.get("timeframe") if message.get("timeframe") is not None else message.get("tf"), 15)
            tf = message.get("timeframe_name") or timeframe_from_minutes(minutes)
            params = dict(message.get("params") or {}) if isinstance(message.get("params"), dict) else {}
            transport = str(message.get("transport") or ("http" if writer is None else "tcp"))
            params["transport"] = transport
            tester = bool(message.get("tester") or str(message.get("mode") or "").lower() in {"tester", "backtest"})
            params["tester"] = tester
            params["mode"] = "tester" if tester else "live"
            symbol = str(message.get("symbol") or "")
            prev_tape = self.active_tape()
            agent = await self._touch_agent(self._cid(message.get("chart_id")), symbol, str(tf), writer=writer, emit=False)
            if not agent:
                return
            chart_id = self._cid(agent.chart_id)
            agent.ea_name = str(message.get("ea_name") or "AurionBridge")
            agent.version = str(message.get("version") or "1.0.0")
            agent.params = {**agent.params, **params}
            agent.status = "online"
            self._agent_owner[chart_id] = writer
            self._purge_gen[chart_id] = self._purge_gen.get(chart_id, 0) + 1
            if writer is not None:
                self._http_seen.pop(chart_id, None)
                meta = self._ea_clients.setdefault(
                    writer, {"peer": writer.get_extra_info("peername"), "charts": [], "symbols": []}
                )
                charts = meta.setdefault("charts", [])
                if chart_id not in charts:
                    charts.append(chart_id)
                if agent.symbol and agent.symbol not in meta.setdefault("symbols", []):
                    meta["symbols"].append(agent.symbol)
            else:
                self._http_seen[chart_id] = time.time()
            self.connected = True
            self._ea_grace_until = 0.0
            self._last_hello_at = utc_iso()
            self.source = "ea" if not self.native.connected else "native+ea"
            await self.emit("agents", {"items": [a.to_dict() for a in self.online_agents()]})
            await self.emit("status", self.snapshot_status)
            via = transport or ("HTTP" if writer is None else "TCP")
            tape_label = "tester" if tester else "live"
            log.info("EA hello %s %s chart=%s via %s v=%s tape=%s", agent.symbol, agent.timeframe, chart_id, via, agent.version, tape_label)
            await self.emit(
                "log",
                {
                    "level": "info",
                    "lang_key": "logs.connected",
                    "message": f"EA {agent.symbol} {agent.timeframe} chart {chart_id} via {via} ({tape_label} tape)",
                },
            )
            await self._refresh_tape_view(prev_tape)
            if agent.symbol:
                asyncio.create_task(self._prime_agent(agent), name=f"aurion-prime-{chart_id}")
            return
        if kind == "bye":
            chart_id = self._cid(message.get("chart_id"))
            reason = str(message.get("reason") or "remove")
            if reason in {"remove", "chartclose"}:
                await self._purge_chart(chart_id, force=True)
            else:
                await self._mark_agent_offline(chart_id)
            return
        if kind == "tick":
            tick = Tick(
                symbol=str(message.get("symbol") or ""),
                time=str(message.get("time") or utc_iso()),
                bid=self._fnum(message.get("bid")),
                ask=self._fnum(message.get("ask")),
                last=self._fnum(message.get("last")),
                volume=self._fnum(message.get("volume")),
                time_msc=self._inum(message.get("time_msc")),
            )
            if tick.symbol and (tick.bid or tick.ask):
                tape = self._msg_tape(message)
                agent = await self._touch_agent(self._cid(message.get("chart_id")), tick.symbol, str(message.get("timeframe_name") or ""))
                if agent and (message.get("tester") or str(message.get("mode") or "").lower() in {"tester", "backtest"}):
                    agent.params = {**(agent.params or {}), "tester": True, "mode": "tester"}
                    tape = "tester"
                store = self._tape_store(tape)
                store["ticks"][tick.symbol] = tick
                store["last_tick_at"] = tick.time
                self.connected = True
                # Only the active tape reaches the desk and the robot. The other
                # chart keeps updating its own store so switching is instant.
                if tape == self.active_tape():
                    await self.emit("tick", tick.to_dict())
                    await self._mark_positions_from_tick(tick)
            return
        if kind == "candle":
            minutes = self._inum(message.get("timeframe") if message.get("timeframe") is not None else message.get("tf"), 15)
            tf = str(message.get("timeframe_name") or timeframe_from_minutes(minutes))
            candle = Candle(
                symbol=str(message.get("symbol") or ""),
                timeframe=tf,
                time=str(message.get("time") or utc_iso()),
                time_msc=self._inum(message.get("time_msc")),
                open=self._fnum(message.get("open") if message.get("open") is not None else message.get("o")),
                high=self._fnum(message.get("high") if message.get("high") is not None else message.get("h")),
                low=self._fnum(message.get("low") if message.get("low") is not None else message.get("l")),
                close=self._fnum(message.get("close") if message.get("close") is not None else message.get("c")),
                volume=self._fnum(message.get("volume") if message.get("volume") is not None else message.get("v")),
                spread=self._fnum(message.get("spread")),
            )
            if candle.symbol and candle.close:
                tape = self._msg_tape(message)
                agent = await self._touch_agent(self._cid(message.get("chart_id")), candle.symbol, candle.timeframe)
                if agent and (message.get("tester") or str(message.get("mode") or "").lower() in {"tester", "backtest"}):
                    agent.params = {**(agent.params or {}), "tester": True, "mode": "tester"}
                    tape = "tester"
                self._put_candle(candle, tape)
                if tape != self.active_tape():
                    return
                payload = candle.to_dict()
                if "closed" in message:
                    payload["closed"] = bool(message.get("closed"))
                await self.emit("candle", payload)
            return
        if kind == "candles":
            symbol = str(message.get("symbol") or "")
            minutes = self._inum(message.get("timeframe"), 15)
            tf = str(message.get("timeframe_name") or timeframe_from_minutes(minutes))
            tape = self._msg_tape(message)
            if symbol:
                await self._touch_agent(self._cid(message.get("chart_id")), symbol, tf)
            bucket = self._tape_store(tape)["candles"][(symbol, tf)]
            replace = True if "replace" not in message else bool(message.get("replace"))
            final = True if "final" not in message else bool(message.get("final"))
            if replace:
                bucket.clear()
            for row in message.get("bars") or []:
                self._put_candle(
                    Candle(
                        symbol=symbol,
                        timeframe=tf,
                        time=str(row.get("time") or ""),
                        time_msc=self._inum(row.get("time_msc")),
                        open=self._fnum(row.get("open") if row.get("open") is not None else row.get("o")),
                        high=self._fnum(row.get("high") if row.get("high") is not None else row.get("h")),
                        low=self._fnum(row.get("low") if row.get("low") is not None else row.get("l")),
                        close=self._fnum(row.get("close") if row.get("close") is not None else row.get("c")),
                        volume=self._fnum(row.get("volume") if row.get("volume") is not None else row.get("v")),
                        spread=self._fnum(row.get("spread")),
                    ),
                    tape,
                )
            if final:
                ordered = sorted(bucket, key=lambda c: (str(c.time), int(c.time_msc or 0)))
                bucket.clear()
                bucket.extend(ordered)
                if tape == self.active_tape():
                    await self.emit("candles", {"symbol": symbol, "timeframe": tf, "bars": [c.to_dict() for c in bucket]})
                    self._resolve_hist(symbol, tf)
            return
        if kind == "account":
            kind_info = classify_account(
                trade_mode=int(message.get("trade_mode") if message.get("trade_mode") is not None else -1),
                margin_mode=int(message.get("margin_mode") if message.get("margin_mode") is not None else -1),
                server=str(message.get("server") or ""),
                company=str(message.get("company") or ""),
                name=str(message.get("name") or ""),
            )
            lev = self._inum(message.get("leverage"))
            tape = self._msg_tape(message)
            prev_acc = self._tape_store(tape)["account"]
            if lev <= 0 and prev_acc.leverage:
                lev = int(prev_acc.leverage)
            acc = Account(
                login=self._inum(message.get("login")) or prev_acc.login,
                name=str(message.get("name") or prev_acc.name or ""),
                server=str(message.get("server") or prev_acc.server or ""),
                currency=str(message.get("currency") or prev_acc.currency or ""),
                company=str(message.get("company") or prev_acc.company or ""),
                leverage=lev,
                balance=float(message.get("balance") or 0),
                equity=float(message.get("equity") or 0),
                margin=float(message.get("margin") or 0),
                margin_free=float(message.get("margin_free") or message.get("free_margin") or 0),
                margin_level=float(message.get("margin_level") or 0),
                profit=float(message.get("profit") or 0),
                credit=float(message.get("credit") or 0),
                trade_allowed=bool(message.get("trade_allowed", True)),
                trade_expert=bool(message.get("trade_expert", True)),
                connected=True,
                account_type=str(kind_info["account_type"]),
                account_label=str(kind_info["account_label"]),
                margin_mode=str(kind_info["margin_mode"]),
                trade_mode_code=int(kind_info["trade_mode_code"]),
                margin_mode_code=int(kind_info["margin_mode_code"]),
            )
            self._tape_store(tape)["account"] = acc
            self.connected = True
            if tape == self.active_tape():
                await self.emit("account", acc.to_dict())
            return
        if kind == "positions":
            tape = self._msg_tape(message)
            rows = []
            for row in message.get("items") or message.get("positions") or []:
                rows.append(
                    Position(
                        ticket=int(row.get("ticket") or 0),
                        symbol=str(row.get("symbol") or ""),
                        type=str(row.get("type") or row.get("side") or "buy"),
                        volume=float(row.get("volume") or 0),
                        price_open=float(row.get("price_open") or row.get("price") or 0),
                        price_current=float(row.get("price_current") or 0),
                        sl=float(row.get("sl") or 0),
                        tp=float(row.get("tp") or 0),
                        profit=float(row.get("profit") or 0),
                        swap=float(row.get("swap") or 0),
                        time=str(row.get("time") or ""),
                        magic=int(row.get("magic") or 0),
                        comment=str(row.get("comment") or ""),
                        strategy=str(row.get("strategy") or ""),
                    )
                )
            store = self._tape_store(tape)
            store["positions"] = rows
            if tape == self.active_tape():
                await self.emit("positions", [p.to_dict() for p in rows])
            return
        if kind == "orders":
            tape = self._msg_tape(message)
            rows = []
            for row in message.get("items") or message.get("orders") or []:
                rows.append(
                    PendingOrder(
                        ticket=int(row.get("ticket") or 0),
                        symbol=str(row.get("symbol") or ""),
                        type=str(row.get("type") or ""),
                        volume=float(row.get("volume") or 0),
                        price=float(row.get("price") or 0),
                        sl=float(row.get("sl") or 0),
                        tp=float(row.get("tp") or 0),
                        time=str(row.get("time") or ""),
                        magic=int(row.get("magic") or 0),
                        comment=str(row.get("comment") or ""),
                    )
                )
            self._tape_store(tape)["orders"] = rows
            if tape == self.active_tape():
                await self.emit("orders", [o.to_dict() for o in rows])
            return
        if kind == "deals":
            tape = self._msg_tape(message)
            rows = []
            for row in message.get("items") or []:
                rows.append(
                    Deal(
                        ticket=int(row.get("ticket") or 0),
                        order=int(row.get("order") or 0),
                        symbol=str(row.get("symbol") or ""),
                        type=str(row.get("type") or ""),
                        volume=float(row.get("volume") or 0),
                        price=float(row.get("price") or 0),
                        profit=float(row.get("profit") or 0),
                        swap=float(row.get("swap") or 0),
                        commission=float(row.get("commission") or 0),
                        time=str(row.get("time") or ""),
                        magic=int(row.get("magic") or 0),
                        comment=str(row.get("comment") or ""),
                        position_id=int(row.get("position_id") or 0),
                        entry=str(row.get("entry") or ""),
                    )
                )
            if rows:
                self._tape_store(tape)["deals"] = rows
                if tape == self.active_tape():
                    await self.emit("deals", [d.to_dict() for d in rows])
            return
        if kind == "log":
            chart_id = self._cid(message.get("chart_id"))
            entry = {
                "ts": message.get("time") or utc_iso(),
                "level": message.get("level") or "info",
                "message": message.get("message") or "",
                "chart_id": chart_id,
            }
            agent = self.agents.get(chart_id)
            if agent:
                agent.logs.append(entry)
                agent.logs = agent.logs[-200:]
                agent.last_seen = utc_iso()
            await self.emit("ea_log", entry)
            return
        if kind == "signal":
            chart_id = self._cid(message.get("chart_id"))
            agent = self.agents.get(chart_id)
            if agent:
                agent.last_signal = message
                agent.last_seen = utc_iso()
            await self.emit("ea_signal", message)
            return
        if kind == "ping":
            agent = await self._touch_agent(
                self._cid(message.get("chart_id")),
                str(message.get("symbol") or ""),
                str(message.get("timeframe_name") or ""),
            )
            if agent and "tester" in message:
                agent.params = {**(agent.params or {}), "tester": bool(message.get("tester")), "mode": "tester" if message.get("tester") else "live"}
            return
        if kind == "pong":
            sent = float(message.get("ping_ms") or 0)
            if sent:
                self.latency_ms = max(0.0, (time.time() * 1000.0) - sent)
            return
        if kind == "result":
            payload = {
                "ok": bool(message.get("ok")),
                "error": None if message.get("ok") else (message.get("detail") or message.get("error") or "EA rejected the order"),
                "detail": message.get("detail") or message.get("error") or "",
                "symbol": message.get("symbol") or "",
                "routed": "ea",
                "retcode": message.get("retcode"),
            }
            for fut in list(self._order_waiters):
                if not fut.done():
                    fut.set_result(payload)
                    break
            await self.emit("order_result", payload)
            return

    @staticmethod
    def _norm_sym(symbol: str) -> str:
        return "".join(ch for ch in str(symbol or "").upper() if ch.isalnum())

    def _sym_match(self, a: str, b: str) -> bool:
        na, nb = self._norm_sym(a), self._norm_sym(b)
        if not na or not nb:
            return False
        return na == nb or na.startswith(nb) or nb.startswith(na)

    async def _mark_agent_offline(self, chart_id: int) -> None:
        agent = self.agents.get(int(chart_id))
        if not agent:
            return
        prev_tape = self.active_tape()
        agent.status = "offline"
        self._purge_gen[int(chart_id)] = self._purge_gen.get(int(chart_id), 0) + 1
        gen = self._purge_gen[int(chart_id)]
        gone_sym = str(agent.symbol or "")
        gone_tape = "tester" if self._is_tester_agent(agent) else "live"
        if gone_sym:
            others = [a for a in self.online_agents(True) if a.symbol == gone_sym and self._is_tester_agent(a) == (gone_tape == "tester")]
            if not others:
                self._tape_store(gone_tape)["ticks"].pop(gone_sym, None)
        await self._refresh_tape_view(prev_tape)
        await self.emit("agents", {"items": [a.to_dict() for a in self.online_agents()]})
        await self.emit("ticks", {k: v.to_dict() for k, v in self.public_ticks().items()})
        await self.emit("status", self.snapshot_status)
        asyncio.create_task(self._purge_chart(int(chart_id), gen=gen))

    async def _purge_chart(self, chart_id: int, force: bool = False, gen: int = 0) -> None:
        prev_tape = self.active_tape()
        if not force:
            await asyncio.sleep(20.0)
        if not force and self._purge_gen.get(int(chart_id), 0) != gen:
            return
        agent = self.agents.get(int(chart_id))
        if not agent:
            return
        if not force and agent.status != "offline":
            return
        gone = self.agents.pop(int(chart_id), None)
        gone_tape = "tester" if (gone and self._is_tester_agent(gone)) else "live"
        store = self._tape_store(gone_tape)
        self._agent_owner.pop(int(chart_id), None)
        self._http_seen.pop(int(chart_id), None)
        self._http_inbox.pop(int(chart_id), None)
        for meta in self._ea_clients.values():
            charts = meta.get("charts") or []
            meta["charts"] = [c for c in charts if int(c) != int(chart_id)]
            still = set()
            for cid in meta["charts"]:
                ag = self.agents.get(int(cid))
                if ag and ag.status != "offline" and ag.symbol:
                    still.add(ag.symbol)
            meta["symbols"] = list(still)
        dropped = []
        if gone and gone.symbol:
            remaining = [a for a in self.online_agents(True) if a.symbol == gone.symbol and self._is_tester_agent(a) == (gone_tape == "tester")]
            if not remaining:
                store["ticks"].pop(gone.symbol, None)
                for key in list(store["candles"].keys()):
                    if key[0] == gone.symbol:
                        store["candles"].pop(key, None)
                dropped.append(gone.symbol)
                for key in list(self._hist_waiters):
                    if self._sym_match(key[0], gone.symbol):
                        for fut in self._hist_waiters.pop(key, []):
                            if not fut.done():
                                fut.set_result([])
        await self._refresh_tape_view(prev_tape)
        await self.emit("agents", {"items": [a.to_dict() for a in self.online_agents()]})
        if dropped:
            await self.emit("ticks", {k: v.to_dict() for k, v in self.public_ticks().items()})
        await self.emit("status", self.snapshot_status)
        log.info("EA chart %s removed (%s)", chart_id, gone.symbol if gone else "")

    def _writers_for_symbol(self, symbol: str | None, any_ok: bool) -> list[asyncio.StreamWriter]:
        if not self._ea_clients:
            return []
        # Commands only ever travel to agents of the ACTIVE tape. A Strategy
        # Tester chart is read-only for the desk.
        want_tester = self.active_tape() == "tester"
        if not symbol:
            return list(self._ea_clients)[:1] if any_ok else []
        matched = []
        for writer, meta in self._ea_clients.items():
            symbols = set(meta.get("symbols") or [])
            for chart_id in meta.get("charts") or []:
                agent = self.agents.get(int(chart_id))
                if agent and agent.status != "offline" and agent.symbol:
                    if self._is_tester_agent(agent) != want_tester:
                        continue
                    symbols.add(agent.symbol)
            if any(self._sym_match(symbol, s) for s in symbols):
                matched.append(writer)
        if matched:
            return matched
        return list(self._ea_clients)[:1] if any_ok else []

    def _http_live(self) -> bool:
        now = time.time()
        return any(now - seen < 20.0 for seen in self._http_seen.values())

    def _queue_http(self, chart_id: int, message: dict[str, Any]) -> None:
        q = self._http_inbox.setdefault(int(chart_id), [])
        q.append(dict(message))
        if len(q) > 32:
            del q[: len(q) - 32]
        http_fresh = time.time() - self._http_post_at.get(int(chart_id), 0) < 12.0
        if not http_fresh:
            self._write_cmd_file(int(chart_id), message)

    def _pop_http_cmd(self, chart_id: int) -> dict[str, Any] | None:
        q = self._http_inbox.get(int(chart_id)) or []
        if not q:
            return None
        cmd = q.pop(0)
        if not q:
            self._http_inbox.pop(int(chart_id), None)
        return cmd

    async def _http_sweep_loop(self) -> None:
        while True:
            await asyncio.sleep(4.0)
            now = time.time()
            for cid, seen in list(self._http_seen.items()):
                if now - seen > 20.0:
                    self._http_seen.pop(cid, None)
                    await self._mark_agent_offline(cid)
            for cid, beat in list(self._agent_beat.items()):
                if now - beat > float(self.AGENT_LIVE_SEC) + 2.0 and cid in self.agents:
                    await self._mark_agent_offline(cid)

    def _inbox_dirs(self) -> list[Path]:
        dirs: list[Path] = []
        seen: set[str] = set()

        def add(path: Path) -> None:
            try:
                key = str(path.resolve()) if path.exists() else str(path)
            except Exception:
                key = str(path)
            if key in seen:
                return
            seen.add(key)
            dirs.append(path)

        add(ROOT / "data" / "ea-inbox")
        appdata = os.environ.get("APPDATA") or ""
        home = os.environ.get("HOME") or ""
        roots: list[Path] = []
        if appdata:
            roots.append(Path(appdata) / "MetaQuotes" / "Terminal")
        if home:
            roots.append(Path(home) / "AppData" / "Roaming" / "MetaQuotes" / "Terminal")
        for mq in roots:
            add(mq / "Common" / "Files")
            try:
                if mq.is_dir():
                    for child in mq.iterdir():
                        if child.is_dir():
                            add(child / "MQL5" / "Files")
                            add(child / "Common" / "Files")
            except Exception:
                pass
        return dirs

    def _inbox_files(self) -> list[Path]:
        files: list[Path] = []
        for folder in self._inbox_dirs():
            if not folder.is_dir():
                continue
            try:
                for path in folder.iterdir():
                    name = path.name.lower()
                    if path.is_file() and name.startswith("aurion_in") and name.endswith((".jsonl", ".json")):
                        files.append(path)
            except Exception:
                continue
        return files

    def _write_cmd_file(self, chart_id: int, message: dict[str, Any]) -> None:
        name = f"aurion_cmd_{int(chart_id)}.json"
        try:
            blob = json.dumps(message, ensure_ascii=False).encode("utf-8")
        except Exception:
            return
        for folder in self._inbox_dirs():
            try:
                folder.mkdir(parents=True, exist_ok=True)
                (folder / name).write_bytes(blob)
            except Exception:
                continue

    async def _ingest_raw_blob(self, raw: bytes) -> int:
        text = raw.replace(b"\x00", b"").decode("utf-8", errors="ignore")
        if text.startswith("\ufeff"):
            text = text.lstrip("\ufeff")
        count = 0
        for line in text.splitlines():
            line = line.strip()
            if not line:
                continue
            obj = parse_ea_json(line)
            if obj is None:
                continue
            await self.ingest_http(obj, via="file")
            count += 1
        return count

    async def _consume_inbox_file(self, path: Path) -> int:
        key = str(path)
        try:
            data = path.read_bytes()
        except Exception:
            return 0
        if key not in self._file_off:
            try:
                age = time.time() - path.stat().st_mtime
            except Exception:
                age = 999.0
            if age > 15.0 or len(data) > 80_000:
                self._file_off[key] = len(data)
                return 0
            self._file_off[key] = max(0, len(data) - 24_000)
        off = self._file_off.get(key, 0)
        if off > len(data):
            off = 0
        chunk = data[off:]
        if not chunk.strip():
            return 0
        n = await self._ingest_raw_blob(chunk)
        self._file_off[key] = len(data)
        if n:
            self._last_file_inbox = path.name
            log.info("EA file inbox %s +%s msg (%s bytes)", path.name, n, len(chunk))
        if len(data) > 400_000:
            try:
                path.write_bytes(b"")
                self._file_off[key] = 0
            except Exception:
                pass
        return n

    async def _file_sweep_loop(self) -> None:
        logged = False
        while True:
            try:
                files = self._inbox_files()
                if not logged:
                    dirs = [str(p) for p in self._inbox_dirs() if p.exists() or str(p).endswith("ea-inbox")]
                    log.info("watching EA file inbox in %s", dirs or self._inbox_dirs()[:2])
                    logged = True
                for path in files:
                    try:
                        await self._consume_inbox_file(path)
                    except Exception:
                        log.exception("EA file inbox failed %s", path)
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("EA file sweep failed")
            await asyncio.sleep(0.25)

    async def ingest_http(self, payload: Any, via: str = "http") -> dict[str, Any]:
        if isinstance(payload, (bytes, bytearray, str)):
            parsed = parse_ea_json(payload)
            if parsed is None:
                return {"ok": False, "error": "invalid json", "has_cmd": False}
            payload = parsed
        messages: list[dict[str, Any]] = []
        chart_id = 0
        if isinstance(payload, list):
            messages = [m for m in payload if isinstance(m, dict)]
        elif isinstance(payload, dict) and str(payload.get("type") or "") == "bundle":
            chart_id = self._cid(payload.get("chart_id"))
            messages = [m for m in (payload.get("messages") or []) if isinstance(m, dict)]
        elif isinstance(payload, dict):
            messages = [payload]
            chart_id = self._cid(payload.get("chart_id"))
        else:
            return {"ok": False, "error": "invalid payload", "has_cmd": False}
        self._last_ingest_at = utc_iso()
        self._ingest_count += 1
        for msg in messages:
            if self._dup_ingest(msg):
                continue
            cid = self._cid(msg.get("chart_id"), chart_id)
            if cid:
                self._http_seen[cid] = time.time()
                if via == "http":
                    self._http_post_at[cid] = time.time()
                chart_id = cid
                agent = self.agents.get(cid)
                if agent:
                    agent.last_seen = utc_iso()
                    if agent.status == "offline":
                        agent.status = "online"
            try:
                await self._on_ea_message(None, msg)
            except Exception:
                log.exception("ingest message %s failed", msg.get("type"))
        if not chart_id:
            return {"ok": True, "has_cmd": False}
        cmd = self._pop_http_cmd(chart_id)
        if not cmd:
            return {"ok": True, "has_cmd": False}
        out: dict[str, Any] = {"ok": True, "has_cmd": True}
        out.update(cmd)
        return out

    async def broadcast_ea(self, message: dict[str, Any], symbol: str | None = None, any_ok: bool = True, once: bool = False) -> int:
        dead: list[asyncio.StreamWriter] = []
        sent = 0
        payload = encode(message)
        writers = self._writers_for_symbol(symbol, any_ok=any_ok)
        if once and writers:
            writers = writers[:1]
        for writer in writers:
            try:
                writer.write(payload)
                await writer.drain()
                sent += 1
            except Exception:
                dead.append(writer)
        for writer in dead:
            self._ea_clients.pop(writer, None)
        if once and sent:
            return sent
        now = time.time()
        want_tester = self.active_tape() == "tester"
        for agent in list(self.agents.values()):
            cid = int(agent.chart_id)
            if agent.status == "offline" or not agent.symbol:
                continue
            if self._is_tester_agent(agent) != want_tester:
                continue
            if cid not in self._http_seen or now - self._http_seen.get(cid, 0) > 20.0:
                continue
            if symbol and not self._sym_match(symbol, agent.symbol):
                continue
            self._queue_http(cid, message)
            sent += 1
            if once:
                return sent
        if sent == 0 and any_ok:
            for cid, seen in self._http_seen.items():
                if now - seen > 20.0:
                    continue
                agent = self.agents.get(int(cid))
                if agent is not None and self._is_tester_agent(agent) != want_tester:
                    continue
                self._queue_http(int(cid), message)
                sent += 1
                break
        return sent

    @staticmethod
    def _ea_frame_type(request: dict[str, Any]) -> str:
        action = str(request.get("action") or request.get("type") or "order").lower()
        mapping = {
            "close": "close",
            "modify": "modify",
            "flatten": "flatten",
            "market": "order",
            "buy": "order",
            "sell": "order",
            "pending": "order",
            "limit": "order",
            "stop": "order",
            "order": "order",
        }
        return mapping.get(action, "order")

    async def send_order(self, request: dict[str, Any]) -> dict[str, Any]:
        if self.native.connected:
            built = self._to_native_request(request)
            if not built.get("ok", True) and "error" in built:
                return built
            result = await asyncio.to_thread(self.native.send_order, built)
            await self.emit("order_result", result)
            return result
        if self._ea_clients or self._http_live():
            request = dict(request)
            action = str(request.get("action") or "order").lower()
            if self.active_tape() == "tester" and not self.online_agents(include_tester=False):
                return {
                    "ok": False,
                    "error": "Only a Strategy Tester chart is attached — the backtest tape is read-only. Attach AurionBridge to a live chart to trade.",
                    "routed": "none",
                    "tape": "tester",
                }
            request["type"] = self._ea_frame_type(request)
            request["ts"] = utc_iso()
            if request.get("side"):
                request["side"] = str(request["side"]).lower()
            symbol = str(request.get("symbol") or "")
            any_ok = (not symbol) or action in {"close", "flatten", "modify"}
            attached = sorted({a.symbol for a in self.active_agents() if a.symbol})
            n_targets = len(self._writers_for_symbol(symbol or None, any_ok=any_ok))
            if n_targets <= 0 and self._http_live():
                n_targets = 1
            if n_targets <= 0:
                hint = f" attached: {', '.join(attached)}" if attached else " — attach AurionBridge to a chart"
                return {"ok": False, "error": f"no EA attached to {symbol or 'any chart'}{hint}"}
            loop = asyncio.get_running_loop()
            fut: asyncio.Future = loop.create_future()
            self._order_waiters.append(fut)
            try:
                n = await self.broadcast_ea(request, symbol=symbol or None, any_ok=any_ok, once=True)
                if n <= 0:
                    return {"ok": False, "error": f"no EA attached to {symbol or 'any chart'}"}
                result = await asyncio.wait_for(asyncio.shield(fut), timeout=12.0)
                if isinstance(result, dict):
                    result = {**result, "clients": n, "type": request["type"]}
                return result
            except asyncio.TimeoutError:
                return {
                    "ok": False,
                    "error": "EA did not confirm the order within 12s. Turn AutoTrading ON on the chart and retry.",
                    "routed": "ea",
                    "clients": n_targets,
                }
            finally:
                if fut in self._order_waiters:
                    self._order_waiters.remove(fut)
        return {"ok": False, "error": "MetaTrader 5 is not reachable. AURION will not fabricate a fill."}

    def _to_native_request(self, request: dict[str, Any]) -> dict[str, Any]:
        import MetaTrader5 as mt5  # type: ignore

        action = str(request.get("action") or "market").lower()
        side = str(request.get("side") or "buy").lower()
        symbol = str(request.get("symbol") or "")
        volume = float(request.get("volume") or 0)
        if action in {"close", "flatten", "modify"}:
            ticket = int(request.get("ticket") or 0)
            pos = next((p for p in self.positions if p.ticket == ticket), None) if ticket else None
            if pos:
                symbol = symbol or pos.symbol
                volume = volume or float(pos.volume)
        if action not in {"close", "flatten", "modify"} and (not symbol or volume <= 0):
            return {"ok": False, "error": "symbol and volume are required"}
        info = self.native.symbol_info(symbol)
        if not info:
            self.native.ensure_symbol(symbol)
            info = self.native.symbol_info(symbol)
        filling = int(info.get("filling_mode") or 1) if info else 1
        type_filling = mt5.ORDER_FILLING_IOC
        if filling & 1:
            type_filling = mt5.ORDER_FILLING_FOK
        elif filling & 2:
            type_filling = mt5.ORDER_FILLING_IOC
        else:
            type_filling = mt5.ORDER_FILLING_RETURN
        tick = self.ticks.get(symbol)
        price = float(request.get("price") or 0)
        if action in {"close", "flatten"}:
            ticket = int(request.get("ticket") or 0)
            pos = next((p for p in self.positions if p.ticket == ticket), None)
            if action == "flatten":
                return {"ok": False, "error": "flatten is handled by the trader, not a single native request"}
            if not pos:
                return {"ok": False, "error": f"position {ticket} not found"}
            order_type = mt5.ORDER_TYPE_SELL if pos.type == "buy" else mt5.ORDER_TYPE_BUY
            px = (tick.bid if pos.type == "buy" else tick.ask) if tick else pos.price_current
            return {
                "action": mt5.TRADE_ACTION_DEAL,
                "symbol": pos.symbol,
                "volume": float(request.get("volume") or pos.volume),
                "type": order_type,
                "position": ticket,
                "price": float(px or 0),
                "deviation": int(request.get("deviation") or 20),
                "magic": int(request.get("magic") or 908173),
                "comment": str(request.get("comment") or "AURION close"),
                "type_filling": type_filling,
                "type_time": mt5.ORDER_TIME_GTC,
            }
        if action == "modify":
            return {
                "action": mt5.TRADE_ACTION_SLTP,
                "symbol": symbol,
                "position": int(request.get("ticket") or 0),
                "sl": float(request.get("sl") or 0),
                "tp": float(request.get("tp") or 0),
            }
        if action in {"pending", "limit", "stop"}:
            mapping = {
                "buy_limit": mt5.ORDER_TYPE_BUY_LIMIT,
                "sell_limit": mt5.ORDER_TYPE_SELL_LIMIT,
                "buy_stop": mt5.ORDER_TYPE_BUY_STOP,
                "sell_stop": mt5.ORDER_TYPE_SELL_STOP,
            }
            key = str(request.get("order_type") or f"{side}_limit")
            return {
                "action": mt5.TRADE_ACTION_PENDING,
                "symbol": symbol,
                "volume": volume,
                "type": mapping.get(key, mt5.ORDER_TYPE_BUY_LIMIT),
                "price": price,
                "sl": float(request.get("sl") or 0),
                "tp": float(request.get("tp") or 0),
                "deviation": int(request.get("deviation") or 20),
                "magic": int(request.get("magic") or 908173),
                "comment": str(request.get("comment") or "AURION"),
                "type_filling": type_filling,
                "type_time": mt5.ORDER_TIME_GTC,
            }
        order_type = mt5.ORDER_TYPE_BUY if side == "buy" else mt5.ORDER_TYPE_SELL
        if not price and tick:
            price = tick.ask if side == "buy" else tick.bid
        return {
            "action": mt5.TRADE_ACTION_DEAL,
            "symbol": symbol,
            "volume": volume,
            "type": order_type,
            "price": float(price or 0),
            "sl": float(request.get("sl") or 0),
            "tp": float(request.get("tp") or 0),
            "deviation": int(request.get("deviation") or 20),
            "magic": int(request.get("magic") or 908173),
            "comment": str(request.get("comment") or "AURION"),
            "type_filling": type_filling,
            "type_time": mt5.ORDER_TIME_GTC,
        }
