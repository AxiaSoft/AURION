"""A setup must reach the desk the instant it exists.

Reported, in the trader's words: *"when AURION signals, notify at that
moment — signal or trade, so we do not miss the trade."*

Two holes produced that, and they are different holes.

1. ``_dispatch_signal`` published the signal *below* the AI veto. A
   setup the AI refused was therefore never published at all: the desk
   stayed silent and the trader found out from the chart afterwards. A
   refusal is the desk's opinion about an entry; the entry is still the
   news.

2. ``_run_enabled_strategies`` has a branch for "a gate is shut, do not
   send" — the robot disarmed, the kill switch down, outside hours. It
   wrote one warning line into a log nobody has open and published
   nothing. That is the mode where a human is supposed to be the one
   acting on the signal, and it was the quietest mode of all.

What is pinned here is the *ordering* and the *coverage*: the signal is
on the bus before anything can refuse it, every unsent entry is
announced with ``armed: False`` and a reason, and a dispatched one is
announced exactly once.

    python3 -m pytest engine/tests/test_a_signal_is_announced_at_once.py
"""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path
from types import SimpleNamespace
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "engine"))

from aurion.runtime.trader import Trader  # noqa: E402


class _Bus:
    def __init__(self) -> None:
        self.sent: list[tuple[str, Any]] = []

    async def publish(self, topic: str, payload: Any) -> None:
        self.sent.append((topic, payload))

    def signals(self) -> list[dict[str, Any]]:
        return [p for t, p in self.sent if t == "signal"]


def _base() -> Trader:
    t = Trader.__new__(Trader)
    t.bus = _Bus()
    t.book = {}
    t.last_block = {}
    t.last_signal = {}
    t.strategy_meta = {}
    t.active_symbol = "XAUUSD"
    t.require_ai_agree = False
    t.smart_filters = False
    t.journalled: list[tuple[str, str, str]] = []
    t.recorded: list[dict[str, Any]] = []

    class _Store:
        def record_signal(self, sig):  # noqa: ANN001, ANN201
            t.recorded.append(dict(sig))

    t.store = _Store()

    async def journal(level, code, text, extra=None):  # noqa: ANN001, ANN202
        t.journalled.append((level, code, text))

    t.journal = journal
    t._sync_book_meta = lambda: None
    return t


# --------------------------------------------------------------- dispatch


def _dispatcher(*, ai_direction: str = "bull", ai_conf: float = 0.9) -> Trader:
    t = _base()
    t.book = {"ema_rsi": {"enabled": True, "inst": object(),
                          "last_action": "idle", "last_reason": "", "last_ts": ""}}
    t.require_ai_agree = True
    t.min_ai_confidence = 0.35
    t.ai = SimpleNamespace(last={"ceiling": 0.9})

    class _Licence:
        def allow_bot_entry(self):  # noqa: ANN201
            return {"ok": True}

    t.license = _Licence()
    t._robot_volume = lambda payload: 0.05
    t._resolve_symbol = lambda request: str(request.get("symbol") or "")
    t._strategy_tag_for_request = lambda req: "ema_rsi"
    t._ai_for = lambda symbol: {"ready": True, "confidence": ai_conf, "direction": ai_direction}
    t._ai_ceiling_note = lambda: ""

    async def warn():  # noqa: ANN202
        return None

    t._warn_unreachable_ai = warn
    t.signal_quality = lambda symbol, side, conf: {"score": 0.8, "reasons": []}
    t._entries_for_signal = lambda symbol, quality: 1
    t.free_slots = lambda symbol: 2
    t._hold_slot = lambda symbol: None
    t._release_slot = lambda symbol: None
    t.volume_mode = "manual"
    t.attempts: list[dict[str, Any]] = []

    async def execute(payload):  # noqa: ANN001, ANN202
        t.attempts.append(dict(payload))
        return {"ok": True, "ticket": 1}

    t.execute = execute
    return t


def _fire(t: Trader) -> None:
    asyncio.run(t._dispatch_signal(
        {"action": "buy", "symbol": "XAUUSD", "side": "buy", "volume": 0.1, "confidence": 0.9},
        "strategy:ema_rsi",
    ))


def test_a_signal_the_ai_refuses_is_still_announced() -> None:
    # The whole point. Published first, vetoed second.
    t = _dispatcher(ai_direction="bear")
    _fire(t)
    assert not t.attempts, "the AI veto must still refuse the order"
    sigs = t.bus.signals()
    assert len(sigs) == 1, f"the vetoed setup was never announced: {t.bus.sent}"
    assert sigs[0]["symbol"] == "XAUUSD"
    assert sigs[0]["action"] == "buy"


def test_a_low_confidence_veto_still_announces() -> None:
    t = _dispatcher(ai_conf=0.01)
    _fire(t)
    assert not t.attempts
    assert len(t.bus.signals()) == 1


def test_a_dispatched_signal_is_announced_exactly_once() -> None:
    t = _dispatcher()
    _fire(t)
    assert t.attempts, "this one should have reached the broker"
    assert len(t.bus.signals()) == 1, "a duplicate card for one setup is worse than none"


def test_the_announcement_carries_what_the_card_prints() -> None:
    t = _dispatcher()
    _fire(t)
    sig = t.bus.signals()[0]
    # Sized by the licence block above the publish, tagged by the one
    # beside it - so moving the publish earlier costs the card nothing.
    assert sig["volume"] == 0.05, "the card would show no lot size"
    assert sig["strategy"] == "ema_rsi", '"from strategy" needs this'
    assert sig["armed"] is True
    assert sig["ts"], "the desk de-duplicates on the timestamp"


def test_the_announcement_is_recorded_as_well_as_published() -> None:
    t = _dispatcher()
    _fire(t)
    assert t.recorded, "the signal history lost the entry"


def test_the_publish_is_above_the_veto_in_the_source() -> None:
    # Ordering is the behaviour here, and a future edit that reorders
    # these two blocks would pass every test above by accident only
    # while the veto happens to allow the trade.
    src = (ROOT / "engine" / "aurion" / "runtime" / "trader.py").read_text(encoding="utf-8")
    start = src.index("    async def _dispatch_signal(self, signal, source: str) -> None:")
    body = src[start:start + 6000]
    publish = body.index('await self.bus.publish("signal", self.last_signal)')
    veto = body.index("# The AI veto lives here and nowhere else.")
    assert publish < veto, "the announcement slipped back below the AI veto"


# ----------------------------------------------------- the disarmed robot


class _Signal(dict):
    pass


def _runner(blocked: list[str] | None = None) -> Trader:
    t = _base()

    class _Inst:
        last_refusal = ""

        def on_candle(self, ctx):  # noqa: ANN001, ANN201
            return {"action": "buy", "symbol": "XAUUSD", "side": "buy",
                    "sl": 2390.0, "tp": 2420.0, "confidence": 0.7,
                    "reason": "breakout"}

    t.book = {"atr_breakout": {"enabled": True, "inst": _Inst(),
                               "last_action": "idle", "last_reason": "", "last_ts": ""}}
    t._note_symbol = lambda slot, symbol, **kw: None
    t._signal_bits = lambda signal: (str((signal or {}).get("action") or ""),
                                     str((signal or {}).get("reason") or ""))
    return t


def _run(t: Trader, blocked: list[str] | None = None) -> None:
    ctx = SimpleNamespace(symbol="XAUUSD", timeframe="M15")
    asyncio.run(t._run_enabled_strategies(ctx, execute=False, blocked=blocked or []))


def test_a_disarmed_robot_still_announces_the_setup() -> None:
    t = _runner()
    _run(t, ["robot is off"])
    sigs = t.bus.signals()
    assert len(sigs) == 1, f"nothing told the trader: {[x[0] for x in t.bus.sent]}"
    assert sigs[0]["armed"] is False, "it must not look like an order on the way"
    assert "robot is off" in sigs[0]["why"], sigs[0]


def test_the_unsent_signal_still_carries_the_levels() -> None:
    t = _runner()
    _run(t, ["kill switch"])
    sig = t.bus.signals()[0]
    for field in ("symbol", "sl", "tp", "timeframe", "strategy", "ts"):
        assert sig.get(field), f"{field} missing — the card cannot be acted on: {sig}"
    assert sig["strategy"] == "atr_breakout"


def test_a_closed_gate_with_no_reason_still_says_something() -> None:
    t = _runner()
    _run(t, [])
    assert t.bus.signals()[0]["why"], "an empty reason is a card that explains nothing"


def test_nothing_is_announced_when_no_strategy_fires() -> None:
    t = _runner()
    t.book["atr_breakout"]["inst"].on_candle = lambda ctx: {"action": "hold", "reason": "flat"}
    _run(t, ["robot is off"])
    assert not t.bus.signals(), "a hold is not news"


def test_the_unsent_signal_is_recorded_like_any_other() -> None:
    t = _runner()
    _run(t, ["robot is off"])
    assert t.recorded, "the history must not depend on whether an order was sent"
    assert t.last_signal.get("armed") is False
