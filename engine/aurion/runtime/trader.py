from __future__ import annotations

import asyncio
import shutil
import time
from collections import deque
from typing import Any

from .deals import aggregate_close_deals
from ..ai.engine import AIEngine
from ..backtest.engine import Backtester
from ..config import ROOT, load, merge, save
from ..mt5.bridge import MT5Bridge
from ..prop.rules import PropEngine
from ..strategy.base import StrategyContext
from ..strategy.loader import StrategyLoader, StrategyValidationError
from ..license.guard import Guard
from ..util.clock import utc_iso
from ..util.market import block_reason as market_block_reason, session as market_session
from ..util.log import RING, get
from .bus import Bus
from .danger import (
    COOLDOWN_SECONDS,
    GRACE_SECONDS,
    clamp_sensitivity,
    score_position,
    threshold_for,
)
from .store import Store, normalise_strategy_tag, parse_strategy_tag

log = get("trader")

# Keep the desk close to live. Matches news_feed.MIN_AGE_SECONDS; going faster
# than the source updates only adds load.
NEWS_REFRESH_SECONDS = 5 * 60



class Trader:
    def __init__(self) -> None:
        self.bus = Bus()
        self.store = Store()
        self.bridge = MT5Bridge()
        self.ai = AIEngine()
        self.prop = PropEngine()
        self.loader = StrategyLoader()
        self.backtester = Backtester()
        self.strategy = None
        self.strategy_meta: dict[str, Any] = {}
        self.book: dict[str, dict[str, Any]] = {}
        self.auto_trade = False
        self.require_ai_agree = True
        self.min_ai_confidence = 0.55
        # Robot position sizing: "auto" = each strategy's preset volume,
        # "manual" = the user's fixed lot for every robot entry.
        self.volume_mode = "auto"
        self.manual_volume = 0.10
        self.trade_style = "normal"
        # How many robot positions may live at once, and how many the robot is
        # allowed to open for one confirmed signal. "Between 1 and N trades":
        # min_open_trades is what a strong setup opens right away,
        # max_open_trades is the hard ceiling the robot never goes past.
        self.min_open_trades = 1
        self.max_open_trades = 2
        # Extra brain: higher-timeframe confirmation, chop/spread rejection and
        # a combined quality score before any robot entry is allowed out.
        self.smart_filters = True
        self.min_signal_quality = 0.55
        self.last_quality: dict[str, Any] = {}
        self.news_trade = False
        # Danger guard: tick-level protective exit. Hard-disabled while prop
        # rules are on — a challenge account only exits through the prop book.
        self.danger_enabled = False
        self.danger_sensitivity = 50
        self._danger_seen: dict[int, float] = {}
        self._danger_cooldown: dict[int, float] = {}
        self._danger_inflight: set[int] = set()
        self.kill_switch = bool(load()["execution"].get("kill_switch_default"))
        self.safe_mode = False
        self.active_symbol = ""
        self.active_timeframe = "M15"
        self.last_signal: dict[str, Any] | None = None
        self.started = False
        self._last_equity_write = 0.0
        self._last_bar_time: dict[tuple[str, str], str] = {}
        self._news_stop = asyncio.Event()
        self._news_task: asyncio.Task | None = None
        self.robot_log: deque[dict[str, Any]] = deque(maxlen=600)
        self._known_pos: dict[int, dict[str, Any]] = {}
        self._pending_tag: list[dict[str, Any]] = []
        self._closed_tickets: set[int] = set()
        self._pos_bootstrapped = False
        self.telegram = None
        self.license = Guard()
        self.backtest_run: dict[str, Any] = {"running": False, "mode": "idle"}
        self._last_ai_tick = 0.0
        self._ai_tick_task: asyncio.Task | None = None
        RING.subscribe(self._on_log)

        # Existing installs already have months of trades; seed the record from
        # them once rather than starting every strategy at zero on upgrade day.
        try:
            seeded = self.store.backfill_strategy_ledger()
            if seeded:
                log.info("strategy ledger seeded from %d historical closes", seeded)
        except Exception:
            log.exception("strategy ledger backfill failed")

    def _on_log(self, payload: dict[str, Any]) -> None:
        try:
            loop = asyncio.get_running_loop()
            loop.create_task(self.bus.publish("log", payload))
        except RuntimeError:
            pass

    async def journal(self, level: str, code: str, message: str, extra: dict[str, Any] | None = None) -> None:
        item = {
            "ts": utc_iso(),
            "level": level,
            "code": code,
            "message": message,
            "channel": "robot",
            "extra": extra or {},
        }
        self.robot_log.append(item)
        if level == "error":
            log.error("[robot] %s", message)
        elif level == "warning":
            log.warning("[robot] %s", message)
        else:
            log.info("[robot] %s", message)
        await self.bus.publish("robot", item)
        await self.bus.publish("log", item)

    async def start(self) -> None:
        if self.started:
            return
        self.started = True
        self.bridge.on_event(self._on_bridge)
        await self.bridge.start()
        cfg = load()
        if cfg["mt5"].get("login") and cfg["mt5"].get("password") and cfg["mt5"].get("server"):
            await self.bridge.connect_native()
        try:
            self._hydrate_closed_tickets()
        except Exception:
            log.exception("closed-ticket hydrate failed")
        try:
            self._load_runtime_book()
        except Exception:
            log.exception("default strategy load failed")
        try:
            from ..telegram import secret as tg_secret
            from ..telegram.bot import TelegramBot

            # A token dropped into the source means the owner wants the bot on,
            # full stop — it starts even when the plan would otherwise gate it.
            if self.license.feature("telegram") or tg_secret.source_token():
                self.telegram = TelegramBot(self)
                await self.telegram.start(auto_enable=True)
            else:
                self.telegram = None
                log.info("telegram bot skipped — no source token and premium feature not licensed")
        except Exception:
            log.exception("telegram bot failed to start")
        try:
            # Anti-sharing heartbeat: report key→machine binding; a revoked /
            # replaced / moved key downgrade arrives as a license event below.
            verdict = self.license.heartbeat()
            if isinstance(verdict, dict) and not verdict.get("ok", True):
                log.warning("license heartbeat downgrade: %s", verdict.get("error"))
                await self.bus.publish("license", self.license.public())
        except Exception:
            log.exception("license heartbeat failed")
        # Do not persist on boot — a failed overlay read would rewrite saved settings.
        self._news_stop = asyncio.Event()
        self._news_task = asyncio.create_task(self._news_refresh_loop(), name="aurion-news")
        log.info("AURION engine started")
        await self.journal("info", "boot", "Engine online. Robot is idle until a strategy is enabled and auto-trade is armed.")

    async def stop(self) -> None:
        self._news_stop.set()
        if self._news_task:
            self._news_task.cancel()
            try:
                await self._news_task
            except (asyncio.CancelledError, Exception):
                pass
            self._news_task = None
        cfg = load()
        if (
            cfg["execution"].get("flatten_on_disconnect")
            and self.bridge.connected
            and self.bridge.tape_mode() == "live"
        ):
            await self.flatten("engine stop")
        try:
            self._persist_runtime()
        except Exception:
            log.exception("persist on stop failed")
        try:
            if self.telegram:
                await self.telegram.stop()
        except Exception:
            log.exception("telegram stop failed")
        await self.bridge.stop()
        self.store.close()
        self.started = False

    async def _on_bridge(self, kind: str, payload: dict[str, Any]) -> None:
        if kind == "tick":
            sym = str(payload.get("symbol") or "")
            await self.bus.publish("tick", payload)
            if not self.active_symbol and self._is_ea_symbol(sym):
                self.active_symbol = sym
            await self._maybe_trail(payload)
            await self._maybe_danger_guard(payload)
            if self._is_ea_symbol(sym):
                await self._maybe_strategy_tick(payload)
                self._schedule_live_ai(sym)
            return
        if kind == "candle":
            self.store.upsert_candle(payload)
            await self.bus.publish("candle", payload)
            if self._is_closed_bar(payload):
                await self._on_closed_candle(payload)
            return
        if kind == "candles":
            for row in payload.get("bars") or []:
                self.store.upsert_candle(row)
            await self.bus.publish("candles", payload)
            return
        if kind == "account":
            metrics = self.prop.metrics(payload)
            dd = float(metrics.get("drawdown_pct") or 0)
            now = time.time()
            if now - self._last_equity_write >= 5:
                self.store.record_equity(payload, dd)
                self._last_equity_write = now
            await self.bus.publish("account", payload)
            decision = self.prop.evaluate_account(payload, [p.to_dict() for p in self.bridge.positions])
            if not decision.get("ok") and (decision.get("action") or "none") not in {"none", ""}:
                await self._handle_prop_trip(decision)
            await self.bus.publish("prop", self.prop.metrics(payload))
            return
        if kind == "positions":
            rows = payload if isinstance(payload, list) else (payload.get("items") if isinstance(payload, dict) else [])
            if not isinstance(rows, list):
                rows = [p.to_dict() for p in self.bridge.positions]
            await self._sync_position_book(rows)
            await self.bus.publish("positions", {"items": [self._annotate_pos(p) for p in rows]})
            return
        if kind == "orders":
            await self.bus.publish("orders", {"items": payload} if isinstance(payload, list) else payload)
            return
        if kind == "deals":
            # Never import MetaTrader deal history into the AURION ledger.
            # Restart / OnTrade dumps would replay old broker fills as if they were ours.
            rows = payload if isinstance(payload, list) else (payload.get("items") if isinstance(payload, dict) else [])
            # Deals arriving IS the signal that MT5 now knows about a close we
            # had to estimate, so this is the moment to go back and correct it.
            try:
                await self.reconcile_estimated_closes()
            except Exception:
                log.exception("reconciliation pass failed")
            await self.bus.publish("deals", {"items": rows} if isinstance(rows, list) else payload)
            return
        if kind == "agents":
            items = payload.get("items") if isinstance(payload, dict) else payload
            if not isinstance(items, list):
                items = []
            await self.bus.publish("agents", {"items": items})
            await self._adopt_ea_market()
            return
        if kind == "ticks":
            await self.bus.publish("ticks", payload if isinstance(payload, dict) else {})
            return
        if kind in {"status", "ea_log", "ea_signal", "order_result", "log"}:
            await self.bus.publish(kind, payload if isinstance(payload, dict) else {"data": payload})

    async def _handle_prop_trip(self, decision: dict[str, Any]) -> None:
        action = decision.get("action") or ""
        self.safe_mode = True
        await self.bus.publish("prop", decision)
        self.store.log_event("warning", str(decision.get("code")), "status.prop_block", decision)
        if "flatten" in action:
            await self.flatten(f"prop:{decision.get('code')}")

    def _ctx(self, symbol: str, timeframe: str, tick: dict[str, Any] | None = None) -> StrategyContext:
        candles = [c.to_dict() for c in self.bridge.candles_of(symbol, timeframe)]
        if not candles and self._is_ea_symbol(symbol):
            candles = self.store.candles(symbol, timeframe, 800)
        return StrategyContext(
            symbol=symbol,
            timeframe=timeframe,
            candles=candles,
            tick=tick,
            account=self.bridge.account.to_dict(),
            positions=[p.to_dict() for p in self.bridge.positions],
            orders=[o.to_dict() for o in self.bridge.orders],
            ai=self.ai.last,
            params=getattr(self.strategy, "params", {}) if self.strategy else {},
            now=utc_iso(),
        )

    def _is_closed_bar(self, payload: dict[str, Any]) -> bool:
        if payload.get("closed") is True:
            return True
        if "closed" in payload:
            return False
        symbol = str(payload.get("symbol") or "")
        timeframe = str(payload.get("timeframe") or self.active_timeframe)
        stamp = str(payload.get("time") or "")
        if not symbol or not stamp:
            return False
        key = (symbol, timeframe)
        prev = self._last_bar_time.get(key)
        self._last_bar_time[key] = stamp
        return bool(prev) and prev != stamp

    def _hydrate_closed_tickets(self) -> None:
        try:
            rows = self.store.query(
                """SELECT ticket FROM trades
                   WHERE ticket IS NOT NULL AND (
                     lower(coalesce(kind,'')) IN ('close','out','inout')
                     OR lower(coalesce(entry,'')) IN ('out','inout')
                   )"""
            )
        except Exception:
            rows = []
        tickets: set[int] = set()
        for row in rows:
            try:
                ticket = int(row.get("ticket") or 0)
            except (TypeError, ValueError):
                ticket = 0
            if ticket:
                tickets.add(ticket)
        self._closed_tickets = tickets

    def _aurion_owned(self, row: dict[str, Any]) -> bool:
        comment = str((row or {}).get("comment") or "")
        tag = str((row or {}).get("strategy") or "") or parse_strategy_tag(comment)
        if tag:
            return True
        return "AURION" in comment.upper()

    def news_trading_on(self) -> bool:
        if self.prop.enabled:
            return not bool((self.prop.profile or {}).get("news_filter"))
        return bool(self.news_trade)

    def _strategy_tag_for_request(self, request: dict[str, Any]) -> str:
        raw = str((request or {}).get("strategy") or "").strip()
        if raw.lower() not in {"", "desk", "manual", "robot", "close", "flatten"}:
            return raw
        tag = parse_strategy_tag(str((request or {}).get("comment") or ""))
        if tag:
            return tag
        src = str((request or {}).get("source") or "")
        if src.startswith("strategy"):
            piece = src.split(":")[-1].strip()
            if piece and piece.lower() not in {"desk", "manual", "robot"}:
                return piece
        enabled = [k for k, v in self.book.items() if v.get("enabled")]
        if enabled:
            return enabled[0]
        return ""

    def _record_close(self, trade: dict[str, Any]) -> bool:
        trade = dict(trade or {})
        try:
            ticket = int(trade.get("ticket") or 0)
        except (TypeError, ValueError):
            ticket = 0
        if ticket and ticket in self._closed_tickets:
            return False
        tag = trade.get("strategy") or parse_strategy_tag(str(trade.get("comment") or ""))
        trade["strategy"] = tag
        trade["kind"] = trade.get("kind") or "close"
        trade["entry"] = trade.get("entry") or "out"
        wrote = bool(self.store.record_trade(trade))
        if ticket:
            self._closed_tickets.add(ticket)
            if len(self._closed_tickets) > 4000:
                self._closed_tickets = set(list(self._closed_tickets)[-2000:])
        if not wrote:
            return False
        try:
            self.prop.note_closed_trade(float(trade.get("profit") or 0))
        except Exception:
            pass
        return True

    def _annotate_pos(self, row: dict[str, Any]) -> dict[str, Any]:
        out = dict(row or {})
        ticket = int(out.get("ticket") or 0)
        known = self._known_pos.get(ticket) or {}
        tag = out.get("strategy") or known.get("strategy") or parse_strategy_tag(str(out.get("comment") or ""))
        if tag:
            out["strategy"] = tag
        return out

    def _remember_open(self, request: dict[str, Any], result: dict[str, Any] | None = None) -> None:
        source = str(request.get("source") or "")
        tag = self._strategy_tag_for_request(request)
        self._pending_tag.append(
            {
                "ts": time.time(),
                "symbol": str(request.get("symbol") or ""),
                "side": str(request.get("side") or request.get("action") or ""),
                "volume": float(request.get("volume") or 0),
                "strategy": tag,
                "comment": request.get("comment") or "",
                "ticket": int((result or {}).get("deal") or (result or {}).get("order") or request.get("ticket") or 0),
            }
        )
        self._pending_tag = [p for p in self._pending_tag if time.time() - float(p.get("ts") or 0) < 120][-20:]

    def _tag_for_new_position(self, pos: dict[str, Any]) -> str:
        comment = str(pos.get("comment") or "")
        tag = parse_strategy_tag(comment)
        if tag:
            return tag
        ticket = int(pos.get("ticket") or 0)
        for pending in list(self._pending_tag):
            if pending.get("ticket") and int(pending["ticket"]) == ticket:
                return str(pending.get("strategy") or "")
            if self.bridge._sym_match(str(pending.get("symbol") or ""), str(pos.get("symbol") or "")):
                side = str(pending.get("side") or "").lower()
                pside = str(pos.get("type") or pos.get("side") or "").lower()
                if not side or side == pside or side in {"market", "buy", "sell"}:
                    self._pending_tag.remove(pending)
                    return str(pending.get("strategy") or "")
        return ""


    async def reconcile_estimated_closes(self) -> int:
        """Go back for the closes we had to estimate.

        A position can leave the book a second or two before its deal reaches
        MT5's history, so the close is recorded from the last floating price
        and marked as an estimate. This runs afterwards, finds those rows, and
        replaces them with MetaTrader's own numbers - which is what makes the
        desk's history and the broker's statement agree rather than nearly
        agree. Returns how many rows it corrected.
        """
        if not getattr(self.bridge, "native", None) or not self.bridge.native.connected:
            return 0
        pending = self.store.pending_reconcile(40)
        if not pending:
            return 0

        from datetime import datetime, timedelta, timezone
        import asyncio as _asyncio

        now = datetime.now(timezone.utc)
        try:
            recent = await _asyncio.to_thread(
                self.bridge.native.deals, now - timedelta(days=3), now
            )
        except Exception:
            return 0
        rows = [
            d.to_dict() if hasattr(d, "to_dict") else d
            for d in list(recent or [])
            if hasattr(d, "to_dict") or isinstance(d, dict)
        ]

        fixed = 0
        for item in pending:
            try:
                ticket = int(item.get("ticket") or 0)
            except (TypeError, ValueError):
                continue
            if not ticket:
                continue
            totals = aggregate_close_deals(rows, ticket)
            if not totals:
                continue
            if self.store.apply_reconciliation(int(item["id"]), totals):
                fixed += 1
                log.info("reconciled close %s with MT5: net %.2f", ticket, totals["net"])
        return fixed

    async def _sync_position_book(self, rows: list[dict[str, Any]]) -> None:
        current: dict[int, dict[str, Any]] = {}
        opened: list[dict[str, Any]] = []
        for raw in rows or []:
            if not isinstance(raw, dict):
                continue
            ticket = int(raw.get("ticket") or 0)
            if not ticket:
                continue
            tag = raw.get("strategy") or self._tag_for_new_position(raw)
            item = {**raw, "strategy": tag}
            current[ticket] = item
            prev = self._known_pos.get(ticket)
            if not prev:
                self._known_pos[ticket] = item
                if getattr(self, "_pos_bootstrapped", False):
                    opened.append(item)
                    # Record entry trade from live MT5 position so SL/TP matches MT5 exactly
                    try:
                        # Avoid duplicate entry if already recorded by execute()
                        existing = self.store.query(
                            "SELECT id FROM trades WHERE ticket=? AND lower(coalesce(kind,'')) IN ('entry','in') LIMIT 1",
                            (ticket,),
                        )
                        if not existing:
                            self.store.record_trade(
                                {
                                    "time": item.get("time") or utc_iso(),
                                    "ticket": ticket,
                                    "symbol": item.get("symbol"),
                                    "side": item.get("type") or item.get("side"),
                                    "volume": item.get("volume"),
                                    "price": item.get("price_open") or item.get("price_current"),
                                    "sl": item.get("sl"),
                                    "tp": item.get("tp"),
                                    "profit": 0,
                                    "swap": item.get("swap") or 0,
                                    "commission": 0,
                                    "comment": item.get("comment"),
                                    "strategy": item.get("strategy") or parse_strategy_tag(str(item.get("comment") or "")),
                                    "kind": "entry",
                                    "entry": "in",
                                }
                            )
                    except Exception:
                        log.exception("entry record failed for %s", ticket)
                # else bootstrap: still ensure entry recorded for pre-existing positions (once)
                else:
                    try:
                        existing = self.store.query(
                            "SELECT id FROM trades WHERE ticket=? AND lower(coalesce(kind,'')) IN ('entry','in') LIMIT 1",
                            (ticket,),
                        )
                        if not existing:
                            self.store.record_trade(
                                {
                                    "time": item.get("time") or utc_iso(),
                                    "ticket": ticket,
                                    "symbol": item.get("symbol"),
                                    "side": item.get("type") or item.get("side"),
                                    "volume": item.get("volume"),
                                    "price": item.get("price_open") or item.get("price_current"),
                                    "sl": item.get("sl"),
                                    "tp": item.get("tp"),
                                    "profit": 0,
                                    "swap": item.get("swap") or 0,
                                    "comment": item.get("comment"),
                                    "strategy": item.get("strategy") or parse_strategy_tag(str(item.get("comment") or "")),
                                    "kind": "entry",
                                    "entry": "in",
                                }
                            )
                    except Exception:
                        pass
            else:
                # Update known pos with latest MT5 values (SL/TP/profit) to keep matching MT5
                prev.update(item)
        closed = [t for t in list(self._known_pos) if t not in current]
        closed_rows: list[dict[str, Any]] = []
        for ticket in closed:
            old = self._known_pos.pop(ticket, {}) or {}
            if getattr(self, "_pos_bootstrapped", False):
                closed_rows.append(old)
            # Try to get accurate profit from bridge deals (MT5 deal history) if available
            # This ensures P/L matches MT5 exactly, not floating estimate
            deal_profit = None
            deal_net = None
            deal_parts = 0
            deal_swap = None
            deal_comm = None
            deal_price = None
            try:
                # Every closing deal for this position, not just the first:
                # a partial close produces several and MT5 reports their sum.
                rows = [
                    d.to_dict() if hasattr(d, "to_dict") else d
                    for d in list(self.bridge.deals or [])[-400:]
                    if hasattr(d, "to_dict") or isinstance(d, dict)
                ]
                totals = aggregate_close_deals(rows, ticket)
                if totals:
                    deal_profit = totals["profit"]
                    deal_swap = totals["swap"]
                    deal_comm = totals["commission"]
                    deal_price = totals["price"]
                    deal_net = totals["net"]
                    deal_parts = totals["parts"]
            except Exception:
                pass
            # Not in the EA feed yet? Ask MT5 directly. Deals can lag the
            # position disappearing by a second or two.
            if deal_profit is None and self.bridge.native.connected:
                try:
                    from datetime import datetime, timedelta, timezone
                    import asyncio as _asyncio

                    now = datetime.now(timezone.utc)
                    recent = await _asyncio.to_thread(
                        self.bridge.native.deals, now - timedelta(days=2), now
                    )
                    rows = [
                        d.to_dict() if hasattr(d, "to_dict") else d
                        for d in list(recent or [])[-400:]
                        if hasattr(d, "to_dict") or isinstance(d, dict)
                    ]
                    totals = aggregate_close_deals(rows, ticket)
                    if totals:
                        deal_profit = totals["profit"]
                        deal_swap = totals["swap"]
                        deal_comm = totals["commission"]
                        deal_price = totals["price"]
                        deal_net = totals["net"]
                        deal_parts = totals["parts"]
                except Exception:
                    pass
            close_trade = {
                "time": utc_iso(),
                "ticket": ticket,
                "symbol": old.get("symbol"),
                "side": old.get("type") or old.get("side"),
                "volume": old.get("volume"),
                "price": deal_price or old.get("price_current") or old.get("price_open"),
                "sl": old.get("sl"),
                "tp": old.get("tp"),
                "profit": deal_profit if deal_profit is not None else (old.get("profit") or 0),
                "swap": deal_swap if deal_swap is not None else (old.get("swap") or 0),
                "commission": deal_comm if deal_comm is not None else 0,
                # net is what the balance actually moved by; MT5's Profit column
                # is gross, and a desk that mixes the two can never reconcile.
                "net": deal_net if deal_net is not None else round(
                    float(old.get("profit") or 0) + float(old.get("swap") or 0), 2
                ),
                # How many deals closed this position, and whether the figures
                # came from MT5 or from the last floating price we had.
                "parts": deal_parts,
                "source": "mt5" if deal_profit is not None else "estimate",
                "comment": old.get("comment"),
                "strategy": old.get("strategy") or parse_strategy_tag(str(old.get("comment") or "")),
                "kind": "close",
                "entry": "out",
            }
            # Use _record_close for dedup and prop tracking (it already notes prop)
            try:
                self._record_close(close_trade)
            except Exception:
                # fallback direct
                self.store.record_trade(close_trade)
                try:
                    self.prop.note_closed_trade(float(close_trade.get("profit") or 0))
                except Exception:
                    pass
            await self.journal(
                "info",
                "closed",
                f"Closed {old.get('symbol')} ticket {ticket} "
                f"{old.get('strategy') or ''} P/L={float(close_trade.get('profit') or 0):.2f} SL={close_trade.get('sl')} TP={close_trade.get('tp')}",
                extra=close_trade,
            )
        try:
            # Native-MT5 positions may have no EA tick at all — scan the book
            # itself so the danger guard still fires within one positions beat.
            await self._danger_scan(list(current.values()))
        except Exception:
            log.exception("danger guard scan failed")
        tg = getattr(self, "telegram", None)
        if getattr(self, "_pos_bootstrapped", False) and tg:
            for item in opened:
                try:
                    await tg.notify_open(item)
                except Exception:
                    log.exception("telegram open notify failed")
            for old in closed_rows:
                try:
                    await tg.notify_close(old)
                except Exception:
                    log.exception("telegram close notify failed")
        self._pos_bootstrapped = True
        if closed:
            self._sync_book_meta()
            await self.bus.publish("strategy", self.strategy_meta)
            await self.bus.publish("history", {"items": self.store.history(80)})

    def _is_ea_symbol(self, symbol: str) -> bool:
        want = str(symbol or "").strip()
        if not want:
            return False
        return any(self.bridge._sym_match(want, a.symbol) for a in self.bridge.active_agents())

    async def _adopt_ea_market(self) -> None:
        agents = self.bridge.active_agents()
        if not agents:
            if self.active_symbol:
                self.active_symbol = ""
            return
        if self._is_ea_symbol(self.active_symbol):
            return
        agent = agents[0]
        await self.set_market(agent.symbol, agent.timeframe or "M15")

    async def _on_closed_candle(self, candle: dict[str, Any]) -> None:
        symbol = candle.get("symbol") or self.active_symbol
        timeframe = candle.get("timeframe") or self.active_timeframe
        if not self._is_ea_symbol(str(symbol or "")):
            return
        rows = [c.to_dict() for c in self.bridge.candles_of(symbol, timeframe)]
        if not rows and self._is_ea_symbol(str(symbol or "")):
            rows = self.store.candles(symbol, timeframe, 1500)
        if not rows:
            return
        try:
            votes = []
            for name, slot in self.book.items():
                if not slot.get("enabled"):
                    continue
                act = str(slot.get("last_action") or "")
                if act == "buy":
                    votes.append("bull")
                elif act == "sell":
                    votes.append("bear")
            self.ai._strategy_votes = votes
            state = await asyncio.to_thread(self.ai.on_closed_bar, rows, symbol, timeframe)
        except Exception as exc:
            log.exception("AI on_closed_bar failed")
            await self.journal("error", "ai_fault", f"AI failed on {symbol} {timeframe}: {exc}")
            return
        if state.get("retrain_due"):
            asyncio.create_task(self._bg_train(rows, symbol, timeframe), name=f"aurion-train-{symbol}")
        self.store.record_signal({**state, "source": "ai"})
        await self.bus.publish("ai", state)
        shown = state.get("display_direction") or state.get("hint") or state.get("direction") or "n/a"
        await self.journal(
            "info",
            "ai_bar",
            f"AI {symbol} {timeframe}: {shown} "
            f"conf={float(state.get('confidence') or 0):.2f} samples={state.get('samples') or 0} "
            f"— {state.get('reason') or 'no reason'}",
            extra={"symbol": symbol, "timeframe": timeframe, "activity": (state.get("activity") or [])[-6:]},
        )
        ctx = self._ctx(symbol, timeframe)
        may_fire = bool(
            self.auto_trade
            and not self.kill_switch
            and not self.safe_mode
            and not (self.prop.enabled and self.prop.locked)
            and self.bridge.tape_mode() == "live"
        )
        try:
            await self._run_enabled_strategies(ctx, execute=may_fire)
        except Exception as exc:
            log.exception("strategy book failed")
            await self.journal("error", "book_fault", f"Strategy book crashed: {exc}")

    async def _maybe_trail(self, tick: dict[str, Any]) -> None:
        points = float((self.strategy.params if self.strategy else {}).get("trailing_points") or 0)
        if points <= 0:
            return
        symbol = tick.get("symbol")
        bid, ask = float(tick.get("bid") or 0), float(tick.get("ask") or 0)
        if not symbol or not (bid or ask):
            return
        for pos in self.bridge.positions:
            if pos.symbol != symbol:
                continue
            if pos.type == "buy" and bid:
                new_sl = bid - points
                if new_sl > float(pos.sl or 0) and new_sl < bid:
                    await self.bridge.send_order({"action": "modify", "ticket": pos.ticket, "symbol": symbol, "sl": new_sl, "tp": pos.tp})
            elif pos.type == "sell" and ask:
                new_sl = ask + points
                if (not pos.sl or new_sl < float(pos.sl)) and new_sl > ask:
                    await self.bridge.send_order({"action": "modify", "ticket": pos.ticket, "symbol": symbol, "sl": new_sl, "tp": pos.tp})

    # ------------------------------------------------------------------
    # Danger guard — automatic protective exit
    # ------------------------------------------------------------------
    def _danger_armed(self) -> bool:
        """True only when the user enabled the guard AND prop rules are off."""
        prop = getattr(self, "prop", None)
        return bool(getattr(self, "danger_enabled", False)) and not bool(getattr(prop, "enabled", False))

    def _danger_state(self) -> dict[str, Any]:
        sensitivity = getattr(self, "danger_sensitivity", 50)
        prop = getattr(self, "prop", None)
        return {
            "enabled": bool(getattr(self, "danger_enabled", False)),
            "sensitivity": int(sensitivity),
            "threshold": round(threshold_for(sensitivity), 1),
            "active": self._danger_armed(),
            "blocked_by_prop": bool(getattr(prop, "enabled", False)),
        }

    async def set_danger(self, body: dict[str, Any]) -> dict[str, Any]:
        body = dict(body or {})
        if "enabled" in body:
            self.danger_enabled = bool(body.get("enabled"))
        if "sensitivity" in body:
            self.danger_sensitivity = clamp_sensitivity(body.get("sensitivity"), self.danger_sensitivity)
        self._sync_book_meta()
        self._persist_runtime()
        await self.bus.publish("strategy", self.strategy_meta)
        state = self._danger_state()
        await self.journal(
            "info",
            "danger_cfg",
            f"Danger guard {'ON' if state['enabled'] else 'OFF'} "
            f"(sensitivity {state['sensitivity']}, threshold {state['threshold']})"
            + (" — idle while prop rules are on" if state["blocked_by_prop"] else ""),
            extra=state,
        )
        return {"ok": True, "danger_guard": state}

    def _danger_timeframe(self, symbol: str) -> str:
        try:
            for agent in self.bridge.active_agents():
                if agent.symbol and self.bridge._sym_match(symbol, agent.symbol) and agent.timeframe:
                    return str(agent.timeframe)
        except Exception:
            pass
        return self.active_timeframe or "M15"

    def _danger_candles(self, symbol: str) -> list[dict[str, Any]]:
        timeframe = self._danger_timeframe(symbol)
        try:
            bars = [c.to_dict() for c in self.bridge.candles_of(symbol, timeframe)]
        except Exception:
            bars = []
        if len(bars) < 20:
            try:
                bars = self.store.candles(symbol, timeframe, 160) or bars
            except Exception:
                pass
        return bars

    def _danger_ai(self, symbol: str) -> dict[str, Any]:
        try:
            by = dict(getattr(self.ai, "by_symbol", None) or {})
            if symbol in by:
                return by[symbol]
            last = self.ai.last or {}
            if str(last.get("symbol") or "") == symbol:
                return last
        except Exception:
            pass
        return {}

    async def _maybe_danger_guard(self, tick: dict[str, Any]) -> None:
        if not self._danger_armed():
            return
        sym = str((tick or {}).get("symbol") or "")
        rows: list[dict[str, Any]] = []
        for pos in self.bridge.positions:
            try:
                if sym and not self.bridge._sym_match(pos.symbol, sym):
                    continue
            except Exception:
                if sym and pos.symbol != sym:
                    continue
            rows.append(self._annotate_pos(pos.to_dict()))
        if rows:
            await self._danger_scan(rows)

    async def _danger_scan(self, rows: list[dict[str, Any]]) -> None:
        if not self._danger_armed():
            return
        try:
            live = self.bridge.tape_mode() == "live"
        except Exception:
            live = False
        if not live or not rows:
            return
        try:
            balance = float(self.bridge.account.balance or self.bridge.account.equity or 0)
        except Exception:
            balance = 0.0
        now = time.time()
        threshold = threshold_for(self.danger_sensitivity)
        for row in rows:
            if not isinstance(row, dict):
                continue
            try:
                ticket = int(row.get("ticket") or 0)
            except (TypeError, ValueError):
                ticket = 0
            if not ticket or ticket in self._danger_inflight:
                continue
            first = float(self._danger_seen.get(ticket) or 0)
            if not first:
                self._danger_seen[ticket] = now
                first = now
            if now - first < GRACE_SECONDS:
                continue
            if now - float(self._danger_cooldown.get(ticket) or 0) < COOLDOWN_SECONDS:
                continue
            symbol = str(row.get("symbol") or "")
            verdict = score_position(
                row,
                candles=self._danger_candles(symbol),
                ai=self._danger_ai(symbol),
                balance=balance,
            )
            if float(verdict.get("score") or 0) < threshold:
                continue
            self._danger_inflight.add(ticket)
            try:
                await self._danger_close(ticket, row, verdict, threshold)
                self._danger_cooldown[ticket] = time.time()
            finally:
                self._danger_inflight.discard(ticket)
        if len(self._danger_seen) > 2000:
            self._danger_seen = {k: v for k, v in self._danger_seen.items() if now - v < 3600}
        if len(self._danger_cooldown) > 2000:
            self._danger_cooldown = {k: v for k, v in self._danger_cooldown.items() if now - v < 3600}

    async def _danger_close(
        self, ticket: int, row: dict[str, Any], verdict: dict[str, Any], threshold: float
    ) -> None:
        symbol = str(row.get("symbol") or "")
        side = str(row.get("type") or row.get("side") or "")
        score = float(verdict.get("score") or 0)
        why = "; ".join(verdict.get("reasons") or []) or "danger score over threshold"
        try:
            volume = float(row.get("volume") or 0)
        except (TypeError, ValueError):
            volume = 0.0
        # Keep the original strategy tag on the close leg so the ledger and
        # per-strategy stats stay consistent — the journal records the guard.
        known = self._known_pos.get(ticket) or {}
        tag = str(row.get("strategy") or known.get("strategy") or "") or parse_strategy_tag(
            str(row.get("comment") or known.get("comment") or "")
        )
        await self.journal(
            "warning",
            "danger_close",
            f"Danger guard closing {symbol} #{ticket} {side} "
            f"score={score:.0f}/{threshold:.0f} ({why})",
            extra={"ticket": ticket, "symbol": symbol, "score": score, "verdict": verdict},
        )
        await self.execute(
            {
                "action": "close",
                "ticket": ticket,
                "symbol": symbol,
                "volume": volume,
                "source": "danger",
                "comment": (f"AURION {tag}" if tag else "AURION danger")[:31],
                "strategy": tag or "danger",
                "emergency": True,
            }
        )

    async def _maybe_strategy_tick(self, tick: dict[str, Any]) -> None:
        if not self.auto_trade:
            return
        if self.kill_switch or self.prop.locked or self.safe_mode:
            return
        ctx = self._ctx(tick.get("symbol") or self.active_symbol, self.active_timeframe, tick)
        for name, slot in self.book.items():
            if not slot.get("enabled"):
                continue
            inst = slot.get("inst")
            if not inst or not hasattr(inst, "on_tick"):
                continue
            try:
                signal = inst.on_tick(ctx)
            except Exception as exc:
                log.exception("strategy %s on_tick crashed", name)
                self.safe_mode = True
                await self.bus.publish("log", {"level": "error", "message": f"strategy fault: {exc}"})
                return
            if signal:
                await self._dispatch_signal(signal, f"strategy_tick:{name}")
                # Keep scanning only while the book still has room; the old
                # code stopped dead after the first strategy fired.
                if self.free_slots(str(tick.get("symbol") or self.active_symbol)) <= 0:
                    return

    def _load_runtime_book(self) -> None:
        cfg = load()
        runtime = cfg.get("runtime") or {}
        self.auto_trade = bool(runtime.get("auto_trade", False))
        self.require_ai_agree = bool(runtime.get("require_ai_agree", True))
        self.min_ai_confidence = float(runtime.get("min_ai_confidence") or 0.55)
        self.volume_mode = "manual" if str(runtime.get("volume_mode") or "auto") == "manual" else "auto"
        try:
            self.manual_volume = max(0.0, min(1000.0, float(runtime.get("manual_volume") or 0.10)))
        except Exception:
            self.manual_volume = 0.10
        self.trade_style = str(runtime.get("trade_style") or "normal")
        if self.trade_style not in {"normal", "scalping"}:
            self.trade_style = "normal"
        self.max_open_trades = self._clamp_int(runtime.get("max_open_trades"), 2, 1, 20)
        self.min_open_trades = self._clamp_int(runtime.get("min_open_trades"), 1, 1, self.max_open_trades)
        self.smart_filters = bool(runtime.get("smart_filters", True))
        try:
            self.min_signal_quality = max(0.0, min(0.95, float(runtime.get("min_signal_quality", 0.55))))
        except (TypeError, ValueError):
            self.min_signal_quality = 0.55
        self.news_trade = bool(runtime.get("news_trade", False))
        danger_cfg = runtime.get("danger_guard") if isinstance(runtime.get("danger_guard"), dict) else {}
        self.danger_enabled = bool(danger_cfg.get("enabled", False))
        self.danger_sensitivity = clamp_sensitivity(danger_cfg.get("sensitivity", 50))
        # License gates: freemium accounts lose prop + scalping + news trading.
        # Persisted premium-era settings are silently downgraded on boot.
        if self.news_trade and not self.license.feature("news"):
            self.news_trade = False
            try:
                merge({"runtime": {"news_trade": False}})
            except Exception:
                pass
        if self.trade_style == "scalping" and not self.license.feature("scalping"):
            self.trade_style = "normal"
            try:
                merge({"runtime": {"trade_style": "normal"}})
            except Exception:
                pass
        if self.prop.enabled and not self.license.feature("prop"):
            self.prop.set_enabled(False)
            try:
                merge({"prop": {"enabled": False}})
            except Exception:
                pass
        saved = runtime.get("strategies") or {}
        self.book = {}
        for name in ("ema_rsi", "price_action", "atr_breakout", "scalp_impulse"):
            spec = saved.get(name) or {}
            inst = self.loader.load_builtin(name, spec.get("params") or {})
            self.book[name] = {
                "inst": inst,
                "enabled": bool(spec.get("enabled")),
                "kind": spec.get("kind") or "builtin",
                "last_action": "idle",
                "last_reason": "",
                "last_ts": "",
            }
        for name, spec in saved.items():
            if name in self.book or not isinstance(spec, dict):
                continue
            try:
                kind = str(spec.get("kind") or "file")
                params = spec.get("params") or {}
                if kind == "builtin":
                    inst = self.loader.load_builtin(name, params)
                else:
                    from pathlib import Path

                    path = Path(spec.get("path") or (self.loader.dir / str(spec.get("file") or name)))
                    inst = self.loader.load_path(path, params)
                self.book[name] = {
                    "inst": inst,
                    "enabled": bool(spec.get("enabled")),
                    "kind": kind,
                    "last_action": "idle",
                    "last_reason": "",
                    "last_ts": "",
                }
            except Exception:
                log.exception("saved strategy %s failed to reload", name)
        self._apply_style_params()
        for name, spec in saved.items():
            if name not in self.book or not isinstance(spec, dict):
                continue
            params = spec.get("params") or {}
            if params:
                inst = self.book[name]["inst"]
                inst.params = {**getattr(inst, "params", {}), **params}
        # Self-heal: any uploaded .py still sitting in the strategies folder is
        # registered (disabled), so a custom strategy can never vanish from the
        # desk just because the runtime config lost its entry.
        try:
            for path in sorted(self.loader.dir.glob("*.py")):
                stem = path.stem
                if stem in self.book or stem.startswith("_") or stem == "template":
                    continue
                try:
                    inst = self.loader.load_path(path, {})
                except Exception:
                    log.exception("uploaded strategy %s failed to load", stem)
                    continue
                self.book[stem] = {
                    "inst": inst,
                    "enabled": False,
                    "kind": "file",
                    "last_action": "idle",
                    "last_reason": "",
                    "last_ts": "",
                }
                log.info("registered uploaded strategy %s from disk", stem)
        except Exception:
            pass
        # Heal legacy configs: older builds allowed several enabled strategies.
        # Now a single one is armed — keep the first, switch the rest off.
        enabled_names = [k for k, v in self.book.items() if v.get("enabled")]
        if len(enabled_names) > 1:
            keep = enabled_names[0]
            for other in enabled_names[1:]:
                self.book[other]["enabled"] = False
            log.warning("multiple strategies were enabled; keeping %s only", keep)
            try:
                self._persist_runtime()
            except Exception:
                pass
        self._sync_book_meta()

    # ------------------------------------------------------------ trade slots
    @staticmethod
    def _clamp_int(value: Any, default: int, low: int, high: int) -> int:
        try:
            out = int(float(value))
        except (TypeError, ValueError):
            out = default
        return max(low, min(high, out))

    def _open_count(self, symbol: str = "") -> int:
        """Live positions, optionally for one symbol only."""
        try:
            rows = list(getattr(self, "bridge").positions)
        except Exception:
            return 0
        if not symbol:
            return len(rows)
        try:
            return sum(1 for p in rows if self.bridge._sym_match(str(getattr(p, "symbol", "")), symbol))
        except Exception:
            return sum(1 for p in rows if str(getattr(p, "symbol", "")) == symbol)

    def _per_symbol_cap(self) -> int:
        """How many positions may share one symbol (prop wins when armed)."""
        if getattr(self.prop, "enabled", False):
            try:
                return max(1, int((self.prop.profile or {}).get("max_positions_per_symbol") or 1))
            except (TypeError, ValueError):
                return 1
        return max(1, int(getattr(self, "max_open_trades", 2) or 2))

    def _total_cap(self) -> int:
        cap = max(1, int(getattr(self, "max_open_trades", 2) or 2))
        if getattr(self.prop, "enabled", False):
            try:
                cap = min(cap, max(1, int((self.prop.profile or {}).get("max_open_trades") or cap)))
            except (TypeError, ValueError):
                pass
        return cap

    def free_slots(self, symbol: str = "") -> int:
        """Robot entries still allowed right now (never negative)."""
        left = self._total_cap() - self._open_count()
        if symbol:
            left = min(left, self._per_symbol_cap() - self._open_count(symbol))
        return max(0, left)

    def _entries_for_signal(self, symbol: str, quality: float) -> int:
        """How many tickets one confirmed signal opens: between min and max.

        A weak-but-valid setup takes the minimum; a high quality one scales up
        towards the ceiling. Never more than the free slots.
        """
        low = max(1, int(getattr(self, "min_open_trades", 1) or 1))
        high = max(low, int(self._total_cap()))
        if high <= low:
            want = low
        else:
            strength = max(0.0, min(1.0, (float(quality) - 0.5) / 0.4))
            want = low + int(round((high - low) * strength))
        return max(0, min(want, self.free_slots(symbol)))

    # --------------------------------------------------------- smarter brain
    def _higher_timeframe(self) -> str:
        ladder = ["M1", "M5", "M15", "M30", "H1", "H4", "D1"]
        try:
            idx = ladder.index(str(self.active_timeframe or "M15").upper())
        except ValueError:
            return "H1"
        return ladder[min(len(ladder) - 1, idx + 2)]

    def _higher_tf_bias(self, symbol: str) -> tuple[str, float]:
        """Trend of the slower chart: ("bull"|"bear"|"neutral", strength 0..1).

        Counter-trend entries are where most of the robot's losses came from —
        a slow-chart read costs nothing and filters them out.
        """
        timeframe = self._higher_timeframe()
        rows: list[dict[str, Any]] = []
        try:
            rows = [c.to_dict() for c in self.bridge.candles_of(symbol, timeframe)]
        except Exception:
            rows = []
        if len(rows) < 60:
            try:
                rows = self.store.candles(symbol, timeframe, 300)
            except Exception:
                rows = []
        if len(rows) < 60:
            return "neutral", 0.0
        try:
            closes = [float(r.get("close") or 0) for r in rows if r.get("close")]
        except (TypeError, ValueError):
            return "neutral", 0.0
        if len(closes) < 60:
            return "neutral", 0.0

        def _ema(values: list[float], span: int) -> float:
            k = 2.0 / (span + 1.0)
            out = values[0]
            for v in values[1:]:
                out = v * k + out * (1 - k)
            return out

        fast = _ema(closes[-120:], 21)
        slow = _ema(closes[-200:] if len(closes) >= 200 else closes, 55)
        price = closes[-1]
        if not price:
            return "neutral", 0.0
        spread = (fast - slow) / price
        strength = max(0.0, min(1.0, abs(spread) / 0.002))
        if spread > 0.0002:
            return "bull", strength
        if spread < -0.0002:
            return "bear", strength
        return "neutral", strength

    def _spread_ok(self, symbol: str) -> tuple[bool, str]:
        """Reject entries when the spread eats the edge."""
        try:
            ticks = self.bridge.public_ticks() or {}
        except Exception:
            return True, ""
        tick = ticks.get(symbol) or {}
        try:
            bid = float(tick.get("bid") or 0)
            ask = float(tick.get("ask") or 0)
        except (TypeError, ValueError):
            return True, ""
        if bid <= 0 or ask <= 0:
            return True, ""
        spread_pct = (ask - bid) / ((ask + bid) / 2.0)
        atr_pct = 0.0
        try:
            feats = (self.ai.by_symbol.get(symbol) or {}).get("features") or {}
            atr_pct = float(feats.get("atr_pct") or 0)
        except Exception:
            atr_pct = 0.0
        if atr_pct > 0 and spread_pct > atr_pct * 0.5:
            return False, f"spread {spread_pct * 100:.3f}% is over half the ATR"
        if atr_pct <= 0 and spread_pct > 0.0015:
            return False, f"spread {spread_pct * 100:.3f}% is too wide"
        return True, ""

    def signal_quality(self, symbol: str, side: str, signal_conf: float = 0.0) -> dict[str, Any]:
        """Blend every read we have into one 0..1 score for this entry.

        Model probability, its measured out-of-sample edge, the strategy's own
        confidence, candle pattern, market regime and the higher timeframe all
        move the same number — so the robot stops taking the setups that only
        one of them liked.
        """
        want = "bull" if str(side).lower() in {"buy", "long"} else "bear"
        ai: dict[str, Any] = {}
        try:
            ai = dict((self.ai.by_symbol.get(symbol) or {}))
            if not ai:
                last = self.ai.last or {}
                if str(last.get("symbol") or "") == symbol or not last.get("symbol"):
                    ai = dict(last)
        except Exception:
            ai = {}
        reasons: list[str] = []
        score = 0.5
        conf = float(ai.get("confidence") or 0)
        direction = str(ai.get("direction") or ai.get("display_direction") or "neutral")
        if ai.get("ready"):
            if direction == want:
                score += 0.30 * conf
                reasons.append(f"ai {direction} {conf:.0%}")
            elif direction == "neutral":
                score -= 0.05
                reasons.append("ai neutral")
            else:
                score -= 0.30 * max(conf, 0.5)
                reasons.append(f"ai {direction} against")
        else:
            score -= 0.05
            reasons.append("ai still learning")
        # Measured edge of the model (holdout accuracy) — an untested model is
        # not allowed to push the score up much.
        try:
            edge = float((self.ai.models.metrics or {}).get("edge") or 0)
        except Exception:
            edge = 0.0
        score += 0.10 * max(0.0, min(1.0, edge))
        if signal_conf:
            score += 0.10 * max(0.0, min(1.0, float(signal_conf)))
            reasons.append(f"strategy {float(signal_conf):.0%}")
        regime = ai.get("regime_obj") if isinstance(ai.get("regime_obj"), dict) else ai.get("regime")
        regime_name = str((regime or {}).get("name") if isinstance(regime, dict) else regime or "")
        if regime_name:
            if "trend" in regime_name.lower():
                score += 0.05
            elif "chop" in regime_name.lower() or "range" in regime_name.lower():
                score -= 0.08
            reasons.append(f"regime {regime_name}")
        bias, strength = self._higher_tf_bias(symbol)
        if bias == want:
            score += 0.12 * strength
            reasons.append(f"{self._higher_timeframe()} {bias}")
        elif bias != "neutral":
            score -= 0.18 * max(0.35, strength)
            reasons.append(f"{self._higher_timeframe()} {bias} against")
        feats = ai.get("features") or {}
        try:
            er = float(feats.get("er10") or 0)
            atr_pct = float(feats.get("atr_pct") or 0)
        except (TypeError, ValueError):
            er = atr_pct = 0.0
        if er and er < 0.18:
            score -= 0.10
            reasons.append("chop (low efficiency)")
        if atr_pct and atr_pct < 0.00025:
            score -= 0.10
            reasons.append("volatility too low")
        score = max(0.0, min(1.0, score))
        return {"score": score, "reasons": reasons, "bias": bias, "ai": direction, "confidence": conf}

    def _auto_limit_meta(self) -> dict[str, Any]:
        """Freemium auto-trade allowance for the UI; never breaks status paint."""
        try:
            return self.license.bot_usage()
        except Exception:
            return {}

    def _sync_book_meta(self) -> None:
        enabled = [k for k, v in self.book.items() if v.get("enabled")]
        first = next((self.book[k]["inst"] for k in enabled), None)
        self.strategy = first
        items = []
        for name, slot in self.book.items():
            inst = slot["inst"]
            desc = inst.describe() if hasattr(inst, "describe") else {"name": name}
            desc["name"] = str(name)
            desc["enabled"] = bool(slot.get("enabled"))
            desc["kind"] = slot.get("kind") or "builtin"
            desc["last_action"] = slot.get("last_action") or "idle"
            desc["last_reason"] = slot.get("last_reason") or ""
            desc["last_ts"] = slot.get("last_ts") or ""
            items.append(desc)
        try:
            # The persistent ledger, not a scan of the trade table: a strategy's
            # record has to outlive a history reset, and every strategy - the
            # four built-ins and any uploaded one - keeps its own.
            ledger = self.store.strategy_ledger([k for k in self.book] + ["desk", "other"])
        except Exception:
            log.exception("strategy ledger unavailable")
            ledger = {}

        def _stat(name: str) -> dict[str, Any]:
            return ledger.get(normalise_strategy_tag(name), {})

        for desc in items:
            stats = _stat(str(desc.get("name") or ""))
            desc["trades"] = int(stats.get("trades") or 0)
            desc["wins"] = int(stats.get("wins") or 0)
            desc["losses"] = int(stats.get("losses") or 0)
            desc["net"] = float(stats.get("net") or 0)
            desc["win_rate"] = float(stats.get("win_rate") or 0)
            # The card shows the record as well as the headline, so the whole
            # ledger row travels with it rather than three of its fields.
            desc["profit_factor"] = stats.get("profit_factor")
            desc["avg"] = float(stats.get("avg") or 0)
            desc["best"] = float(stats.get("best") or 0)
            desc["worst"] = float(stats.get("worst") or 0)
            desc["gross_profit"] = float(stats.get("gross_profit") or 0)
            desc["gross_loss"] = float(stats.get("gross_loss") or 0)
            desc["last_trade_ts"] = stats.get("last_ts")
        self.strategy_meta = {
            "name": ",".join(enabled) if enabled else None,
            "enabled": bool(enabled) and self.auto_trade,
            "auto_trade": self.auto_trade,
            "require_ai_agree": self.require_ai_agree,
            "min_ai_confidence": self.min_ai_confidence,
            "volume_mode": getattr(self, "volume_mode", "auto"),
            "manual_volume": getattr(self, "manual_volume", 0.10),
            "trade_style": self.trade_style,
            "min_open_trades": int(getattr(self, "min_open_trades", 1) or 1),
            "max_open_trades": int(getattr(self, "max_open_trades", 2) or 2),
            "open_trades": self._open_count(),
            "free_slots": self.free_slots(),
            "smart_filters": bool(getattr(self, "smart_filters", True)),
            # What the caps actually are once the prop profile has had its
            # say. The desk was showing the trader's own number, which is a
            # wish rather than the rule the robot is being held to.
            "cap_effective": self._total_cap(),
            "cap_symbol": self._per_symbol_cap(),
            "cap_by_prop": bool(
                getattr(self.prop, "enabled", False)
                and self._total_cap() < max(1, int(getattr(self, "max_open_trades", 2) or 2))
            ),
            "min_signal_quality": float(getattr(self, "min_signal_quality", 0.55) or 0.55),
            "last_quality": dict(getattr(self, "last_quality", {}) or {}),
            "news_trade": self.news_trading_on(),
            "news_trade_locked": bool(self.prop.enabled),
            "danger_guard": self._danger_state(),
            "auto_limit": self._auto_limit_meta(),
            "prop_enabled": bool(getattr(self.prop, "enabled", True)),
            "items": items,
            "stats": ledger,
            "class": first.__class__.__name__ if first else "",
        }

    def _persist_runtime(self) -> None:
        merge(
            {
                "runtime": {
                    "auto_trade": self.auto_trade,
                    "require_ai_agree": self.require_ai_agree,
                    "min_ai_confidence": self.min_ai_confidence,
                    "volume_mode": getattr(self, "volume_mode", "auto"),
                    "manual_volume": getattr(self, "manual_volume", 0.10),
                    "trade_style": self.trade_style,
                    "min_open_trades": int(getattr(self, "min_open_trades", 1) or 1),
                    "max_open_trades": int(getattr(self, "max_open_trades", 2) or 2),
                    "smart_filters": bool(getattr(self, "smart_filters", True)),
                    "min_signal_quality": float(getattr(self, "min_signal_quality", 0.55) or 0.55),
                    "news_trade": self.news_trade,
                    "danger_guard": {
                        "enabled": bool(self.danger_enabled),
                        "sensitivity": int(self.danger_sensitivity),
                    },
                    "strategies": {
                        name: {
                            "enabled": bool(slot.get("enabled")),
                            "params": getattr(slot.get("inst"), "params", {}),
                            "kind": slot.get("kind") or "builtin",
                            **(
                                {
                                    "file": name if str(name).endswith(".py") else f"{name}.py",
                                }
                                if (slot.get("kind") or "builtin") != "builtin"
                                else {}
                            ),
                        }
                        for name, slot in self.book.items()
                    },
                }
            }
        )

    def _signal_bits(self, signal: Any) -> tuple[str, str]:
        if not signal:
            return "", ""
        if hasattr(signal, "action"):
            return str(signal.action or ""), str(getattr(signal, "reason", "") or "")
        if isinstance(signal, dict):
            return str(signal.get("action") or ""), str(signal.get("reason") or "")
        return "", ""

    async def _run_enabled_strategies(self, ctx: StrategyContext, execute: bool = False) -> None:
        closes: list[tuple[str, Any]] = []
        entries: list[tuple[str, Any]] = []
        enabled = [name for name, slot in self.book.items() if slot.get("enabled") and slot.get("inst")]
        if not enabled:
            await self.journal("info", "no_strategy", f"Closed {ctx.symbol} {ctx.timeframe} — no strategy enabled.")
            self._sync_book_meta()
            await self.bus.publish("strategy", self.strategy_meta)
            return
        await self.journal(
            "info",
            "eval",
            f"Evaluating {', '.join(enabled)} on {ctx.symbol} {ctx.timeframe} "
            f"({'LIVE fire' if execute else 'observe only — will not send'})",
        )
        for name, slot in self.book.items():
            if not slot.get("enabled"):
                continue
            inst = slot.get("inst")
            if not inst:
                continue
            try:
                signal = inst.on_candle(ctx)
            except Exception as exc:
                log.exception("strategy %s on_candle crashed", name)
                slot["last_action"] = "fault"
                slot["last_reason"] = str(exc)
                slot["last_ts"] = utc_iso()
                self.safe_mode = True
                await self.journal("error", "strategy_fault", f"{name} crashed: {exc}")
                self._sync_book_meta()
                await self.bus.publish("strategy", self.strategy_meta)
                return
            action, reason = self._signal_bits(signal)
            if not signal or action in {"", "hold", "none"}:
                slot["last_action"] = "hold"
                slot["last_reason"] = reason or "no setup on this bar"
                slot["last_ts"] = utc_iso()
                await self.journal("info", "hold", f"{name}: hold — {slot['last_reason']}")
                continue
            slot["last_action"] = action
            slot["last_reason"] = reason or action
            slot["last_ts"] = utc_iso()
            await self.journal("info", "signal", f"{name}: {action} — {slot['last_reason']}")
            if action in {"close", "close_all", "flatten"}:
                closes.append((name, signal))
            elif action in {"buy", "sell", "market"}:
                entries.append((name, signal))
        if not execute:
            if closes or entries:
                await self.journal(
                    "warning",
                    "not_armed",
                    "Signal seen but auto-trade is not armed (or a gate is closed) — order not sent.",
                )
            self._sync_book_meta()
            await self.bus.publish("strategy", self.strategy_meta)
            return
        for name, signal in closes:
            await self.journal("info", "close", f"{name} requested close")
            await self._dispatch_signal(signal, f"strategy:{name}")
        if not entries:
            self._sync_book_meta()
            await self.bus.publish("strategy", self.strategy_meta)
            return
        sides = set()
        for _, signal in entries:
            action, _ = self._signal_bits(signal)
            side = action if action in {"buy", "sell"} else "buy"
            if hasattr(signal, "side") and getattr(signal, "side", None):
                side = str(signal.side)
            elif isinstance(signal, dict) and signal.get("side"):
                side = str(signal.get("side"))
            sides.add(side)
        if len(sides) > 1:
            await self.journal("warning", "disagree", "Enabled strategies disagreed on side — no entry")
            self._sync_book_meta()
            await self.bus.publish("strategy", self.strategy_meta)
            return
        # Every agreeing strategy gets a chance, up to the configured ceiling.
        for name, signal in entries:
            if self.free_slots(ctx.symbol) <= 0:
                await self.journal(
                    "info",
                    "slots_full",
                    f"Holding {self._open_count()} of max {self._total_cap()} robot trades — {name} not dispatched",
                )
                break
            await self.journal("info", "dispatch", f"Dispatching {name} {self._signal_bits(signal)[0]}")
            await self._dispatch_signal(signal, f"strategy:{name}")
        self._sync_book_meta()
        await self.bus.publish("strategy", self.strategy_meta)

    # Style packs also carry the confluence settings, so "normal" trades the
    # strict, trend-following version of every strategy while "scalping"
    # loosens the slow filters it cannot afford to wait for.
    STYLE_PACKS = {
        "normal": {
            "ema_rsi": {
                "fast": 8, "slow": 21, "rsi_period": 14, "volume": 0.10, "sl_atr": 1.6, "tp_atr": 2.4,
                "min_rr": 1.5, "with_trend": True, "require_momentum": True, "min_efficiency": 0.15,
            },
            "price_action": {
                "volume": 0.10, "min_score": 0.62, "sl_atr": 1.4, "tp_atr": 2.2,
                "min_rr": 1.5, "with_trend": True, "require_momentum": False, "min_efficiency": 0.12,
            },
            "atr_breakout": {
                "lookback": 20, "volume": 0.10, "sl_atr": 1.2, "tp_atr": 2.0,
                "min_rr": 1.6, "with_trend": True, "require_momentum": True, "min_efficiency": 0.18,
            },
            "scalp_impulse": {
                "lookback": 8, "volume": 0.05, "sl_atr": 0.9, "tp_atr": 1.4,
                "min_rr": 1.3, "with_trend": True, "require_momentum": False, "min_efficiency": 0.2,
            },
        },
        "scalping": {
            "ema_rsi": {
                "fast": 3, "slow": 8, "rsi_period": 7, "volume": 0.05, "sl_atr": 0.7, "tp_atr": 1.1,
                "min_rr": 1.15, "with_trend": True, "require_momentum": False, "min_efficiency": 0.1,
            },
            "price_action": {
                "volume": 0.05, "min_score": 0.55, "sl_atr": 0.7, "tp_atr": 1.05,
                "min_rr": 1.15, "with_trend": False, "require_momentum": False, "min_efficiency": 0.08,
            },
            "atr_breakout": {
                "lookback": 8, "volume": 0.05, "sl_atr": 0.55, "tp_atr": 0.95,
                "min_rr": 1.2, "with_trend": True, "require_momentum": False, "min_efficiency": 0.12,
            },
            "scalp_impulse": {
                "lookback": 5, "volume": 0.05, "sl_atr": 0.5, "tp_atr": 0.8,
                "min_rr": 1.1, "with_trend": False, "require_momentum": False, "min_efficiency": 0.12,
            },
        },
    }

    def _apply_style_params(self) -> None:
        pack = self.STYLE_PACKS.get(self.trade_style) or self.STYLE_PACKS["normal"]
        for name, slot in self.book.items():
            inst = slot.get("inst")
            if not inst:
                continue
            overlay = pack.get(name) or {}
            inst.params = {**getattr(inst, "params", {}), **overlay}

    def set_auto(self, body: dict[str, Any]) -> dict[str, Any]:
        if "enabled" in body or "auto_trade" in body:
            self.auto_trade = bool(body.get("enabled") if "enabled" in body else body.get("auto_trade"))
        if "require_ai_agree" in body:
            self.require_ai_agree = bool(body.get("require_ai_agree"))
        if "min_ai_confidence" in body:
            self.min_ai_confidence = float(body.get("min_ai_confidence") or 0)
        if "volume_mode" in body:
            mode = str(body.get("volume_mode") or "auto")
            if mode == "manual" and not self.license.feature("volume_mode"):
                return {"ok": False, "error": "premium_required", "feature": "volume_mode", "upgrade": True}
            self.volume_mode = mode if mode == "manual" else "auto"
        if "manual_volume" in body and str(getattr(self, "volume_mode", "auto")) == "manual":
            # manual volume itself is premium controlled via volume_mode
            if not self.license.feature("volume_mode"):
                return {"ok": False, "error": "premium_required", "feature": "volume_mode", "upgrade": True}
        if "manual_volume" in body:
            try:
                self.manual_volume = max(0.0, min(1000.0, float(body.get("manual_volume") or 0)))
            except Exception:
                pass
        if "max_open_trades" in body:
            self.max_open_trades = self._clamp_int(body.get("max_open_trades"), getattr(self, "max_open_trades", 2), 1, 20)
            if getattr(self, "min_open_trades", 1) > self.max_open_trades:
                self.min_open_trades = self.max_open_trades
        if "min_open_trades" in body:
            self.min_open_trades = self._clamp_int(
                body.get("min_open_trades"), getattr(self, "min_open_trades", 1), 1, int(getattr(self, "max_open_trades", 2) or 2)
            )
        if "smart_filters" in body:
            self.smart_filters = bool(body.get("smart_filters"))
        if "min_signal_quality" in body:
            try:
                self.min_signal_quality = max(0.0, min(0.95, float(body.get("min_signal_quality") or 0)))
            except (TypeError, ValueError):
                pass
        if "trade_style" in body:
            style = str(body.get("trade_style") or "normal")
            style = style if style in {"normal", "scalping"} else "normal"
            if style == "scalping" and not self.license.feature("scalping"):
                return {"ok": False, "error": "premium_required", "feature": "scalping", "upgrade": True}
            self.trade_style = style
            self._apply_style_params()
            if self.trade_style == "scalping" and self.active_timeframe in {"H1", "H4", "D1"}:
                self.active_timeframe = "M1"
        if "news_trade" in body and not self.prop.enabled:
            if body.get("news_trade") and not self.license.feature("news"):
                return {"ok": False, "error": "premium_required", "feature": "news", "upgrade": True}
            self.news_trade = bool(body.get("news_trade"))
        if "prop_enabled" in body:
            if body.get("prop_enabled") and not self.license.feature("prop"):
                return {"ok": False, "error": "premium_required", "feature": "prop", "upgrade": True}
            self.prop.set_enabled(bool(body.get("prop_enabled")))
            merge({"prop": {"enabled": self.prop.enabled}})
        self._sync_book_meta()
        self._persist_runtime()
        try:
            loop = asyncio.get_running_loop()
            loop.create_task(self.bus.publish("strategy", self.strategy_meta))
            loop.create_task(self.bus.publish("prop", self.prop.metrics(self.bridge.account.to_dict())))
        except RuntimeError:
            pass
        return {"ok": True, "strategy": self.strategy_meta, "auto_trade": self.auto_trade, "prop_enabled": self.prop.enabled}

    async def toggle_strategy(self, name: str, enabled: bool, params: dict[str, Any] | None = None) -> dict[str, Any]:
        name = str(name or "").strip()
        if name.endswith(".py"):
            name = name[:-3]
        if name not in self.book:
            # Not armed yet — first try the built-ins, then fall back to a
            # user-uploaded .py in the strategies folder. Without this a custom
            # strategy that survived a restart only as a file could never be
            # switched on ("unknown builtin strategy ...").
            from ..strategy.loader import StrategyValidationError

            inst = None
            kind = "builtin"
            try:
                inst = self.loader.load_builtin(name, params or {})
            except StrategyValidationError:
                inst = None
            if inst is None:
                from pathlib import Path as _P

                cand = _P(self.loader.dir / f"{name}.py")
                if not cand.exists():
                    return {"ok": False, "error": f"unknown strategy {name}"}
                try:
                    inst = self.loader.load_path(cand, params or {})
                    kind = "file"
                except Exception as exc:
                    return {"ok": False, "error": str(exc)}
            self.book[name] = {"inst": inst, "enabled": False, "kind": kind, "last_action": "idle", "last_reason": "", "last_ts": ""}
        if params:
            inst = self.book[name]["inst"]
            inst.params = {**getattr(inst, "params", {}), **params}
        if enabled:
            # Radio behaviour: exactly one strategy armed at a time. Turning
            # this one on switches every other strategy off.
            for other, slot in self.book.items():
                if other != name and slot.get("enabled"):
                    slot["enabled"] = False
        self.book[name]["enabled"] = bool(enabled)
        self._sync_book_meta()
        self._persist_runtime()
        await self.bus.publish("strategy", self.strategy_meta)
        return {"ok": True, "strategy": self.strategy_meta}

    # ------------------------------------------------------------------
    # Custom (user-uploaded) strategy management
    # ------------------------------------------------------------------
    def _custom_slot(self, name: str):
        """Resolve a book slot that the user is allowed to edit/delete."""
        name = str(name or "").strip()
        if name.endswith(".py"):
            name = name[:-3]
        slot = self.book.get(name)
        if slot is None:
            return name, None, {"ok": False, "error": f"unknown strategy {name}"}
        if (slot.get("kind") or "builtin") != "file":
            return name, None, {
                "ok": False,
                "error": "built-in strategies are read-only — upload your own .py copy to change it",
            }
        return name, slot, None

    def strategy_source(self, name: str) -> dict[str, Any]:
        name, slot, err = self._custom_slot(name)
        if err:
            return err
        path = self.loader.dir / f"{name}.py"
        if not path.exists():
            return {"ok": False, "error": "strategy file missing from disk"}
        try:
            return {"ok": True, "name": name, "file": path.name, "source": path.read_text(encoding="utf-8")}
        except Exception as exc:
            return {"ok": False, "error": str(exc)}

    async def update_strategy(self, name: str, source: str) -> dict[str, Any]:
        """Rewrite the code of a custom strategy and hot-reload it in place."""
        name, slot, err = self._custom_slot(name)
        if err:
            return err
        if not str(source or "").strip():
            return {"ok": False, "error": "empty strategy"}
        enabled = bool(slot.get("enabled"))
        params = dict(getattr(slot.get("inst"), "params", {}) or {})
        try:
            # save_upload validates first, so broken code never reaches disk.
            path = self.loader.save_upload(f"{name}.py", source)
            inst = self.loader.load_path(path, params)
        except Exception as exc:
            return {"ok": False, "error": str(exc)}
        ctx = None
        if enabled and hasattr(slot["inst"], "on_stop"):
            try:
                ctx = self._ctx(self.active_symbol, self.active_timeframe)
                slot["inst"].on_stop(ctx)
            except Exception:
                pass
        slot["inst"] = inst
        slot["last_action"] = "idle"
        slot["last_reason"] = "reloaded"
        slot["last_ts"] = ""
        if enabled and hasattr(inst, "on_start"):
            try:
                inst.on_start(ctx or self._ctx(self.active_symbol, self.active_timeframe))
            except Exception:
                pass
        self._sync_book_meta()
        self._persist_runtime()
        await self.bus.publish("strategy", self.strategy_meta)
        return {"ok": True, "strategy": self.strategy_meta, "name": name, "file": f"{name}.py"}

    async def delete_strategy(self, name: str) -> dict[str, Any]:
        """Remove a custom strategy from the book and delete its .py file."""
        name, slot, err = self._custom_slot(name)
        if err:
            return err
        if slot.get("enabled") and hasattr(slot["inst"], "on_stop"):
            try:
                slot["inst"].on_stop(self._ctx(self.active_symbol, self.active_timeframe))
            except Exception:
                pass
        del self.book[name]
        try:
            self.loader.loaded.pop(name, None)
        except Exception:
            pass
        file_missing = False
        try:
            (self.loader.dir / f"{name}.py").unlink(missing_ok=True)
        except Exception as exc:
            log.exception("could not delete strategy file %s.py", name)
            file_missing = str(exc)
        self._sync_book_meta()
        self._persist_runtime()
        await self.bus.publish("strategy", self.strategy_meta)
        out = {"ok": True, "strategy": self.strategy_meta, "name": name}
        if file_missing:
            out["warning"] = file_missing
        return out

    def _robot_volume(self, payload: dict[str, Any]) -> Any:
        """Volume for a robot entry: manual mode pins every robot trade to the
        user's fixed lot (any symbol); auto keeps the strategy's own volume."""
        if str(getattr(self, "volume_mode", "auto")) == "manual":
            try:
                vol = float(getattr(self, "manual_volume", 0) or 0)
            except Exception:
                vol = 0.0
            if vol > 0:
                return vol
        return payload.get("volume")

    async def _dispatch_signal(self, signal, source: str) -> None:
        if not signal:
            return
        payload = signal.to_dict() if hasattr(signal, "to_dict") else dict(signal)
        payload["source"] = source
        if payload.get("action") in {None, "", "hold"}:
            return
        action = str(payload.get("action") or "")
        if action in {"buy", "sell", "market"}:
            gate = self.license.allow_bot_entry()
            if not gate.get("ok"):
                await self.journal("warning", "license", f"License blocked robot entry: {gate.get('error')}")
                return
            payload["volume"] = self._robot_volume(payload)
        if action in {"buy", "sell", "market"} and self.require_ai_agree:
            ai = self.ai.last or {}
            if ai.get("ready"):
                if float(ai.get("confidence") or 0) < self.min_ai_confidence:
                    await self.journal(
                        "warning",
                        "ai_low",
                        f"AI confidence {float(ai.get('confidence') or 0):.2f} < {self.min_ai_confidence:.2f} — entry skipped",
                    )
                    return
                want = "bull" if action == "buy" else "bear"
                if action == "market":
                    want = "bull" if str(payload.get("side") or "buy") == "buy" else "bear"
                if ai.get("direction") not in {want, "neutral"} and ai.get("direction") != want:
                    await self.journal(
                        "warning",
                        "ai_disagree",
                        f"AI {ai.get('direction')} disagrees with {action} — skipped",
                    )
                    return
        if action in {"buy", "sell", "market"} and not payload.get("comment"):
            tag = self._strategy_tag_for_request({**payload, "source": source})
            payload["comment"] = (f"AURION {tag}" if tag else "AURION")[:31]
            if tag:
                payload["strategy"] = tag
        payload["source"] = source
        self.last_signal = {**payload, "source": source, "ts": utc_iso()}
        self.store.record_signal(self.last_signal)
        await self.bus.publish("signal", self.last_signal)
        if action not in {"buy", "sell", "market"}:
            await self.journal(
                "info", "fire", f"{source} firing {action} {payload.get('symbol') or ''} vol={payload.get('volume') or 0}"
            )
            await self.execute(payload)
            return
        # --- entry path: judge it, size it, then decide how many tickets ----
        symbol = self._resolve_symbol(payload)
        payload["symbol"] = symbol
        side = str(payload.get("side") or (action if action in {"buy", "sell"} else "buy"))
        verdict = self.signal_quality(symbol, side, float(payload.get("confidence") or 0))
        quality = float(verdict.get("score") or 0)
        payload["quality"] = round(quality, 3)
        # Keep the last judgement where the desk can read it. A score the
        # trader cannot see is a number they have to take on trust, and the
        # setting that acts on it stays abstract until they watch it work.
        self.last_quality = {
            "score": round(quality, 3),
            "passed": quality >= float(getattr(self, "min_signal_quality", 0.55) or 0),
            "symbol": symbol,
            "side": side,
            "reasons": list(verdict.get("reasons") or []),
            "bias": verdict.get("bias") or "neutral",
            "at": utc_iso(),
        }
        if getattr(self, "smart_filters", True):
            if quality < float(getattr(self, "min_signal_quality", 0.55) or 0):
                await self.journal(
                    "warning",
                    "low_quality",
                    f"Skipped {side} {symbol}: quality {quality:.2f} < {float(getattr(self, 'min_signal_quality', 0.55)):.2f} "
                    f"({'; '.join(verdict.get('reasons') or []) or 'no supporting read'})",
                    {"quality": verdict},
                )
                return
            ok_spread, why = self._spread_ok(symbol)
            if not ok_spread:
                await self.journal("warning", "spread", f"Skipped {side} {symbol}: {why}")
                return
        count = self._entries_for_signal(symbol, quality)
        if count <= 0:
            await self.journal(
                "info",
                "slots_full",
                f"{symbol} already holds {self._open_count(symbol)} of max {self._total_cap()} robot trades — no new entry",
            )
            return
        base_volume = float(payload.get("volume") or 0)
        if base_volume > 0 and getattr(self, "smart_filters", True) and str(getattr(self, "volume_mode", "auto")) != "manual":
            # Weak-but-valid setups trade smaller; never larger than the preset.
            factor = 0.6 + 0.4 * max(0.0, min(1.0, (quality - 0.5) / 0.4))
            payload["volume"] = round(max(0.01, base_volume * factor), 2)
        await self.journal(
            "info",
            "fire",
            f"{source} firing {side} {symbol} x{count} vol={payload.get('volume') or 0} "
            f"quality={quality:.2f} ({'; '.join(verdict.get('reasons') or [])})",
            {"quality": verdict, "tickets": count},
        )
        for i in range(count):
            if i:
                # Let MT5 report the new position before sizing the next one,
                # so the ceiling is counted against a fresh book.
                await asyncio.sleep(0.6)
                if self.free_slots(symbol) <= 0:
                    break
            result = await self.execute(dict(payload))
            if not (result or {}).get("ok"):
                break

    def _resolve_symbol(self, request: dict[str, Any]) -> str:
        symbol = str(request.get("symbol") or "").strip()
        if symbol:
            return symbol
        if self.active_symbol:
            return self.active_symbol
        for agent in self.bridge.active_agents():
            if agent.symbol:
                return agent.symbol
        ticks = self.bridge.public_ticks()
        if ticks:
            return next(iter(ticks))
        return ""

    async def execute(self, request: dict[str, Any]) -> dict[str, Any]:
        request = dict(request or {})
        source = str(request.get("source") or "desk")
        if self.kill_switch and str(request.get("action") or "") not in {"close", "flatten", "close_all"}:
            await self.journal("warning", "kill", "Order blocked — kill switch is armed")
            return {"ok": False, "error": "kill switch armed"}
        action = str(request.get("action") or "market").lower()
        if action not in {"close", "flatten", "close_all", "modify"}:
            sess = self.market_state()
            if not sess.get("trading_allowed"):
                why = market_block_reason(sess) or "market closed"
                await self.journal(
                    "warning",
                    "market_closed",
                    f"Order blocked — {why} (reopens {sess.get('next_open') or 'Monday'})",
                    {"session": sess},
                )
                return {"ok": False, "error": sess.get("reason") or "market_closed", "market": sess}
        if action in {"buy", "sell"}:
            request = {**request, "side": action, "action": "market"}
        if action == "close_all":
            return await self.flatten(request.get("reason") or "desk")
        if action == "close":
            ticket = int(request.get("ticket") or 0)
            pos = next((p for p in self.bridge.positions if p.ticket == ticket), None) if ticket else None
            if pos is None:
                symbol = request.get("symbol") or self.active_symbol
                pos = next((p for p in self.bridge.positions if p.symbol == symbol), None)
            if not pos:
                await self.journal("warning", "no_pos", "Close requested but no matching position")
                return {"ok": False, "error": "no position to close"}
            request = {
                **request,
                "ticket": pos.ticket,
                "action": "close",
                "symbol": pos.symbol,
                "volume": float(request.get("volume") or pos.volume),
                "side": "sell" if pos.type == "buy" else "buy",
                "profit": float(getattr(pos, "profit", 0) or 0),
            }
        if str(request.get("action") or "") == "market":
            robotish = source.startswith("strategy") or source in {"robot", "strategy_tick"}
            if robotish:
                # The desk may always trade by hand; the robot obeys the
                # "open between 1 and N trades" ceiling on every single entry.
                symbol_now = self._resolve_symbol(request)
                if self.free_slots(symbol_now) <= 0:
                    await self.journal(
                        "warning",
                        "max_open_trades",
                        f"Robot entry blocked — {self._open_count()} open, ceiling is {self._total_cap()}",
                    )
                    return {"ok": False, "error": f"max open trades reached ({self._total_cap()})"}
                lic = self.license.allow_bot_entry()
                if not lic.get("ok"):
                    until = lic.get("limit_until") or ""
                    await self.journal(
                        "warning",
                        "license",
                        f"Freemium auto-trade limit reached — robot paused until {until}".rstrip(" —"),
                    )
                    out = {"ok": False, "error": lic.get("error") or "license", "license": lic.get("license")}
                    if until:
                        out["limit_until"] = until
                        out["window_hours"] = lic.get("window_hours")
                    return out
        if str(request.get("action") or "") == "market":
            request["symbol"] = self._resolve_symbol(request)
            if not request["symbol"]:
                await self.journal("error", "no_symbol", "Order has no symbol — pick a market or attach AurionBridge")
                return {"ok": False, "error": "symbol is required — pick a live chart or type the broker symbol"}
            try:
                volume = float(request.get("volume") or 0)
            except (TypeError, ValueError):
                volume = 0.0
            if volume <= 0:
                await self.journal("error", "no_volume", "Order has no volume")
                return {"ok": False, "error": "volume must be greater than 0"}
            request["volume"] = volume
            if not request.get("comment"):
                tag = self._strategy_tag_for_request(request)
                request["comment"] = (f"AURION {tag}" if tag else "AURION")[:31]
                if tag:
                    request["strategy"] = tag
            for key in ("sl", "tp"):
                try:
                    val = float(request.get(key) or 0)
                except (TypeError, ValueError):
                    val = 0.0
                if val:
                    request[key] = val
                else:
                    request.pop(key, None)
        if str(request.get("action") or "") == "market" and not self.news_trading_on():
            blocked, why = self.prop._news_blackout(str(request.get("symbol") or ""), force=True)
            if blocked:
                await self.journal("warning", "news", f"News window blocked the order: {why}")
                return {"ok": False, "error": why}
        gate = self.prop.allow_order(request, self.bridge.account.to_dict(), [p.to_dict() for p in self.bridge.positions])
        if not gate.get("ok"):
            why = gate.get("error") or "blocked"
            self.store.log_event("warning", why, "logs.rule_block", request)
            await self.journal("warning", "prop_block", f"Prop blocked the order: {why}")
            return gate
        if not (self.bridge.connected or self.bridge.active_agents() or self.bridge.native.connected or self.bridge._ea_clients):
            await self.journal("error", "mt5_down", "MT5 is not reachable — AURION will not fabricate a fill")
            return {"ok": False, "error": "MetaTrader 5 is not reachable. AURION will not fabricate a fill."}
        await self.journal(
            "info",
            "send",
            f"Sending {request.get('side') or request.get('action')} {request.get('symbol')} "
            f"vol={request.get('volume')} via {'native' if self.bridge.native.connected else 'EA'}",
        )
        result = await self.bridge.send_order(request)
        action_now = str(request.get("action") or "")
        if result.get("ok") and action_now in {"market", "buy", "sell"}:
            self.prop.note_entry()
            self._remember_open(request, result)
            if source.startswith("strategy") or source in {"robot", "strategy_tick"}:
                try:
                    self.license.note_bot_fill()
                    # Let the desk re-paint the freemium auto-trade allowance live.
                    await self.bus.publish("license", self.license.public())
                except Exception:
                    log.exception("license note failed")
        if result.get("ok"):
            tag = parse_strategy_tag(str(request.get("comment") or ""))
            if action_now == "close":
                # Close recording is now handled by _sync_position_book which gets accurate profit/SL/TP from MT5 deals/positions
                # Just publish immediate refresh, the ledger will be updated on next positions event (0.4s)
                self._sync_book_meta()
                await self.bus.publish("strategy", self.strategy_meta)
                # Trigger a quick history publish (will be updated again when position sync records close)
                await self.bus.publish("history", {"items": self.store.history(80)})
            elif action_now in {"market", "buy", "sell"}:
                # Always record entry trade immediately so history shows execution even before position sync
                # Price from result if available, otherwise from request; SL/TP from request (MT5 will echo them in position)
                try:
                    price_val = result.get("price") or request.get("price") or 0
                except Exception:
                    price_val = request.get("price") or 0
                self.store.record_trade(
                    {
                        "time": utc_iso(),
                        "ticket": result.get("deal") or result.get("order") or request.get("ticket") or 0,
                        "symbol": request.get("symbol"),
                        "side": request.get("side") or request.get("action"),
                        "volume": request.get("volume"),
                        "price": price_val,
                        "sl": request.get("sl"),
                        "tp": request.get("tp"),
                        "profit": 0,
                        "swap": 0,
                        "commission": 0,
                        "comment": request.get("comment"),
                        "strategy": tag or self._strategy_tag_for_request(request),
                        "kind": "entry",
                        "entry": "in",
                    }
                )
        detail = result.get("detail") or result.get("error") or result
        self.store.log_event(
            "info" if result.get("ok") else "error",
            str(detail),
            "logs.order_sent" if result.get("ok") else "logs.order_fail",
            result,
        )
        await self.journal(
            "info" if result.get("ok") else "error",
            "fill" if result.get("ok") else "reject",
            f"{'Filled' if result.get('ok') else 'Rejected'}: {detail}",
            extra=result if isinstance(result, dict) else {},
        )
        await self.bus.publish("order_result", result)
        return result

    async def flatten(self, reason: str) -> dict[str, Any]:
        results = []
        for pos in list(self.bridge.positions):
            known = self._known_pos.get(int(pos.ticket or 0)) or {}
            tag = known.get("strategy") or parse_strategy_tag(str(getattr(pos, "comment", "") or known.get("comment") or ""))
            comment = f"AURION {tag}" if tag else f"AURION flatten {reason}"
            results.append(
                await self.bridge.send_order(
                    {
                        "action": "close",
                        "ticket": pos.ticket,
                        "symbol": pos.symbol,
                        "volume": pos.volume,
                        "side": "sell" if pos.type == "buy" else "buy",
                        "comment": comment[:31],
                        "strategy": tag,
                        "emergency": True,
                    }
                )
            )
        await self.bus.publish("log", {"level": "warning", "message": f"flatten: {reason}"})
        return {"ok": all(r.get("ok") for r in results) if results else True, "results": results, "reason": reason}

    # -- market session ----------------------------------------------------
    def _friday_close_hour(self) -> int | None:
        try:
            profile = self.prop.profile or {}
            value = profile.get("friday_close_utc_hour")
            return int(value) if value not in (None, "") else None
        except Exception:
            return None

    def _weekend_allowed(self) -> bool:
        try:
            return bool((self.prop.profile or {}).get("allow_weekend"))
        except Exception:
            return False

    async def _news_refresh_loop(self) -> None:
        """Keep the economic calendar current for as long as the engine runs.

        The feed only carries the current week, so a robot left running over a
        weekend would otherwise keep filtering against last week's releases.
        """
        from .. import news_feed

        while not self._news_stop.is_set():
            try:
                await asyncio.get_running_loop().run_in_executor(None, news_feed.refresh)
                self.prop.reload_news()
            except Exception:
                log.exception("news refresh failed")
            try:
                await asyncio.wait_for(self._news_stop.wait(), timeout=NEWS_REFRESH_SECONDS)
            except asyncio.TimeoutError:
                continue

    def news_state(self) -> dict[str, Any]:
        """Is a high-impact release inside the blackout window right now?

        The desk shows this instead of a generic "market closed" line, because
        "no trade" during a news freeze has a completely different cause.
        """
        try:
            blocked, why = self.prop._news_blackout(self.active_symbol or "", force=True)
        except Exception:
            return {"active": False, "reason": "", "event": ""}
        return {"active": bool(blocked), "reason": str(why or ""), "event": str(why or "")}

    def market_state(self) -> dict[str, Any]:
        sess = market_session(friday_close_hour=self._friday_close_hour())
        sess["allow_weekend"] = self._weekend_allowed()
        # A blocked weekend is only "blocked" when weekend trading is off.
        sess["trading_allowed"] = bool(sess["open"] or sess["allow_weekend"])
        sess["news"] = self.news_state()
        return sess

    async def _note_market_session(self) -> None:
        """Journal the weekend exactly once per state change.

        Without this the desk shows a silent robot on Saturday and the user
        cannot tell a shut market from a broken one.
        """
        sess = self.market_state()
        state = str(sess.get("state") or "")
        if state == getattr(self, "_market_state_seen", ""):
            return
        first = not hasattr(self, "_market_state_seen")
        self._market_state_seen = state
        if first or not state:
            return
        if state == "weekend":
            await self.journal(
                "warning",
                "market_closed",
                "Market closed for the weekend — no trades will be placed until "
                f"{sess.get('next_open') or 'Monday'}",
                {"session": sess},
            )
        else:
            await self.journal("info", "market_open", "Market session open", {"session": sess})

    def snapshot(self) -> dict[str, Any]:
        account = self.bridge.account.to_dict()
        try:
            ver = load().get("version") or "1.0.0"
        except Exception:
            ver = "1.0.0"
        return {
            "engine": "online",
            "version": ver,
            "kill_switch": self.kill_switch,
            "safe_mode": self.safe_mode,
            "active_symbol": self.active_symbol,
            "active_timeframe": self.active_timeframe,
            "strategy": self.strategy_meta,
            "auto_trade": self.auto_trade,
            "trade_style": self.trade_style,
            "ai": {**(self.ai.last or {}), "activity": list(getattr(self.ai, "activity", []) or [])[-40:]},
            "ai_by_symbol": self._ai_by_symbol(),
            "prop": self.prop.metrics(account),
            "mt5": self.bridge.snapshot_status,
            "positions": [self._annotate_pos(p.to_dict()) for p in self.bridge.positions],
            "orders": [o.to_dict() for o in self.bridge.orders],
            "ticks": {k: v.to_dict() for k, v in self.bridge.public_ticks().items()},
            "agents": [a.to_dict() for a in self.bridge.public_agents()],
            "last_signal": self.last_signal,
            "gate": self.trade_gate(),
            "gates": self.gates_by_symbol(),
            "license": self.license.public(),
            "robot": list(self.robot_log)[-80:],
            "telegram": self.telegram.public() if getattr(self, "telegram", None) else {},
            "tape": self.bridge.tape_mode(),
            "backtest": dict(self.backtest_run or {"running": False, "mode": "idle"}),
            "market": self.market_state(),
            "ts": utc_iso(),
        }

    def _ai_by_symbol(self) -> list[dict[str, Any]]:
        """Per-chart AI states for the desk's multi-chart direction slider.
        Only the charts attached right now (plus the last-inferred symbol as a
        fallback), so detached charts do not linger in the slider."""
        by = dict(getattr(self.ai, "by_symbol", None) or {})
        if not by:
            return []
        try:
            active = {str(a.symbol) for a in (self.bridge.active_agents() or []) if getattr(a, "symbol", "")}
        except Exception:
            active = set()
        last_sym = str((self.ai.last or {}).get("symbol") or "")
        items = [st for sym, st in by.items() if not active or sym in active or sym == last_sym]
        return items[-12:]

    def trade_gate(self) -> dict[str, Any]:
        reasons: list[str] = []
        mt5 = bool(
            self.bridge.connected
            or self.bridge.native.connected
            or self.bridge.active_agents()
            or bool(getattr(self.bridge, "_ea_clients", None))
            or bool(getattr(self.bridge, "_http_live", lambda: False)())
        )
        if not mt5:
            reasons.append("mt5_down")
        if self.kill_switch:
            reasons.append("kill")
        if self.safe_mode:
            reasons.append("safe")
        if self.prop.enabled and self.prop.locked:
            reasons.append("prop_lock")
        if not self.auto_trade:
            reasons.append("auto_off")
        enabled = [k for k, v in self.book.items() if v.get("enabled")]
        if not enabled:
            reasons.append("no_strategy")
        lic = self.license.allow_bot_entry()
        if not lic.get("ok"):
            reasons.append(str(lic.get("error") or "license"))
        if self.free_slots() <= 0:
            reasons.append("slots_full")
        ai = self.ai.last or {}
        ai_low = False
        if self.require_ai_agree and ai.get("ready"):
            if float(ai.get("confidence") or 0) < self.min_ai_confidence:
                ai_low = True
                reasons.append("ai_low")
        robot_ready = not reasons
        if not mt5:
            who = "nobody"
        elif robot_ready:
            who = "robot"
        else:
            who = "manual"
        return {
            "who": who,
            "ready": robot_ready,
            "mt5": mt5,
            "auto_trade": self.auto_trade,
            "strategies": enabled,
            "kill": self.kill_switch,
            "safe": self.safe_mode,
            "prop": bool(self.prop.enabled),
            "prop_locked": bool(self.prop.locked),
            "ai_gate": bool(self.require_ai_agree),
            "ai_low": ai_low,
            "style": self.trade_style,
            "open_trades": self._open_count(),
            "max_open_trades": int(self._total_cap()),
            "reasons": reasons,
            "manual_ok": bool(mt5 and not self.kill_switch and not (self.prop.enabled and self.prop.locked)),
        }

    def gates_by_symbol(self) -> list[dict[str, Any]]:
        """Per-symbol "who trades" cards for the desk's gate slider.

        One entry per live EA chart (plus the active market as a fallback),
        so the desk can show exactly which symbol the robot may fire on.
        """
        pairs: list[tuple[str, str]] = []
        try:
            for agent in self.bridge.active_agents():
                if getattr(agent, "symbol", ""):
                    pairs.append(
                        (
                            str(agent.symbol),
                            str(getattr(agent, "timeframe", "") or self.active_timeframe),
                        )
                    )
        except Exception:
            pairs = []
        if not pairs and self.active_symbol:
            pairs.append((self.active_symbol, self.active_timeframe))
        try:
            base = self.trade_gate()
        except Exception:
            log.exception("trade gate failed")
            return []
        out: list[dict[str, Any]] = []
        seen: set[str] = set()
        for symbol, timeframe in pairs:
            if not symbol or symbol in seen:
                continue
            seen.add(symbol)
            try:
                out.append(self.gate_for_symbol(symbol, timeframe, base))
            except Exception:
                log.exception("per-symbol gate failed for %s", symbol)
        return out

    def gate_for_symbol(
        self, symbol: str, timeframe: str = "", base: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        """Overlay the global trade gate with checks that differ per symbol.

        AI confidence is judged on that symbol's own read, the prop
        allow-list / per-symbol cap and the news blackout apply per symbol —
        everything else (kill switch, auto-trade, strategy, licence) is shared.
        """
        base = dict(base or self.trade_gate())
        symbol = str(symbol or "")
        reasons = [r for r in (base.get("reasons") or []) if r != "ai_low"]
        # This symbol's own AI read (falls back to the global read when it is
        # about this symbol).
        ai_low = False
        if self.require_ai_agree:
            ai: dict[str, Any] = {}
            try:
                by = dict(getattr(self.ai, "by_symbol", None) or {})
                ai = by.get(symbol) or {}
                if not ai:
                    last = self.ai.last or {}
                    if str(last.get("symbol") or "") == symbol:
                        ai = last
            except Exception:
                ai = {}
            if ai.get("ready") and float(ai.get("confidence") or 0) < self.min_ai_confidence:
                ai_low = True
                reasons.append("ai_low")
        # Prop allow-list and per-symbol cap (robot entries).
        if getattr(self.prop, "enabled", False):
            allowed = str((self.prop.profile or {}).get("allowed_symbols") or "").strip()
            if allowed:
                names = {s.strip().upper() for s in allowed.replace(";", ",").split(",") if s.strip()}
                if symbol.upper() not in names:
                    reasons.append("symbol_blocked")
            try:
                per = int((self.prop.profile or {}).get("max_positions_per_symbol") or 1)
            except (TypeError, ValueError):
                per = 1
            try:
                n_same = sum(1 for p in self.bridge.positions if getattr(p, "symbol", "") == symbol)
            except Exception:
                n_same = 0
            if n_same >= per:
                reasons.append("symbol_max")
        # News blackout blocks entries (robot and manual) while news trading is off.
        try:
            news_off = not self.news_trading_on()
        except Exception:
            news_off = False
        if news_off and symbol:
            try:
                blocked, _ = self.prop._news_blackout(symbol, force=True)
            except Exception:
                blocked = False
            if blocked:
                reasons.append("news_block")
        reasons = list(dict.fromkeys(reasons))
        mt5 = bool(base.get("mt5"))
        robot_ready = not reasons
        if not mt5:
            who = "nobody"
        elif robot_ready:
            who = "robot"
        else:
            who = "manual"
        try:
            n_open = sum(1 for p in self.bridge.positions if getattr(p, "symbol", "") == symbol)
        except Exception:
            n_open = 0
        return {
            **base,
            "symbol": symbol,
            "timeframe": str(timeframe or ""),
            "who": who,
            "ready": robot_ready,
            "ai_low": ai_low,
            "reasons": reasons,
            "positions": n_open,
            "manual_ok": bool(base.get("manual_ok"))
            and "symbol_blocked" not in reasons
            and "news_block" not in reasons,
        }

    async def factory_reset(self) -> dict[str, Any]:
        factory = ROOT / "config" / "aurion.factory.json"
        if not factory.exists():
            return {"ok": False, "error": "factory template missing"}
        try:
            from ..config import drop_backup

            drop_backup()
            raw = factory.read_text(encoding="utf-8")
            data = __import__("json").loads(raw)
            save(data)
            load(force=True)
        except Exception as exc:
            return {"ok": False, "error": f"could not restore factory config: {exc}"}
        models = ROOT / "engine" / "models"
        if models.exists():
            for child in models.iterdir():
                try:
                    if child.is_dir():
                        shutil.rmtree(child, ignore_errors=True)
                    else:
                        child.unlink()
                except Exception:
                    pass
        try:
            self.store.recreate()
        except Exception:
            log.exception("store recreate failed")
        self.kill_switch = False
        self.safe_mode = False
        self.auto_trade = False
        self.require_ai_agree = True
        self.min_ai_confidence = 0.55
        self.trade_style = "normal"
        self.min_open_trades = 1
        self.max_open_trades = 2
        self.smart_filters = True
        self.min_signal_quality = 0.55
        self.last_quality: dict[str, Any] = {}
        self.danger_enabled = False
        self.danger_sensitivity = 50
        self._danger_seen = {}
        self._danger_cooldown = {}
        self._danger_inflight = set()
        self.last_signal = None
        self.active_symbol = ""
        self.active_timeframe = "M15"
        self.robot_log.clear()
        self.backtest_run = {"running": False, "mode": "idle"}
        self._last_bar_time.clear()
        self._known_pos = {}
        self._pending_tag = []
        self._closed_tickets = set()
        self._pos_bootstrapped = False
        try:
            self.prop = PropEngine()
        except Exception:
            log.exception("prop reset failed")
        try:
            self.ai = AIEngine()
        except Exception:
            log.exception("ai reset failed")
        try:
            self._load_runtime_book()
        except Exception:
            log.exception("book reset failed")
        await self.journal("warning", "factory", "Factory reset complete. Login, history, models and settings were wiped.")
        await self.bus.publish("strategy", self.strategy_meta)
        return {"ok": True, "factory": True}

    async def set_market(self, symbol: str, timeframe: str) -> dict[str, Any]:
        symbol = str(symbol or "").strip()
        timeframe = str(timeframe or "M15")
        if not symbol:
            return {"ok": False, "error": "symbol is required"}
        if self.bridge.active_agents() and not self._is_ea_symbol(symbol):
            return {"ok": False, "error": f"no AurionBridge on {symbol}"}
        if not self.bridge.active_agents():
            return {"ok": False, "error": "attach AurionBridge first — AURION will not load a market-watch chart"}
        self.active_symbol = symbol
        self.active_timeframe = timeframe
        bars = await self.bridge.pull_candles(symbol, timeframe, load()["engine"].get("candle_lookback") or 1500)
        if bars:
            try:
                self.ai.infer(bars, symbol, timeframe)
            except Exception:
                log.exception("AI infer failed")
            if not self.ai.models.ready and len(bars) >= int(load()["ai"]["min_bars_to_train"]):
                asyncio.create_task(self._bg_train(bars, symbol, timeframe), name=f"aurion-train-{symbol}")
        return {"ok": True, "symbol": symbol, "timeframe": timeframe, "bars": len(bars), "ai": self.ai.last}

    async def _bg_train(self, bars: list[dict[str, Any]], symbol: str, timeframe: str) -> None:
        try:
            result = await asyncio.to_thread(self.ai.train, bars, symbol, timeframe)
            await self.bus.publish("ai", (result or {}).get("state") or self.ai.last)
        except Exception:
            log.exception("background AI train failed")

    async def apply_strategy(self, spec: dict[str, Any]) -> dict[str, Any]:
        kind = spec.get("kind") or "builtin"
        name = spec.get("name") or spec.get("file")
        params = spec.get("params") or {}
        try:
            if kind == "builtin":
                inst = self.loader.load_builtin(str(name), params)
            else:
                from pathlib import Path

                path = Path(spec.get("path") or (self.loader.dir / str(name)))
                inst = self.loader.load_path(path, params)
        except StrategyValidationError as exc:
            return {"ok": False, "error": str(exc)}
        if self.strategy and hasattr(self.strategy, "on_stop"):
            try:
                self.strategy.on_stop(self._ctx(self.active_symbol, self.active_timeframe))
            except Exception:
                pass
        name = str(name)
        if kind != "builtin":
            from pathlib import Path as _P

            path = _P(spec.get("path") or (self.loader.dir / name))
            name = path.stem or name
            if name.endswith(".py"):
                name = name[:-3]
        prev = self.book.get(name) or {}
        if "enabled" in spec:
            enabled = bool(spec.get("enabled"))
        else:
            enabled = bool(prev.get("enabled"))
        if enabled:
            # Single armed strategy: applying this one disarms the others.
            for other, slot in self.book.items():
                if other != name and slot.get("enabled"):
                    slot["enabled"] = False
        self.book[name] = {
            "inst": inst,
            "enabled": enabled,
            "kind": kind,
            "last_action": prev.get("last_action") or "idle",
            "last_reason": prev.get("last_reason") or "",
            "last_ts": prev.get("last_ts") or "",
        }
        self.strategy = inst
        if enabled and hasattr(inst, "on_start"):
            inst.on_start(self._ctx(self.active_symbol, self.active_timeframe))
        self._sync_book_meta()
        self._persist_runtime()
        await self.bus.publish("strategy", self.strategy_meta)
        return {"ok": True, "strategy": self.strategy_meta}

    def _publish_now(self, kind: str, payload: dict[str, Any]) -> None:
        try:
            loop = asyncio.get_running_loop()
            loop.create_task(self.bus.publish(kind, payload))
        except RuntimeError:
            pass

    def set_kill(self, armed: bool) -> dict[str, Any]:
        self.kill_switch = bool(armed)
        merge({"execution": {"kill_switch_default": self.kill_switch}})
        self._publish_now("status", {"kill_switch": self.kill_switch})
        return {"ok": True, "kill_switch": self.kill_switch}

    def set_safe(self, value: bool) -> dict[str, Any]:
        self.safe_mode = bool(value)
        self._publish_now("status", {"safe_mode": self.safe_mode})
        return {"ok": True, "safe_mode": self.safe_mode}

    def _schedule_live_ai(self, symbol: str) -> None:
        now = time.time()
        if now - float(self._last_ai_tick or 0) < 1.15:
            return
        if self._ai_tick_task and not self._ai_tick_task.done():
            return
        self._last_ai_tick = now
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return
        self._ai_tick_task = loop.create_task(self._infer_live(symbol), name=f"aurion-ai-{symbol}")

    async def _infer_live(self, symbol: str) -> None:
        symbol = str(symbol or self.active_symbol or "")
        if not symbol or not self._is_ea_symbol(symbol):
            return
        timeframe = self.active_timeframe or "M15"
        rows = [c.to_dict() for c in self.bridge.candles_of(symbol, timeframe)]
        if len(rows) < 40:
            return
        try:
            votes = []
            for slot in self.book.values():
                if not slot.get("enabled"):
                    continue
                act = str(slot.get("last_action") or "")
                if act == "buy":
                    votes.append("bull")
                elif act == "sell":
                    votes.append("bear")
            self.ai._strategy_votes = votes
            state = await asyncio.to_thread(self.ai.infer, rows, symbol, timeframe)
            await self.bus.publish("ai", state)
        except Exception:
            log.exception("live AI infer failed")

    async def chart_signals(self, symbol: str, timeframe: str = "M15", count: int = 800, strict: bool = True) -> dict[str, Any]:
        # premium feature
        if not self.license.feature("chart_signals"):
            return {"ok": False, "error": "premium_required", "feature": "chart_signals", "upgrade": True}
        symbol = str(symbol or self.active_symbol or "").strip()
        timeframe = str(timeframe or self.active_timeframe or "M15")
        if not symbol:
            return {"ok": False, "error": "symbol_required"}
        # Need candles
        bars = [c.to_dict() for c in self.bridge.candles_of(symbol, timeframe)]
        if len(bars) < 50:
            try:
                bars = await self.bridge.pull_candles(symbol, timeframe, int(count or 800))
            except Exception:
                bars = bars or []
        if not bars or len(bars) < 30:
            return {"ok": False, "error": "no_candles", "symbol": symbol, "timeframe": timeframe}
        try:
            from ..signals.chart_signals import get_chart_signals
            result = get_chart_signals(bars, strict=bool(strict))
            result["symbol"] = symbol
            result["timeframe"] = timeframe
            return result
        except Exception as exc:
            return {"ok": False, "error": str(exc)}

    async def backtest(self, body: dict[str, Any]) -> dict[str, Any]:
        if bool((self.backtest_run or {}).get("running")):
            return {"ok": False, "error": "backtest_busy", "running": True, **self.backtest_run}
        symbol = str(body.get("symbol") or self.active_symbol or "")
        timeframe = str(body.get("timeframe") or self.active_timeframe or "M15")
        if not symbol or not self._is_ea_symbol(symbol):
            return {"ok": False, "error": "no AurionBridge on that symbol — attach the EA first"}
        bars = [c.to_dict() for c in self.bridge.candles_of(symbol, timeframe)]
        if len(bars) < 90:
            bars = await self.bridge.pull_candles(symbol, timeframe, int(body.get("bars") or 1500))
        if not bars:
            return {"ok": False, "error": "no real MT5 history available for this symbol/timeframe"}
        spec = body.get("strategy") or {"kind": "builtin", "name": "ema_rsi", "params": body.get("params") or {}}
        try:
            inst = self.loader.build(spec)
        except StrategyValidationError as exc:
            return {"ok": False, "error": str(exc)}
        except Exception as exc:
            return {"ok": False, "error": str(exc)}
        started = utc_iso()
        self.backtest_run = {
            "ok": True,
            "running": True,
            "mode": "backtest",
            "symbol": symbol,
            "timeframe": timeframe,
            "strategy": getattr(inst, "name", str(spec.get("name") or "")),
            "bars": len(bars),
            "started": started,
        }
        await self.bus.publish("backtest", dict(self.backtest_run))
        try:
            result = await asyncio.to_thread(
                self.backtester.run,
                inst,
                bars,
                symbol,
                timeframe,
                float(body.get("initial_equity") or self.bridge.account.equity or 10_000),
            )
        except Exception as exc:
            result = {"ok": False, "error": str(exc), "mode": "backtest", "symbol": symbol, "timeframe": timeframe}
        result = dict(result or {})
        result["mode"] = "backtest"
        result["running"] = False
        result["started"] = started
        result["finished"] = utc_iso()
        self.backtest_run = result
        await self.bus.publish("backtest", dict(result))
        return result
