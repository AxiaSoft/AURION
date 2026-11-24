"""Signalling while the candle is still being written.

Reported, and open since the first list: "it should signal as the chart
moves, not only on finished candles". The marks on the chart came from
a replay over CLOSED bars, so a setup that appeared thirty seconds into
an M15 candle was invisible for the next fourteen and a half minutes —
the whole of the period the trader is sitting there for.

What is pinned here is the contract between the engine's watch pass and
the chart:

  * only entries are published, never a hold and never a fault;
  * every mark carries the TIME of the bar it was seen on, because the
    desk holds its own array and an index into ours lands on a
    different candle;
  * an empty list goes out as readily as a full one, so a setup that
    evaporates is seen to evaporate;
  * silence costs nothing when there was nothing to say;
  * and none of it can trade, raise, or leave a trace on the strategy.

    python3 -m pytest engine/tests/test_live_signalling.py
"""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "engine"))

from aurion.runtime import bus as bus_mod  # noqa: E402
from aurion.runtime.trader import Trader, _as_float  # noqa: E402

TRADER_SRC = (ROOT / "engine" / "aurion" / "runtime" / "trader.py").read_text(encoding="utf-8")
CHARTS_SRC = (ROOT / "apps" / "web" / "js" / "charts.js").read_text(encoding="utf-8")
APP_SRC = (ROOT / "apps" / "web" / "js" / "app.js").read_text(encoding="utf-8")


class _Signal:
    def __init__(self, action: str, **kw: object) -> None:
        self.action = action
        self.reason = str(kw.get("reason") or "structure and trend agree")
        self.price = kw.get("price", 1.2345)
        self.sl = kw.get("sl", 1.2300)
        self.tp = kw.get("tp", 1.2400)
        self.confidence = kw.get("confidence", 0.71)


class _Strategy:
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
            return _Signal(self.action)
        if self.action == "boom":
            raise RuntimeError("the strategy exploded")
        return None


class _Bus:
    def __init__(self) -> None:
        self.sent: list[tuple[str, dict]] = []

    async def publish(self, topic, payload):  # noqa: ANN001
        self.sent.append((topic, payload))


BAR_TIME = "2026-11-24T10:00:00"


def _watcher(action: str = "buy", *, names: tuple[str, ...] = ("price_action",)) -> tuple[Trader, _Bus]:
    """A Trader with nothing in it but the watch pass and a book."""
    t = Trader.__new__(Trader)
    t.book = {n: {"enabled": True, "inst": _Strategy(action)} for n in names}
    t.active_symbol = "EURUSD"
    t.active_timeframe = "M15"
    t._is_ea_symbol = lambda s: True
    t._watch_at = 0.0
    t.strategy_meta = {}
    t._sync_book_meta = lambda: None
    t.bus = _Bus()

    class _Ctx:
        # The last bar is the one being written, and it is the only one
        # whose time matters here.
        candles = ([{"time": f"2026-11-24T0{i}:00:00", "close": 1.2} for i in range(9)]
                   + [{"time": BAR_TIME, "close": 1.2345}] * 51)

    t._ctx = lambda *a, **k: _Ctx()
    return t, t.bus


def _forming(bus: _Bus) -> list[dict]:
    return [p for topic, p in bus.sent if topic == "live_signal"]


# ---------------------------------------------------------------- engine


def test_a_setup_on_the_open_candle_is_published() -> None:
    t, bus = _watcher("buy")
    asyncio.run(t._watch_strategies({"symbol": "EURUSD", "bid": 1.2344}))
    out = _forming(bus)
    assert len(out) == 1, "the watch pass has to tell the chart what it saw"
    payload = out[0]
    assert payload["symbol"] == "EURUSD"
    assert payload["timeframe"] == "M15"
    assert len(payload["signals"]) == 1
    mark = payload["signals"][0]
    assert mark["side"] == "buy"
    assert mark["forming"] is True, "a provisional mark must say so on the wire"
    assert mark["strategy"] == "price_action"


def test_the_mark_carries_the_time_of_the_bar_it_was_seen_on() -> None:
    """An index would land on a different candle on the desk's array."""
    t, bus = _watcher("sell")
    asyncio.run(t._watch_strategies({"symbol": "EURUSD"}))
    payload = _forming(bus)[0]
    assert payload["time"] == BAR_TIME
    assert payload["signals"][0]["time"] == BAR_TIME


def test_the_levels_come_with_it() -> None:
    """An arrow that cannot say where the stop goes is not a case."""
    t, bus = _watcher("buy")
    asyncio.run(t._watch_strategies({"symbol": "EURUSD"}))
    mark = _forming(bus)[0]["signals"][0]
    assert mark["price"] == 1.2345
    assert mark["sl"] == 1.2300
    assert mark["tp"] == 1.2400
    assert 0 < mark["confidence"] <= 1


def test_a_hold_is_not_a_mark() -> None:
    t, bus = _watcher("")
    asyncio.run(t._watch_strategies({"symbol": "EURUSD"}))
    out = _forming(bus)
    # Nothing was being shown and nothing is: no broadcast is owed.
    assert out == [], "an idle strategy must not cost a broadcast"
    assert t.book["price_action"]["live_action"] == "hold", "the card still updates"


def test_a_setup_that_evaporates_is_published_as_an_empty_list() -> None:
    """The one case silence would get wrong.

    If the engine only ever spoke when it had something, the last mark
    would stay on the chart for ever and the trader would act on a
    setup that stopped existing two minutes ago.
    """
    t, bus = _watcher("buy")
    asyncio.run(t._watch_strategies({"symbol": "EURUSD"}))
    assert len(_forming(bus)[0]["signals"]) == 1
    # The setup goes away.
    t.book["price_action"]["inst"].action = ""
    t._watch_at = 0.0
    asyncio.run(t._watch_strategies({"symbol": "EURUSD"}))
    out = _forming(bus)
    assert len(out) == 2, "the disappearance has to be sent"
    assert out[-1]["signals"] == []
    # And having said it once, it stops repeating itself.
    t._watch_at = 0.0
    asyncio.run(t._watch_strategies({"symbol": "EURUSD"}))
    assert len(_forming(bus)) == 2


def test_a_crashing_strategy_publishes_nothing_and_raises_nothing() -> None:
    t, bus = _watcher("boom")
    asyncio.run(t._watch_strategies({"symbol": "EURUSD"}))
    assert _forming(bus) == [] or _forming(bus)[0]["signals"] == []
    assert t.book["price_action"]["live_action"] == "fault"


def test_two_strategies_agreeing_are_two_marks() -> None:
    t, bus = _watcher("buy", names=("price_action", "smart_money"))
    asyncio.run(t._watch_strategies({"symbol": "EURUSD"}))
    marks = _forming(bus)[0]["signals"]
    assert len(marks) == 2
    assert sorted(m["strategy"] for m in marks) == ["price_action", "smart_money"]


def test_a_bar_with_no_time_is_not_published() -> None:
    """Without a bar time there is nowhere on the chart to put it."""
    t, bus = _watcher("buy")

    class _Ctx:
        candles = [{"close": 1.2} for _ in range(60)]

    t._ctx = lambda *a, **k: _Ctx()
    asyncio.run(t._watch_strategies({"symbol": "EURUSD"}))
    assert _forming(bus) == []


def test_the_watch_pass_still_leaves_no_trace() -> None:
    """Publishing must not change what is being looked at."""
    t, bus = _watcher("buy")
    inst = t.book["price_action"]["inst"]
    asyncio.run(t._watch_strategies({"symbol": "EURUSD"}))
    assert inst.refusals == {"no setup": 3}
    assert inst.last_refusal == "no setup"


def test_a_price_that_is_not_a_number_does_not_take_the_pass_down() -> None:
    """Strategies are user code; a price can be anything at all."""
    assert _as_float("nonsense") == 0.0
    assert _as_float(None) == 0.0
    assert _as_float(float("inf")) == 0.0
    assert _as_float(float("nan")) == 0.0
    assert _as_float("1.5") == 1.5
    t, bus = _watcher("buy")
    t.book["price_action"]["inst"].action = "buy"

    class _Junk(_Strategy):
        def on_candle(self, ctx):  # noqa: ANN001
            return _Signal("buy", price=object(), sl="x", tp=None, confidence=[])

    t.book["price_action"]["inst"] = _Junk("buy")
    asyncio.run(t._watch_strategies({"symbol": "EURUSD"}))
    mark = _forming(bus)[0]["signals"][0]
    assert mark["sl"] == 0.0 and mark["tp"] == 0.0 and mark["confidence"] == 0.0
    # An unusable entry falls back to the bar's own close rather than
    # putting the mark at price zero, off the bottom of the chart.
    assert mark["price"] == 1.2345


def test_the_entry_falls_back_to_the_live_price() -> None:
    t, bus = _watcher("buy")

    class _NoPrice(_Strategy):
        def on_candle(self, ctx):  # noqa: ANN001
            return _Signal("buy", price=0)

    t.book["price_action"]["inst"] = _NoPrice("buy")
    asyncio.run(t._watch_strategies({"symbol": "EURUSD", "bid": 1.2311}))
    assert _forming(bus)[0]["signals"][0]["price"] == 1.2311


def test_it_is_droppable_on_a_backlogged_desk() -> None:
    """Superseded two seconds later, like a tick. Never queued up."""
    assert "live_signal" in bus_mod.DROPPABLE


def test_forming_marks_never_become_orders() -> None:
    """The decision that counts is still taken on a closed bar.

    _publish_forming may read and send. If it ever gains the power to
    place, modify or close anything, this is the test that should have
    stopped it.
    """
    start = TRADER_SRC.index("async def _publish_forming(")
    end = TRADER_SRC.index("\n    async def ", start + 10)
    body = TRADER_SRC[start:end]
    for forbidden in ("_dispatch_signal", "send_order", "place_order", "_open_trade",
                      "close_position", "auto_trade"):
        assert forbidden not in body, f"the forming pass must not reach {forbidden}"


# ------------------------------------------------------------------ desk


def test_the_chart_draws_forming_marks_only_on_the_newest_bar() -> None:
    """The rule that makes them self-clearing.

    No message is needed to retire a provisional mark: the bar it was
    found on stops being the last one, and it stops being drawn.
    """
    start = CHARTS_SRC.index("paintLiveSignals(L) {")
    body = CHARTS_SRC[start:start + 4000]
    assert "barTime(sig.time) !== headTime" in body, "a mark off the head bar must be skipped"
    assert "if (!this.showSignals) return;" in body, "one switch governs all marks"
    assert "setLineDash" in body, "provisional marks are dashed, never solid"
    assert "ctx.stroke()" in body


def test_the_desk_refuses_a_reading_of_another_chart() -> None:
    start = APP_SRC.index("function applyLiveSignals(")
    body = APP_SRC[start:start + 2500]
    assert "sym !== S.symbol" in body
    assert "tf !== S.timeframe" in body
    assert "licFeat(\"chart_signals\")" in body, "premium is premium on this layer too"
    assert "S.signalsEnabled" in body and "S.showSignals" in body


def test_switching_symbol_clears_the_forming_layer() -> None:
    start = APP_SRC.index("async function pickMarket(")
    body = APP_SRC[start:start + 2500]
    assert "clearLiveSignals()" in body, \
        "a dashed BUY from the last symbol would read as a setup on this one"


def test_the_forming_layer_is_separate_from_the_confirmed_one() -> None:
    """They must never be merged: one is a finding, the other a guess."""
    assert "S.chartSignals = rows" not in APP_SRC
    assert "setLiveSignals" in APP_SRC and "setSignals" in APP_SRC
    assert "this.liveSignals = Array.isArray(signals)" in CHARTS_SRC


def test_the_card_says_a_forming_setup_is_provisional() -> None:
    assert 'sig.forming ? "  \u00b7 " + this.i18n("signal.forming"' in CHARTS_SRC
    assert 'signal.forming_note' in CHARTS_SRC
    import json
    for tag in ("en", "fa", "ar"):
        words = json.loads((ROOT / "lang" / f"{tag}.json").read_text(encoding="utf-8"))
        assert words["signal"]["forming"], f"{tag} has no word for a forming setup"
        assert words["signal"]["forming_note"]


TESTS = [v for k, v in sorted(globals().items()) if k.startswith("test_")]


if __name__ == "__main__":  # pragma: no cover
    for fn in TESTS:
        fn()
        print("  ok  " + fn.__name__)
    print("\nThe chart signals while the candle is still open.")
