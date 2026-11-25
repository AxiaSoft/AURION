from __future__ import annotations

import asyncio
import json
import shutil
import threading
import time
from collections import deque
from pathlib import Path
from typing import Any

from .auto_entry import confirm_entry, expired_orders, plan_entry
from .deals import aggregate_close_deals, history_row_matches
from ..prop.hours import (broker_offset_minutes, resolve_zone, zone_choices,
                          zone_label, zone_offset_minutes)
from .gates import fire_blockers as gate_blockers
from .risk import (
    DEFAULT_SCOPE,
    MONEY_SCOPES,
    REFERENCE_LOT,
    SymbolSpec,
    auto_risk_cap,
    auto_risk_pct,
    cap_stop,
    money_at_risk,
    normalise_scope,
    risk_budget,
    round_volume,
    volume_for_risk,
)
from .sizing import auto_lot
from .stops import ladder_target, resolve_stop, resolve_stop_r
from ..ai.engine import AIEngine
from ..backtest.engine import Backtester
from ..config import ROOT, load, merge, save
from ..mt5.bridge import MT5Bridge
from ..prop.rules import PropEngine
from ..strategy.base import StrategyContext
from ..strategy.loader import (
    BUILTIN_NAMES,
    LEGACY_BUILTINS,
    StrategyLoader,
    StrategyValidationError,
)
from ..license.guard import Guard
from ..util.clock import utc_iso
from ..util.errors import readable_error
from ..util.history import HISTORY_DAYS, at_least_window, bars_to_cover, requested_window
from ..build_id import BUILD_ID
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

# How often the calendar loop wakes up. It is deliberately SHORTER than
# news_feed.MIN_AGE_SECONDS: most passes find a warm cache, cost a stat()
# and go back to sleep, and the few that do go to the network are spread
# out by the cache age rather than by this number. The two used to be the
# same value, which meant every single pass went to the network - see
# MIN_AGE_SECONDS for what that did to the engine.
NEWS_REFRESH_SECONDS = 5 * 60

# The longest one calendar pass may take before it is abandoned. Nothing in
# the calendar is worth holding a trading engine up for: a release that is
# half an hour stale still blacks out the right minute, a tick that arrives
# ten seconds late is gone.
NEWS_PASS_BUDGET = 30.0

# How many position snapshots in a row a ticket must be missing from before
# AURION will write an exit for it without the broker having confirmed one.
#
# Positions arrive about once a second, so three strikes is roughly three
# seconds of patience - far too short to matter to a trader reading the
# blotter, and long enough to ride out the gap in the feed that was being
# mistaken for a close. The confirmed path (a closing deal in the broker's
# own history) does not wait at all; see Trader._close_is_evidenced.
POSITION_MISSING_STRIKES = 3


#: Bars of run-up handed to a range backtest before the period starts.
#:
#: The Backtester already discards its first `warmup` bars (80) without
#: trading them, so a range that begins exactly at the chosen date would
#: lose its first eighty bars to warming up - on a one-day M15 run that
#: is the whole day. Feeding the bars BEFORE the period lets the
#: indicators arrive primed and the period itself be traded in full.
#:
#: 400 rather than 80 because a strategy may read further back than the
#: replay does; it is capped by whatever history actually exists, and
#: costs only a little time.
RANGE_WARMUP_BARS = 400

#: The name the robot trades under when no strategy is enabled.
#:
#: The same name the backtest's {"kind": "robot"} runs under, on
#: purpose: a trader measures "robot" in a replay and then sees
#: "robot" on the live ticket, and the two are the same code.
SOLO_ROBOT_NAME = "robot"

#: Wall-clock ceiling for one chart-mark pass.
#:
#: The marks are an armed strategy's own output replayed bar by bar,
#: and smart_money costs about 11 ms a bar. Now that the marked region
#: is one day rather than the whole series, a pass is small - this is
#: a ceiling against a pathological strategy, not a work allowance to
#: be spent.
CHART_MARK_BUDGET_SECONDS = 8.0

#: How much of the chart carries signal marks: the last day of it.
#:
#: It used to be the whole series, reached a slab at a time: 1200 bars
#: on the first pass and 1500 more on every refresh, for ever, until
#: six months were covered. That was asked for - "the signals are only
#: drawn at the right edge" - and it is what made the engine
#: unusable once the expert was attached to real charts. The work
#: never finished. Every refresh of every chart had more history to
#: chew through, four charts did it at once, and the machine never got
#: back to idle.
#:
#: It was also not worth it. A mark on a bar from three months ago is
#: not a trading decision; the trader is reading the right-hand edge.
#: So the marked region is now a fixed, finite, recent window - the
#: last day on every timeframe - which is 1440 bars of M1 and 6 bars
#: of H4, and once it is covered the work STOPS.
MARK_DAYS = 1

#: How much further back one refresh may reach when it is filling in
#: the rest of the chart. The first pass covers MARK_DAYS so the
#: newest bars - today's - carry their marks immediately; after that
#: each call walks this many bars further back until the window the
#: desk asked for is covered, and then stops.
#:
#: This is what makes "the whole chart eventually, the engine never
#: blocked" possible at once. The old planner had no second half: it
#: walked 1500 bars per refresh with no destination, so it never
#: reached a finished state and the engine never returned to idle.
#: The destination here is the window the desk asked for, which is
#: itself bounded by what the trader is looking at.
MARK_EXTEND_BARS = 2000

#: How many charts' worth of analysis to remember at once.
CHART_MARK_CACHES = 8


def _as_float(value: Any) -> float:
    """A number, or 0.0 — never an exception.

    Strategies are user code and a price on one of them can be a
    string, a Decimal, None, or a numpy scalar that stops being JSON
    the moment it reaches the socket. A forming mark is a courtesy
    drawn thirty times a minute; it must never be the thing that takes
    the watch pass down.
    """
    try:
        out = float(value)
    except (TypeError, ValueError):
        return 0.0
    return out if out == out and out not in (float("inf"), float("-inf")) else 0.0


def _slice_bars(
    bars: list[dict[str, Any]],
    start: Any,
    end: Any,
) -> dict[str, Any]:
    """The bars inside [start, end], plus run-up before them.

    `start` and `end` are YYYY-MM-DD, or anything ISO that begins with
    one; `end` is INCLUSIVE, because a trader who picks the 5th means
    the whole of the 5th. Either may be empty, which means "no bound on
    that side", so the calendar can ask for a month, a week or a day
    with one shape of request.

    Returns the bars to replay, the period actually covered, and an
    error when the request is answerable but empty - a week with no
    bars in it is a real answer and must not be reported as a crash or,
    worse, silently widened to the whole history.
    """
    def day_of(bar: dict[str, Any]) -> str:
        value = str((bar or {}).get("time") or (bar or {}).get("t") or "")
        return value[:10]

    lo = str(start or "").strip()[:10]
    hi = str(end or "").strip()[:10]
    if not lo and not hi:
        return {"bars": bars, "from": day_of(bars[0]) if bars else "", "to": day_of(bars[-1]) if bars else ""}

    inside: list[int] = []
    for i, bar in enumerate(bars):
        day = day_of(bar)
        if not day:
            continue
        if lo and day < lo:
            continue
        if hi and day > hi:
            continue
        inside.append(i)

    if not inside:
        # Said plainly, because the two causes need different actions:
        # a period before the history begins needs a different period,
        # and a closed week needs none.
        return {"bars": [], "from": lo, "to": hi,
                "code": "no_bars_in_period",
                "error": "no bars in that period"}

    first, last = inside[0], inside[-1]
    begin = max(0, first - RANGE_WARMUP_BARS)
    return {
        "bars": bars[begin: last + 1],
        "from": day_of(bars[first]),
        "to": day_of(bars[last]),
        # How many of the bars handed over are run-up rather than the
        # period itself. The result reports it so "tested bars" cannot
        # be read as "bars in the month you picked".
        "warmup": first - begin,
    }



class Trader:
    def __init__(self) -> None:
        self.bus = Bus()
        self.store = Store()
        self.bridge = MT5Bridge()
        # Downloaded bars belong to this installation, not to the life of
        # this process. The bridge keeps them in memory; this is where it
        # puts them on disk and where it reads them back from, so the
        # first chart after a restart is drawn out of AURION's own files
        # instead of being downloaded from the broker all over again.
        self.bridge.use_candle_archive(
            save=lambda sym, tf, rows: self.store.save_candles(sym, tf, rows),
            load=lambda sym, tf, count: self.store.candles(sym, tf, count),
        )
        self.ai = AIEngine()
        self.prop = PropEngine()
        self.loader = StrategyLoader()
        self.backtester = Backtester()
        self.strategy = None
        self.strategy_meta: dict[str, Any] = {}
        self.book: dict[str, dict[str, Any]] = {}
        self.auto_trade = False
        self.require_ai_agree = True
        # Reachable on purpose. The AI's confidence is shrunk towards "no
        # information" in proportion to the edge it has measured out of
        # sample, so with three classes and no edge yet it cannot report
        # more than 0.53 - and the old default of 0.55 was therefore an
        # off switch that read like a market opinion. See
        # LiveModels.confidence_ceiling().
        self.min_ai_confidence = 0.35
        # Robot position sizing: "auto" = each strategy's preset volume,
        # "manual" = the user's fixed lot for every robot entry.
        self.volume_mode = "auto"
        self.manual_volume = 0.10
        # The robot with no strategy underneath it.
        #
        # Asked for directly: "when every strategy is off, the robot
        # should enter on its own." Until now a book with nothing
        # enabled was a dead desk - the closed-bar handler wrote "no
        # strategy enabled" and returned - which made disabling the
        # last strategy an off switch for the whole product rather
        # than a choice about which method to trade.
        #
        # It is the SAME decision-maker the backtest already offers as
        # {"kind": "robot"}: the model's own read of the bar, with the
        # live confidence floor as its only setting. So a trader can
        # measure it before trusting it, and what they measured is
        # what runs.
        #
        # It never competes with a strategy. The moment one strategy
        # is enabled, that strategy is the opinion and this stands
        # down - otherwise two unrelated methods would be sending
        # orders on the same symbol.
        self.solo_robot = True
        self._solo_slot: dict[str, Any] | None = None
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
        # Why the last ticket was sized to nothing, in the words the trader needs.
        self.last_money_block: dict[str, Any] = {}
        self.news_trade = False
        # Auto entry point: the robot names a price and waits there with the
        # stop and target already attached, instead of buying the market the
        # instant a candle closes.
        self.auto_entry = False
        self.auto_entry_depth = 0.5
        self.auto_entry_offset = 0.35
        self.auto_entry_expiry = 120
        self.auto_entry_confirm = "normal"
        self._auto_entry_sweep = 0.0
        self._auto_entry_tickets: set[int] = set()
        # Entries on the wire, per symbol. Held from just before the send
        # until MetaTrader reports the position (or the send fails), so a
        # second signal arriving in the gap cannot reuse the same slot.
        self._entry_inflight: dict[str, int] = {}
        # Danger guard: tick-level protective exit. Hard-disabled while prop
        # rules are on — a challenge account only exits through the prop book.
        self.danger_enabled = False
        # Risk free, as a desk setting rather than a strategy parameter.
        #
        # It was reachable only through strategy params, which means a
        # trader who opens a position by hand - or runs the desk with no
        # strategy loaded - got nothing. Protecting a trade is not a
        # property of a strategy; it is a property of the account.
        # Chosen once, in System settings, and used by everything that
        # has to know what time it is for this trader - prop windows
        # first among them. "broker" is worked out from MetaTrader's own
        # clock rather than asked for.
        self.desk_timezone = "broker"
        self.risk_free_enabled = False
        # The last time a real signal was refused on its way to the broker,
        # and by what. Published, because this is the question the desk
        # could never answer.
        self.last_block: dict[str, Any] = {}
        # How often the cards are re-asked between bar closes. Two seconds
        # looks live to a person and costs a few milliseconds of one
        # thread; the strategies are pure functions of the candles.
        self._watch_at = 0.0
        # Money management, stated the one way that means the same thing on
        # every instrument: what a stop is allowed to cost per 1.00 lot.
        self.max_loss_per_lot = 10.0
        # Automatic money management. "fixed" is the number the trader
        # typed; "auto" is a share of the live account, recomputed for
        # every ticket. See _cap().
        self.money_mode = "fixed"
        self.money_risk_pct = 1.0
        self._auto_cap_last = 0.0
        self._auto_cap_said = False
        # What that number counts: one trade, or one 0.01 lot. See
        # MONEY_SCOPES in runtime/risk.py.
        self.money_scope = DEFAULT_SCOPE
        self._spec_gap_said: set[str] = set()
        self._cap_note: dict[int, float] = {}
        self.risk_free_trigger_pct = 0.30
        self.risk_free_lock_pct = 0.0
        # Laddered protection. One break-even move stops a winner turning
        # into a loser but does nothing about a winner giving its profit
        # back; these walk the stop up a rung at a time behind price.
        self.risk_free_ladder = True
        self.risk_free_steps = 3
        # Which rule last moved each position's stop, so "this trade is
        # now risk free" is journalled once rather than on every tick.
        self._stop_note: dict[int, str] = {}
        # The stop a position was opened with, per ticket. Break-even
        # rewrites pos.sl, so after the first move the broker can no
        # longer tell us what the original risk was - and R is measured
        # from the original risk or it is measured from nothing.
        self._entry_risk: dict[int, float] = {}
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
        self._analysis_stop = asyncio.Event()
        self._analysis_task: asyncio.Task | None = None
        self.robot_log: deque[dict[str, Any]] = deque(maxlen=600)
        self._known_pos: dict[int, dict[str, Any]] = {}
        #: ticket -> how many consecutive position snapshots it has been
        #: missing from. See _sync_position_book: one gap in the feed is
        #: not a close, and treating it as one wrote phantom exits.
        self._pos_missing: dict[int, int] = {}
        self._pending_tag: list[dict[str, Any]] = []
        self._closed_tickets: set[int] = set()
        self._pos_bootstrapped = False
        self.telegram = None
        self.license = Guard()
        self.backtest_run: dict[str, Any] = {"running": False, "mode": "idle"}
        # Raised when the trader calls a running replay off. The replay
        # itself runs in a worker thread (see _run_backtest), so this is
        # a threading.Event and not an asyncio one: cancelling the task
        # cannot interrupt a thread, but a flag the bar loop reads can.
        self._backtest_cancel = threading.Event()
        # Chart marks already worked out, per symbol/timeframe/armed set.
        # Analysis is expensive enough that it is done in slabs across
        # refreshes; this is what carries the finished slabs between them.
        self._chart_marks: dict[str, dict[str, Any]] = {}
        self._last_ai_tick = 0.0
        # Event faults already reported, so a broken path says so once
        # instead of several times a second.
        self._event_faults: set[str] = set()
        # The background task that adopts the EA's chart as the desk's
        # market. One at a time, and never on the ingest path.
        self._adopt_task: asyncio.Task | None = None
        # Said once: the AI filter has been set above what the AI can
        # report, so it is refusing everything by arithmetic.
        self._ai_ceiling_said = False
        # The replay runs off the request path; this is the handle to it.
        self._backtest_task: asyncio.Task | None = None
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
        self._analysis_stop = asyncio.Event()
        self._analysis_task = asyncio.create_task(
            self._analysis_loop(), name="aurion-analysis"
        )
        log.info("AURION engine started")
        await self.journal("info", "boot", "Engine online. Robot is idle until a strategy is enabled and auto-trade is armed.")

    async def stop(self) -> None:
        self._analysis_stop.set()
        if getattr(self, "_analysis_task", None):
            self._analysis_task.cancel()
            try:
                await self._analysis_task
            except (asyncio.CancelledError, Exception):
                pass
            self._analysis_task = None
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

    def _note_broker_clock(self, payload: dict[str, Any]) -> None:
        """Learn the broker's timezone from the tick that already says it.

        MetaTrader stamps every tick with its server's own time. The
        difference between that and the clock here is the broker's
        offset, so nobody has to know their broker runs on EET, or
        notice when it shifts for summer time, for the prop window to
        line up with the session they actually watch.
        """
        if str(getattr(self, "desk_timezone", "UTC")).lower() != "broker":
            return
        minutes = broker_offset_minutes(str(payload.get("time") or ""))
        if minutes is None or minutes == self.prop.broker_minutes:
            return
        self.prop.broker_minutes = minutes
        log.info("broker clock is UTC%+d:%02d", minutes // 60, abs(minutes) % 60)

    async def _on_bridge(self, kind: str, payload: dict[str, Any]) -> None:
        """Route one event from MetaTrader, and never die quietly.

        The bridge catches whatever a handler raises and writes it to the
        engine log file. Nobody reads an engine log file; the trader reads
        the desk, where a robot that has stopped processing ticks looks
        exactly like a quiet market. Faults are journalled instead - once
        per kind, because a broken tick path would otherwise repeat itself
        several times a second.
        """
        try:
            await self._route_bridge(kind, payload)
        except Exception as exc:
            log.exception("bridge event %s failed", kind)
            key = f"{kind}:{type(exc).__name__}"
            if key in self._event_faults:
                return
            self._event_faults.add(key)
            await self.journal(
                "error",
                "event_fault",
                f"A '{kind}' update from MetaTrader could not be processed — "
                f"{type(exc).__name__}: {exc}. This is a fault in AURION, not in the market.",
            )

    async def _route_bridge(self, kind: str, payload: dict[str, Any]) -> None:
        if kind == "tick":
            self._note_broker_clock(payload)
            sym = str(payload.get("symbol") or "")
            await self.bus.publish("tick", payload)
            if not self.active_symbol and self._is_ea_symbol(sym):
                self.active_symbol = sym
            await self._enforce_stop_cap(payload)
            await self._maybe_trail(payload)
            await self._maybe_danger_guard(payload)
            if self._is_ea_symbol(sym):
                await self._watch_strategies(payload)
                await self._maybe_strategy_tick(payload)
                self._schedule_live_ai(sym)
            # Last, so it reports the state the handlers above just left
            # behind rather than the one they started from.
            await self._push_analysis()
            return
        if kind == "candle":
            self.store.upsert_candle(payload)
            await self.bus.publish("candle", payload)
            if self._is_closed_bar(payload):
                await self._on_closed_candle(payload)
            return
        if kind == "candles":
            # One transaction for the block, not one per bar. The expert
            # hands its history over in thousands, and upsert_candle()
            # commits every row: three thousand bars were three thousand
            # flushes to disk, which is the stall a trader reads as
            # "still downloading candles" long after the download ended.
            self.store.save_candles(
                payload.get("symbol") or "", payload.get("timeframe") or "",
                payload.get("bars") or [],
            )
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
        if kind == "hist_progress":
            # Straight through: how far a history download has got is a
            # fact about the bridge, not something the trader applies
            # any rule to. The desk is the only consumer.
            await self.bus.publish("hist_progress", payload if isinstance(payload, dict) else {})
            return
        if kind in {"status", "ea_log", "ea_signal", "order_result", "log"}:
            await self.bus.publish(kind, payload if isinstance(payload, dict) else {"data": payload})

    async def _announce_prop_check(self, request: dict[str, Any], gate: dict[str, Any]) -> None:
        """Say out loud what the prop rules did with this order - either way.

        Asked for directly: "tell me when prop stops a trade, and tell me
        when it lets one through". Until now only the refusal left a
        trace, and it left it in the robot log - a page nobody has open
        while they are watching a chart. So a trader who had armed a
        profile could not tell the difference between "the rules are
        quietly doing their job" and "the rules are eating my trades",
        which is exactly the complaint.

        One event per gated entry, carrying the verdict and, when it is
        a refusal, the sentence that names the rule. Closes, modifies
        and anything the gate waved through untouched because prop is
        off are not news and are not announced.
        """
        if not getattr(self.prop, "enabled", False):
            return
        action = str(request.get("action") or "").lower()
        if action not in {"market", "buy", "sell", "pending"}:
            return
        if gate.get("bypassed"):
            return
        ok = bool(gate.get("ok"))
        profile = self.prop.profile or {}
        payload = {
            "ok": ok,
            "why": "" if ok else str(gate.get("error") or "blocked"),
            "symbol": str(request.get("symbol") or ""),
            "side": str(request.get("side") or action or ""),
            "volume": float(request.get("volume") or 0),
            "profile": str(profile.get("id") or ""),
            "source": str(request.get("source") or ""),
            # Which count limits are live right now. Empty on every
            # firm-shaped profile, and that emptiness is the answer to
            # "is prop the reason I am taking fewer trades?".
            "throttles": list(self.prop.throttle_names()) if hasattr(self.prop, "throttle_names") else [],
            "ts": utc_iso(),
        }
        if ok:
            await self.journal(
                "info",
                "prop_pass",
                f"Prop checked {payload['side']} {payload['symbol']} "
                f"{payload['volume']:g} against the {payload['profile'] or 'prop'} profile and allowed it",
                {"prop_check": payload},
            )
        try:
            await self.bus.publish("prop_check", payload)
        except Exception:
            log.exception("prop check publish failed")

    async def _handle_prop_trip(self, decision: dict[str, Any]) -> None:
        action = decision.get("action") or ""
        self.safe_mode = True
        await self.bus.publish("prop", decision)
        self.store.log_event("warning", str(decision.get("code")), "status.prop_block", decision)
        if "flatten" in action:
            await self.flatten(f"prop:{decision.get('code')}")

    def _ai_for(self, symbol: str) -> dict[str, Any]:
        """The AI's reading of *this* chart, never of some other one.

        ``AIEngine.last`` is whichever chart was analysed most recently.
        On a one-symbol desk that is the right answer by accident; the
        moment a second symbol is watched it stops being the right
        answer and nobody notices, because the reading still looks
        perfectly sensible - it is just about a different instrument.

        The damage was real and ran both ways. A strategy was handed
        another chart's direction, confidence and regime in its context,
        so ``with_trend`` and the AI-agreement rule inside it were judged
        against the wrong market; and the account's AI veto refused an
        entry with "the AI reads bear against this buy" when the bear
        read belonged to a symbol the signal had never mentioned. That
        is how a strong setup gets turned down for no reason the trader
        can see on the chart in front of them.

        ``by_symbol`` has carried ``ready``, ``direction`` and
        ``confidence`` per chart all along, and ``signal_quality`` was
        already reading it that way. This is the same lookup, in one
        place, for everyone: the chart's own entry, and ``last`` only
        when it is about this chart or about no chart at all.
        """
        name = str(symbol or "").strip()
        try:
            view = dict((self.ai.by_symbol.get(name) or {})) if name else {}
            if view:
                return view
            last = dict(self.ai.last or {})
            if not name:
                return last
            last_sym = str(last.get("symbol") or "")
            return last if (last_sym == name or not last_sym) else {}
        except Exception:
            return {}

    def _ctx(self, symbol: str, timeframe: str, tick: dict[str, Any] | None = None) -> StrategyContext:
        candles = [c.to_dict() for c in self.bridge.candles_of(symbol, timeframe)]
        if not candles and self._is_ea_symbol(symbol):
            candles = self.store.candles(symbol, timeframe, at_least_window(timeframe))
        return StrategyContext(
            symbol=symbol,
            timeframe=timeframe,
            candles=candles,
            tick=tick,
            account=self.bridge.account.to_dict(),
            positions=[p.to_dict() for p in self.bridge.positions],
            orders=[o.to_dict() for o in self.bridge.orders],
            ai=self._ai_for(symbol),
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
        fixed += self._audit_closed_rows(rows)
        return fixed

    def _audit_closed_rows(self, deal_rows: list[dict[str, Any]]) -> int:
        """Re-check rows that were already believed to agree with MT5.

        Being right when written is not the same as being right. MT5 posts
        swap at rollover, and some brokers book commission as its own deal
        minutes after the close - both land on a position whose history row
        was finished and never looked at again. Nothing marks those rows as
        estimates, so the estimate sweep above will never revisit them and
        the desk drifts away from the terminal one overnight charge at a
        time.

        Only rows whose position still appears in the deal window are
        checked; outside it there is nothing to compare against and silence
        is the correct answer, not a warning.
        """
        try:
            stored = self.store.closed_rows_for_audit(60)
        except Exception:
            return 0
        repaired = 0
        for row in stored:
            try:
                ticket = int(row.get("ticket") or 0)
            except (TypeError, ValueError):
                continue
            if not ticket:
                continue
            totals = aggregate_close_deals(deal_rows, ticket)
            if not totals:
                continue
            drift = history_row_matches(row, totals)
            if not drift:
                continue
            if self.store.apply_reconciliation(int(row["id"]), totals):
                repaired += 1
                log.info(
                    "history row %s for ticket %s drifted from MT5 on %s - corrected",
                    row.get("id"), ticket, ", ".join(drift),
                )
        return repaired

    def _close_is_evidenced(self, ticket: int) -> bool:
        """Has the broker actually told us this position closed?

        A closing deal carrying the position's id is the broker's own word
        for it, and it is the only thing that lets _sync_position_book call
        a close immediately. Everything else has to wait for the ticket to
        stay missing, because a feed with a hole in it looks identical to a
        position that has gone.
        """
        try:
            rows = [
                d.to_dict() if hasattr(d, "to_dict") else d
                for d in list(self.bridge.deals or [])[-400:]
                if hasattr(d, "to_dict") or isinstance(d, dict)
            ]
            return aggregate_close_deals(rows, int(ticket)) is not None
        except Exception:
            return False

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
        # Which of the positions we were holding are not in this snapshot?
        #
        # Absence used to be proof of a close, and it is not. Reported, and
        # ugly: AURION kept writing an exit for a trade that was still open
        # at the broker - "it records the stop before the stop is touched,
        # then the target before the target is touched, over and over until
        # I hit the kill switch". Nothing was wrong with the stop logic. The
        # positions feed had a gap in it. One snapshot arrives short or
        # empty - the expert's post was refused, the engine was mid-stall,
        # the terminal answered while it was still assembling the list - and
        # every ticket in it looked closed, so an exit was written, and the
        # next snapshot brought the position back, so an entry was written,
        # and round it went.
        #
        # A close is now something we have to be shown, not something we
        # infer from silence. Either the broker's own deal history carries a
        # closing deal for the ticket, or the ticket has been missing from
        # several consecutive snapshots in a row. One gap proves nothing.
        # The constructor sets this. The guard is for the Traders that are
        # built field by field rather than through __init__ - the suite is
        # full of them, because a real Trader opens a database, loads a
        # licence and starts four loops - and for any state restored from
        # before this counter existed. A book that can sync is a book that
        # can count strikes; demanding the caller remember a second field
        # would just move the crash.
        if getattr(self, "_pos_missing", None) is None:
            self._pos_missing = {}
        missing = [t for t in list(self._known_pos) if t not in current]
        for ticket in list(self._pos_missing):
            if ticket not in missing:
                self._pos_missing.pop(ticket, None)
        closed = []
        for ticket in missing:
            if self._close_is_evidenced(ticket):
                self._pos_missing.pop(ticket, None)
                closed.append(ticket)
                continue
            seen = self._pos_missing.get(ticket, 0) + 1
            self._pos_missing[ticket] = seen
            if seen >= POSITION_MISSING_STRIKES:
                self._pos_missing.pop(ticket, None)
                closed.append(ticket)
            else:
                log.debug(
                    "position %s absent from the feed (%s/%s) - not calling it closed yet",
                    ticket, seen, POSITION_MISSING_STRIKES,
                )
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
            deal_totals: dict[str, Any] | None = None
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
                    deal_totals = totals
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
                        deal_totals = totals
                        deal_profit = totals["profit"]
                        deal_swap = totals["swap"]
                        deal_comm = totals["commission"]
                        deal_price = totals["price"]
                        deal_net = totals["net"]
                        deal_parts = totals["parts"]
                except Exception:
                    pass
            mt5_view = deal_totals or {}
            close_trade = {
                # MetaTrader's close time, not the moment the desk noticed
                # the position had gone. They differ by a second normally
                # and by minutes after a reconnect, and a history sorted on
                # the wrong one does not line up with the terminal's.
                "time": mt5_view.get("close_time") or utc_iso(),
                "ticket": ticket,
                "symbol": old.get("symbol"),
                "side": old.get("type") or old.get("side"),
                # The closed volume from the deals: a partial close moves
                # less than the position was carrying.
                "volume": mt5_view.get("volume") or old.get("volume"),
                "price": deal_price or old.get("price_current") or old.get("price_open"),
                # Carried so a row can be matched against MetaTrader's
                # History tab, which lists a position by its open side too.
                "price_open": mt5_view.get("open_price") or old.get("price_open"),
                "time_open": mt5_view.get("open_time") or old.get("time"),
                "order": mt5_view.get("order"),
                "deals": mt5_view.get("deals") or [],
                "sl": old.get("sl"),
                "tp": old.get("tp"),
                "profit": deal_profit if deal_profit is not None else (old.get("profit") or 0),
                "swap": deal_swap if deal_swap is not None else (old.get("swap") or 0),
                "commission": deal_comm if deal_comm is not None else 0,
                # Brokers that bill on the way in put the whole commission on
                # the entry deal; shown separately so "why is net below
                # Profit" is answerable from the desk.
                "entry_commission": mt5_view.get("entry_commission") or 0,
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
        if getattr(self, "_pos_bootstrapped", False) and opened:
            # A resting order that finally filled is the moment the robot
            # actually entered, so that is when it is counted - not when the
            # order was placed. A freemium allowance spent on an order the
            # market never came back to would be a bill for a trade that
            # never happened.
            for item in opened:
                try:
                    if int(item.get("ticket") or 0) not in self._auto_entry_tickets:
                        continue
                    self._auto_entry_tickets.discard(int(item.get("ticket") or 0))
                    self.prop.note_entry()
                    self.license.note_bot_fill()
                    await self.bus.publish("license", self.license.public())
                    await self.journal(
                        "info",
                        "auto_entry_filled",
                        f"Resting order filled: {item.get('type') or ''} {item.get('symbol') or ''} "
                        f"at {item.get('price_open') or item.get('price_current') or '—'}",
                    )
                except Exception:
                    log.exception("auto-entry fill accounting failed")
        try:
            await self.sweep_pending()
        except Exception:
            log.exception("pending sweep failed")
        tg = getattr(self, "telegram", None)
        if getattr(self, "_pos_bootstrapped", False):
            # One event per real entry and exit, published where the
            # runtime already works out that a position appeared or
            # disappeared - and behind the same bootstrap flag, so
            # reconnecting to a desk with eight open trades does not
            # announce eight entries that happened yesterday.
            #
            # The desk decides what to do with these: an entry and an
            # exit are worth a sound and a Windows toast, a change of
            # status is not. That judgement belongs on this side of the
            # bus, so "a trade happened" is a different kind of message
            # from "something changed", rather than both being a log line
            # the desk has to pattern-match.
            for item in opened:
                await self._announce_trade("entry", item)
            for old in closed_rows:
                await self._announce_trade("exit", old)
            if tg:
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

    async def _announce_trade(self, kind: str, row: dict[str, Any]) -> None:
        """Say that a trade opened or closed, and how it went.

        An exit is split into profit and loss here rather than on the
        desk, because the engine is the only side that knows the real
        figure - the desk sees a position vanish and would have to guess.
        """
        try:
            row = dict(row or {})
            profit = float(row.get("profit") or 0)
            result = "flat"
            if kind == "exit":
                result = "profit" if profit > 0 else "loss" if profit < 0 else "flat"
            await self.bus.publish("trade", {
                "kind": kind,
                "result": result,
                "ticket": row.get("ticket"),
                "symbol": row.get("symbol") or "",
                "side": str(row.get("type") or row.get("side") or "").lower(),
                "volume": float(row.get("volume") or 0),
                "price": float(row.get("price_open") or row.get("price") or 0),
                "close_price": float(row.get("price_current") or row.get("close") or 0),
                "profit": profit,
                "strategy": row.get("strategy") or "",
                # The account's currency when the row does not carry one,
                # so the desk never shows a bare number for an amount.
                "currency": row.get("currency") or getattr(self.bridge.account, "currency", "") or "",
                "ts": utc_iso(),
            })
        except Exception:
            # A notification is never worth losing the position update for.
            log.exception("trade announcement failed")

    def _is_ea_symbol(self, symbol: str) -> bool:
        want = str(symbol or "").strip()
        if not want:
            return False
        return any(self.bridge._sym_match(want, a.symbol) for a in self.bridge.active_agents())

    async def _adopt_ea_market(self) -> None:
        """Take the chart the EA just reported as the desk's market.

        Scheduled, never awaited here, and that is the whole point.

        This runs while the bridge is handling the EA's own hello. Taking
        the market loads its history, and over the HTTP transport the only
        way to get history is to ask the EA for it and wait - but the EA
        is a single thread inside MetaTrader that cannot send anything
        until the POST it is currently blocked on comes back. So the wait
        could only ever end one way: eight seconds of deadlock, a
        timeout warning on the desk, a hello answered eight seconds late,
        and the chart left with no bars until the next poll. Every attach,
        every re-attach, every terminal restart.

        Handing it to a task lets the hello return at once. The EA reads
        the request_history command that is already riding on that
        response, sends the bars on its very next cycle, and the wait ends
        in well under a second with real data in it.
        """
        agents = self.bridge.active_agents()
        if not agents:
            if self.active_symbol:
                self.active_symbol = ""
            return
        if self._is_ea_symbol(self.active_symbol):
            return
        task = getattr(self, "_adopt_task", None)
        if task is not None and not task.done():
            return
        agent = agents[0]
        symbol = str(agent.symbol or "")
        timeframe = str(agent.timeframe or "M15")
        if not symbol:
            return
        self._adopt_task = asyncio.create_task(
            self._adopt_market(symbol, timeframe), name=f"aurion-adopt-{symbol}"
        )

    async def _adopt_market(self, symbol: str, timeframe: str) -> None:
        try:
            result = await self.set_market(symbol, timeframe)
        except Exception as exc:
            log.exception("adopting %s %s failed", symbol, timeframe)
            await self.journal(
                "error", "adopt_fault",
                f"Could not load {symbol} {timeframe} after the EA attached — {type(exc).__name__}: {exc}",
            )
            return
        if not (result or {}).get("ok"):
            await self.journal(
                "warning", "adopt",
                f"{symbol} {timeframe} was not adopted: {(result or {}).get('error') or 'unknown'}",
            )

    async def _on_closed_candle(self, candle: dict[str, Any]) -> None:
        symbol = candle.get("symbol") or self.active_symbol
        timeframe = candle.get("timeframe") or self.active_timeframe
        if not self._is_ea_symbol(str(symbol or "")):
            return
        rows = [c.to_dict() for c in self.bridge.candles_of(symbol, timeframe)]
        if not rows and self._is_ea_symbol(str(symbol or "")):
            rows = self.store.candles(symbol, timeframe, at_least_window(timeframe))
        if not rows:
            return
        state: dict[str, Any] | None = None
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
            # An AI fault must not stop the strategies.
            #
            # This used to `return`, which meant one exception out of the
            # model silently switched the entire robot off: no strategy
            # was evaluated, no signal was produced, and nothing in the
            # log said the book had been skipped - only that the AI had
            # failed. The product says everywhere that the AI is a filter
            # and never a source of signals, and the default for
            # execution.flatten_on_ai_fault is false for the same reason.
            #
            # The strategies still run. If require_ai_agree is on, the
            # gate in _dispatch_signal then refuses the entry for want of
            # an opinion - which is the correct, conservative outcome and
            # is journalled with a reason.
            log.exception("AI on_closed_bar failed")
            await self.journal(
                "error",
                "ai_fault",
                f"AI failed on {symbol} {timeframe}: {exc} — strategies still evaluated",
            )

        if state:
            if state.get("retrain_due"):
                asyncio.create_task(self._bg_train(rows, symbol, timeframe), name=f"aurion-train-{symbol}")
            self.store.record_signal({**state, "source": "ai"})
            await self.bus.publish("ai", state)
            # A closed bar is the one moment the analysis is guaranteed to
            # have moved, so it goes out now rather than on the next tick.
            await self._push_analysis(force=True)
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
        blocked = self.fire_blockers()
        may_fire = not blocked
        try:
            await self._run_enabled_strategies(ctx, execute=may_fire, blocked=blocked)
        except Exception as exc:
            log.exception("strategy book failed")
            await self.journal("error", "book_fault", f"Strategy book crashed: {exc}")

    # ------------------------------------------------------------------
    # Money management — what a stop is allowed to cost
    # ------------------------------------------------------------------
    def symbol_spec(self, symbol: str) -> SymbolSpec:
        """The broker's contract spec for a symbol, as a SymbolSpec."""
        try:
            info = self.bridge.symbol_spec(str(symbol or ""))
        except Exception:
            log.exception("symbol spec lookup failed for %s", symbol)
            info = {}
        return SymbolSpec.from_info(info, str(symbol or ""))

    AUTO_RISK_MIN_PCT = 0.05
    AUTO_RISK_MAX_PCT = 10.0

    def _equity_now(self) -> float:
        """Live equity, falling back to balance. 0 when the account is unknown."""
        try:
            account = self.bridge.account.to_dict() or {}
        except Exception:
            return 0.0
        for key in ("equity", "balance"):
            try:
                value = float(account.get(key) or 0)
            except (TypeError, ValueError):
                continue
            if value > 0:
                return value
        return 0.0

    def _auto_risk_pct(self) -> float:
        """The share of the account one trade may lose, after every ceiling.

        The arithmetic itself is risk.auto_risk_pct, not a copy of it
        here: the desk previews this same number while the trader is
        typing, so there has to be exactly one implementation for the
        shared cases in tests/fixtures/auto-risk-cap.json to pin.
        """
        return auto_risk_pct(
            getattr(self, "money_risk_pct", 1.0),
            self.AUTO_RISK_MIN_PCT,
            self.AUTO_RISK_MAX_PCT,
            self._prop_risk_ceiling(),
        )

    def _prop_risk_ceiling(self) -> float:
        """The prop profile's max risk per trade, or 0 when none is armed.

        Published to the desk as well as used here - a preview cannot be
        correct unless it knows about the ceiling that will be applied to
        what is being typed.
        """
        if not getattr(self.prop, "enabled", False):
            return 0.0
        try:
            return max(0.0, float((self.prop.profile or {}).get("max_risk_per_trade_pct") or 0))
        except (TypeError, ValueError):
            return 0.0

    def _cap(self) -> float:
        """The most one trade may lose, in account currency.

        This is the single number the whole money rule is built on -
        sizing, stop capping and the chart replay all read it - so
        "automatic" is implemented here and nowhere else. In automatic
        mode the cap is a share of live equity, recomputed for every
        ticket: an account that doubles risks twice as much, an account
        in drawdown risks less, and nobody edits a field. A fixed
        currency amount typed once is the one money setting guaranteed
        to be wrong later.

        It fails CLOSED. If the account has not reported equity yet,
        the last cap that WAS computed is used rather than zero -
        because zero here does not mean "no risk", it means "no rule",
        and dropping the stop cap the moment the terminal reconnects is
        the worst possible reading of missing data.
        """
        if str(getattr(self, "money_mode", "fixed")) == "auto":
            equity = self._equity_now()
            if equity > 0:
                _, cap = auto_risk_cap(
                    equity,
                    getattr(self, "money_risk_pct", 1.0),
                    self.AUTO_RISK_MIN_PCT,
                    self.AUTO_RISK_MAX_PCT,
                    self._prop_risk_ceiling(),
                )
                if cap > 0:
                    self._auto_cap_last = cap
                    return cap
            held = float(getattr(self, "_auto_cap_last", 0.0) or 0.0)
            if held > 0:
                return held
            # Nothing to size against and nothing remembered: fall back
            # to the stored fixed cap rather than to no rule at all.
            try:
                return max(0.0, float(getattr(self, "max_loss_per_lot", 0.0) or 0.0))
            except (TypeError, ValueError):
                return 0.0
        try:
            return max(0.0, float(getattr(self, "max_loss_per_lot", 0.0) or 0.0))
        except (TypeError, ValueError):
            return 0.0

    def _scope(self) -> str:
        """Whether the cap is read per trade or per 0.01 lot.

        Automatic mode is always per trade. A percentage of the account
        that then multiplies by the lot size is not a percentage of the
        account, and the point of the mode is that "what can this cost
        me?" has an answer without arithmetic.
        """
        if str(getattr(self, "money_mode", "fixed")) == "auto":
            return "trade"
        return normalise_scope(getattr(self, "money_scope", DEFAULT_SCOPE))

    def _cap_words(self) -> str:
        """The cap and its unit, for anything a human reads."""
        cap = self._cap()
        if str(getattr(self, "money_mode", "fixed")) == "auto":
            equity = self._equity_now()
            where = f" of {equity:.2f} equity" if equity > 0 else " (equity not reported yet)"
            return f"{cap:.2f} per trade — {self._auto_risk_pct():.2f}%{where}"
        return (f"{cap:.2f} per trade" if self._scope() == "trade"
                else f"{cap:.2f} per {REFERENCE_LOT:g} lot")

    async def _no_spec(self, symbol: str) -> None:
        """Say once per symbol that money cannot be priced here.

        Not silently skipped: a cap the trader believes is protecting
        them, and is not, is worse than no cap. It is also not a refusal
        to trade — the stop the strategy chose is still a stop.
        """
        key = str(symbol or "")
        if key in self._spec_gap_said:
            return
        self._spec_gap_said.add(key)
        await self.journal(
            "warning",
            "no_spec",
            f"{key}: the broker has not reported a tick value, so the "
            f"stop cap of {self._cap_words()} cannot be applied here. "
            "Attach AurionBridge to this symbol's chart, or connect the terminal.",
        )

    async def _apply_money_rules(self, request: dict[str, Any], price: float = 0.0) -> dict[str, Any]:
        """Hold every outgoing ticket to the per-lot loss cap.

        Three things happen here, in this order, and all three are the
        same rule seen from different sides:

          * a ticket with no stop gets one, at exactly the cap;
          * a stop further away than the cap is pulled in to it;
          * the lot size is reduced until the stop's cost fits the
            account's risk budget.

        The stop is only ever moved *closer* to the entry. Nothing here
        widens risk, and nothing here invents a price: with no contract
        spec the request goes out untouched and the journal says so.
        """
        self.last_money_block = {}
        cap = self._cap()
        if cap <= 0:
            return request
        action = str(request.get("action") or "").lower()
        if action not in {"market", "pending", "limit", "stop", "buy", "sell"}:
            return request
        symbol = str(request.get("symbol") or "")
        side = str(request.get("side") or request.get("action") or "").lower()
        if side not in {"buy", "sell"} or not symbol:
            return request

        spec = self.symbol_spec(symbol)
        if not spec.usable:
            await self._no_spec(symbol)
            return request

        entry = float(price or request.get("price") or 0.0)
        if entry <= 0:
            tick = self.tick_of(symbol)
            if tick:
                entry = float(tick.get("ask" if side == "buy" else "bid") or 0)
        if entry <= 0:
            return request

        scope = self._scope()
        requested_volume = float(request.get("volume") or 0)
        wanted_sl = float(request.get("sl") or 0)

        # Size first, under a per-trade cap.
        #
        # The cap has two levers and they are not equally good. Pulling
        # the stop in keeps the size and moves the exit, which is the
        # one thing the trader actually chose by looking at the chart;
        # it is also how a big ticket ends up with a stop four tenths of
        # a pip away, dying in the spread. Cutting the size keeps the
        # stop exactly where it was drawn and simply buys less of it.
        #
        # So under "trade" the size moves first and the stop is only
        # touched when the broker's minimum lot already risks more than
        # the cap - at which point there is no size left to cut and
        # tightening is the only alternative to refusing the trade.
        #
        # Under "lot" the budget grows with the size, so sizing down
        # never helps and this is skipped entirely.
        if scope == "trade" and wanted_sl > 0 and requested_volume > 0:
            at_risk = money_at_risk(side, entry, wanted_sl, requested_volume, spec)
            if at_risk > cap + 1e-9:
                fitted = volume_for_risk(side, entry, wanted_sl, spec, cap, requested_volume)
                if fitted > 0:
                    await self.journal(
                        "info",
                        "sized_to_cap",
                        f"{symbol} {side}: {requested_volume:.2f} lots with that stop risks "
                        f"{at_risk:.2f}; sent {fitted:.2f} so the trade cannot lose more than "
                        f"{cap:.2f}. The stop was left where you put it.",
                        {"requested": requested_volume, "sent": fitted,
                         "would_risk": round(at_risk, 2), "cap": cap},
                    )
                    request["volume"] = fitted
                    requested_volume = fitted
                    # Sized to land on the cap, so the stop is inside it
                    # by construction. Running the stop rule now would
                    # still nudge it one tick, because the allowed
                    # distance is floored to whole ticks and the stop
                    # that just paid for itself sits exactly on the
                    # boundary. Moving a trader's stop by a tick for a
                    # rounding artefact is noise in the journal and a
                    # different fill, so it is skipped when the ticket
                    # already fits.
                    if money_at_risk(side, entry, wanted_sl, fitted, spec) <= cap + 1e-6:
                        return await self._size_for_budget(request, side, entry, symbol)

        # Whatever size is going out now, the stop still has to fit the
        # cap at that size. Measuring the cap against a notional one lot
        # is what made the stop on a 0.01-lot ticket a hundred times
        # tighter than asked; multiplying it by the lot, which is what
        # the per-lot scope does, is what gave a 0.10-lot ticket a 100
        # stop from a setting that said 10.
        capped = cap_stop(
            side, entry, float(request.get("sl") or 0), spec, cap,
            float(request.get("volume") or 0), scope,
        )
        if capped is None:
            return request
        if capped.capped:
            before = float(request.get("sl") or 0)
            request["sl"] = capped.sl
            await self.journal(
                "info",
                "stop_capped",
                f"{symbol} {side}: stop {('moved to ' + str(capped.sl)) if before else 'set at ' + str(capped.sl)} "
                f"so this ticket risks {capped.money:.2f}, inside the cap of {self._cap_words()} "
                f"({capped.reason})",
                {"before": before, "after": capped.sl, "money": round(capped.money, 2),
                 "scope": scope},
            )

        return await self._size_for_budget(request, side, entry, symbol)

    async def _size_for_budget(self, request: dict[str, Any], side: str,
                               entry: float, symbol: str) -> dict[str, Any]:
        """The account's own risk budget, applied after the stop cap.

        Two ceilings, and the lower one wins: the cap says what a trade
        may lose, prop's percentage says what this account may lose on
        one trade, and neither is allowed to let the other be stepped
        over.
        """
        spec = self.symbol_spec(symbol)
        if not spec.usable:
            return request
        budget = self._risk_budget()
        requested = float(request.get("volume") or 0)
        if budget > 0 and requested > 0:
            sized = volume_for_risk(side, entry, float(request.get("sl") or 0), spec, budget, requested)
            if sized > 0 and sized < requested - 1e-9:
                await self.journal(
                    "info",
                    "sized_down",
                    f"{symbol}: {requested:.2f} lots would risk "
                    f"{money_at_risk(side, entry, float(request.get('sl') or 0), requested, spec):.2f}; "
                    f"sent {sized:.2f} to stay inside the {budget:.2f} budget",
                    {"requested": requested, "sent": sized, "budget": round(budget, 2)},
                )
                request["volume"] = sized
            elif sized <= 0:
                # The budget will not pay for the broker's smallest lot at
                # this stop. There is no size left to cut, so this is the
                # same fork the cap meets one step earlier: tighten the
                # stop until the smallest lot fits, or refuse the trade.
                #
                # The cap tightens. This refused — and that is the fault
                # reported from the desk as "volume after sizing is below
                # the broker's minimum lot" on every manual order, with
                # the robot silently doing nothing for the same reason.
                # The message named the broker's minimum lot, which was
                # not the binding number at all: the binding number is
                # the prop profile's risk-per-trade percentage, and on a
                # small account it lands under the money cap, so nothing
                # can ever be sent. Two ceilings where the lower one is
                # unreachable is not a risk rule, it is an off switch
                # that nobody asked for and nothing explains.
                #
                # So: send the smallest lot the broker will take, with
                # the stop pulled in until it costs no more than the
                # budget. That keeps the trader inside the number they
                # agreed to with the firm, which is the whole point of
                # the budget, and it is exactly what already happens one
                # line above when the cap is the binding ceiling.
                smallest = round_volume(spec.volume_min, spec)
                fitted = None
                if smallest > 0 and requested >= smallest - 1e-9:
                    fitted = cap_stop(side, entry, float(request.get("sl") or 0),
                                      spec, budget, smallest, "trade")
                # A stop inside the current spread is not a stop, it is an
                # instant exit wearing one. Tightening is only a rescue
                # while the result is still a trade, so the spread - the
                # one cost that is visible at this instant - is the floor.
                # No quote means no measurement, and an unmeasured floor
                # does not get to refuse anything.
                if fitted is not None:
                    quote = self.tick_of(symbol)
                    try:
                        spread = float(quote.get("ask") or 0) - float(quote.get("bid") or 0)
                    except (TypeError, ValueError):
                        spread = 0.0
                    if spread > 0 and fitted.distance < spread:
                        fitted = None
                if fitted is not None and fitted.sl > 0:
                    before = float(request.get("sl") or 0)
                    request["volume"] = smallest
                    request["sl"] = fitted.sl
                    self.last_money_block = {}
                    await self.journal(
                        "info",
                        "sized_to_budget",
                        f"{symbol}: {requested:.2f} lots risks more than the "
                        f"{budget:.2f} this account allows on one trade, and "
                        f"{smallest:g} is the smallest the broker takes — sent "
                        f"{smallest:g} with the stop moved to {fitted.sl} so it "
                        f"costs {fitted.money:.2f}.",
                        {"requested": requested, "sent": smallest, "budget": round(budget, 2),
                         "sl_before": before, "sl_after": fitted.sl,
                         "money": round(fitted.money, 2)},
                    )
                else:
                    # Even one tick of stop on the smallest lot costs more
                    # than the budget. Nothing can be sent, and the trader
                    # is owed the two numbers and the way out rather than
                    # a sentence about lot sizes.
                    per_min = money_at_risk(side, entry, float(request.get("sl") or 0),
                                            smallest or spec.volume_min, spec)
                    why = (
                        f"{symbol}: this account allows {budget:.2f} on one trade, but the "
                        f"smallest lot the broker takes ({(smallest or spec.volume_min):g}) "
                        f"risks {per_min:.2f} with this stop, and pulling the stop in far "
                        f"enough would put it inside the spread. Raise the risk-per-trade "
                        f"percentage in Prop, or trade an instrument whose minimum lot fits."
                    )
                    self.last_money_block = {
                        "symbol": symbol, "budget": round(budget, 2),
                        "min_lot": smallest or spec.volume_min,
                        "min_lot_risk": round(per_min, 2), "why": why, "at": utc_iso(),
                    }
                    await self.journal("warning", "too_small", why, dict(self.last_money_block))
                    request["volume"] = 0.0
        return request

    def _risk_budget(self) -> float:
        """What one trade may lose, in account money.

        Prop's own per-trade percentage when prop is on, because that is
        the number the trader agreed to with the firm; otherwise the cap
        itself, read as one lot's worth.
        """
        account = self.bridge.account.to_dict() if getattr(self, "bridge", None) else {}
        equity = 0.0
        for key in ("equity", "balance"):
            try:
                equity = float(account.get(key) or 0)
            except (TypeError, ValueError):
                equity = 0.0
            if equity > 0:
                break
        prop = getattr(self, "prop", None)
        if prop is not None and getattr(prop, "enabled", False) and equity > 0:
            try:
                pct = float((prop.profile or {}).get("max_risk_per_trade_pct") or 0)
            except Exception:
                pct = 0.0
            if pct > 0:
                return equity * pct / 100.0
        return 0.0

    async def _enforce_stop_cap(self, tick: dict[str, Any]) -> None:
        """The same rule, applied to positions that are already open.

        A ticket can acquire too much risk after it was sent: the stop
        is edited in the terminal, the cap is lowered on this page, or
        the position was opened by hand with no stop at all. The rule is
        a standing one, so it is enforced on every tick and not only at
        the moment of entry — and, as everywhere else, it only ever
        moves a stop closer to the entry.
        """
        cap = self._cap()
        if cap <= 0:
            return
        symbol = str(tick.get("symbol") or "")
        bridge = getattr(self, "bridge", None)
        if not symbol or bridge is None:
            return
        spec = self.symbol_spec(symbol)
        if not spec.usable:
            return
        for pos in list(bridge.positions):
            if pos.symbol != symbol:
                continue
            side = str(pos.type or "").lower()
            entry = float(pos.price_open or 0)
            if side not in {"buy", "sell"} or entry <= 0:
                continue
            capped = cap_stop(side, entry, float(pos.sl or 0), spec, cap,
                              float(getattr(pos, "volume", 0) or 0), self._scope())
            if capped is None or not capped.capped:
                continue
            if abs(self._cap_note.get(pos.ticket, 0.0) - capped.sl) < spec.tick_size / 2:
                continue        # already asked for this one
            self._cap_note[pos.ticket] = capped.sl
            await self.journal(
                "warning",
                "stop_capped_live",
                f"{symbol} #{pos.ticket} risked more than {self._cap_words()} — stop pulled to {capped.sl}",
                {"ticket": pos.ticket, "sl": capped.sl, "money": round(capped.money, 2),
                 "scope": self._scope()},
            )
            await bridge.send_order({
                "action": "modify",
                "ticket": pos.ticket,
                "symbol": symbol,
                "sl": capped.sl,
                "tp": pos.tp,
            })

    def _remember_risk(self, pos: Any) -> float:
        """The stop this position was opened with, in price.

        Recorded the first time the ticket is seen and never updated,
        because every later reading of pos.sl may be a stop this very
        method moved. Tickets that have gone are dropped so a long
        session does not accumulate them.
        """
        ticket = getattr(pos, "ticket", None)
        if ticket is None:
            return 0.0
        known = self._entry_risk.get(ticket)
        if known is not None:
            return known
        entry = float(getattr(pos, "price_open", 0) or 0)
        sl = float(getattr(pos, "sl", 0) or 0)
        risk = abs(entry - sl) if (entry > 0 and sl > 0) else 0.0
        self._entry_risk[ticket] = risk
        if len(self._entry_risk) > 512:
            live = {getattr(p, "ticket", None) for p in getattr(self.bridge, "positions", [])}
            for gone in [t for t in self._entry_risk if t not in live]:
                self._entry_risk.pop(gone, None)
        return risk

    async def _maybe_trail(self, tick: dict[str, Any]) -> None:
        """Move protective stops forward, never back.

        Two rules, resolved together because a position has one stop:

          breakeven_points        profit that arms the risk-free move
          breakeven_lock_points   how far past entry the stop then sits
          trailing_points         distance the stop follows price at

        The arithmetic is in runtime/stops.py, deliberately free of
        MetaTrader and testable on its own. This method is only the part
        that has to touch a broker: pick the closing price for each side,
        ask what the stop should be, and send at most one modify.

        Closing price, not the convenient one. A long is closed at the
        bid and a short at the ask, so measuring a long's profit against
        the ask - as the old trailing code effectively did by comparing
        against whichever came in the tick - says a position is in profit
        by a spread more than it is. On the break-even rule that is the
        difference between a stop that cannot lose and one that loses
        exactly the spread, every time.
        """
        params = (self.strategy.params if self.strategy else {}) or {}
        trailing = float(params.get("trailing_points") or 0)
        be_trigger = float(params.get("breakeven_points") or 0)
        be_lock = float(params.get("breakeven_lock_points") or 0)

        # The account setting, for every position rather than only the
        # ones a loaded strategy happens to own. A strategy that names
        # its own points still wins: it knows the instrument it was
        # written for, and this does not.
        use_pct = bool(self.risk_free_enabled) and be_trigger <= 0

        # R-based management, the default. The backtest applies exactly
        # these rules through the same arithmetic, so what the report
        # promises is what the robot does. An explicit points setting on
        # the strategy, or the account's risk-free percentage, still
        # overrides it - both are someone saying what they want.
        be_at_r = float(params.get("be_at_r", 0.8) or 0)
        be_lock_r = float(params.get("be_lock_r", 0.1) or 0)
        trail_at_r = float(params.get("trail_at_r", 0.0) or 0)
        trail_r = float(params.get("trail_r", 0.0) or 0)
        use_r = be_trigger <= 0 and not use_pct and (be_at_r > 0 or trail_r > 0)

        ladder_on = bool(getattr(self, "risk_free_ladder", False))
        if trailing <= 0 and be_trigger <= 0 and not use_pct and not use_r and not ladder_on:
            return

        symbol = tick.get("symbol")
        bid, ask = float(tick.get("bid") or 0), float(tick.get("ask") or 0)
        if not symbol or not (bid or ask):
            return
        spread = max(0.0, ask - bid) if (bid and ask) else 0.0

        bridge = getattr(self, "bridge", None)
        if bridge is None:
            return

        for pos in list(bridge.positions):
            if pos.symbol != symbol:
                continue

            side = str(pos.type or "").lower()
            close_px = bid if side == "buy" else ask
            if not close_px:
                continue

            entry = float(pos.price_open or 0)
            trigger, lock = be_trigger, be_lock
            if use_pct and entry > 0:
                # A percentage is the same number on every instrument,
                # which is the only kind of number one box in the desk
                # can sensibly ask for. 150 points is a fair trigger on
                # EURUSD and meaningless on gold.
                trigger = entry * self.risk_free_trigger_pct / 100.0
                lock = entry * self.risk_free_lock_pct / 100.0

            # A tenth of a spread is not worth a round trip, and without
            # a floor a fast instrument sends a modify on every tick and
            # spends its time queueing behind itself.
            min_step = spread * 0.5

            # The ladder comes first when it is armed and the position has
            # a target to measure rungs against. It protects strictly more
            # than a single break-even move, and resolve_stop below would
            # only ever pull the stop back towards entry.
            ladder = None
            if getattr(self, "risk_free_ladder", False) and entry > 0:
                ladder = ladder_target(
                    side,
                    entry,
                    float(pos.tp or 0),
                    close_px,
                    steps=int(getattr(self, "risk_free_steps", 3) or 3),
                    lock_points=lock,
                    spread=spread,
                )
            if ladder is not None:
                target, rung = ladder
                current = float(pos.sl or 0)
                # Forward only. A rung already locked is never given up,
                # and a stop that would not move by a meaningful amount
                # is not worth a round trip to the broker.
                better = (
                    current <= 0
                    or (side == "buy" and target > current + min_step)
                    or (side == "sell" and target < current - min_step)
                )
                if not better:
                    continue
                note = f"ladder{rung}"
                if self._stop_note.get(pos.ticket) != note:
                    self._stop_note[pos.ticket] = note
                    await self.journal(
                        "info",
                        "risk_free",
                        f"{symbol} #{pos.ticket} reached TP{rung} — stop moved up to "
                        f"{'break-even' if rung == 1 else f'TP{rung - 1}'} to protect the profit",
                    )
                await bridge.send_order({
                    "action": "modify",
                    "ticket": pos.ticket,
                    "symbol": symbol,
                    "sl": target,
                    "tp": pos.tp,
                })
                continue

            if use_r:
                initial = self._remember_risk(pos)
                if initial <= 0:
                    continue
                plan = resolve_stop_r(
                    side,
                    entry,
                    initial,
                    close_px,
                    float(pos.sl or 0),
                    be_at_r=be_at_r,
                    be_lock_r=be_lock_r,
                    trail_at_r=trail_at_r,
                    trail_r=trail_r,
                    spread=spread,
                    min_step=min_step,
                )
            else:
                plan = resolve_stop(
                    side,
                    entry,
                    close_px,
                    float(pos.sl or 0),
                    breakeven_points=trigger,
                    breakeven_lock_points=lock,
                    trailing_points=trailing,
                    spread=spread,
                    min_step=min_step,
                )
            if plan is None:
                continue

            # Said once per position, not once per tick. The journal is
            # read by people.
            if self._stop_note.get(pos.ticket) != plan.reason:
                self._stop_note[pos.ticket] = plan.reason
                if plan.reason == "breakeven":
                    await self.journal(
                        "info",
                        "risk_free",
                        f"{symbol} #{pos.ticket} is now risk free - stop moved past entry",
                    )

            await bridge.send_order({
                "action": "modify",
                "ticket": pos.ticket,
                "symbol": symbol,
                "sl": plan.sl,
                "tp": pos.tp,
            })

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

    @staticmethod
    def _clamp_pct(value: Any, fallback: float) -> float:
        """A percentage of the entry price, kept inside the believable."""
        try:
            pct = float(value)
        except (TypeError, ValueError):
            return fallback
        if pct != pct:        # NaN
            return fallback
        return max(0.0, min(50.0, pct))

    def _risk_free_state(self) -> dict[str, Any]:
        """Read defensively, like every other panel in the snapshot.

        _sync_book_meta builds the whole strategies view in one dict. A
        single attribute this method cannot read raises out of all of it,
        so the desk loses the strategy cards, the quality score, the money
        rule and the block reason together - and the trader sees an empty
        panel rather than the one thing that is actually missing.
        """
        def num(name: str, fallback: float) -> float:
            try:
                return float(getattr(self, name, fallback))
            except (TypeError, ValueError):
                return fallback

        steps = int(num("risk_free_steps", 3)) or 3
        return {
            "enabled": bool(getattr(self, "risk_free_enabled", False)),
            "trigger_pct": round(num("risk_free_trigger_pct", 0.30), 4),
            "lock_pct": round(num("risk_free_lock_pct", 0.0), 4),
            "ladder": bool(getattr(self, "risk_free_ladder", True)),
            "steps": steps,
            # Spelled out for the desk so the panel can say "at TP1, the
            # stop moves to break-even" instead of printing a bare 0.20.
            "rungs": [
                {
                    "step": i,
                    "label": f"TP{i}",
                    "moves_to": "entry" if i == 1 else f"TP{i - 1}",
                    "fraction": round(i / steps, 4),
                }
                for i in range(1, steps + 1)
            ],
        }

    def _timezone_city(self) -> str:
        """The chosen zone as somebody would say it out loud."""
        from ..prop.hours import ZONES

        for _, iana, city, _m in ZONES:
            if iana == self.desk_timezone:
                return city
        return self.desk_timezone

    def _timezone_state(self) -> dict[str, Any]:
        minutes = self.prop.broker_minutes
        return {
            "timezone": self.desk_timezone,
            "label": zone_label(self.desk_timezone, minutes),
            "city": self._timezone_city(),
            "broker_offset_minutes": minutes,
            # The chosen zone's offset today, so the desk can convert a
            # time to broker time by arithmetic rather than by shipping
            # a second implementation of timezones to the browser.
            "offset_minutes": zone_offset_minutes(self.desk_timezone, minutes),
            # Cities, not database keys, and grouped by region. Built
            # fresh each time so the offsets shown are today's, summer
            # time included.
            "choices": zone_choices(minutes),
        }

    async def set_timezone(self, body: dict[str, Any]) -> dict[str, Any]:
        """The desk's clock. Everything that needs to know the time uses it.

        Deliberately not a prop setting. Which hours a prop firm allows
        is their rule; what time it is where you sit is not, and asking
        the same question once per profile is how the answers start
        disagreeing.
        """
        wanted = str((body or {}).get("timezone") or "").strip()
        if not wanted:
            return {"ok": False, "error": "no timezone given"}

        if wanted.lower() not in {"broker", "local"} and resolve_zone(wanted) is None:
            return {"ok": False, "error": f"'{wanted}' is not a timezone this machine knows"}

        self.desk_timezone = wanted
        self.prop.desk_timezone = wanted
        if wanted.lower() != "broker":
            # A stale broker offset must not colour the new choice.
            self.prop.broker_minutes = self.prop.broker_minutes

        merge({"system": {"timezone": wanted}})
        self._sync_book_meta()
        await self.bus.publish("strategy", self.strategy_meta)

        state = self._timezone_state()
        await self.journal("info", "timezone", f"Desk clock set to {state['label']}", extra=state)
        return {"ok": True, "system": state}

    async def set_risk_free(self, body: dict[str, Any]) -> dict[str, Any]:
        body = dict(body or {})
        if "enabled" in body:
            self.risk_free_enabled = bool(body.get("enabled"))
        if "trigger_pct" in body:
            self.risk_free_trigger_pct = self._clamp_pct(
                body.get("trigger_pct"), self.risk_free_trigger_pct)
        if "lock_pct" in body:
            self.risk_free_lock_pct = self._clamp_pct(
                body.get("lock_pct"), self.risk_free_lock_pct)
        if "ladder" in body:
            self.risk_free_ladder = bool(body.get("ladder"))
        if "steps" in body:
            self.risk_free_steps = self._clamp_int(
                body.get("steps"), int(getattr(self, "risk_free_steps", 3) or 3), 1, 5)

        # Rebuild the snapshot and push it, exactly as set_danger does.
        #
        # Leaving these two lines out is why the switch turned itself
        # back off: the value was saved and persisted correctly, but
        # strategy_meta still carried the old state, so the desk reloaded
        # its settings, read enabled=false and repainted the switch off.
        # From the outside that is indistinguishable from a setting that
        # refuses to save.
        self._sync_book_meta()
        self._persist_runtime()
        await self.bus.publish("strategy", self.strategy_meta)

        state = self._risk_free_state()
        await self.journal(
            "info",
            "risk_free_cfg",
            (
                f"Risk free ladder ON - stop climbs a rung at each of "
                f"{state['steps']} targets (TP1 locks the entry)"
                if state["ladder"] else
                (f"Risk free ON - stops move past entry at +{state['trigger_pct']}%"
                 if state["enabled"] else "Risk free OFF")
            ),
            extra=state,
        )
        return {"ok": True, "risk_free": state}

    def _money_state(self) -> dict[str, Any]:
        """What the desk needs to draw the money rule and its reach."""
        cap = self._cap()
        symbol = str(getattr(self, "active_symbol", "") or "")
        spec = self.symbol_spec(symbol) if symbol else SymbolSpec()
        scope = self._scope()
        mode = str(getattr(self, "money_mode", "fixed"))
        equity = self._equity_now()
        state: dict[str, Any] = {
            "max_loss_per_lot": cap,
            # Automatic mode. The desk needs all four to say what it is
            # doing: which mode, the percentage asked for, the
            # percentage actually in force after the prop ceiling, and
            # the equity the cap was computed from - so a cap that
            # looks wrong can be checked rather than guessed at.
            "mode": mode,
            "risk_pct": float(getattr(self, "money_risk_pct", 1.0) or 0.0),
            "risk_pct_effective": self._auto_risk_pct(),
            # The rule's INPUTS, not just its answer. risk_pct_effective
            # resolves the SAVED percentage; the desk also has to show
            # what a percentage being typed would do, and it cannot do
            # that without the bounds that will be applied to it. When
            # it tried, by reusing risk_pct_effective as a ceiling, the
            # preview froze at the saved value.
            "risk_pct_min": self.AUTO_RISK_MIN_PCT,
            "risk_pct_max": self.AUTO_RISK_MAX_PCT,
            "risk_pct_cap": self._prop_risk_ceiling(),
            "equity": equity,
            "auto_held": bool(mode == "auto" and equity <= 0 and cap > 0),
            "scope": scope,
            "symbol": symbol,
            "priced": bool(spec.usable),
            "currency": spec.currency or str((self.bridge.account.to_dict() or {}).get("currency") or ""),
        }
        if spec.usable and cap > 0:
            # The widest stop the cap allows, at the reference size the
            # desk prints beside it. distance_for() takes money and a
            # volume, so the budget has to be the one that belongs to
            # that volume - passing the raw cap read a per-trade budget
            # as if it were per-lot and overstated the reach.
            ref = REFERENCE_LOT
            distance = spec.floor_to_tick(spec.distance_for(risk_budget(cap, ref, scope), ref))
            state["max_stop_distance"] = spec.round_price(distance)
            state["max_stop_points"] = round(distance / spec.tick_size, 1) if spec.tick_size else 0
        state["reference_lot"] = REFERENCE_LOT
        state["specs"] = self._spec_table()
        return state

    def _spec_table(self) -> dict[str, dict[str, Any]]:
        """The contract numbers the desk needs to price a ticket itself.

        A stop written in price says nothing about what it costs, and
        the desk is where that question is asked - the trader is typing
        a stop and wants to know, before pressing anything, how many
        points away it is and how much money that is at the lot they
        have chosen. Sending the two numbers the arithmetic needs is
        cheaper and far more responsive than asking the engine to price
        every keystroke.

        Only symbols whose spec is ``usable`` are included. A symbol
        that is absent is the honest answer "money cannot be computed
        here" - the same rule risk.py states, and for the same reason:
        a guessed tick value is a confident wrong number on somebody's
        risk. The desk must show nothing rather than guess.
        """
        names: list[str] = []

        def add(symbol: Any) -> None:
            name = str(symbol or "").strip()
            if name and name not in names:
                names.append(name)

        add(getattr(self, "active_symbol", ""))
        try:
            for pos in self.bridge.positions or []:
                add(getattr(pos, "symbol", ""))
        except Exception:  # pragma: no cover - a bridge mid-reconnect
            log.exception("position symbols unavailable for the spec table")
        try:
            for name in self.bridge.known_symbols():
                add(name)
        except Exception:  # pragma: no cover - older bridge
            log.exception("known_symbols unavailable")

        out: dict[str, dict[str, Any]] = {}
        # Bounded: a desk watches a basket, not a broker's whole book,
        # and this rides on every snapshot.
        for name in names[:40]:
            spec = self.symbol_spec(name)
            if not spec.usable:
                continue
            out[name] = {
                "tick_size": spec.tick_size,
                "tick_value": spec.tick_value,
                "digits": int(spec.digits),
                "currency": spec.currency,
                "volume_min": spec.volume_min,
                "volume_step": spec.volume_step,
                "contract_size": spec.contract_size,
            }
        return out

    async def set_money(self, body: dict[str, Any]) -> dict[str, Any]:
        """Set the loss cap and what it counts. 0 turns the rule off, loudly."""
        body = dict(body or {})
        if "mode" in body:
            asked_mode = str(body.get("mode") or "").strip().lower()
            if asked_mode not in {"fixed", "auto"}:
                return {"ok": False, "error": "mode must be 'fixed' or 'auto'"}
            self.money_mode = asked_mode
        if "risk_pct" in body:
            try:
                pct = float(body.get("risk_pct") or 0)
            except (TypeError, ValueError):
                return {"ok": False, "error": "risk_pct must be a number"}
            if pct < self.AUTO_RISK_MIN_PCT or pct > self.AUTO_RISK_MAX_PCT:
                # Refused rather than clamped. A trader who typed 50
                # meant something, and silently saving 10 teaches them
                # the field does not do what it says.
                return {
                    "ok": False,
                    "error": (f"risk per trade must be between {self.AUTO_RISK_MIN_PCT:g}% "
                              f"and {self.AUTO_RISK_MAX_PCT:g}%"),
                }
            self.money_risk_pct = pct
            self._auto_cap_last = 0.0
        if "scope" in body:
            asked = str(body.get("scope") or "")
            if asked.strip().lower() not in MONEY_SCOPES:
                # Named rather than silently defaulted: a desk that sends
                # a scope it invented is a desk that thinks the cap means
                # something it does not.
                return {"ok": False, "error": "scope must be one of " + ", ".join(MONEY_SCOPES)}
            self.money_scope = normalise_scope(asked)
        if "max_loss_per_lot" in body:
            try:
                value = float(body.get("max_loss_per_lot") or 0)
            except (TypeError, ValueError):
                return {"ok": False, "error": "max_loss_per_lot must be a number"}
            self.max_loss_per_lot = max(0.0, min(100_000.0, value))
        self._spec_gap_said.clear()
        self._cap_note.clear()
        self._sync_book_meta()
        self._persist_runtime()
        await self.bus.publish("strategy", self.strategy_meta)
        state = self._money_state()
        await self.journal(
            "info",
            "money_cfg",
            (f"Stop cap set to {self._cap_words()}"
             if state["max_loss_per_lot"] > 0
             else "Stop cap OFF — stops are whatever the strategy asks for"),
            extra=state,
        )
        return {"ok": True, "money": state}

    def _chart_stop_cap(self, symbol: str):
        """A (side, entry, sl) -> sl rule for the chart replay, or None."""
        cap = self._cap()
        spec = self.symbol_spec(symbol)
        if cap <= 0 or not spec.usable:
            return None

        scope = self._scope()

        def rule(side: str, entry: float, sl: float, volume: float = 0.0) -> float:
            # Same scope as the live rule: a replay that prices risk by a
            # different rule than the desk is a chart of a system nobody
            # is running.
            out = cap_stop(side, entry, sl, spec, cap, volume, scope)
            return out.sl if out else sl

        return rule

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

    async def _watch_strategies(self, tick: dict[str, Any]) -> None:
        """Keep the strategy cards and the chart honest between bar closes.

        A card that only changes when a candle closes is a card that says
        "idle" for fourteen minutes out of fifteen, and the trader cannot
        tell a thinking robot from a stopped one. This asks every armed
        strategy the same question the live engine will ask at the close —
        on the bar as it stands — and publishes the answer. It never
        trades: the decision that counts is still taken on a closed bar,
        because a signal measured on half a candle is not a signal.

        The same pass now also feeds the chart. Reported as "it should
        signal as the chart moves, not only on finished candles": the
        marks on the canvas came from a replay over closed bars, so on
        M15 a setup that formed at 10:00:30 was invisible until 10:15,
        and by then it was history. What goes out here is labelled
        `forming` and carries the time of the bar it was seen on, so the
        desk can draw it as provisional and drop it the moment the
        strategy stops seeing it. A forming mark is a question, not an
        instruction; the confirmed mark is still the one the closed-bar
        replay produces.
        """
        now = time.time()
        if now - float(getattr(self, "_watch_at", 0.0) or 0.0) < self.WATCH_EVERY_SEC:
            return
        self._watch_at = now
        symbol = str(tick.get("symbol") or self.active_symbol or "")
        if not symbol or not self._is_ea_symbol(symbol):
            return
        armed = [(name, slot) for name, slot in self.book.items() if slot.get("enabled") and slot.get("inst")]
        if not armed:
            return
        ctx = self._ctx(symbol, self.active_timeframe, tick)
        if not ctx.candles or len(ctx.candles) < 30:
            return

        def look() -> dict[str, tuple[str, str, dict[str, Any]]]:
            out: dict[str, tuple[str, str, dict[str, Any]]] = {}
            for name, slot in armed:
                inst = slot.get("inst")
                # The tally of "why it stayed out" is per closed bar and the
                # desk reads it; asking thirty times a minute would drown it.
                # Snapshot it, ask, put it back.
                tally = dict(getattr(inst, "refusals", {}) or {})
                last_kind = getattr(inst, "last_refusal_kind", "")
                last_why = getattr(inst, "last_refusal", "")
                try:
                    signal = inst.on_candle(ctx)
                except Exception as exc:        # a watch pass must never arm safe mode
                    out[name] = ("fault", str(exc), {})
                    continue
                finally:
                    if hasattr(inst, "refusals"):
                        inst.refusals = tally
                action = str(getattr(signal, "action", "") or "") if signal else ""
                if signal and action in {"buy", "sell", "close", "close_all", "flatten"}:
                    # The levels come with it, because a mark on the chart
                    # that cannot say where the stop would go is an arrow,
                    # not a case the trader can judge.
                    out[name] = (action, str(getattr(signal, "reason", "") or action), {
                        "price": _as_float(getattr(signal, "price", 0.0)),
                        "sl": _as_float(getattr(signal, "sl", 0.0)),
                        "tp": _as_float(getattr(signal, "tp", 0.0)),
                        "confidence": _as_float(getattr(signal, "confidence", 0.0)),
                    })
                else:
                    out[name] = ("hold", str(getattr(inst, "last_refusal", "") or "no setup on this bar"), {})
                # And the strategy is left exactly as the last closed bar
                # left it, so nothing the watch saw can leak into a trade.
                if hasattr(inst, "last_refusal"):
                    inst.last_refusal = last_why
                    inst.last_refusal_kind = last_kind
            return out

        try:
            seen = await asyncio.to_thread(look)
        except Exception:
            log.exception("strategy watch failed")
            return
        changed = False
        for name, (action, why, _levels) in seen.items():
            slot = self.book.get(name)
            if slot is None:
                continue
            if slot.get("live_action") != action or slot.get("live_reason") != why:
                changed = True
            slot["live_action"] = action
            slot["live_reason"] = why
            slot["live_ts"] = utc_iso()
            self._note_symbol(slot, symbol, live_action=action, live_reason=why,
                              live_ts=slot["live_ts"])
        await self._publish_forming(symbol, self.active_timeframe, ctx, seen, tick)
        if not changed:
            return
        self._sync_book_meta()
        await self.bus.publish("strategy", self.strategy_meta)

    async def _publish_forming(
        self,
        symbol: str,
        timeframe: str,
        ctx: StrategyContext,
        seen: dict[str, tuple[str, str, dict[str, Any]]],
        tick: dict[str, Any],
    ) -> None:
        """Send the chart what the armed strategies see on the unfinished bar.

        Only entries — buy and sell. A `hold` is not a mark and a
        `fault` belongs in the log, not on the canvas.

        The bar's TIME goes with it, because that is the only thing that
        says where the mark belongs; the desk holds its own array and
        an index into ours would land on a different candle. When the
        bar closes, that time stops being the newest bar and the desk
        drops the mark — the closed-bar replay is what replaces it, and
        a provisional arrow left behind on a finished candle would be a
        signal the robot never acted on.

        An empty list is published as readily as a full one. Silence
        would leave the last mark on the chart for ever, and a setup
        that has evaporated is precisely the thing the trader must see
        evaporate.
        """
        bars = ctx.candles or []
        bar_time = str((bars[-1] or {}).get("time") or "") if bars else ""
        if not bar_time:
            return
        fallback = _as_float((tick or {}).get("bid")) or _as_float((bars[-1] or {}).get("close"))
        marks: list[dict[str, Any]] = []
        for name, (action, why, levels) in sorted(seen.items()):
            if action not in {"buy", "sell"}:
                continue
            marks.append({
                "strategy": name,
                "side": action,
                "type": action,
                "time": bar_time,
                "price": _as_float(levels.get("price")) or fallback,
                "sl": _as_float(levels.get("sl")),
                "tp": _as_float(levels.get("tp")),
                "confidence": _as_float(levels.get("confidence")),
                "reason": why,
                "forming": True,
            })
        payload = {
            "symbol": symbol,
            "timeframe": timeframe,
            "time": bar_time,
            "signals": marks,
            "ts": utc_iso(),
        }
        # Nothing to say, and nothing was being said: do not spend a
        # broadcast on it. The desk clears its own marks when the chart
        # changes, so a silent engine cannot strand one here.
        if not marks and not getattr(self, "_forming_had", False):
            return
        self._forming_had = bool(marks)
        await self.bus.publish("live_signal", payload)

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
        self.min_ai_confidence = float(runtime.get("min_ai_confidence") or 0.35)
        self.solo_robot = bool(runtime.get("solo_robot", True))
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
        # Auto entry point: rest the robot's trade at a price instead of
        # taking the market. See runtime/auto_entry.py for why.
        auto_cfg = runtime.get("auto_entry") if isinstance(runtime.get("auto_entry"), dict) else {}
        self.auto_entry = bool(auto_cfg.get("enabled", False))
        try:
            self.auto_entry_depth = max(0.0, min(1.0, float(auto_cfg.get("zone_depth", 0.5))))
        except (TypeError, ValueError):
            self.auto_entry_depth = 0.5
        try:
            self.auto_entry_offset = max(0.0, min(5.0, float(auto_cfg.get("offset_atr", 0.35))))
        except (TypeError, ValueError):
            self.auto_entry_offset = 0.35
        self.auto_entry_expiry = self._clamp_int(auto_cfg.get("expiry_minutes"), 120, 0, 10080)
        confirm = str(auto_cfg.get("confirm", "normal") or "normal").lower()
        self.auto_entry_confirm = confirm if confirm in {"off", "normal", "strict"} else "normal"
        danger_cfg = runtime.get("danger_guard") if isinstance(runtime.get("danger_guard"), dict) else {}
        self.danger_enabled = bool(danger_cfg.get("enabled", False))
        self.danger_sensitivity = clamp_sensitivity(danger_cfg.get("sensitivity", 50))
        system = cfg.get("system") if isinstance(cfg.get("system"), dict) else {}
        self.desk_timezone = str(system.get("timezone") or "UTC").strip() or "UTC"
        self.prop.desk_timezone = self.desk_timezone
        money_cfg = runtime.get("money") if isinstance(runtime.get("money"), dict) else {}
        try:
            self.max_loss_per_lot = max(0.0, float(money_cfg.get("max_loss_per_lot", 10.0)))
        except (TypeError, ValueError):
            self.max_loss_per_lot = 10.0
        # Absent from an older config file, which is the common case:
        # normalise_scope answers DEFAULT_SCOPE, so an upgraded desk
        # reads its existing number per trade. That is a change in
        # behaviour and it is the point - it is the reading the number
        # was always labelled with.
        self.money_scope = normalise_scope(money_cfg.get("scope"))
        self.money_mode = "auto" if str(money_cfg.get("mode") or "fixed") == "auto" else "fixed"
        try:
            pct = float(money_cfg.get("risk_pct", 1.0))
        except (TypeError, ValueError):
            pct = 1.0
        self.money_risk_pct = max(self.AUTO_RISK_MIN_PCT, min(self.AUTO_RISK_MAX_PCT, pct))
        self._auto_cap_last = 0.0
        rf_cfg = runtime.get("risk_free") if isinstance(runtime.get("risk_free"), dict) else {}
        self.risk_free_enabled = bool(rf_cfg.get("enabled", False))
        self.risk_free_trigger_pct = self._clamp_pct(rf_cfg.get("trigger_pct"), 0.30)
        self.risk_free_lock_pct = self._clamp_pct(rf_cfg.get("lock_pct"), 0.0)
        self.risk_free_ladder = bool(rf_cfg.get("ladder", True))
        self.risk_free_steps = self._clamp_int(rf_cfg.get("steps"), 3, 1, 5)
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
        saved = self._migrate_retired_strategies(runtime.get("strategies") or {})
        self.book = {}
        for name in BUILTIN_NAMES:
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
                # Through the same resolver as every other caller. The old
                # join dropped the ".py" whenever a saved entry predated the
                # "file" key, so an upgraded desk lost the strategy on boot
                # and only got it back from the self-heal sweep below -
                # disabled, however it had been left.
                inst = self.loader.build({
                    "kind": kind,
                    "name": spec.get("file") or name,
                    "path": spec.get("path"),
                    "params": params,
                })
                self.book[name] = {
                    "inst": inst,
                    "enabled": bool(spec.get("enabled")),
                    "kind": kind,
                    "last_action": "idle",
                    "last_reason": "",
                    "last_ts": "",
                }
                self._clear_strategy_fault(name)
            except Exception as exc:
                log.exception("saved strategy %s failed to reload", name)
                self._note_strategy_fault(name, exc)
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
                except Exception as exc:
                    log.exception("uploaded strategy %s failed to load", stem)
                    self._note_strategy_fault(stem, exc, file=path.name)
                    continue
                self.book[stem] = {
                    "inst": inst,
                    "enabled": False,
                    "kind": "file",
                    "last_action": "idle",
                    "last_reason": "",
                    "last_ts": "",
                }
                self._clear_strategy_fault(stem)
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

    def _resting_count(self, symbol: str = "") -> int:
        """Robot orders waiting at a price. Each one is a trade in waiting."""
        try:
            rows = self._own_pending_orders()
        except Exception:
            return 0
        if not symbol:
            return len(rows)
        out = 0
        for row in rows:
            other = str(row.get("symbol") or "")
            try:
                same = bool(self.bridge._sym_match(other, symbol))
            except Exception:
                same = other == symbol
            if same:
                out += 1
        return out

    def _inflight_count(self, symbol: str = "") -> int:
        """Entries sent but not yet confirmed by MT5."""
        book = getattr(self, "_entry_inflight", None) or {}
        if not symbol:
            return sum(int(v) for v in book.values())
        total = 0
        for other, n in book.items():
            try:
                same = bool(self.bridge._sym_match(str(other), symbol))
            except Exception:
                same = str(other) == symbol
            if same:
                total += int(n)
        return total

    def _committed_count(self, symbol: str = "") -> int:
        """Everything that is, or is about to be, a position.

        The open-trade cap used to be measured against live positions
        alone, which is the one number that lags. An order resting at a
        price will become a position without anyone asking again, and an
        entry already on the wire is a position MetaTrader has simply not
        reported yet. Counting only what has already landed let a cap of
        one produce two trades: the second signal looked at an empty book
        because the first had not arrived.
        """
        return (
            self._open_count(symbol)
            + self._resting_count(symbol)
            + self._inflight_count(symbol)
        )

    def _hold_slot(self, symbol: str) -> None:
        book = getattr(self, "_entry_inflight", None)
        if book is None:
            book = self._entry_inflight = {}
        key = str(symbol or "")
        book[key] = int(book.get(key) or 0) + 1

    def _release_slot(self, symbol: str) -> None:
        book = getattr(self, "_entry_inflight", None) or {}
        key = str(symbol or "")
        left = int(book.get(key) or 0) - 1
        if left > 0:
            book[key] = left
        else:
            book.pop(key, None)

    def _prop_caps_count(self) -> bool:
        """Is the armed prop profile allowed to lower the ticket ceiling?

        Only when the profile asks for it. A funded-account rulebook
        limits money, not the number of trades, so the firm-shaped
        profiles no longer hold the robot's ceiling down - that was
        AURION's own throttle wearing the firm's name, and it is the
        reported "prop mode reduces the trade count". See
        PropEngine.counts_capped().
        """
        prop = getattr(self, "prop", None)
        if not getattr(prop, "enabled", False):
            return False
        try:
            return bool((prop.profile or {}).get("throttle_entries"))
        except Exception:
            return False

    def _per_symbol_cap(self) -> int:
        """How many positions may share one symbol (prop wins when armed)."""
        if self._prop_caps_count():
            try:
                return max(1, int((self.prop.profile or {}).get("max_positions_per_symbol") or 1))
            except (TypeError, ValueError):
                return 1
        return max(1, int(getattr(self, "max_open_trades", 2) or 2))

    def _total_cap(self) -> int:
        cap = max(1, int(getattr(self, "max_open_trades", 2) or 2))
        if self._prop_caps_count():
            try:
                cap = min(cap, max(1, int((self.prop.profile or {}).get("max_open_trades") or cap)))
            except (TypeError, ValueError):
                pass
        return cap

    def free_slots(self, symbol: str = "") -> int:
        """Robot entries still allowed right now (never negative).

        Measured against commitments rather than arrivals - see
        _committed_count. A resting order and an entry on the wire both
        hold their slot, so the ceiling means the same thing whether or
        not MetaTrader has caught up.
        """
        left = self._total_cap() - self._committed_count()
        if symbol:
            left = min(left, self._per_symbol_cap() - self._committed_count(symbol))
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

    def tick_of(self, symbol: str) -> dict[str, Any]:
        """The live quote for a symbol, as a plain dict. Never raises.

        The bridge stores quotes as Tick dataclasses, the desk and the
        tests hand around dicts, and brokers rename the instrument -
        EURUSD, EURUSD.m, EURUSD-ECN. Every reader that re-invented one
        of those three facts got a different two of them wrong; the
        spread gate read `tick.get("bid")` on a dataclass and raised
        AttributeError, which is not in the exception list it was
        written to survive, so it took the whole strategy book down on
        the way out and the robot never sent an order. One accessor, so
        there is one place to be right.
        """
        want = str(symbol or "").strip()
        if not want:
            return {}
        match = getattr(self.bridge, "_sym_match", None)

        def pick(book: Any) -> Any:
            if not isinstance(book, dict) or not book:
                return None
            if want in book:
                return book[want]
            if callable(match):
                for key, value in book.items():
                    try:
                        if match(want, str(key)):
                            return value
                    except Exception:
                        continue
            return None

        row = None
        for source in ("public_ticks", "ticks"):
            try:
                book = getattr(self.bridge, source, None)
                book = book() if callable(book) else book
            except Exception:
                continue
            row = pick(book)
            if row is not None:
                break
        if row is None:
            return {}
        if hasattr(row, "to_dict"):
            try:
                row = row.to_dict()
            except Exception:
                return {}
        if isinstance(row, dict):
            return dict(row)
        return {
            "symbol": want,
            "bid": float(getattr(row, "bid", 0) or 0),
            "ask": float(getattr(row, "ask", 0) or 0),
            "time": str(getattr(row, "time", "") or ""),
        }

    def _spread_ok(self, symbol: str) -> tuple[bool, str]:
        """Reject entries when the spread eats the edge.

        Open on every doubt: a quote that cannot be read is not evidence
        of a bad spread, and refusing the trade for it would be the gate
        inventing a reason. Only a spread it has actually measured says no.
        """
        tick = self.tick_of(symbol)
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
        """Blend every read that *has* an opinion into one 0..1 score.

        This used to start at 0.5 and add or subtract fixed amounts. That
        arithmetic had a fault which switched the robot off entirely on a
        fresh install: an AI that has not finished training took 0.05 off
        the score for "still learning", a model with no measured edge
        added nothing, and the default floor is 0.55 — so a perfectly
        good setup scored about 0.51 and was skipped for "low quality".
        Nobody could see it, because the thing that silenced the robot was
        the absence of evidence rather than evidence against.

        Now each read is a vote with a weight, and a read with nothing to
        say simply does not vote. No votes at all means the score is the
        floor: the robot trades the strategy's own judgement, which is
        what it is for.
        """
        want = "bull" if str(side).lower() in {"buy", "long"} else "bear"
        ai: dict[str, Any] = self._ai_for(symbol)

        reasons: list[str] = []
        votes: list[tuple[float, float]] = []      # (weight, 0..1 value)

        def vote(weight: float, value: float, note: str) -> None:
            votes.append((max(0.0, weight), max(0.0, min(1.0, value))))
            if note:
                reasons.append(note)

        # --- the model, only when it is actually ready ------------------
        conf = float(ai.get("confidence") or 0)
        direction = str(ai.get("direction") or ai.get("display_direction") or "neutral")
        try:
            edge = float((self.ai.models.metrics or {}).get("edge") or 0)
        except Exception:
            edge = 0.0
        if ai.get("ready"):
            # An untested model is allowed an opinion, not a loud one.
            weight = 0.6 + 0.6 * max(0.0, min(1.0, edge))
            if direction == want:
                vote(weight, 0.5 + 0.5 * conf, f"ai {direction} {conf:.0%}")
            elif direction == "neutral":
                vote(weight * 0.5, 0.5, "ai neutral")
            else:
                vote(weight, 0.5 - 0.5 * max(conf, 0.5), f"ai {direction} against")
        else:
            # Not a penalty. A model that has not finished learning knows
            # nothing about this trade, and knowing nothing is not a
            # reason to refuse it.
            reasons.append("ai still learning (not counted)")

        # --- the strategy's own confidence ------------------------------
        if signal_conf:
            vote(1.0, float(signal_conf), f"strategy {float(signal_conf):.0%}")

        # --- the slower chart -------------------------------------------
        bias, strength = self._higher_tf_bias(symbol)
        if bias == want:
            vote(1.0, 0.5 + 0.5 * max(0.2, strength), f"{self._higher_timeframe()} {bias}")
        elif bias != "neutral":
            vote(1.0, 0.5 - 0.5 * max(0.35, strength), f"{self._higher_timeframe()} {bias} against")

        # --- regime and the raw features --------------------------------
        regime = ai.get("regime_obj") if isinstance(ai.get("regime_obj"), dict) else ai.get("regime")
        regime_name = str((regime or {}).get("name") if isinstance(regime, dict) else regime or "")
        if regime_name:
            low = regime_name.lower()
            if "trend" in low:
                vote(0.5, 0.75, f"regime {regime_name}")
            elif "chop" in low or "range" in low:
                vote(0.5, 0.3, f"regime {regime_name}")
            else:
                reasons.append(f"regime {regime_name}")
        feats = ai.get("features") or {}
        try:
            er = float(feats.get("er10") or 0)
            atr_pct = float(feats.get("atr_pct") or 0)
        except (TypeError, ValueError):
            er = atr_pct = 0.0
        if er:
            vote(0.5, 0.25 if er < 0.18 else 0.6, "chop (low efficiency)" if er < 0.18 else "")
        if atr_pct and atr_pct < 0.00025:
            vote(0.5, 0.25, "volatility too low")

        floor = float(getattr(self, "min_signal_quality", 0.55) or 0.55)
        if votes:
            total = sum(w for w, _ in votes) or 1.0
            score = sum(w * v for w, v in votes) / total
        else:
            # Nothing had an opinion. The strategy's own gates already
            # passed, so this must not be the thing that refuses.
            score = floor
            reasons.append("nothing to judge it by — the strategy's own gates stand")
        score = max(0.0, min(1.0, score))
        return {"score": score, "reasons": reasons, "bias": bias, "ai": direction, "confidence": conf}

    def _auto_limit_meta(self) -> dict[str, Any]:
        """Freemium auto-trade allowance for the UI; never breaks status paint."""
        try:
            return self.license.bot_usage()
        except Exception:
            return {}

    # How many symbols a strategy keeps a record for. A desk watching a
    # basket is the case this exists for; a cap stops a mistyped feed
    # from growing the snapshot without bound.
    SYMBOL_MEMORY = 12

    @staticmethod
    def _note_symbol(slot: dict[str, Any], symbol: str, **fields: Any) -> None:
        """Record what a strategy said about ONE symbol.

        The book used to keep a single last_action per strategy. That is
        true of a desk watching one chart and a lie on any other: a buy
        on EURUSD was overwritten by a hold on GBPUSD seconds later, and
        the card showed whichever symbol happened to close last without
        saying which one it was talking about. The per-symbol record is
        kept here and the single field is left alone, so everything that
        reads it still works.
        """
        sym = str(symbol or "").strip()
        if not sym:
            return
        book = slot.setdefault("by_symbol", {})
        row = book.setdefault(sym, {"symbol": sym})
        row.update({k: v for k, v in fields.items() if v is not None})
        row["symbol"] = sym
        if len(book) > Trader.SYMBOL_MEMORY:
            # Oldest first, by whichever timestamp the row carries.
            stale = sorted(book.items(), key=lambda kv: str(kv[1].get("ts") or kv[1].get("live_ts") or ""))
            for key, _ in stale[: len(book) - Trader.SYMBOL_MEMORY]:
                book.pop(key, None)

    @staticmethod
    def _strategy_file_of(slot: dict[str, Any] | None, name: str) -> str:
        """The .py the trader would open to fix this, as a bare name."""
        for key in ("file", "path"):
            value = str((slot or {}).get(key) or "")
            if value:
                return Path(value).name
        inst = (slot or {}).get("inst")
        for key in ("__file__", "path", "file"):
            value = str(getattr(inst, key, "") or "")
            if value:
                return Path(value).name
        return f"{name}.py"

    @staticmethod
    def _strategy_fault_detail(exc: Exception, slot: dict[str, Any] | None = None) -> str:
        """The exact error, with the line in the trader's own file.

        "ZeroDivisionError: division by zero" is true and unusable: the
        file is the one thing the trader can change and it is the one
        thing the message left out. The traceback is walked from the
        bottom for the last frame that is NOT inside the AURION package
        - that is the author's own code - and its file and line are put
        in front of the message.
        """
        import traceback

        frames = traceback.extract_tb(exc.__traceback__)
        here = str(Path(__file__).resolve().parents[1])
        mine = [f for f in frames if here not in str(Path(f.filename).resolve().parent)]
        text = f"{type(exc).__name__}: {exc}"
        if isinstance(exc, StrategyValidationError):
            text = str(exc)
        if mine:
            last = mine[-1]
            where = f"{Path(last.filename).name} line {last.lineno}"
            if last.line:
                return f"{where}: {text}  ->  {last.line.strip()[:120]}"
            return f"{where}: {text}"
        return text

    def _note_strategy_fault(self, name: str, exc: Exception, file: str | None = None,
                             detail: str | None = None) -> None:
        """Remember a strategy file that is on disk but would not load.

        A file that fails to import is simply absent from the book, so the
        desk shows nothing at all: no card, no error, no row. The trader
        uploaded something, it was accepted, and then it was not there -
        which reads as the upload having been lost rather than the code
        having a fault in it. The log said so all along, and nobody reads
        the log.
        """
        key = str(name or "").strip()
        # Strip the suffix the same way _clear_strategy_fault does.
        # It did not, so a fault recorded against "x.py" - which is how
        # older runtime configs keyed their saved strategies - could
        # never be cleared by a later successful load of "x". The card
        # stayed on the desk with its original message long after the
        # strategy was loading perfectly, which reads as "the same error
        # keeps coming back" when nothing is wrong any more.
        if key.endswith(".py"):
            key = key[:-3]
        if not key:
            return
        faults = getattr(self, "strategy_faults", None)
        if faults is None:
            faults = self.strategy_faults = {}
        faults[key] = {
            "name": key,
            "file": file or f"{key}.py",
            "error": detail or (
                f"{type(exc).__name__}: {exc}" if not isinstance(exc, StrategyValidationError) else str(exc)
            ),
            "ts": utc_iso(),
        }

    def _clear_strategy_fault(self, name: str) -> None:
        """A name that loads is no longer broken."""
        key = str(name or "").strip()
        if key.endswith(".py"):
            key = key[:-3]
        faults = getattr(self, "strategy_faults", None)
        if faults:
            faults.pop(key, None)

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
            # What the strategy is saying *right now*, between closes.
            desc["live_action"] = slot.get("live_action") or ""
            desc["live_reason"] = slot.get("live_reason") or ""
            desc["live_ts"] = slot.get("live_ts") or ""
            # What it is saying about EACH symbol it has been asked about.
            # The three fields above are the most recent answer whatever
            # symbol produced it, which on a desk watching a basket names
            # no instrument at all - so the card could not say whether a
            # "buy" meant EURUSD or gold.
            by = slot.get("by_symbol") or {}
            desc["symbols"] = sorted(
                (dict(v) for v in by.values() if isinstance(v, dict)),
                key=lambda r: str(r.get("live_ts") or r.get("ts") or ""),
                reverse=True,
            )
            # The running tally of refusals: one bar's reason is an anecdote,
            # the tally is the answer to "why has it not traded all week".
            try:
                desc["refusals"] = [
                    {"reason": kind, "count": int(count)}
                    for kind, count in (inst.refusal_report(5) if hasattr(inst, "refusal_report") else [])
                ]
            except Exception:
                desc["refusals"] = []
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

        def panel(name: str, build: Any, empty: Any) -> Any:
            """One sub-card of the snapshot, or an empty one with a log line.

            The strategies view is published as a single dict. Anything
            that raises while building one card used to take the whole
            dict with it, so a fault in the money rule emptied the
            strategy cards, the quality score and the block reason as
            well. A missing card is a bug to fix; a missing panel is a
            trader who cannot see their robot.
            """
            try:
                return build()
            except Exception:
                log.exception("strategy snapshot: %s is unavailable", name)
                return empty

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
        solo = bool(getattr(self, "solo_robot", True)) and not enabled
        self.strategy_meta = {
            # Named even with an empty book: "nothing" and "the robot
            # itself" are different answers to "who is trading", and
            # the command centre asks exactly that question.
            "name": ",".join(enabled) if enabled else ("robot" if solo else None),
            "enabled": (bool(enabled) or solo) and self.auto_trade,
            # Whether the robot MAY trade alone, and whether it is in
            # fact the one deciding right now.
            "solo_robot": bool(getattr(self, "solo_robot", True)),
            "solo_active": solo,
            "auto_trade": self.auto_trade,
            "require_ai_agree": self.require_ai_agree,
            "min_ai_confidence": self.min_ai_confidence,
            "volume_mode": getattr(self, "volume_mode", "auto"),
            "manual_volume": getattr(self, "manual_volume", 0.10),
            "trade_style": self.trade_style,
            "min_open_trades": int(getattr(self, "min_open_trades", 1) or 1),
            "max_open_trades": int(getattr(self, "max_open_trades", 2) or 2),
            "open_trades": panel("open trades", self._open_count, 0),
            "free_slots": panel("free slots", self.free_slots, 0),
            "smart_filters": bool(getattr(self, "smart_filters", True)),
            # What the caps actually are once the prop profile has had its
            # say. The desk was showing the trader's own number, which is a
            # wish rather than the rule the robot is being held to.
            "cap_effective": panel("cap", self._total_cap, 0),
            "cap_symbol": panel("symbol cap", self._per_symbol_cap, 0),
            "cap_by_prop": bool(
                getattr(self.prop, "enabled", False)
                and self._total_cap() < max(1, int(getattr(self, "max_open_trades", 2) or 2))
            ),
            "min_signal_quality": float(getattr(self, "min_signal_quality", 0.55) or 0.55),
            "last_quality": dict(getattr(self, "last_quality", {}) or {}),
            "last_block": dict(getattr(self, "last_block", {}) or {}),
            "news_trade": panel("news", self.news_trading_on, False),
            "news_trade_locked": bool(self.prop.enabled),
            "auto_entry": bool(getattr(self, "auto_entry", False)),
            "auto_entry_expiry": int(getattr(self, "auto_entry_expiry", 120)),
            "auto_entry_confirm": str(getattr(self, "auto_entry_confirm", "normal")),
            "pending_orders": panel("pending orders", lambda: len(self._own_pending_orders()), 0),
            "danger_guard": panel("danger guard", self._danger_state, {}),
            "risk_free": panel("risk free", self._risk_free_state, {}),
            "money": panel("money rule", self._money_state, {}),
            "system": panel("clock", self._timezone_state, {}),
            "auto_limit": panel("auto limit", self._auto_limit_meta, {}),
            "prop_enabled": bool(getattr(self.prop, "enabled", True)),
            "items": items,
            # Files in the strategies folder that would not load. Without
            # these the desk can only show what succeeded, so a broken
            # upload looks like a lost upload.
            "faults": sorted(
                (dict(v) for v in (getattr(self, "strategy_faults", {}) or {}).values()),
                key=lambda r: str(r.get("name") or ""),
            ),
            "stats": ledger,
            "class": first.__class__.__name__ if first else "",
        }

    @staticmethod
    def _migrate_retired_strategies(saved: dict[str, Any]) -> dict[str, Any]:
        """Carry a retired built-in's saved state over to its replacement.

        A trader who had scalp_impulse armed should come back from the upgrade
        with King armed, not with auto-trading quietly switched off and no
        explanation. Only the *enabled* flag and the kind travel: the old
        parameters described an indicator strategy and mean nothing to a
        structural one, so forwarding them would be worse than dropping them.
        """
        if not isinstance(saved, dict):
            return {}
        out = dict(saved)
        for old_name, new_name in LEGACY_BUILTINS.items():
            spec = out.pop(old_name, None)
            if not isinstance(spec, dict):
                continue
            existing = out.get(new_name)
            if isinstance(existing, dict) and existing.get("enabled"):
                continue
            out[new_name] = {
                "enabled": bool(spec.get("enabled")),
                "kind": "builtin",
            }
        return out

    def _persist_runtime(self) -> None:
        merge(
            {
                "runtime": {
                    "auto_trade": self.auto_trade,
                    "require_ai_agree": self.require_ai_agree,
                    "min_ai_confidence": self.min_ai_confidence,
                    "solo_robot": bool(getattr(self, "solo_robot", True)),
                    "volume_mode": getattr(self, "volume_mode", "auto"),
                    "manual_volume": getattr(self, "manual_volume", 0.10),
                    "trade_style": self.trade_style,
                    "min_open_trades": int(getattr(self, "min_open_trades", 1) or 1),
                    "max_open_trades": int(getattr(self, "max_open_trades", 2) or 2),
                    "smart_filters": bool(getattr(self, "smart_filters", True)),
                    "min_signal_quality": float(getattr(self, "min_signal_quality", 0.55) or 0.55),
                    "news_trade": self.news_trade,
                    "auto_entry": {
                        "enabled": bool(getattr(self, "auto_entry", False)),
                        "zone_depth": float(getattr(self, "auto_entry_depth", 0.5)),
                        "offset_atr": float(getattr(self, "auto_entry_offset", 0.35)),
                        "expiry_minutes": int(getattr(self, "auto_entry_expiry", 120)),
                    },
                    "money": {
                        "max_loss_per_lot": float(getattr(self, "max_loss_per_lot", 10.0) or 0.0),
                        # The scope the trader chose, not the one in force:
                        # automatic mode forces "trade", and saving that
                        # would quietly rewrite their fixed-mode setting
                        # the first time automatic was switched on.
                        "scope": normalise_scope(getattr(self, "money_scope", DEFAULT_SCOPE)),
                        "mode": str(getattr(self, "money_mode", "fixed")),
                        "risk_pct": float(getattr(self, "money_risk_pct", 1.0) or 0.0),
                    },
                    "risk_free": {
                        "enabled": bool(self.risk_free_enabled),
                        "trigger_pct": float(self.risk_free_trigger_pct),
                        "lock_pct": float(self.risk_free_lock_pct),
                        "ladder": bool(getattr(self, "risk_free_ladder", True)),
                        "steps": int(getattr(self, "risk_free_steps", 3) or 3),
                    },
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

    def fire_blockers(self) -> list[str]:
        """Every reason a signal would not be sent right now, by name.

        "Signal seen but auto-trade is not armed (or a gate is closed)"
        was the only thing the log said when a strategy fired and nothing
        happened, and it is five possibilities in one sentence. A trader
        looking at that cannot tell whether they forgot the switch, the
        kill switch is down, prop has locked them out, or the tape is not
        live - and every one of those has a different fix.
        """
        return gate_blockers(
            auto_trade=bool(self.auto_trade),
            kill_switch=bool(self.kill_switch),
            safe_mode=bool(self.safe_mode),
            prop_enabled=bool(self.prop.enabled),
            prop_locked=bool(self.prop.locked),
            tape_mode=self.bridge.tape_mode(),
        )

    def _solo_robot_slot(self) -> dict[str, Any] | None:
        """The robot's own slot, built once, or None if it may not trade.

        Returns None when the trader has switched solo trading off, and
        when the robot has already crashed once this session: a fault
        here would otherwise be raised on every closed candle for as
        long as the desk stays open, filling the log and announcing
        nothing new. The same rule the book applies to a strategy that
        throws.

        The slot is shaped like a book slot - last_action, last_reason,
        last_ts, symbols - because everything downstream of the
        evaluation loop reads those fields and none of it should have
        to know whether a strategy or the robot produced the signal.
        """
        if not bool(getattr(self, "solo_robot", True)):
            return None
        slot = getattr(self, "_solo_slot", None)
        if slot is not None:
            return None if slot.get("faulted") else slot
        try:
            inst = self.loader.build({
                "kind": "robot",
                "name": SOLO_ROBOT_NAME,
                # The live floor, not the class default: the trader set
                # that number for robot entries and this IS a robot
                # entry. Read at build time and refreshed below, so
                # moving the slider moves the robot.
                "params": {"min_confidence": float(getattr(self, "min_ai_confidence", 0.35) or 0.0)},
            })
        except Exception:
            log.exception("the solo robot could not be built")
            self._solo_slot = {"faulted": True, "inst": None}
            return None
        slot = {
            "inst": inst,
            "enabled": True,
            "kind": "robot",
            "solo": True,
            "last_action": "",
            "last_reason": "",
            "last_ts": "",
            "symbols": {},
        }
        self._solo_slot = slot
        return slot

    async def _run_enabled_strategies(
        self, ctx: StrategyContext, execute: bool = False, blocked: list[str] | None = None
    ) -> None:
        closes: list[tuple[str, Any]] = []
        entries: list[tuple[str, Any]] = []
        # Who is deciding this bar: the enabled strategies, or - when
        # there are none - the robot on its own. See self.solo_robot.
        pairs: list[tuple[str, dict[str, Any]]] = [
            (name, slot) for name, slot in self.book.items()
            if slot.get("enabled") and slot.get("inst")
        ]
        if not pairs:
            solo = self._solo_robot_slot()
            if solo is not None and solo.get("inst") is not None:
                # The confidence floor is a live setting; a robot built
                # an hour ago must not keep trading yesterday's number.
                try:
                    solo["inst"].params = {
                        **getattr(solo["inst"], "params", {}),
                        "min_confidence": float(getattr(self, "min_ai_confidence", 0.35) or 0.0),
                    }
                except Exception:
                    pass
            if solo is None:
                await self.journal("info", "no_strategy",
                                   f"Closed {ctx.symbol} {ctx.timeframe} — no strategy enabled.")
                self._sync_book_meta()
                await self.bus.publish("strategy", self.strategy_meta)
                return
            pairs = [(SOLO_ROBOT_NAME, solo)]
        await self.journal(
            "info",
            "eval",
            f"Evaluating {', '.join(name for name, _ in pairs)} on {ctx.symbol} {ctx.timeframe} "
            f"({'LIVE fire' if execute else 'observe only — will not send'})",
        )
        for name, slot in pairs:
            inst = slot.get("inst")
            if not inst:
                continue
            try:
                signal = inst.on_candle(ctx)
            except Exception as exc:
                # One broken file is one broken file.
                #
                # This used to set safe_mode and RETURN: a single bad
                # line in a single strategy stopped the robot trading
                # at all, and the strategies that had not been asked
                # yet were never asked - on this bar or any later one,
                # because the next bar crashed in the same place. A
                # desk with three strategies lost all three to a typo
                # in the one the trader was still writing, and the
                # only sign was "safe mode" with no file named.
                #
                # Now the fault belongs to the strategy that caused
                # it: it is switched off, named on the broken-files
                # card with the exact error and the line it happened
                # on, and the loop carries on to the others.
                detail = self._strategy_fault_detail(exc, slot)
                log.exception("strategy %s on_candle crashed", name)
                slot["last_action"] = "fault"
                slot["last_reason"] = detail
                slot["last_ts"] = utc_iso()
                # Off, not just marked. Left armed it would raise on
                # every closed candle for as long as the desk is open,
                # filling the log and announcing nothing new.
                slot["enabled"] = False
                if slot.get("solo"):
                    slot["faulted"] = True
                self._note_symbol(slot, ctx.symbol, action="fault",
                                  reason=detail, ts=slot["last_ts"])
                self._note_strategy_fault(name, exc, file=self._strategy_file_of(slot, name),
                                          detail=detail)
                await self.journal("error", "strategy_fault",
                                   f"{name} was switched off after it crashed: {detail}")
                continue
            action, reason = self._signal_bits(signal)
            if not signal or action in {"", "hold", "none"}:
                # "no setup on this bar" is true and useless. A strategy that
                # declines now says which rule stopped it, and that sentence
                # is what the desk shows — otherwise a quiet robot and a
                # broken one look exactly the same from the outside.
                said = str(getattr(inst, "last_refusal", "") or "")
                slot["last_action"] = "hold"
                slot["last_reason"] = reason or said or "no setup on this bar"
                slot["last_ts"] = utc_iso()
                self._note_symbol(slot, ctx.symbol, action="hold",
                                  reason=slot["last_reason"], ts=slot["last_ts"],
                                  timeframe=str(getattr(ctx, "timeframe", "") or ""))
                await self.journal("info", "hold", f"{name}: hold — {slot['last_reason']}")
                continue
            slot["last_action"] = action
            slot["last_reason"] = reason or action
            slot["last_ts"] = utc_iso()
            self._note_symbol(slot, ctx.symbol, action=action,
                              reason=slot["last_reason"], ts=slot["last_ts"],
                              timeframe=str(getattr(ctx, "timeframe", "") or ""))
            await self.journal("info", "signal", f"{name}: {action} — {slot['last_reason']}")
            if action in {"close", "close_all", "flatten"}:
                closes.append((name, signal))
            elif action in {"buy", "sell", "market"}:
                entries.append((name, signal))
        if not execute:
            if closes or entries:
                why = ", ".join(blocked) if blocked else "a gate is closed"
                await self.journal(
                    "warning",
                    "not_armed",
                    f"Signal seen but not sent — {why}.",
                    extra={"blocked": list(blocked or [])},
                )
                # Tell the desk anyway, now, on every one of them.
                #
                # This branch is the robot disarmed, the kill switch
                # down, outside trading hours - a gate that stops the
                # ORDER. The setup still happened, and until now the
                # only trace of it was a warning line in a log nobody
                # has open: no chime, no card, no Windows toast. That
                # is the reported fault, in the trader's words - "we
                # miss the trade because nothing tells us in time" -
                # and it is worst in exactly the mode where a human is
                # supposed to be the one acting on it.
                #
                # armed:false is the whole difference from a dispatched
                # signal. The card says it is a signal only, and why,
                # so nobody waits for a fill that is not coming.
                for name, signal in entries:
                    try:
                        seen = signal.to_dict() if hasattr(signal, "to_dict") else dict(signal or {})
                    except Exception:
                        seen = {}
                    if not seen:
                        continue
                    seen.setdefault("symbol", getattr(ctx, "symbol", "") or self.active_symbol)
                    seen.setdefault("timeframe", str(getattr(ctx, "timeframe", "") or ""))
                    seen["strategy"] = name
                    seen["source"] = f"strategy:{name}"
                    seen["armed"] = False
                    seen["why"] = why
                    seen["ts"] = utc_iso()
                    self.last_signal = seen
                    self.store.record_signal(seen)
                    await self.bus.publish("signal", seen)
            self._sync_book_meta()
            await self.bus.publish("strategy", self.strategy_meta)
            return
        for name, signal in closes:
            await self.journal("info", "close", f"{name} requested close")
            await self._safe_dispatch(signal, name)
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
            await self._safe_dispatch(signal, name)
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
            # smart_money's own gates (HTF structure, discount/premium)
            # already do what with_trend/require_momentum do on the
            # others, so the style pack only moves the speed knobs.
            "smart_money": {
                "volume": 0.10, "setup_bars": 20, "sweep_bars": 3, "disp_bars": 3,
                "min_displacement": 1.0, "min_rr": 1.5, "equilibrium": 0.62,
                "require_htf": True,
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
            # Scalping cannot wait 20 bars for a retrace, so the whole
            # sequence is compressed and the higher-timeframe check is
            # dropped: on a scalp the HTF has not moved since the sweep.
            "smart_money": {
                "volume": 0.05, "setup_bars": 8, "sweep_bars": 2, "disp_bars": 2,
                "min_displacement": 0.7, "min_rr": 1.15, "equilibrium": 0.7,
                "require_htf": False,
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
        if "solo_robot" in body:
            self.solo_robot = bool(body.get("solo_robot"))
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
        if "auto_entry" in body:
            # Accept the bare switch the desk sends, or the full object when
            # an advanced user tunes the depth from the API.
            raw = body.get("auto_entry")
            auto = raw if isinstance(raw, dict) else {"enabled": bool(raw)}
            if "enabled" in auto:
                self.auto_entry = bool(auto.get("enabled"))
            for key, attr, lo, hi in (
                ("zone_depth", "auto_entry_depth", 0.0, 1.0),
                ("offset_atr", "auto_entry_offset", 0.0, 5.0),
            ):
                if key in auto:
                    try:
                        setattr(self, attr, max(lo, min(hi, float(auto.get(key)))))
                    except (TypeError, ValueError):
                        pass
            if "expiry_minutes" in auto:
                self.auto_entry_expiry = self._clamp_int(auto.get("expiry_minutes"), 120, 0, 10080)
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
                    return {"ok": False, "error": readable_error(str(exc))}
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
            return {"ok": False, "error": readable_error(str(exc))}

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
            return {"ok": False, "error": readable_error(str(exc))}
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
            # Both copies: the working one in the installation and the
            # user's own in data/strategies. Deleting only the first
            # would have the vault restore it at the next start, which
            # turns a safety net into a bug.
            self.loader.forget(name)
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
        """Volume for a robot entry.

        Manual mode pins every robot trade to the user's fixed lot, on
        any symbol. Auto sizes the entry from how sure the strategy is
        and how much equity stands behind it - see runtime/sizing.py.

        Auto used to mean "whatever volume the strategy named", and
        every built-in names 0.10, so auto was a constant: a setup the
        robot barely liked was staked exactly as heavily as one it was
        certain of. A signal that reports no confidence at all is not
        sized on a guess - it keeps the volume it asked for.
        """
        if str(getattr(self, "volume_mode", "auto")) == "manual":
            try:
                vol = float(getattr(self, "manual_volume", 0) or 0)
            except Exception:
                vol = 0.0
            if vol > 0:
                return vol
        try:
            conf = float(payload.get("confidence") or 0)
        except (TypeError, ValueError):
            conf = 0.0
        if conf > 0:
            return auto_lot(conf, self._equity_now())
        return payload.get("volume")

    async def _blocked(
        self,
        source: str,
        payload: dict[str, Any],
        code: str,
        why: str,
        extra: dict[str, Any] | None = None,
    ) -> None:
        """Record, in one place, that a real signal did not become an order.

        "The robot does not trade" was unanswerable because each refusal
        wrote its own sentence into the log and nothing kept a record. The
        strategy card said "hold", which was a lie — the strategy did not
        hold, the desk refused it. Now the refusal lands on the card that
        produced the signal, and on the desk's own last-block line.
        """
        name = str(source or "").split(":", 1)[-1]
        slot = (getattr(self, "book", None) or {}).get(name)
        if slot is not None:
            slot["last_action"] = "blocked"
            slot["last_reason"] = why
            slot["last_ts"] = utc_iso()
        self.last_block = {
            "code": code,
            "why": why,
            "strategy": name,
            "symbol": str(payload.get("symbol") or ""),
            "side": str(payload.get("side") or payload.get("action") or ""),
            "at": utc_iso(),
        }
        await self.journal("warning", code, f"Signal not sent — {why}", {**(extra or {}), "block": self.last_block})
        if slot is not None:
            self._sync_book_meta()
            await self.bus.publish("strategy", self.strategy_meta)

    def _ai_ceiling(self) -> float:
        """The highest confidence the AI can currently report, or 0."""
        try:
            return float((self.ai.last or {}).get("ceiling") or 0.0)
        except Exception:
            return 0.0

    def _ai_ceiling_note(self) -> str:
        ceiling = self._ai_ceiling()
        if ceiling <= 0 or ceiling >= float(getattr(self, "min_ai_confidence", 0.35) or 0):
            return ""
        return (
            f" — and with the edge measured so far the AI cannot go above {ceiling:.2f}, "
            f"so this setting refuses every entry"
        )

    async def _warn_unreachable_ai(self) -> None:
        """Say once that the AI filter has been set to an impossible number.

        The AI's confidence is shrunk towards "no information" in
        proportion to the edge it has actually measured out of sample, so
        it has a ceiling - about 0.53 with three classes and no edge yet.
        A minimum set above that is not a strict filter, it is an off
        switch with a market-sounding excuse, and the trader reads
        "AI confidence 0.31 is under the 0.55 you asked for" as the
        market's fault rather than the slider's.
        """
        ceiling = self._ai_ceiling()
        if ceiling <= 0 or ceiling >= float(getattr(self, "min_ai_confidence", 0.35) or 0):
            self._ai_ceiling_said = False
            return
        if getattr(self, "_ai_ceiling_said", False):
            return
        self._ai_ceiling_said = True
        await self.journal(
            "warning",
            "ai_unreachable",
            f"The AI filter is set to {float(self.min_ai_confidence):.2f}, but the AI cannot "
            f"report more than {ceiling:.2f} until it measures an edge out of sample. "
            f"Every robot entry will be refused while both are true. Lower the minimum in "
            f"Robot, or switch the AI agreement filter off — the strategy's own rules and "
            f"the quality score still apply.",
            {"min_ai_confidence": float(self.min_ai_confidence), "ceiling": ceiling},
        )

    async def _safe_dispatch(self, signal, name: str) -> None:
        """Send one strategy's signal, and survive a fault in the path.

        A fault between the signal and the broker used to abort the whole
        closed-bar handler: the remaining strategies were never asked, the
        desk showed "Strategy book crashed" with a Python message in it,
        and the next bar did exactly the same thing. That is a robot that
        never trades and cannot say why. The crash is now owned by the one
        signal that caused it - named, journalled as an error so it reaches
        the desk, and left behind as last_block so the "why did nothing
        happen" card has an answer.
        """
        try:
            await self._dispatch_signal(signal, f"strategy:{name}")
        except Exception as exc:
            log.exception("dispatching %s failed", name)
            payload = {}
            try:
                payload = signal.to_dict() if hasattr(signal, "to_dict") else dict(signal or {})
            except Exception:
                payload = {}
            self.last_block = {
                "at": utc_iso(),
                "source": f"strategy:{name}",
                "reason": "fault",
                "detail": f"{type(exc).__name__}: {exc}",
                "symbol": payload.get("symbol") or self.active_symbol,
                "action": payload.get("action") or "",
            }
            await self.journal(
                "error",
                "dispatch_fault",
                f"{name}: the order path failed on the way to the broker — "
                f"{type(exc).__name__}: {exc}. Nothing was sent.",
                {"signal": payload},
            )
            await self.bus.publish("block", self.last_block)

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
                await self._blocked(source, payload, "license", str(gate.get("error") or "licence limit"))
                return
            payload["volume"] = self._robot_volume(payload)
        if action in {"buy", "sell", "market"} and not payload.get("comment"):
            tag = self._strategy_tag_for_request({**payload, "source": source})
            payload["comment"] = (f"AURION {tag}" if tag else "AURION")[:31]
            if tag:
                payload["strategy"] = tag
        payload["source"] = source
        # Announce it the moment it exists, not once it has survived
        # every gate.
        #
        # This used to sit below the AI veto, so a setup the AI refused
        # was never published at all: the desk stayed silent, and the
        # trader learned about the move afterwards from the chart. A
        # refusal is the desk's decision about an entry, and the entry
        # is still the news - reported as "we miss trades because
        # nothing tells us in time".
        #
        # Everything the card prints is already on the payload here:
        # the licence gate above has sized it and the tag is set, so
        # moving the publish up costs the card nothing and buys it the
        # veto, the money rules and the broker round trip in latency.
        # Whether it became an order is a separate event - the trade.
        self.last_signal = {**payload, "source": source, "ts": utc_iso(), "armed": True}
        self.store.record_signal(self.last_signal)
        await self.bus.publish("signal", self.last_signal)
        # The AI veto lives here and nowhere else.
        #
        # It used to be asked twice: once by the strategy, through its own
        # require_ai_agree parameter inside entry_allowed(), and again
        # here with the account's setting. Two switches for one rule, in
        # two places, with different defaults — so turning the desk's
        # switch off changed nothing on three of the four built-ins, and
        # the trader could not say which of the two had refused. The
        # built-ins no longer ask; this is the account's rule.
        if action in {"buy", "sell", "market"} and self.require_ai_agree:
            # This chart's reading, not the last chart the AI happened to
            # look at. See _ai_for(): the veto used to refuse a XAUUSD buy
            # because EURUSD read bear, and said so in words that made the
            # trader doubt the chart instead of the robot.
            ai = self._ai_for(self._resolve_symbol(payload))
            if ai.get("ready"):
                if float(ai.get("confidence") or 0) < self.min_ai_confidence:
                    await self._blocked(
                        source,
                        payload,
                        "ai_low",
                        f"AI confidence {float(ai.get('confidence') or 0):.2f} is under the "
                        f"{self.min_ai_confidence:.2f} you asked for" + self._ai_ceiling_note(),
                    )
                    await self._warn_unreachable_ai()
                    return
                want = "bull" if action == "buy" else "bear"
                if action == "market":
                    want = "bull" if str(payload.get("side") or "buy") == "buy" else "bear"
                if ai.get("direction") not in {want, "neutral"} and ai.get("direction") != want:
                    await self._blocked(
                        source, payload, "ai_disagree", f"the AI reads {ai.get('direction')} against this {action}"
                    )
                    return
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
        # The quality floor no longer refuses an entry.
        #
        # Asked for directly - the smart filters were to stop blocking
        # trades - and measured before shipping, because a change to
        # what the robot will and will not take is not a preference.
        #
        # A/B over a seeded synthetic market, 8 markets x 3 built-ins,
        # 2 837 priced trades, expectancy in R (costs not modelled; see
        # backtest/engine.py). The split is on the strategy's own
        # confidence against the 0.55 floor, which is exactly what
        # signal_quality() returns when the model is still learning and
        # the slower chart has no opinion - the state of any fresh
        # install:
        #
        #   everything                 n=2837  win 45.4%  PF 1.15  +0.0580R
        #   the floor let through      n=2756  win 45.5%  PF 1.14  +0.0568R
        #   the floor refused          n=  81  win 43.2%  PF 1.33  +0.0990R
        #
        # So the floor was refusing 2.9% of entries and the ones it
        # refused were, if anything, slightly better than the ones it
        # allowed. n=81 is small and that number is noisy - the honest
        # reading is not "blocking is harmful", it is "there is no
        # measured evidence it protects anything", which is not enough
        # to keep a rule that stops a trade.
        #
        # What the same measurement does support is keeping the score
        # itself. Confidence predicts return across its range - the six
        # bands run -0.040R, -0.021R, -0.000R, +0.138R, +0.093R,
        # +0.178R, corr +0.067 - so the quality-weighted lot below
        # earns its keep: at the same average size it returned +156.4R
        # where flat sizing returned +135.8R, about 15% better. The
        # score now shapes the size and the number of tickets, and
        # refuses nothing.
        if getattr(self, "smart_filters", True):
            # The spread guard stays, and is deliberately not covered by
            # the measurement above: a historical bar carries no spread,
            # so there is nothing here to A/B it against. It is also not
            # the same kind of rule - it is not an opinion about the
            # setup, it is a refusal to pay a cost that is visible at
            # that instant, which is what stops the robot buying into a
            # rollover or a news-print spread. Removing it on a hunch is
            # exactly the thing the measurement above exists to avoid.
            ok_spread, why = self._spread_ok(symbol)
            if not ok_spread:
                await self._blocked(source, payload, "spread", why)
                return
        count = self._entries_for_signal(symbol, quality)
        if count <= 0:
            await self._blocked(
                source,
                payload,
                "slots_full",
                f"{symbol} already holds {self._open_count(symbol)} of max {self._total_cap()} robot trades",
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
            # Re-check every time, including the first. Between deciding
            # how many to open and actually opening them, another signal
            # or a fill may have taken the last slot.
            if self.free_slots(symbol) <= 0:
                break
            self._hold_slot(symbol)
            try:
                result = await self.execute(dict(payload))
            finally:
                # The hold is released either way: on success the position
                # or the resting order now holds the slot itself, and on
                # failure nothing should keep holding it.
                self._release_slot(symbol)
            if not (result or {}).get("ok"):
                # Say why, on the card that produced the signal.
                #
                # Everything upstream of here records its refusal through
                # _blocked(); the order path itself did not, so a ticket
                # that died at the broker or in the money rule left the
                # strategy card saying "hold" and the "why did nothing
                # happen" line empty. That is the robot the trader
                # described as silently not entering - it was entering,
                # and being refused, with nowhere to say so.
                await self._blocked(
                    source, payload, "order_refused",
                    str((result or {}).get("error") or "the order was refused"),
                )
                break

    # ---- auto entry point ------------------------------------------------
    # The robot names the price it wants and leaves the order sitting there
    # with the stop and target attached, instead of hitting the market the
    # moment a candle closes.

    MAGIC = 908173
    WATCH_EVERY_SEC = 2.0

    def _own_pending_orders(self) -> list[dict[str, Any]]:
        """AURION's resting orders, as plain dicts. Never the trader's own."""
        out: list[dict[str, Any]] = []
        bridge = getattr(self, "bridge", None)
        for order in getattr(bridge, "orders", None) or []:
            row = order.to_dict() if hasattr(order, "to_dict") else dict(order or {})
            try:
                if int(row.get("magic") or 0) != self.MAGIC:
                    continue
            except (TypeError, ValueError):
                continue
            out.append(row)
        return out

    async def _apply_auto_entry(self, request: dict[str, Any]) -> dict[str, Any]:
        """Rewrite a robot market order into a resting order, when asked.

        Returns the request to send: either a pending order, or the original
        market order when there is no better price to wait for. Never raises
        and never swallows the trade - a failed plan means "go to market",
        because the alternative is a strategy whose signals silently vanish.
        """
        symbol = str(request.get("symbol") or "")
        tick = self.tick_of(symbol)
        if not tick:
            return request
        side = str(request.get("side") or "buy").lower()
        extra = request.get("extra") if isinstance(request.get("extra"), dict) else {}
        plan = plan_entry(
            side,
            float(tick.get("bid") or 0),
            float(tick.get("ask") or 0),
            float(request.get("sl") or 0),
            float(request.get("tp") or 0),
            extra,
            zone_depth=float(getattr(self, "auto_entry_depth", 0.5)),
            offset_atr=float(getattr(self, "auto_entry_offset", 0.35)),
            expiry_minutes=int(getattr(self, "auto_entry_expiry", 120)),
        )
        if not plan:
            await self.journal(
                "info",
                "auto_entry_market",
                f"Auto entry found no better price for {side} {symbol} — sending at market",
            )
            return request
        # The entry point is planted. Now wait for the market to agree with
        # it. A resting order fills on touch, which takes the trade where
        # price merely visited the level as readily as the one where the
        # level held - so before committing, ask the candles whether this
        # is a level being defended or a level being walked through.
        verdict = confirm_entry(
            side,
            self._confirm_candles(symbol),
            float(plan.get("price") or 0),
            mode=str(getattr(self, "auto_entry_confirm", "normal")),
        )
        if not verdict.get("confirmed"):
            await self.journal(
                "info",
                "auto_entry_waiting",
                f"Entry planted for {side} {symbol} at {plan['price']} — waiting for "
                f"confirmation: {verdict.get('reason')}",
                {"plan": dict(plan), "confirm": dict(verdict)},
            )
            return {**request, "action": "hold", "auto_entry_waiting": True,
                    "confirm": dict(verdict), "plan": dict(plan)}
        out = {
            **request,
            "action": "pending",
            "order_type": plan["order_type"],
            "price": plan["price"],
            "auto_entry": True,
            "confirm": dict(verdict),
        }
        if plan.get("sl"):
            out["sl"] = plan["sl"]
        if plan.get("tp"):
            out["tp"] = plan["tp"]
        await self.journal(
            "info",
            "auto_entry",
            f"Auto entry: {plan['order_type'].replace('_', ' ')} {symbol} at {plan['price']} "
            f"({plan['improvement']} better than {plan['market']}) with SL {out.get('sl') or '—'} / "
            f"TP {out.get('tp') or '—'}"
            + (f", RR {plan['rr']}" if plan.get("rr") else ""),
            {"plan": dict(plan)},
        )
        return out

    def _confirm_candles(self, symbol: str, count: int = 6) -> list[dict[str, Any]]:
        """The last few closed bars, for the entry confirmation check."""
        timeframe = str(getattr(self, "active_timeframe", "") or "M15")
        count = max(2, int(count))
        # The bridge holds the live series; the store is the fallback when
        # this symbol is not the one being streamed.
        try:
            bridge = getattr(self, "bridge", None)
            if bridge is not None:
                live = [c.to_dict() if hasattr(c, "to_dict") else dict(c or {})
                        for c in (bridge.candles_of(symbol, timeframe) or [])]
                if len(live) >= 2:
                    return live[-count:]
        except Exception:
            log.exception("could not read live candles to confirm entry for %s", symbol)
        store = getattr(self, "store", None)
        if store is None:
            return []
        try:
            return list(store.candles(symbol, timeframe, count) or [])
        except Exception:
            log.exception("could not read candles to confirm entry for %s", symbol)
            return []

    async def sweep_pending(self, force: bool = False) -> int:
        """Cancel our resting orders that have waited past their shelf life.

        A pending order is a decision with a timestamp on it. The structure
        that justified the level does not survive forever, and an order left
        from yesterday is not a trade anyone chose to take today.
        """
        expiry = int(getattr(self, "auto_entry_expiry", 120))
        if expiry <= 0:
            return 0
        now = time.time()
        if not force and now - float(getattr(self, "_auto_entry_sweep", 0.0)) < 30.0:
            return 0
        self._auto_entry_sweep = now
        tickets = expired_orders(self._own_pending_orders(), now, expiry, self.MAGIC)
        killed = 0
        for ticket in tickets:
            result = await self.bridge.send_order({"action": "cancel", "ticket": ticket})
            if (result or {}).get("ok"):
                killed += 1
                await self.journal(
                    "info",
                    "auto_entry_expired",
                    f"Cancelled resting order {ticket} — unfilled after {expiry} minutes",
                )
            else:
                await self.journal(
                    "warning",
                    "auto_entry_cancel",
                    f"Could not cancel resting order {ticket}: {(result or {}).get('error') or 'unknown'}",
                )
        return killed

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
            return {"ok": False, "code": "kill_switch", "error": "kill switch armed"}
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
                return {"ok": False,
                        "code": str(sess.get("reason") or "market_closed"),
                        "args": {"opens": str(sess.get("next_open") or "")},
                        "error": sess.get("reason") or "market_closed", "market": sess}
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
                return {"ok": False, "code": "no_position", "error": "no position to close"}
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
                    return {"ok": False, "code": "max_open",
                        "args": {"n": self._total_cap()},
                        "error": f"max open trades reached ({self._total_cap()})"}
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
                return {"ok": False, "code": "symbol_required",
                        "error": "symbol is required — pick a live chart or type the broker symbol"}
            try:
                volume = float(request.get("volume") or 0)
            except (TypeError, ValueError):
                volume = 0.0
            if volume <= 0:
                await self.journal("error", "no_volume", "Order has no volume")
                return {"ok": False, "code": "volume_required", "error": "volume must be greater than 0"}
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
            # Money management, before any gate judges the ticket: the
            # stop the prop rules are asked to approve has to be the stop
            # that will actually be sent.
            request = await self._apply_money_rules(request)
            if float(request.get("volume") or 0) <= 0:
                # Say which number is binding. "Below the broker's minimum
                # lot" was true and useless: the broker's minimum is fixed
                # and the trader cannot change it, so the one sentence they
                # were given named the only part of the problem they had no
                # control over. _size_for_budget leaves the real reason -
                # and the way out - in last_money_block.
                why = str((getattr(self, "last_money_block", None) or {}).get("why") or "")
                return {"ok": False, "error": why or
                        "volume after sizing is below the broker's minimum lot"}
        if str(request.get("action") or "") == "market" and not self.news_trading_on():
            blocked, why = self.prop._news_blackout(str(request.get("symbol") or ""), force=True)
            if blocked:
                await self.journal("warning", "news", f"News window blocked the order: {why}")
                return {"ok": False, "error": why}
        gate = self.prop.allow_order(request, self.bridge.account.to_dict(), [p.to_dict() for p in self.bridge.positions])
        await self._announce_prop_check(request, gate)
        if not gate.get("ok"):
            why = gate.get("error") or "blocked"
            self.store.log_event("warning", why, "logs.rule_block", request)
            await self.journal("warning", "prop_block", f"Prop blocked the order: {why}")
            return gate
        if not (self.bridge.connected or self.bridge.active_agents() or self.bridge.native.connected or self.bridge._ea_clients):
            await self.journal("error", "mt5_down", "MT5 is not reachable — AURION will not fabricate a fill")
            return {"ok": False, "code": "mt5_unreachable",
                    "error": "MetaTrader 5 is not reachable. AURION will not fabricate a fill."}
        # Auto entry point. Deliberately the last step before the wire: every
        # gate above - prop, news, quality, the open-trade ceiling - judges
        # the trade the strategy asked for, and swapping the order type under
        # them earlier would change what they were asked to approve.
        if (
            str(request.get("action") or "") == "market"
            and getattr(self, "auto_entry", False)
            and (source.startswith("strategy") or source in {"robot", "strategy_tick"})
        ):
            try:
                request = await self._apply_auto_entry(request)
                if request.get("auto_entry_waiting"):
                    # Planted, not entered. This is a deferral, not a
                    # rejection: the setup stands and the next closed
                    # candle gets another vote. Returning here is what
                    # keeps "hold" off the wire.
                    return {
                        "ok": True,
                        "held": True,
                        "auto_entry_waiting": True,
                        "confirm": request.get("confirm"),
                        "plan": request.get("plan"),
                        "error": None,
                    }
                if str(request.get("action") or "") == "pending":
                    # The resting price is not the market price, so the
                    # stop's cost in money is a different number. Price
                    # it again rather than shipping yesterday's answer.
                    request = await self._apply_money_rules(request, float(request.get("price") or 0))
            except Exception:
                log.exception("auto entry planning failed - sending at market")
        await self.journal(
            "info",
            "send",
            f"Sending {request.get('side') or request.get('action')} {request.get('symbol')} "
            f"vol={request.get('volume')} via {'native' if self.bridge.native.connected else 'EA'}",
        )
        result = await self.bridge.send_order(request)
        action_now = str(request.get("action") or "")
        if result.get("ok") and action_now == "pending" and request.get("auto_entry"):
            # The trade has not started yet; it starts if price comes to the
            # level. Remember the ticket so the fill can be accounted for,
            # and tag it so the strategy still owns the trade hours later.
            try:
                ticket = int(result.get("order") or result.get("deal") or 0)
            except (TypeError, ValueError):
                ticket = 0
            if ticket:
                self._auto_entry_tickets.add(ticket)
            self._remember_open(request, result)
            await self.journal(
                "info",
                "auto_entry_placed",
                f"Resting {str(request.get('order_type') or '').replace('_', ' ')} {request.get('symbol')} "
                f"at {request.get('price')} — the trade starts only if price reaches it",
            )
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

        Everything this loop does happens on a worker thread, and the whole
        pass is on a hard clock. The download was already off the event loop;
        ``reload_news()`` was not, and it is not cheap - it re-reads the
        calendar CSV off disk and builds a datetime for every release in it.
        Nor was the pass bounded: a name server that accepts the connection
        and then says nothing holds the thread for as long as the socket
        timeout allows, twice, and the engine's logs showed exactly that -
        a six and a half minute hole in the tape with "getaddrinfo failed"
        at the end of it, while the expert's posts were refused and the desk
        drew every chart as gone.

        Nothing here is worth a single late tick. If a pass cannot finish in
        the budget it is abandoned and the next one tries again.
        """
        from .. import news_feed

        def _pass() -> None:
            news_feed.refresh()
            self.prop.reload_news()

        while not self._news_stop.is_set():
            try:
                await asyncio.wait_for(asyncio.to_thread(_pass), timeout=NEWS_PASS_BUDGET)
            except asyncio.TimeoutError:
                log.warning("news refresh took too long and was left behind")
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
            # Which experts this build ships, and which version each chart is
            # actually running. An update can replace the .mq5 on disk; only
            # the trader can recompile it in MetaTrader, so the desk has to
            # be able to see the difference and say so.
            "experts": self.experts_state(),
            "last_signal": self.last_signal,
            "gate": self.trade_gate(),
            "analysis": {
                **self._safe_analysis(),
                "by_symbol": self._analysis_by_symbol(),
            },
            "gates": self.gates_by_symbol(),
            "license": self.license.public(),
            "robot": list(self.robot_log)[-80:],
            "telegram": self.telegram.public() if getattr(self, "telegram", None) else {},
            "tape": self.bridge.tape_mode(),
            "backtest": dict(self.backtest_run or {"running": False, "mode": "idle"}),
            "market": self.market_state(),
            "ts": utc_iso(),
        }

    def experts_state(self) -> dict[str, Any]:
        """The MetaTrader side of the install, shipped against running."""
        from ..mt5 import experts

        try:
            agents = [a.to_dict() for a in self.bridge.public_agents()]
            return experts.state(agents)
        except Exception:        # a reporting read must never break a snapshot
            log.exception("experts state failed")
            return {"shipped": [], "version": "", "charts": [], "stale": [], "outdated": False}

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

    # ------------------------------------------------------------------
    # "Why is it not trading, and when will it?"
    #
    # Every part of the answer already existed, in five different places:
    # the gate's reason codes, the strategy's own refusal, the running
    # refusal tally, the AI read, and the journal. Scattered, they ask the
    # trader to be the one who joins them up, and a trader watching a
    # robot do nothing cannot tell a quiet market from a broken install.
    # This assembles them into one answer about one symbol and one
    # strategy, in sentences rather than codes.
    # ------------------------------------------------------------------

    GATE_PLAIN = {
        "mt5_down": ("MetaTrader is not connected", "Open MetaTrader and attach AurionBridge to the chart."),
        "kill": ("The kill switch is down", "Release the kill switch on the dashboard."),
        "safe": ("Safe mode is on after a fault", "Clear safe mode once you have read the fault."),
        "prop_lock": ("The prop rules have locked trading", "Wait for the next prop period, or relax the profile."),
        "auto_off": ("Auto-trade is off", "Arm auto-trade. Until then the robot watches and reports but never sends."),
        "no_strategy": ("No strategy is enabled", "Enable one in Strategies."),
        "slots_full": ("Every trade slot is already in use", "Close a position or raise the open-trade cap."),
        "ai_low": ("The AI is not confident enough yet", "Wait, or lower the AI confidence filter."),
    }

    # How often the live analysis may be recomputed and pushed. Ticks
    # arrive several times a second; the analysis is in-memory state
    # (no pandas, no strategy call) but there is no point redrawing a
    # panel faster than a person can read it.
    # The desk repaints the Intelligence card from this, so the number is
    # the worst-case age of what a trader is looking at.
    #
    # It was 0.2s, and the cost estimate behind that number counted one
    # symbol. The payload grew to carry an analysis PER WATCHED CHART -
    # up to twelve - and the change test json-dumps the lot, so five
    # times a second became the most expensive thing on the tick path
    # on a desk with several experts attached. Twice a second is faster
    # than a person reads a changing number, and the saving goes to the
    # price updates the trader is actually watching.
    ANALYSIS_PUSH_SECONDS = 0.5
    # How often the engine asks itself whether the reading changed. This
    # exists because ticks are NOT a reliable heartbeat: they only arrive
    # while an MT5 EA is attached and the market is open. Driving the
    # live card from ticks alone left it frozen on a closed market, on a
    # demo account with no EA, and on any symbol the EA was not watching
    # - which is exactly when a trader stares at it hardest.
    ANALYSIS_LOOP_SECONDS = 0.25

    async def _analysis_loop(self) -> None:
        """Keep the live analysis live, whatever is or is not feeding us.

        _push_analysis only publishes when the content actually changed,
        so an idle engine sends nothing at all and this costs a
        sub-millisecond comparison a few times a second.
        """
        while not self._analysis_stop.is_set():
            try:
                await self._push_analysis()
            except Exception:
                log.exception("analysis push failed")
            try:
                await asyncio.wait_for(
                    self._analysis_stop.wait(), timeout=self.ANALYSIS_LOOP_SECONDS
                )
            except asyncio.TimeoutError:
                continue

    async def _push_analysis(self, force: bool = False) -> None:
        """Send the live analysis the moment it changes.

        The analysis used to travel only inside the full snapshot, which
        the desk polls every ten seconds or so. So the panel named "live
        analysis" was up to ten seconds stale and visibly jumped in
        steps, which is what the trader was describing when they said it
        refreshes instead of being live.

        This publishes on its own topic instead, driven by the tick
        stream. It is throttled so a busy symbol cannot flood the socket,
        and -- more importantly -- it only sends when the content has
        actually changed, so a quiet market costs one comparison per
        tick and no traffic at all. Because it recomputes from current
        state, every cause of a change is caught here: a new AI read, a
        strategy refusal, a gate opening, an order being planted.
        """
        now = time.time()
        if not force and now - getattr(self, "_analysis_sent_at", 0.0) < self.ANALYSIS_PUSH_SECONDS:
            return
        # Nobody is listening. Recomputing an analysis for a dozen
        # charts, json-dumping it and comparing it, so that the result
        # can be published to no one, is pure cost on the tick path -
        # and the tick path is what the live price rides on.
        if not force and not self.bus.client_count():
            self._analysis_sent_at = now
            return
        self._analysis_sent_at = now
        try:
            data = self._safe_analysis()
        except Exception:
            log.exception("analysis push failed")
            return
        data = dict(data)
        data["by_symbol"] = self._analysis_by_symbol()
        sig = self._analysis_signature(data)
        if not force and sig == getattr(self, "_analysis_sig", None):
            return
        self._analysis_sig = sig
        await self.bus.publish("analysis", data)

    # Fields that change on their own as time passes rather than because
    # the robot's reading changed. Counting them would make every
    # comparison unequal, so the throttle would publish on every tick and
    # the desk would restamp "updated just now" forever - the age would
    # stop meaning anything at all.
    # "next_eval" is dropped whole: it is only a countdown (in_seconds plus
    # the "in about 2m 1s" text rendered from it). It still travels in the
    # payload - it just does not get a vote on whether this is new.
    ANALYSIS_CLOCK_FIELDS = frozenset({
        "ts", "utc", "in_seconds", "seconds", "countdown", "next_eval",
    })

    def _analysis_signature(self, data: Any) -> str:
        def strip(node: Any) -> Any:
            if isinstance(node, dict):
                return {k: strip(v) for k, v in node.items()
                        if k not in self.ANALYSIS_CLOCK_FIELDS}
            if isinstance(node, list):
                return [strip(v) for v in node]
            return node
        try:
            return json.dumps(strip(data), sort_keys=True, default=str)
        except Exception:
            return repr(data)

    def _safe_analysis(self) -> dict[str, Any]:
        """A reporting read must never be the thing that breaks a snapshot."""
        try:
            return self.analysis()
        except Exception:
            log.exception("analysis unavailable")
            return {"symbol": self.active_symbol, "blockers": [], "console": [], "fault": True}

    # How many watched charts the per-symbol analysis will cover. The
    # desk's direction slider caps itself at 12 the same way, and this
    # runs several times a second, so an unbounded loop here would be a
    # slow leak rather than an obvious bug.
    ANALYSIS_SYMBOL_CAP = 12

    def _watched_symbols(self) -> list[str]:
        """The symbols the desk's direction slider is stepping through.

        Deliberately the same source the slider uses - charts with the
        EA actually attached - so stepping to a slide can never land on
        a symbol this has no analysis for.
        """
        out: list[str] = []
        seen: set[str] = set()
        try:
            agents = self.bridge.public_agents() or []
        except Exception:
            agents = []
        for a in agents:
            sym = str(getattr(a, "symbol", "") or "")
            if sym and sym not in seen:
                seen.add(sym)
                out.append(sym)
        active = str(self.active_symbol or "")
        if active and active not in seen:
            out.insert(0, active)
        return out[: self.ANALYSIS_SYMBOL_CAP]

    def _analysis_by_symbol(self) -> dict[str, Any]:
        """One analysis per watched chart, keyed by symbol.

        The Intelligence page shows the direction slider above the live
        analysis, and stepping the slider has to move both. Without this
        the analysis only ever described the active symbol, so the two
        halves of the page disagreed as soon as the trader pressed the
        arrow.
        """
        out: dict[str, Any] = {}
        for sym in self._watched_symbols():
            try:
                out[sym] = self.analysis(sym)
            except Exception:
                log.exception("analysis failed for %s", sym)
        return out

    def analysis(self, symbol: str = "", strategy: str = "") -> dict[str, Any]:
        """One readable account of what the robot is doing right now."""
        symbol = str(symbol or self.active_symbol or "")
        timeframe = str(self.active_timeframe or "M15")
        gate = self.trade_gate()

        name = str(strategy or "")
        if not name or name not in self.book:
            enabled = [k for k, v in self.book.items() if v.get("enabled")]
            name = enabled[0] if enabled else (next(iter(self.book), "") if self.book else "")
        slot = self.book.get(name) or {}
        inst = slot.get("inst")

        ai = dict(self.ai.last or {})
        if symbol:
            by = dict(getattr(self.ai, "by_symbol", None) or {})
            ai = dict(by.get(symbol) or ai)

        blockers: list[dict[str, Any]] = []
        for code in gate.get("reasons") or []:
            text, fix = self.GATE_PLAIN.get(code, (str(code).replace("_", " "), ""))
            blockers.append({"code": code, "text": text, "fix": fix, "where": "desk"})

        # The strategy's own verdict, which is a different thing from the
        # desk's gates: the gates say whether a signal would be allowed
        # out, this says whether there is one.
        refusal = str(getattr(inst, "last_refusal", "") or "") if inst else ""
        live_action = str(slot.get("live_action") or slot.get("last_action") or "")
        live_reason = str(slot.get("live_reason") or slot.get("last_reason") or "")
        setup = bool(live_action in {"buy", "sell"})
        if not setup and name:
            blockers.append({
                "code": "no_setup",
                "text": refusal or live_reason or "no setup on this bar",
                "fix": "",
                "where": "strategy",
            })

        try:
            refusals = [
                {"reason": kind, "count": int(count)}
                for kind, count in (inst.refusal_report(6) if inst and hasattr(inst, "refusal_report") else [])
            ]
        except Exception:
            refusals = []

        # Entry points already planted for this symbol. A resting order is
        # the robot having decided and being in the market's waiting room,
        # which reads as "doing nothing" unless something says otherwise.
        resting = []
        try:
            for od in self._own_pending_orders():
                if symbol and str(od.get("symbol") or "") != symbol:
                    continue
                resting.append({
                    "ticket": od.get("ticket"),
                    "type": od.get("type") or "",
                    "price": float(od.get("price") or od.get("price_open") or 0),
                    "sl": float(od.get("sl") or 0),
                    "tp": float(od.get("tp") or 0),
                    "volume": float(od.get("volume") or 0),
                })
        except Exception:
            log.exception("resting order read failed")

        # "When" has two honest answers and they are not the same. If
        # something on the desk is switched off, the answer is "when you
        # switch it on" - no amount of waiting fixes it. If the only thing
        # missing is a setup, the answer is the next time this strategy is
        # asked, which is the close of the current candle.
        desk_side = [b for b in blockers if b["where"] == "desk"]
        next_eval = self._next_candle_close(symbol, timeframe)
        if resting:
            levels = ", ".join(f"{r['type'].replace('_', ' ')} at {r['price']}" for r in resting[:3])
            when = f"The entry is already planted ({levels}). The trade starts if price reaches it."
        elif setup and not getattr(self, "auto_entry", False):
            # Worth saying out loud. With auto entry off the robot takes
            # the market on a signal and never rests an order, so looking
            # for a planted entry point on the chart will never find one
            # - and that is a setting, not a fault.
            when = (
                "Now, at market: auto entry is off, so the robot takes the price it is "
                "given instead of planting an entry point and waiting."
            )
        elif desk_side:
            when = "Not until the above is cleared — this will not fix itself with time."
        elif setup:
            when = "Now: a setup is on the table and nothing is blocking it."
        else:
            when = f"At the next candle close ({timeframe}), when the strategy is asked again."

        return {
            "symbol": symbol,
            "timeframe": timeframe,
            "strategy": name,
            "strategy_enabled": bool(slot.get("enabled")),
            "ready": bool(gate.get("ready")),
            "setup": setup,
            "auto_entry": bool(getattr(self, "auto_entry", False)),
            "resting": resting,
            "action": live_action,
            "reason": live_reason,
            "refusal": refusal,
            "refusals": refusals,
            "blockers": blockers,
            "when": when,
            "next_eval": next_eval,
            "ai": {
                "ready": bool(ai.get("ready")),
                "direction": ai.get("direction") or ai.get("bias") or "",
                "confidence": float(ai.get("confidence") or 0),
                "min_confidence": float(self.min_ai_confidence or 0),
                "gate": bool(self.require_ai_agree),
                "regime": ai.get("regime") or "",
                "edge": ai.get("edge"),
            },
            "market": self.market_state(),
            "console": self._analysis_console(symbol, name),
            "ts": utc_iso(),
        }

    MINUTES = {
        "M1": 1, "M5": 5, "M15": 15, "M30": 30,
        "H1": 60, "H4": 240, "D1": 1440, "W1": 10080,
    }

    def _next_candle_close(self, symbol: str, timeframe: str) -> dict[str, Any]:
        """When this strategy is next asked anything, in seconds and in words."""
        minutes = self.MINUTES.get(str(timeframe or "").upper(), 0)
        if minutes <= 0:
            return {"in_seconds": None, "text": ""}
        period = minutes * 60
        remaining = int(period - (time.time() % period))
        if remaining >= 3600:
            text = f"in about {remaining // 3600}h {(remaining % 3600) // 60}m"
        elif remaining >= 60:
            text = f"in about {remaining // 60}m {remaining % 60}s"
        else:
            text = f"in {remaining}s"
        return {"in_seconds": remaining, "text": text}

    def _analysis_console(self, symbol: str, strategy: str) -> list[dict[str, Any]]:
        """The journal, narrowed to the lines about this symbol and strategy.

        The full robot log is every chart at once, which is the reason
        nobody reads it. Entries, exits and faults are always kept: those
        are the lines a trader is actually waiting for.
        """
        keep = {"entry", "exit", "signal", "order", "close", "fill", "blocked", "strategy_fault", "backtest"}
        sym = str(symbol or "").upper()
        name = str(strategy or "").lower()
        out: list[dict[str, Any]] = []
        for item in list(self.robot_log)[-250:]:
            code = str(item.get("code") or "")
            message = str(item.get("message") or "")
            hay = message.upper()
            if code in keep or (sym and sym in hay) or (name and name in message.lower()):
                out.append(item)
        return out[-60:]

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
        # An empty book is only a closed gate when the robot is not
        # allowed to trade on its own. With solo trading on it is a
        # choice of method, not a missing part, so the card names the
        # robot as the thing that decides instead of saying the desk
        # is unarmed.
        solo = not enabled and bool(getattr(self, "solo_robot", True))
        if not enabled and not solo:
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
            "strategies": enabled or ([SOLO_ROBOT_NAME] if solo else []),
            # So the desk can say "the robot, on its own" rather than
            # listing a strategy that is not in the book.
            "solo_robot": solo,
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
        # Take the settings back from the file that was just restored,
        # rather than restating them here.
        #
        # What was here set the minimum AI confidence to 0.55 while
        # aurion.factory.json says 0.35, and before the model has
        # measured an edge it cannot report more than about 0.53 (see
        # LiveModels.confidence_ceiling and test_ai_brain) - a robot
        # that refuses every entry. To be exact: it was not doing that,
        # because _load_runtime_book() is called again further down this
        # same reset and read the right number off the file. It was a
        # contradiction waiting for someone to reorder two blocks.
        #
        # Restating the defaults in a second place also meant the lot
        # mode, the manual lot, the news switch and the auto-entry
        # settings were never reset at all. One reader, one set of
        # defaults, in the file the trader can actually see.
        self._load_runtime_book()
        self.last_quality: dict[str, Any] = {}
        self.danger_enabled = False
        self.danger_sensitivity = 50
        self._danger_seen = {}
        self._danger_cooldown = {}
        self._danger_inflight = set()
        self._entry_inflight = {}
        self.last_signal = None
        self.active_symbol = ""
        self.active_timeframe = "M15"
        self.robot_log.clear()
        self.backtest_run = {"running": False, "mode": "idle"}
        self._backtest_cancel.clear()
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
        bars = await self.bridge.pull_candles(
            symbol, timeframe, at_least_window(timeframe, load()["engine"].get("candle_lookback"))
        )
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
        # One resolver for every caller. This used to join the name onto the
        # strategies folder itself, which loses the ".py" whenever the caller
        # passes a stem - the desk's dropdown does - and surfaced as a raw
        # FileNotFoundError naming a path the trader never typed.
        try:
            inst = self.loader.build({"kind": kind, "name": name, "path": spec.get("path"), "params": params})
        except StrategyValidationError as exc:
            return {"ok": False, "error": readable_error(str(exc))}
        except Exception as exc:
            log.exception("strategy %s failed to load", name)
            return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}
        if self.strategy and hasattr(self.strategy, "on_stop"):
            try:
                self.strategy.on_stop(self._ctx(self.active_symbol, self.active_timeframe))
            except Exception:
                pass
        name = str(name)
        if kind != "builtin":
            from pathlib import Path as _P

            # The book is keyed by stem. Derive it from the name itself -
            # joining it onto the strategies folder first was how the ".py"
            # went missing everywhere else.
            explicit = spec.get("path")
            source = _P(explicit) if explicit else (self.loader.file_for(name) or _P(str(name)))
            name = source.stem or name
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
        self._clear_strategy_fault(name)
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

    # ------------------------------------------------- chart mark cache

    def _marks_store(self) -> dict[str, Any]:
        """The cache, created on demand.

        Not simply self._chart_marks: the Python test harness builds a
        Trader with __new__ and hand-sets only the attributes a given
        check needs, so anything read here must survive not having been
        through __init__.
        """
        store = getattr(self, "_chart_marks", None)
        if store is None:
            store = {}
            self._chart_marks = store
        return store

    def _chart_mark_key(self, symbol: str, timeframe: str, armed: list) -> str:
        """What makes one body of analysis different from another.

        The armed set is part of it: the marks are those strategies'
        own output, so arming a fourth strategy invalidates everything
        and the cache must not quietly keep showing three strategies'
        marks under a four-strategy label.
        """
        names = ",".join(sorted(str(n) for n, _ in armed))
        return f"{symbol}|{timeframe}|{names}"

    def _mark_floor(self, timeframe: str, total: int) -> int:
        """The oldest bar index that carries signal marks.

        One day back from the right-hand edge, whatever the timeframe:
        1440 bars of M1, 96 of M15, 6 of H4. See MARK_DAYS.
        """
        from ..mt5.types import timeframe_minutes
        from ..signals.strategy_signals import WARMUP_BARS

        # Deliberately NOT bars_for_days(): that has a 400-bar floor,
        # meant for "enough bars for an indicator to have an opinion",
        # which is a different question. Applied here it would turn
        # one day of H4 into sixty-six days.
        minutes = max(1, int(timeframe_minutes(timeframe)))
        span = max(1, (MARK_DAYS * 24 * 60) // minutes)
        # Clamped to `total`: on a long timeframe the warm-up can be
        # longer than the whole series (220 bars of warm-up against
        # 180 bars of D1), and an unclamped floor would hand back a
        # backwards range - first past last - which reads as "analyse
        # nothing" in one place and "analyse everything" in another.
        return min(total, max(WARMUP_BARS, total - span))

    def _mark_target_floor(self, total: int) -> int:
        """The oldest bar the marks should EVENTUALLY reach.

        _mark_floor is where the first pass starts, so that today's
        bars carry their marks within one refresh instead of after a
        six-month replay. This is where the walk finishes.

        They used to be the same number, and that was the fault
        behind "the older candles have no signals": a chart holding
        a month of history was marked over its last day and no
        further, for ever, because the planner had already reached
        its floor and reported itself complete. The marked stretch
        then looked like signals that start part-way across the
        chart and stop.

        The destination is the start of the window the desk asked
        for - bounded by what the trader has on screen, not by six
        months - less the warm-up the strategies need before they
        are entitled to an opinion.
        """
        from ..signals.strategy_signals import WARMUP_BARS

        return max(0, min(total, WARMUP_BARS))

    def _chart_mark_plan(self, symbol: str, timeframe: str, armed: list, bars: list) -> dict[str, Any]:
        """Which bars to analyse on this call.

        The marked region is the last MARK_DAYS of the chart and
        nothing older, so this is only ever asked to do one of two
        small things: cover that window the first time, or catch up
        with the handful of bars that have closed since the last call.

        It used to walk backwards through the entire series, 1500 bars
        per refresh, and never finish. With the expert attached to
        several real charts that was an engine that never returned to
        idle - which is what "the engine goes haywire and the desk
        dies when the EA is on" was. Work that has no end cannot be
        budgeted; work with a fixed, recent horizon can.

        Positions are held as bar TIMES, not indices: the history
        scrolls, so index 4000 is a different bar tomorrow, and a cache
        keyed on indices would quietly slide its marks into the wrong
        place.
        """
        key = self._chart_mark_key(symbol, timeframe, armed)
        total = len(bars)
        floor = self._mark_floor(timeframe, total)
        held = self._marks_store().get(key)
        times = [str(b.get("time") or "") for b in bars]
        index_of = {t: i for i, t in enumerate(times) if t}

        # `to_time` is the LAST bar analysed, so the exclusive bound is
        # one past it. Reading it back as the bound itself leaves the
        # newest covered bar looking uncovered, and every refresh
        # re-analyses that one bar for ever.
        lo = hi = None
        if held:
            lo = index_of.get(held.get("from_time") or "")
            end = index_of.get(held.get("to_time") or "")
            hi = None if end is None else end + 1
        if lo is None or hi is None or lo > hi:
            # Nothing usable: either the first call, or the history
            # moved far enough that the remembered bars have scrolled
            # off. Cover the window in one pass - it is one day.
            return {"key": key, "first": floor, "last": total, "fresh": True}

        if hi < total:
            # New bars have arrived since last time. One bar of overlap
            # so a mark on the boundary bar is not lost between passes.
            # `floor` is applied too: as the chart scrolls, the window
            # slides forward and the bars that fall out of it stop
            # being re-analysed.
            return {"key": key, "first": max(floor, hi - 1), "last": total, "fresh": False}

        target = self._mark_target_floor(total)
        if lo > target:
            # Everything newer is covered, so this call goes further
            # back - one bounded slab of it, not the whole remainder.
            # Bounded per call keeps the engine answering; repeated
            # across refreshes it still arrives at the start of the
            # chart, and then stops for good.
            return {"key": key, "first": max(target, lo - MARK_EXTEND_BARS),
                    "last": lo + 1, "fresh": False}

        # Covered, and there is nothing older to do. This is the state
        # the old planner could never reach.
        return {"key": key, "first": lo, "last": lo, "fresh": False, "complete": True}

    def _chart_marks_merge(
        self, symbol: str, timeframe: str, armed: list, bars: list,
        plan: dict[str, Any], result: dict[str, Any],
    ) -> dict[str, Any]:
        """Fold this pass into what is already known and answer with all of it.

        The desk gets every mark discovered so far, not just the slab
        analysed on this call - otherwise each refresh would wipe the
        chart and redraw a different fragment of it.
        """
        key = plan["key"]
        total = len(bars)
        times = [str(b.get("time") or "") for b in bars]
        index_of = {t: i for i, t in enumerate(times) if t}
        held = None if plan.get("fresh") else self._marks_store().get(key)

        kept: list[dict[str, Any]] = []
        if held:
            # Re-index: these marks were found when the history was a
            # different length. A mark whose bar has scrolled off is
            # dropped rather than guessed at.
            for mark in held.get("signals", []):
                idx = index_of.get(str(mark.get("time") or ""))
                if idx is None:
                    continue
                kept.append({**mark, "index": idx})

        # What the pass ACTUALLY covered, not what it was asked to.
        # The replay runs newest-first and stops on a time budget, so
        # a truncated slab covers [covered_from, covered_to) with
        # covered_from above the bar the plan named. Trusting the plan
        # here marked the unanalysed remainder as analysed, and that
        # stretch then never got a second look - the oldest bars of
        # every slab silently kept their "no setups here" verdict
        # without anything having looked at them.
        lo = int(result.get("covered_from", plan["first"]) or 0)
        hi = int(result.get("covered_to") or plan["last"])
        lo = max(0, min(lo, total))
        fresh_marks = list(result.get("signals") or [])
        # Anything previously known inside the slab just re-analysed is
        # replaced by what the slab found, so a strategy whose settings
        # changed cannot leave a stale arrow behind.
        kept = [m for m in kept if not (lo <= int(m.get("index", -1)) < hi)]
        merged = kept + fresh_marks
        merged.sort(key=lambda m: (int(m.get("index", 0)), str(m.get("strategy", ""))))
        # Thinned here as well as inside the replay: each slab is under
        # the cap on its own, but five slabs added together need not be.
        # thin_marks keeps the best of each slice of history rather than
        # the newest, so accumulating coverage never pushes the spring
        # off the chart to make room for the autumn.
        from ..signals.strategy_signals import thin_marks
        merged = thin_marks(merged)

        if held:
            old_lo = index_of.get(held.get("from_time") or "")
            old_end = index_of.get(held.get("to_time") or "")
            covered_lo = lo if old_lo is None else min(old_lo, lo)
            covered_hi = hi if old_end is None else max(old_end + 1, hi)
        else:
            covered_lo, covered_hi = lo, hi

        covered_lo = max(0, min(covered_lo, total))
        covered_hi = max(covered_lo, min(covered_hi, total))
        store = self._marks_store()
        store[key] = {
            "from_time": times[covered_lo] if covered_lo < total else "",
            "to_time": times[covered_hi - 1] if 0 < covered_hi <= total else "",
            "signals": merged,
        }
        # One cache per chart the trader looks at; a handful of symbols
        # at a time, so this only stops an unbounded leak over days.
        while len(store) > CHART_MARK_CACHES:
            store.pop(next(iter(store)))

        # "Complete" means the MARKED WINDOW is covered, not the whole
        # series. It used to mean reaching WARMUP_BARS - the very first
        # bar of six months of history - which the marked region no
        # longer extends to by design. Left as it was, the desk would
        # hold its "still analysing" wash over the chart for ever and
        # keep polling for work that was already finished.
        complete = covered_lo <= self._mark_target_floor(total) and covered_hi >= total

        # Re-planning against the state just written is the only way
        # to be sure this says what the next call will really do; a
        # second copy of the planner's arithmetic here would drift
        # away from it the first time either changed.
        next_lo = next_hi = None
        if not complete:
            nxt = self._chart_mark_plan(symbol, timeframe, armed, bars)
            if not nxt.get("complete"):
                next_lo = max(0, min(total, int(nxt.get("first") or 0)))
                next_hi = max(next_lo, min(total, int(nxt.get("last") or 0)))

        return {
            **result,
            "signals": merged,
            "count": len(merged),
            "covered_from": covered_lo,
            "covered_to": covered_hi,
            # Which bars those are, by name. The desk cannot turn an
            # index into a date on its own - it holds a different slice
            # of the history than the engine analysed - and "analysed
            # from bar 14 200" is not something a trader can check
            # against their own chart.
            "covered_from_time": times[covered_lo] if covered_lo < total else "",
            "covered_to_time": times[covered_hi - 1] if 0 < covered_hi <= total else "",
            "total_bars": total,
            # The slab the NEXT call will work through, so the desk can
            # point at the candles being analysed instead of shading
            # everything that is not finished yet and labelling the lot
            # "analysing". Asked for in those words: show exactly which
            # candles the analysis is running on.
            "next_from": next_lo,
            "next_to": next_hi,
            "next_from_time": times[next_lo] if next_lo is not None and next_lo < total else "",
            "next_to_time": times[next_hi - 1] if next_hi and 0 < next_hi <= total else "",
            # The desk draws a boundary at `covered_from` and says marks
            # start there, so an unanalysed stretch is never read as a
            # stretch with no setups. `complete` turns that off.
            "complete": bool(complete),
            "analysing": not complete,
        }

    #: A backtest assembles its window one month at a time. See
    #: _pull_history_in_steps - and AURION_HIST_MONTH_DAYS in the
    #: expert, which is the other half of the same agreement.
    BACKTEST_STEP_DAYS = 31

    #: Enough steps for half a year, and a hard stop either way: a
    #: loop that asks the terminal for history is exactly the kind
    #: that must not be able to run for ever.
    BACKTEST_MAX_STEPS = 8

    async def _pull_history_in_steps(
        self, symbol: str, timeframe: str, want: int, asked_from: str = "",
    ) -> list[dict[str, Any]]:
        """Fetch a long window as a series of short ones.

        The expert now serves at most a month of new history per
        request, because asking it for six months in one breath is
        what buried the engine when the chart first attached. A
        backtest over three months still needs its three months, so
        it asks three times instead of demanding them all at once.

        Each round is a request the engine can answer promptly and
        the terminal can satisfy, and the rounds stop as soon as one
        of three things is true: the window is covered, the oldest
        day asked for is on hand, or a round brought nothing new -
        which is what a broker that has no more history looks like,
        and is an answer rather than a reason to keep asking.
        """
        from ..util.history import bars_for_days

        step = max(1, int(bars_for_days(timeframe, self.BACKTEST_STEP_DAYS)))
        bars: list[dict[str, Any]] = []
        reach = 0
        for _ in range(self.BACKTEST_MAX_STEPS):
            reach = min(int(want), reach + step) if want else reach + step
            got = await self.bridge.pull_candles(
                symbol, timeframe, reach, need_from=asked_from, tries=3,
            ) or []
            gained = len(got) > len(bars)
            if got:
                bars = got
            if len(bars) >= int(want or 0) and want:
                break
            if asked_from:
                oldest = str((bars[0] or {}).get("time") or "")[:10] if bars else ""
                if oldest and oldest <= asked_from:
                    break
            if not gained:
                # The terminal has stopped finding more. Asking again
                # would only repeat the same download.
                break
        return bars

    async def chart_signals(self, symbol: str, timeframe: str = "M15", count: int = 0, strict: bool = True) -> dict[str, Any]:
        # premium feature
        if not self.license.feature("chart_signals"):
            return {"ok": False, "error": "premium_required", "feature": "chart_signals", "upgrade": True}
        symbol = str(symbol or self.active_symbol or "").strip()
        timeframe = str(timeframe or self.active_timeframe or "M15")
        if not symbol:
            return {"ok": False, "error": "symbol_required"}
        # Need candles
        # Signals must cover the window the trader is reading them on -
        # no more and no less. The cached bars used to be accepted
        # whenever there were more than 50 of them, so on a chart that
        # had just opened the analysis ran over the last fifty bars and
        # the rest of the window came back blank.
        #
        # The count comes from the desk and is believed, because the
        # desk is the only side that knows how many bars are on screen.
        # Raising it to the full HISTORY_DAYS floor here meant every
        # chart that opened replayed every armed strategy over six
        # months of bars - 259 200 of them on M1 - to draw marks on the
        # day and a half that was visible.
        want = requested_window(timeframe, count)
        bars = [c.to_dict() for c in self.bridge.candles_of(symbol, timeframe)]
        if len(bars) < want:
            try:
                bars = await self.bridge.pull_candles(symbol, timeframe, want, exact=True) or bars
            except Exception:
                bars = bars or []
        if not bars or len(bars) < 30:
            return {"ok": False, "error": "no_candles", "symbol": symbol, "timeframe": timeframe}
        # The marks on the chart have to be the armed strategies' own output.
        # They used to be a fixed EMA-cross detector that ran regardless of
        # what the trader had switched on, so the chart and the order book
        # were two different systems and only one of them placed trades.
        armed = [(name, slot.get("inst")) for name, slot in self.book.items() if slot.get("enabled")]
        try:
            if armed:
                from ..signals.strategy_signals import replay

                # Where to look this time.
                #
                # Reported: "the signals are only drawn at the right
                # edge of the chart, not across all the months". They
                # were - the replay covered the last 240 bars. Covering
                # six months instead is 17 280 bars on M15, and at
                # roughly 11 ms a bar for smart_money that is a
                # three-minute HTTP request, so it cannot simply be
                # widened.
                #
                # So the analysis is remembered and extended: each
                # refresh does the new bars at the right-hand edge
                # first, then spends what budget is left pushing the
                # covered region further back. The chart fills in from
                # the right over a few refreshes instead of being
                # permanently blank behind bar 240.
                plan = self._chart_mark_plan(symbol, timeframe, armed, bars)

                result = await asyncio.to_thread(
                    replay,
                    bars,
                    armed,
                    symbol,
                    timeframe,
                    # No AI read is passed in on purpose. There is only
                    # today's, and applying it to a bar from last Tuesday
                    # would be look-ahead dressed up as confluence. A
                    # strategy with require_ai_agree therefore shows its
                    # pure structural setups here, which is the honest
                    # answer to "what did the strategy see".
                    ai={},
                    on_error=lambda name, exc: log.warning("chart replay: %s failed: %s", name, exc),
                    # The marks obey the money rule too. A stop drawn at a
                    # distance the engine would refuse to send is a trade
                    # the trader cannot actually take.
                    cap=self._chart_stop_cap(symbol),
                    budget_seconds=CHART_MARK_BUDGET_SECONDS,
                    first=plan["first"],
                    last=plan["last"],
                )
                result = self._chart_marks_merge(symbol, timeframe, armed, bars, plan, result)
            else:
                # Nothing armed. Falling back to the indicator read keeps the
                # chart useful, but it is labelled so nobody mistakes it for
                # what the robot would do.
                from ..signals.chart_signals import get_chart_signals

                result = await asyncio.to_thread(get_chart_signals, bars, bool(strict))
                result["source"] = "indicator"
                result["strategies"] = []
            result["symbol"] = symbol
            result["timeframe"] = timeframe
            return result
        except Exception as exc:
            log.exception("chart signals failed")
            return {"ok": False, "error": readable_error(str(exc))}

    async def backtest(self, body: dict[str, Any]) -> dict[str, Any]:
        # Every refusal from here on carries a `code` beside its English
        # `error`.
        #
        # The desk showed the English sentence verbatim - a line of
        # English in the middle of a Persian results card, which is
        # what "English is still showing in the backtest" was about.
        # The sentence stays, because it is what goes into the log and
        # what can be quoted in a bug report; the code is what the desk
        # translates, and `args` carries the parts of the sentence that
        # are facts rather than words.
        if bool((self.backtest_run or {}).get("running")):
            return {"ok": False, "code": "backtest_busy", "error": "backtest_busy",
                    "running": True, **self.backtest_run}
        symbol = str(body.get("symbol") or self.active_symbol or "")
        timeframe = str(body.get("timeframe") or self.active_timeframe or "M15")
        if not symbol or not self._is_ea_symbol(symbol):
            return {"ok": False, "code": "no_ea_symbol",
                    "args": {"symbol": symbol},
                    "error": "no AurionBridge on that symbol — attach the EA first"}
        # The trader must be able to backtest anywhere inside the thirty
        # days the chart shows. Cached bars were taken as sufficient at 90
        # of them, which on M5 is seven hours, so a run launched from a
        # fresh chart silently tested a sliver of the visible history.
        want = at_least_window(timeframe, body.get("bars"))
        # A run over a named period needs the bars of THAT period, and
        # the promise-sized window is measured from now - so a request
        # for "last month" on a desk whose cache starts three weeks ago
        # used to be answered "no bars in that period", which reads as
        # a data fault for what is really an unfetched window. Size the
        # ask from the oldest day actually being asked for.
        want = max(want, bars_to_cover(timeframe, body.get("from")))
        bars = [c.to_dict() for c in self.bridge.candles_of(symbol, timeframe)]
        # Whether to fetch is a question about DATES, not about counts.
        #
        # This used to be `len(bars) < want` alone, and that comparison
        # is the second half of "I pick November and it tests some
        # other month". Both sides of it are counts, and a count says
        # nothing about WHERE the bars are. A cache holding the
        # six-month window is longer than almost any `want` - on M1 it
        # is the 300 000-bar ceiling - so a request that starts before
        # that window satisfied the test instantly, no fetch was made,
        # and the run was answered out of bars that could not contain
        # the period the trader chose.
        #
        # So ask the other question as well: does what we hold actually
        # reach back to the first day being asked for? If it does not,
        # fetch regardless of how many bars there are.
        asked_from = str(body.get("from") or "").strip()[:10]
        oldest_held = str((bars[0] or {}).get("time") or "")[:10] if bars else ""
        too_recent = bool(asked_from and oldest_held and asked_from < oldest_held)
        if len(bars) < want or too_recent:
            # Three attempts, not one.
            #
            # Reported: "I tried to backtest M5 on a symbol, the app
            # had that symbol on H1, and the M5 run said there is
            # nothing there." There was nothing there - yet. A
            # timeframe no chart has been opened on does not exist in
            # the terminal until something asks for it, the expert's
            # first CopyRates on it comes back empty while MetaTrader
            # goes to the broker, and the single ask this made was
            # over long before the series arrived. The answer then
            # read as a verdict on the broker's archive instead of a
            # report on a download that had just started.
            bars = await self._pull_history_in_steps(
                symbol, timeframe, want, asked_from,
            ) or bars
        if not bars:
            # Still nothing. Say which of the two it is, because they
            # need opposite things from the trader: waiting, or giving
            # up on this symbol. An expert is attached (checked above),
            # so a timeframe the terminal genuinely has no bars for at
            # all is the rarer case by far.
            depth = {}
            try:
                depth = self.bridge.hist_depth(symbol, timeframe) or {}
            except Exception:
                depth = {}
            # The terminal ANSWERED and said it holds none: that is a
            # fact about the broker's archive and waiting will not
            # change it. Anything else - no answer yet, or an answer
            # saying it holds bars we have not received - is a
            # download in progress, and telling that trader there is
            # "no history" sends them to the wrong place entirely.
            answered = bool(depth.get("at"))
            try:
                available = int(depth.get("available") or 0)
            except (TypeError, ValueError):
                available = 0
            if answered and available <= 0:
                return {"ok": False, "code": "no_history",
                        "args": {"symbol": symbol, "timeframe": timeframe},
                        "depth": depth,
                        "error": "no real MT5 history available for this symbol/timeframe",
                        "build_id": BUILD_ID}
            return {"ok": False, "code": "history_downloading",
                    "args": {"symbol": symbol, "timeframe": timeframe,
                             "have": 0, "want": int(want)},
                    "depth": depth,
                    "downloading": True,
                    "error": (f"{timeframe} candles for {symbol} are still being "
                              f"downloaded from MetaTrader — none have arrived yet"),
                    "build_id": BUILD_ID}

        # A run over one month, one week or one day, chosen from the
        # calendar. Without this the only testable period was "all the
        # history there is", which over six months of M1 is 259 200 bars
        # and a very long wait for an answer about one week in March.
        window = _slice_bars(bars, body.get("from"), body.get("to"))
        if window.get("error"):
            # Say WHICH history exists. "No bars in that period" is true
            # and useless: the two causes - a period before this
            # broker's history begins, and a closed market - need
            # different actions from the trader, and only the first one
            # can be distinguished by naming the oldest bar there is.
            oldest = str((bars[0] or {}).get("time") or "")[:10]
            newest = str((bars[-1] or {}).get("time") or "")[:10]
            detail = window["error"]
            code = str(window.get("code") or "no_bars_in_period")
            args = {"symbol": symbol, "timeframe": timeframe,
                    "oldest": oldest, "newest": newest}
            if oldest and newest:
                detail = (
                    f"{detail} — this terminal only has {timeframe} bars "
                    f"from {oldest} to {newest} for {symbol}"
                )
                code = "no_bars_in_period_have"
            # A series that is still coming down is not a series that
            # ends where it currently ends. Saying "this terminal only
            # has March onwards" about a download that is thirty
            # seconds old sends the trader to change broker settings
            # over a window that is about to arrive.
            filling = len(bars) < want
            if filling:
                args["filling"] = True
                code = code + "_filling"
            return {"ok": False, "code": code, "args": args,
                    "filling": filling, "error": detail, "build_id": BUILD_ID}
        bars = window["bars"]
        tested_from = window["from"]
        tested_to = window["to"]

        spec = body.get("strategy") or {"kind": "builtin", "name": "ema_rsi", "params": body.get("params") or {}}
        # The robot on its own, with no strategy underneath it. Its one
        # setting is the confidence floor, and the honest value for it
        # is the one the live robot is running on right now -- otherwise
        # the replay answers for a default nobody trades.
        if str(spec.get("kind") or "") == "robot" or str(spec.get("name") or "").lower() == "robot":
            params = dict(spec.get("params") or {})
            params.setdefault("min_confidence", float(getattr(self, "min_ai_confidence", 0.35) or 0.0))
            spec = {**spec, "kind": "robot", "name": "robot", "params": params}
        try:
            inst = self.loader.build(spec)
        except StrategyValidationError as exc:
            # The detail is the strategy author's own fault message and
            # cannot be translated; the heading around it can.
            return {"ok": False, "code": "strategy_invalid",
                    "args": {"detail": readable_error(str(exc))},
                    "error": readable_error(str(exc)), "build_id": BUILD_ID}
        except Exception as exc:
            # Not a validation error, so it is something the loader did
            # not expect - an errno included. A backtest answers over
            # the websocket rather than through the endpoint wrapper, so
            # the net has to be here or there is none at all.
            log.exception("backtest could not build the strategy")
            return {"ok": False, "error": readable_error(str(exc)), "build_id": BUILD_ID}
        started = utc_iso()
        # A cancel from the previous run must not kill this one before
        # it has replayed a bar.
        self._backtest_cancel.clear()
        self.backtest_run = {
            "ok": True,
            "running": True,
            "accepted": True,
            "mode": "backtest",
            "symbol": symbol,
            "timeframe": timeframe,
            "strategy": getattr(inst, "name", str(spec.get("name") or "")),
            "bars": len(bars),
            # Echoed so the desk can title the run with the period the
            # trader picked, not the period it assumes was used.
            "from": tested_from,
            "to": tested_to,
            "progress": 0,
            "started": started,
            # Stated, so the result can be read against the settings it
            # was produced under rather than assumed to be defaults.
            "volume_mode": str(getattr(self, "volume_mode", "auto")),
            "manual_volume": float(getattr(self, "manual_volume", 0.0) or 0.0),
            "max_open": int(self._total_cap()),
        }
        await self.bus.publish("backtest", dict(self.backtest_run))
        equity = float(body.get("initial_equity") or self.bridge.account.equity or 10_000)
        self._backtest_task = asyncio.create_task(
            self._run_backtest(
                inst, bars, symbol, timeframe, equity, started,
                # The bars prepended BEFORE the chosen period, so the
                # replay skips exactly those and starts trading on the
                # day the trader picked. See _run_backtest.
                int(window.get("warmup") or 0),
            ),
            name=f"aurion-backtest-{symbol}",
        )
        # Answer now. The run itself reports over the bus.
        #
        # This used to hold the HTTP request open for the whole replay. The
        # desk's proxy gives up after 25 seconds and reports "engine
        # offline", so a backtest that took longer than that - which is most
        # of them, because the AI is asked for a fresh read on every bar -
        # finished perfectly in the engine and told the trader their engine
        # had died. Nothing was wrong except the waiting.
        return dict(self.backtest_run)

    async def cancel_backtest(self) -> dict[str, Any]:
        """Call a running replay off.

        Asked for directly: "put an option in the backtest to cancel
        it". A replay asks the AI for a read on every bar, so a long
        window is minutes of work with no way out but closing the desk.

        Two things have to happen and only one of them is the task.
        The replay body runs inside asyncio.to_thread, and cancelling a
        task cannot interrupt a thread, so the flag is what actually
        stops the work; the task handle is only used to wake a run that
        has not reached its bar loop yet. The run then ends through its
        normal path - partial result, bus publish, journal line - so a
        cancelled backtest is a shorter result and not an error.

        Refusals carry a `code`, like every other refusal here, because
        the desk translates the code and never the English sentence.
        """
        if not bool((self.backtest_run or {}).get("running")):
            return {"ok": False, "code": "backtest_idle",
                    "error": "no backtest is running"}
        if self._backtest_cancel.is_set():
            # Already asked for. Saying so is not an error - the trader
            # pressed the button twice, which is what people do when a
            # long run takes a moment to notice.
            return {"ok": True, "cancelling": True, "running": True,
                    **(self.backtest_run or {})}
        self._backtest_cancel.set()
        state = {**(self.backtest_run or {}), "running": True, "cancelling": True}
        self.backtest_run = state
        await self.bus.publish("backtest", dict(state))
        await self.journal("info", "backtest", "Backtest cancelled by the trader")
        return {"ok": True, "cancelling": True, **state}

    def _backtest_pip_size(self, symbol: str) -> float:
        """How much price a pip is, for this broker's quote of this symbol.

        The result listed money per trade and nothing about distance, so
        "how far did it go" could only be worked out from two prices
        with five decimals each. Money also conflates distance with lot
        size, which makes two trades of identical quality look unlike
        each other.

        The convention, and it is only a convention: on a quote with
        three or five decimals the last digit is a fractional pip, so a
        pip is ten points. Everywhere else a pip is one point - which
        for a two-decimal metal means 0.01, the broker's own step,
        because there is no agreed pip on gold and inventing one would
        be worse than reporting the step the broker actually quotes.

        0 when the broker will not say. The caller then reports no pip
        figure at all rather than a number derived from a guess.
        """
        try:
            spec = self.symbol_spec(str(symbol or ""))
        except Exception:
            log.exception("backtest could not read the spec for %s", symbol)
            return 0.0
        if not spec.usable:
            return 0.0
        try:
            digits = int(spec.digits)
            point = float(spec.tick_size)
        except (TypeError, ValueError):
            return 0.0
        if point <= 0:
            return 0.0
        return point * 10.0 if digits in (3, 5) else point

    def _backtest_point_value(self, symbol: str) -> float:
        """What one whole unit of price is worth, per 1.0 lot, in money.

        This was the number behind "the backtest trades in cents". It
        was the literal 1.0, so the replay priced a trade as

            (exit - entry) * volume

        and on a five-digit pair a 50-point winner at 0.10 lots came
        out as 0.0005 - not a small profit, a profit in the wrong unit
        entirely. Every figure built on it inherited the mistake:
        equity, drawdown, the curve, and R, since the stop distance was
        converted the same way.

        The live side has had one answer to this question since the
        money rules went in: money = distance / tick_size * tick_value
        * volume (runtime/risk.py). Per whole unit of price and per
        lot, that is tick_value / tick_size - 10 000 on a typical FX
        pair, which is exactly the factor the results were missing.

        Asked of the same broker the replay's bars came from, so the
        test and the account agree. When the broker will not say - no
        MT5 connection, an EA that does not answer, an unknown symbol -
        it falls back to 1.0, which is what it always was. A guessed
        tick value is a wrong number stated with confidence, and the
        run reports the factor it used so nobody has to assume.
        """
        try:
            spec = self.symbol_spec(str(symbol or ""))
        except Exception:
            log.exception("backtest could not read the spec for %s", symbol)
            return 1.0
        if not spec.usable:
            return 1.0
        try:
            value = float(spec.tick_value) / float(spec.tick_size)
        except (TypeError, ValueError, ZeroDivisionError):
            return 1.0
        return value if value > 0 else 1.0

    #: The least run-up any replay gets, whatever period was asked for.
    #:
    #: Matches the Backtester's own default. A period that starts near
    #: the beginning of this terminal's history cannot be given the
    #: full run-up, and trading a strategy on bar three with empty
    #: indicators is not a test of anything.
    BACKTEST_MIN_WARMUP = 80

    async def _run_backtest(
        self,
        inst: Any,
        bars: list[dict[str, Any]],
        symbol: str,
        timeframe: str,
        equity: float,
        started: str,
        prepended: int = 0,
    ) -> dict[str, Any]:
        """The replay itself, off the request path, reporting as it goes.

        `prepended` is how many of `bars` sit BEFORE the period the
        trader chose - the run-up _slice_bars added so the indicators
        arrive primed.

        It used to be computed and then thrown away: the replay was
        told to skip a flat eighty bars, so on a range run it traded
        the other three hundred and twenty bars of run-up as though
        they were part of the test. A one-day backtest therefore filled
        up with trades dated three days before the day that was asked
        for, which is exactly "I pick a date and it tests a different
        one". The run-up is run-up; it is skipped in full.
        """
        loop = asyncio.get_running_loop()
        last_sent = 0.0

        def report(done: int, total: int, live: dict[str, Any] | None = None) -> None:
            # Called from the worker thread, so the publish has to be
            # handed back to the loop rather than awaited here.
            nonlocal last_sent
            now = time.time()
            if done < total and now - last_sent < 0.5:
                return
            last_sent = now
            pct = int(round(100.0 * done / max(1, total)))
            # Carry the replay's own state through, so the desk can draw
            # the test as it happens instead of showing a spinner and a
            # percentage. Namespaced under "live" so nothing here can be
            # mistaken for a finished result.
            state = {**(self.backtest_run or {}), "running": True, "progress": pct}
            if isinstance(live, dict):
                state["live"] = dict(live)
            self.backtest_run = state
            loop.call_soon_threadsafe(
                lambda: asyncio.ensure_future(self.bus.publish("backtest", dict(state)))
            )

        try:
            # Replay with the desk's own settings, not the backtester's
            # defaults. The lot mode decides what each entry is sized at
            # and the open-trade cap decides how many may run at once;
            # with neither passed through, a replay reported the result
            # of a 0.1-lot, one-trade-at-a-time robot nobody is running.
            warmup = max(self.BACKTEST_MIN_WARMUP, int(prepended or 0))
            # Never so much run-up that there is nothing left to test:
            # a short period near the start of history would otherwise
            # be skipped entirely and report zero trades.
            warmup = min(warmup, max(1, len(bars) - 5))
            result = await asyncio.to_thread(
                self.backtester.run, inst, bars, symbol, timeframe, equity,
                self._backtest_point_value(symbol), warmup, None, report,
                str(getattr(self, "volume_mode", "auto")),
                float(getattr(self, "manual_volume", 0.0) or 0.0),
                int(self._total_cap()),
                self._backtest_pip_size(symbol),
                # Read once per bar inside the replay. This is the only
                # thing that can stop a run already in the worker
                # thread; see cancel_backtest.
                self._backtest_cancel.is_set,
            )
        except Exception as exc:
            log.exception("backtest failed")
            result = {
                "ok": False,
                "error": readable_error(str(exc)),
                "build_id": BUILD_ID,
                "mode": "backtest",
                "symbol": symbol,
                "timeframe": timeframe,
            }
        result = dict(result or {})
        result["mode"] = "backtest"
        result["running"] = False
        # A run that was called off reports what it replayed, labelled.
        # The flag is read before it is cleared, and the result is
        # trusted first: the backtester sets `cancelled` itself when it
        # breaks out of the bar loop, and a run that finished in the
        # instant between the press and the check is a finished run.
        cancelled = bool(result.get("cancelled")) or (
            self._backtest_cancel.is_set() and not result.get("ok")
        )
        if cancelled:
            result["cancelled"] = True
        result.pop("cancelling", None)
        self._backtest_cancel.clear()
        # Progress is where it stopped, not a lie about completion.
        result["progress"] = 100 if not cancelled else int(
            (self.backtest_run or {}).get("progress") or 0
        )
        result["started"] = started
        result["finished"] = utc_iso()
        self.backtest_run = result
        await self.bus.publish("backtest", dict(result))
        await self.journal(
            "info" if result.get("ok") else "error",
            "backtest",
            (
                f"Backtest {'cancelled' if cancelled else 'finished'}: {symbol} {timeframe} "
                f"{(result.get('metrics') or {}).get('trades', 0)} trades, "
                f"win rate {float((result.get('metrics') or {}).get('win_rate') or 0):.0f}%"
                if result.get("ok")
                else f"Backtest failed: {result.get('error')}"
            ),
        )
        return result
