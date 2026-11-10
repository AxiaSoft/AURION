"""The AI must be asked about the chart the signal is on.

Reported from the desk as two separate complaints that turn out to be
one bug: strong setups that never become orders, and refusals whose
wording does not match what is on the screen.

``AIEngine.last`` is whichever chart was analysed most recently. On a
single-symbol desk that is the right answer by accident. Watch a second
symbol and it silently stops being the right answer — the reading still
looks sensible, it is simply about a different instrument. So a gold buy
could be refused with "the AI reads bear against this buy" because the
euro read bear, and the strategy evaluating gold was handed the euro's
direction, confidence and regime in its own context.

``AIEngine.by_symbol`` has carried ``ready``, ``direction`` and
``confidence`` per chart the whole time, and ``signal_quality()`` was
already reading it that way; the context and the account's veto were not.
``Trader._ai_for()`` is now the single lookup all three use.

These are behavioural checks — they build a trader, give the AI two
charts with opposite opinions, and look at what comes out.

    python3 -m pytest engine/tests/test_ai_reads_this_chart.py
"""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "engine"))

from aurion.runtime.trader import Trader  # noqa: E402


class _AI:
    """Two charts, opposite readings, and a `last` that is the wrong one."""

    def __init__(self) -> None:
        self.by_symbol: dict[str, dict[str, Any]] = {
            "XAUUSD": {"symbol": "XAUUSD", "ready": True, "direction": "bull", "confidence": 0.81},
            "EURUSD": {"symbol": "EURUSD", "ready": True, "direction": "bear", "confidence": 0.77},
        }
        # The euro was analysed most recently. Nothing about the gold
        # signal below has anything to do with it.
        self.last = dict(self.by_symbol["EURUSD"])


class _Bus:
    def __init__(self) -> None:
        self.sent: list[tuple[str, Any]] = []

    async def publish(self, topic: str, payload: Any) -> None:
        self.sent.append((topic, payload))


def _trader() -> Trader:
    t = Trader.__new__(Trader)
    t.ai = _AI()
    t.bus = _Bus()
    t.book = {}
    t.last_block = {}
    t.active_symbol = ""
    return t


# --------------------------------------------------------------- _ai_for


def test_each_chart_gets_its_own_reading() -> None:
    t = _trader()
    assert t._ai_for("XAUUSD").get("direction") == "bull", \
        "gold's own reading is bull and that is what gold must be judged by"
    assert t._ai_for("EURUSD").get("direction") == "bear"
    assert t._ai_for("XAUUSD").get("confidence") == 0.81, \
        "the confidence has to come from the same chart as the direction"


def test_a_chart_the_ai_has_never_seen_gets_no_opinion() -> None:
    """Silence, not somebody else's answer.

    This is the half that mattered: returning ``last`` here is what let
    one chart's bear read veto another chart's buy. An empty dict means
    ``ai.get("ready")`` is false, the veto stands down, and the trade is
    decided by the strategy's own rules — which is the honest outcome
    when the model has nothing to say about this market.
    """
    t = _trader()
    assert t._ai_for("US30") == {}, "an unanalysed chart must not inherit another chart's view"
    assert not t._ai_for("US30").get("ready")


def test_last_is_still_used_when_it_is_about_this_chart() -> None:
    """The fix must not throw away a perfectly good reading."""
    t = _trader()
    t.ai.by_symbol = {}
    t.ai.last = {"symbol": "EURUSD", "ready": True, "direction": "bear", "confidence": 0.7}
    assert t._ai_for("EURUSD").get("direction") == "bear"
    assert t._ai_for("XAUUSD") == {}


def test_an_unlabelled_reading_is_accepted() -> None:
    """A reading with no symbol is the one-chart desk, and still counts."""
    t = _trader()
    t.ai.by_symbol = {}
    t.ai.last = {"ready": True, "direction": "bull", "confidence": 0.6}
    assert t._ai_for("ANYTHING").get("direction") == "bull"


def test_a_broken_ai_object_costs_nothing() -> None:
    t = _trader()

    class _Bad:
        @property
        def by_symbol(self):  # noqa: ANN201
            raise RuntimeError("boom")

    t.ai = _Bad()
    assert t._ai_for("XAUUSD") == {}, "a fault in the AI must not take the order path with it"


def test_the_strategy_is_handed_its_own_charts_reading() -> None:
    """The quieter half of the same bug.

    Every strategy's context carried ``ai.last``, so ``with_trend`` and
    anything else reading ``ctx.ai`` on a basket desk was judging gold's
    setup by the euro's model output. No refusal was logged for that -
    the strategy simply declined, and the card said "hold".
    """
    t = _trader()

    class _Bridge:
        account = type("A", (), {"to_dict": lambda self: {}})()
        positions: list = []
        orders: list = []

        def candles_of(self, symbol, timeframe):  # noqa: ANN001, ANN201
            return [type("C", (), {"to_dict": lambda self: {"close": 1.0}})()]

    t.bridge = _Bridge()
    t.strategy = None
    ctx = t._ctx("XAUUSD", "M15")
    assert ctx.ai.get("direction") == "bull", \
        "the gold context must carry gold's reading, not the last chart analysed"
    assert t._ctx("US30", "M15").ai == {}, \
        "and a chart with no reading must carry none"


# ------------------------------------------------------- the account veto


def _entry_trader() -> Trader:
    t = _trader()
    t.require_ai_agree = True
    t.min_ai_confidence = 0.55
    t.last_signal = {}
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
    t._robot_volume = lambda payload: float(payload.get("volume") or 0.1)
    t.executed: list[dict[str, Any]] = []

    async def execute(payload):  # noqa: ANN001, ANN202
        t.executed.append(dict(payload))
        return {"ok": True}

    t.execute = execute
    t._sync_book_meta = lambda: None
    t.strategy_meta = {}
    return t


def _dispatch(t: Trader, payload: dict[str, Any]) -> None:
    asyncio.run(t._dispatch_signal(dict(payload), "strategy:ema_rsi"))


def test_a_gold_buy_is_not_refused_because_the_euro_reads_bear() -> None:
    """The reported fault, end to end.

    Gold's own reading is bull at 0.81 — comfortably over the 0.55 the
    trader asked for. Before the fix the veto read the euro instead and
    answered "the AI reads bear against this buy", naming a direction
    nobody could find on the gold chart.
    """
    t = _entry_trader()
    reached: list[str] = []
    # Stop the dispatch just past the veto, so this test is about the
    # veto and nothing downstream of it.
    t._resolve_symbol = lambda request: str(request.get("symbol") or "")
    t.signal_quality = lambda symbol, side, conf: reached.append(symbol) or {"score": 0.8, "reasons": []}
    t._entries_for_signal = lambda symbol, quality: 0
    t._open_count = lambda symbol: 0
    t._total_cap = lambda: 2
    t.smart_filters = False
    t._strategy_tag_for_request = lambda req: "ema_rsi"
    _dispatch(t, {"action": "buy", "symbol": "XAUUSD", "side": "buy", "volume": 0.1, "confidence": 0.9})

    assert reached == ["XAUUSD"], (
        "the gold buy must survive the AI veto — it was refused by the euro's reading: "
        f"{t.last_block.get('why')}"
    )
    assert t.last_block.get("code") not in {"ai_low", "ai_disagree"}


def test_the_veto_still_works_on_the_chart_it_is_about() -> None:
    """Loosening the lookup must not loosen the rule."""
    t = _entry_trader()
    t._resolve_symbol = lambda request: str(request.get("symbol") or "")
    _dispatch(t, {"action": "buy", "symbol": "EURUSD", "side": "buy", "volume": 0.1, "confidence": 0.9})
    assert t.last_block.get("code") == "ai_disagree", \
        "the euro really does read bear, so a euro buy is still refused"
    assert not t.executed


def test_a_chart_with_no_reading_is_decided_by_the_strategy() -> None:
    """No opinion is not a refusal.

    Before the fix this trade was judged by whichever chart the AI had
    last looked at, so a strategy could be vetoed on a market the model
    had never been shown.
    """
    t = _entry_trader()
    t._resolve_symbol = lambda request: str(request.get("symbol") or "")
    seen: list[str] = []
    t.signal_quality = lambda symbol, side, conf: seen.append(symbol) or {"score": 0.8, "reasons": []}
    t._entries_for_signal = lambda symbol, quality: 0  # stop before sizing
    t._open_count = lambda symbol: 0
    t._total_cap = lambda: 2
    t.smart_filters = False
    t._strategy_tag_for_request = lambda req: "ema_rsi"
    _dispatch(t, {"action": "buy", "symbol": "US30", "side": "buy", "volume": 0.1, "confidence": 0.9})
    assert seen == ["US30"], f"the veto refused a chart the AI has no opinion on: {t.last_block}"


if __name__ == "__main__":  # pragma: no cover
    import pytest

    raise SystemExit(pytest.main([__file__, "-q"]))
