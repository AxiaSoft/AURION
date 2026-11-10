"""A robot entry that is refused has to land somewhere a trader can read.

Reported from the desk: "I try a manual trade and get 'volume after
sizing is below the broker's minimum lot' — maybe that is also why the
robot never enters." Both halves were true and they were the same
defect seen twice.

The manual half is fixed in the money rule (see
``Trader._size_for_budget``). This file guards the other half: when the
order path itself refuses a robot ticket, the refusal used to break the
send loop and go no further. Everything *upstream* of the order path
records a refusal through ``_blocked()`` — the licence, the AI veto,
the slot ceiling — so the strategy card could explain itself. The order
path did not, so a ticket that died in the money rule or at the broker
left the card saying "hold" and the "why did nothing happen" line
blank. That is a robot that looks idle while it is actually being
turned away on every bar.

    python3 -m pytest engine/tests/test_a_refused_order_says_so.py
"""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "engine"))

from aurion.runtime.trader import Trader  # noqa: E402


class _Bus:
    def __init__(self) -> None:
        self.sent: list[tuple[str, Any]] = []

    async def publish(self, topic: str, payload: Any) -> None:
        self.sent.append((topic, payload))


def _trader(error: str) -> Trader:
    t = Trader.__new__(Trader)
    t.bus = _Bus()
    t.book = {"ema_rsi": {"enabled": True, "inst": object(),
                          "last_action": "idle", "last_reason": "", "last_ts": ""}}
    t.last_block = {}
    t.last_signal = {}
    t.strategy_meta = {}
    t.active_symbol = "XAUUSD"
    t.require_ai_agree = False
    t.smart_filters = False
    t.journalled: list[tuple[str, str, str]] = []

    class _Licence:
        def allow_bot_entry(self):  # noqa: ANN201
            return {"ok": True}

    class _Store:
        def record_signal(self, sig):  # noqa: ANN001, ANN201
            return None

    t.license = _Licence()
    t.store = _Store()

    async def journal(level, code, text, extra=None):  # noqa: ANN001, ANN202
        t.journalled.append((level, code, text))

    t.journal = journal
    t._sync_book_meta = lambda: None
    t._robot_volume = lambda payload: float(payload.get("volume") or 0.1)
    t._resolve_symbol = lambda request: str(request.get("symbol") or "")
    t._strategy_tag_for_request = lambda req: "ema_rsi"
    t.signal_quality = lambda symbol, side, conf: {"score": 0.8, "reasons": []}
    t._entries_for_signal = lambda symbol, quality: 1
    t._open_count = lambda symbol=None: 0
    t._total_cap = lambda: 2
    t.free_slots = lambda symbol: 2
    t._hold_slot = lambda symbol: None
    t._release_slot = lambda symbol: None
    t.volume_mode = "manual"

    t.attempts: list[dict[str, Any]] = []

    async def execute(payload):  # noqa: ANN001, ANN202
        t.attempts.append(dict(payload))
        return {"ok": False, "error": error}

    t.execute = execute
    return t


WHY = ("XAUUSD: this account allows 4.00 on one trade, but the smallest lot "
       "the broker takes (0.01) risks 12.00 with this stop.")


def _fire(t: Trader) -> None:
    asyncio.run(t._dispatch_signal(
        {"action": "buy", "symbol": "XAUUSD", "side": "buy", "volume": 0.1, "confidence": 0.9},
        "strategy:ema_rsi",
    ))


def test_a_refused_entry_reaches_the_strategy_card() -> None:
    t = _trader(WHY)
    _fire(t)
    assert t.attempts, "the ticket must actually have been attempted"
    assert t.book["ema_rsi"]["last_action"] == "blocked", \
        'the card said "hold", which is a lie — the strategy did not hold'
    assert WHY in t.book["ema_rsi"]["last_reason"]


def test_the_desks_last_block_carries_the_reason_verbatim() -> None:
    t = _trader(WHY)
    _fire(t)
    assert t.last_block.get("code") == "order_refused"
    assert t.last_block.get("why") == WHY
    assert t.last_block.get("symbol") == "XAUUSD"


def test_the_refusal_is_journalled_as_a_warning() -> None:
    t = _trader(WHY)
    _fire(t)
    assert any(code == "order_refused" and level == "warning"
               for level, code, _ in t.journalled), t.journalled


def test_a_refusal_with_no_message_still_says_something() -> None:
    """A broker that returns a bare failure must not produce an empty line."""
    t = _trader("")
    _fire(t)
    assert t.last_block.get("why"), "an empty reason is the fault all over again"


def test_the_loop_stops_after_a_refusal() -> None:
    """One refused ticket must not become three."""
    t = _trader(WHY)
    t._entries_for_signal = lambda symbol, quality: 3
    _fire(t)
    assert len(t.attempts) == 1


def test_the_order_path_quotes_the_money_rule_rather_than_the_broker() -> None:
    """execute() must hand on the sentence the sizing wrote.

    The old message named the broker's minimum lot, which is the one
    number in the whole chain that the trader cannot change. The reason
    the sizing recorded names the setting that unblocks them.
    """
    src = (ROOT / "engine" / "aurion" / "runtime" / "trader.py").read_text(encoding="utf-8")
    at = src.index("volume after sizing is below the broker's minimum lot")
    window = src[at - 700:at]
    assert 'getattr(self, "last_money_block"' in window, \
        "the refusal has to read the reason the money rule left behind"
    assert "return {\"ok\": False, \"error\": why or" in src


if __name__ == "__main__":  # pragma: no cover
    import pytest

    raise SystemExit(pytest.main([__file__, "-q"]))
