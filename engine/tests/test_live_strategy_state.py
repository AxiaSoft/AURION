"""The strategy card has to be live, and every refusal has to be named.

Two faults are pinned here, both reported from a real desk:

1. "the state field never changes" - the card was painted from the last
   *order attempt*, so on a 15-minute chart it told the trader nothing for
   fourteen minutes out of every fifteen, and the word "hold" was used both
   for "the strategy sees no setup" and for "the desk refused the signal".

2. "the robot does not enter" - six different places could drop a signal,
   each wrote its own line in the journal, and nothing kept a record. There
   was no screen that could answer the question.

    python3 -m pytest engine/tests/test_live_strategy_state.py
"""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "engine"))

from aurion.runtime.trader import Trader  # noqa: E402

TRADER_SRC = (ROOT / "engine" / "aurion" / "runtime" / "trader.py").read_text(encoding="utf-8")
BUILTINS = ROOT / "engine" / "aurion" / "strategy" / "builtin"


class _Signal:
    def __init__(self, action: str, reason: str) -> None:
        self.action = action
        self.reason = reason


class _Strategy:
    """A strategy that answers, and that keeps a tally like the real ones."""

    def __init__(self, action: str) -> None:
        self.action = action
        self.calls = 0
        self.refusals: dict[str, int] = {"no setup": 3}
        self.last_refusal = "no setup"
        self.last_refusal_kind = "no setup"

    def on_candle(self, ctx):  # noqa: ANN001
        self.calls += 1
        self.refusals["watched"] = self.refusals.get("watched", 0) + 1
        self.last_refusal = "watched"
        if self.action in {"buy", "sell"}:
            return _Signal(self.action, "structure and trend agree")
        return None


def _watcher(action: str = "buy") -> tuple[Trader, _Strategy]:
    t = Trader.__new__(Trader)
    inst = _Strategy(action)
    t.book = {"king": {"enabled": True, "inst": inst}}
    t.active_symbol = "EURUSD"
    t.active_timeframe = "M15"
    t._is_ea_symbol = lambda s: True
    t._watch_at = 0.0
    t.strategy_meta = {}
    t._sync_book_meta = lambda: None

    class _Bus:
        sent: list = []

        async def publish(self, topic, payload):
            self.sent.append((topic, payload))

    t.bus = _Bus()

    class _Ctx:
        candles = [{"open": 1, "high": 1, "low": 1, "close": 1} for _ in range(60)]

    t._ctx = lambda *a, **k: _Ctx()
    return t, inst


def test_the_card_is_answered_between_candle_closes() -> None:
    t, inst = _watcher("sell")
    asyncio.run(t._watch_strategies({"symbol": "EURUSD"}))
    slot = t.book["king"]
    assert inst.calls == 1, "the watch pass has to actually ask the strategy"
    assert slot["live_action"] == "sell"
    assert slot["live_reason"]
    assert slot["live_ts"], "without a timestamp the desk cannot tell live from stale"


def test_a_strategy_with_no_setup_reads_as_hold_and_says_why() -> None:
    t, inst = _watcher("")
    asyncio.run(t._watch_strategies({"symbol": "EURUSD"}))
    assert t.book["king"]["live_action"] == "hold"
    assert t.book["king"]["live_reason"] == "watched"


def test_the_watch_pass_leaves_no_trace_on_the_strategy() -> None:
    """Looking must not change what is being looked at.

    The refusal tally is per closed bar and the desk reads it; a pass every
    couple of seconds would bury the real counts under its own.
    """
    t, inst = _watcher("")
    asyncio.run(t._watch_strategies({"symbol": "EURUSD"}))
    assert inst.refusals == {"no setup": 3}, "the tally belongs to closed bars"
    assert inst.last_refusal == "no setup"
    assert inst.last_refusal_kind == "no setup"


def test_it_is_throttled() -> None:
    t, inst = _watcher("buy")
    asyncio.run(t._watch_strategies({"symbol": "EURUSD"}))
    asyncio.run(t._watch_strategies({"symbol": "EURUSD"}))
    asyncio.run(t._watch_strategies({"symbol": "EURUSD"}))
    assert inst.calls == 1, "three ticks in the same second must cost one pass"
    assert Trader.WATCH_EVERY_SEC <= 5.0, "slower than this and the card stops looking live"


def test_every_refusal_goes_through_the_one_recorder() -> None:
    """Each drop has to leave a named record, or the question returns."""
    for code in ("license", "ai_low", "ai_disagree", "low_quality", "spread", "slots_full"):
        assert f'"{code}",' in TRADER_SRC, f"{code} is no longer recorded"
    assert TRADER_SRC.count("async def _blocked(") == 1
    assert 'self.last_block = {' in TRADER_SRC


def test_the_ai_veto_is_asked_once() -> None:
    """It used to be two switches for one rule, in two places.

    The built-ins carried their own require_ai_agree inside entry_allowed(),
    so the desk's switch did nothing on them and no log could say which of
    the two had refused the trade. The account's setting is the rule now.
    """
    for path in BUILTINS.glob("*.py"):
        if path.name.startswith("_"):
            continue
        src = path.read_text(encoding="utf-8")
        if '"require_ai_agree"' not in src:
            continue
        assert '"require_ai_agree": True' not in src, \
            f"{path.name} still vetoes on the AI by itself"


TESTS = [
    test_the_card_is_answered_between_candle_closes,
    test_a_strategy_with_no_setup_reads_as_hold_and_says_why,
    test_the_watch_pass_leaves_no_trace_on_the_strategy,
    test_it_is_throttled,
    test_every_refusal_goes_through_the_one_recorder,
    test_the_ai_veto_is_asked_once,
]


if __name__ == "__main__":  # pragma: no cover
    for fn in TESTS:
        fn()
        print("  ok  " + fn.__name__)
    print("\nThe cards are live and every refusal has a name.")
