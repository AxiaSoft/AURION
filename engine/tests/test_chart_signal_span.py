"""Chart marks: a real span, over a bounded and recent window.

This file has been through two opposite instructions, and both are
preserved here because the second one only makes sense against the
first.

**Originally:** "the signals are only drawn at the right edge of the
chart - draw them across all the months." They were. ``replay`` covered
``DEFAULT_WINDOW`` = 240 bars and nothing before it, so a trader
scrolling back found arrows bunched at the right and months of
apparently empty chart behind them. An absent mark does not read as
"not analysed", it reads as "no setup here", which is a much more
dangerous thing to believe. Two things were wrong and both were fixed,
and both fixes still stand and are still tested below:

* **It was quadratic.** Every bar was handed ``bars[:i+1]``, so bar
  10 000 got 10 000 bars. A strategy that declares ``history_window``
  has already said how far back it reads, so it is handed that much
  and a pass becomes linear.
* **Thinning kept only the newest sixty marks**, so widening the
  analysis would have changed nothing visible.

**Then:** covering all the months was done by walking backwards 1500
bars per refresh, for ever, on every chart at once - and with the
expert attached to real charts that is an engine that never returns to
idle. Reported as the engine flapping and the desk dying whenever the
EA was on, with the instruction: do not analyse the whole chart, one
day is what is being looked at.

So the marked region is now the last ``MARK_DAYS`` and the work ENDS.
The tests that asserted coverage walks backwards across the whole
series have been replaced by tests that it covers the window and then
stops; see test_chart_load_is_bounded.py. What has NOT changed is that
marks must span the region they claim to cover, must be thinned evenly
rather than trimmed to the newest, and must follow their bar when the
history scrolls - so those tests are untouched.

Run:
    python3 -m pytest engine/tests/test_chart_signal_span.py -q
"""

from __future__ import annotations

import datetime as dt
import random
import sys
import time
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from aurion.runtime.trader import MARK_DAYS, Trader  # noqa: E402
from aurion.signals import strategy_signals as ss  # noqa: E402
from aurion.strategy.builtin.ema_rsi import EmaRsi  # noqa: E402
from aurion.strategy.builtin.smart_money import SmartMoney  # noqa: E402


#: Bars of M15 inside the marked window - what the planner will ask
#: for on a settled chart. 96 bars to the day.
MARKED_M15 = MARK_DAYS * 24 * 60 // 15


def _bars(n: int, shift: int = 0) -> list[dict[str, Any]]:
    """A deterministic random walk. Same seed, same bars, every run."""
    random.seed(7)
    when = dt.datetime(2026, 1, 1)
    price = 1.1000
    out = []
    for i in range(n + shift):
        price += random.gauss(0, 0.0007)
        out.append({
            "time": (when + dt.timedelta(minutes=15 * i)).isoformat() + "Z",
            "open": round(price, 5),
            "high": round(price + abs(random.gauss(0, 0.0004)), 5),
            "low": round(price - abs(random.gauss(0, 0.0004)), 5),
            "close": round(price, 5),
            "volume": 100,
        })
    return out[shift:]


# --------------------------------------------- the cap itself is gone


def test_the_default_is_the_whole_chart() -> None:
    """0, meaning everything. It was 240 bars."""
    assert ss.DEFAULT_WINDOW == 0


def test_marks_are_not_bunched_at_the_right_edge() -> None:
    """The reported symptom, measured.

    Driven by a strategy that fires on a fixed cadence, not by a
    builtin on a random walk: where setups happen to fall on synthetic
    data is luck, and a check that depends on luck will one day fail
    for a reason that has nothing to do with the thing it guards. The
    cadence makes the spread a property of the coverage alone.
    """
    class Metronome(EmaRsi):
        history_window = 300

        def on_candle(self, ctx):  # type: ignore[override]
            # Keyed off the BAR, not off len(candles): the slice is
            # capped, so len(candles) is the same number on almost
            # every bar and a cadence built on it fires continuously
            # and then collapses in the de-duplicator.
            last = ctx.candles[-1]
            minute = int(str(last["time"])[14:16])
            if minute != 0:
                return None
            from aurion.strategy.base import StrategySignal
            close = float(last["close"])
            return StrategySignal(action="buy", symbol=ctx.symbol, volume=0.1,
                                  sl=close - 0.01, tp=close + 0.01, price=close)

    bars = _bars(2000)
    res = ss.replay(bars, [("metronome", Metronome())], "EURUSD", "M15", budget_seconds=600)
    idx = [int(s["index"]) for s in res["signals"]]
    assert idx, "no marks at all"
    # Marks in the oldest third, the middle, and the newest third.
    third = len(bars) // 3
    assert any(i < third for i in idx), f"nothing in the first third: {idx[:4]}"
    assert any(third <= i < 2 * third for i in idx), "nothing in the middle third"
    assert any(i >= 2 * third for i in idx), "nothing in the last third"
    assert min(idx) < 400, f"the oldest mark is at bar {min(idx)} of 2000 - still edge-bunched"
    assert res["covered_from"] <= ss.WARMUP_BARS
    assert res["covered_to"] == len(bars)


def test_analysis_never_starts_before_the_warmup() -> None:
    """A strategy asked about bar 3 has nothing to work with."""
    bars = _bars(800)
    res = ss.replay(bars, [("ema_rsi", EmaRsi())], "EURUSD", "M15", budget_seconds=600)
    assert res["covered_from"] >= ss.WARMUP_BARS


def test_thinning_never_keeps_only_the_newest() -> None:
    """The SECOND cause of the same bug, and the subtler one.

    `_dedupe` ended with `return kept[-60:]`. Even once the replay
    covered six months, only the sixty newest marks survived it - so
    widening the analysis would have changed nothing the trader could
    see, and the obvious fix would have looked like it had not worked.

    Thinning has to reduce density evenly instead, or it is just the
    original bias applied one step later.
    """
    marks = [{"index": i, "strategy": "s", "type": "buy", "confidence": (i % 7) / 10.0}
             for i in range(0, 20_000, 10)]
    out = ss.thin_marks(marks, most=200)
    assert len(out) <= 200
    idx = [m["index"] for m in out]
    assert min(idx) < 500, f"the oldest kept mark is {min(idx)} - still trimmed to the newest"
    assert max(idx) > 19_000, "the newest marks were dropped"
    # Even coverage: every fifth of the history keeps some.
    for n in range(5):
        lo, hi = n * 4000, (n + 1) * 4000
        assert any(lo <= i < hi for i in idx), f"nothing kept between {lo} and {hi}"


def test_thinning_keeps_the_most_confident_of_each_slice() -> None:
    """When two marks compete for one slot, the better one stays."""
    marks = [{"index": 0, "strategy": "s", "type": "buy", "confidence": 0.1},
             {"index": 1, "strategy": "s", "type": "buy", "confidence": 0.9},
             {"index": 999, "strategy": "s", "type": "buy", "confidence": 0.5}]
    out = ss.thin_marks(marks, most=2)
    assert sorted(m["confidence"] for m in out) == [0.5, 0.9]


def test_a_short_list_is_returned_untouched() -> None:
    marks = [{"index": i, "strategy": "s", "type": "buy", "confidence": 0.5} for i in range(10)]
    assert ss.thin_marks(marks, most=600) == marks


# ------------------------------------------- the slice that pays for it


def test_a_declared_window_is_what_the_strategy_is_handed() -> None:
    """Not bars[:i+1]. This is what makes a full pass affordable.

    Captured off a real run rather than read off the source: the point
    is what the strategy actually receives, not what the code appears
    to say.
    """
    seen: list[int] = []

    class Spy(EmaRsi):
        history_window = 300

        def on_candle(self, ctx):  # type: ignore[override]
            seen.append(len(ctx.candles))
            return None

    bars = _bars(1200)
    ss.replay(bars, [("spy", Spy())], "EURUSD", "M15", budget_seconds=600)
    assert seen, "the strategy was never called"
    assert max(seen) <= 300, f"a strategy declaring 300 bars was handed {max(seen)}"


def test_an_undeclared_strategy_is_still_bounded() -> None:
    """0 means "the whole frame", and a chart cannot afford that.

    In a BACKTEST 0 is honoured exactly. Here it becomes SLICE_CEILING,
    because the alternative is not more accurate marks - it is no marks
    at all on everything but the last few hundred bars, which is the
    bug being fixed. The envelope reports the number used.
    """
    seen: list[int] = []

    class Spy(EmaRsi):
        history_window = 0

        def on_candle(self, ctx):  # type: ignore[override]
            seen.append(len(ctx.candles))
            return None

    bars = _bars(ss.SLICE_CEILING + 900)
    res = ss.replay(bars, [("spy", Spy())], "EURUSD", "M15", budget_seconds=600)
    assert max(seen) <= ss.SLICE_CEILING
    assert res["slice"] == ss.SLICE_CEILING


def test_the_ceiling_does_not_change_what_smart_money_sees() -> None:
    """The A/B behind SLICE_CEILING, re-runnable.

    smart_money is the only builtin declaring 0, because its
    higher-timeframe bias resamples the frame - so it is the one
    strategy a slice could change. Over 1200 M15 bars, unbounded
    against the ceiling: identical marks at identical levels.
    """
    bars = _bars(1200)
    inst = SmartMoney()
    wide = ss.SLICE_CEILING
    try:
        ss.SLICE_CEILING = 10 ** 9
        a = ss.replay(bars, [("smart_money", inst)], "EURUSD", "M15", budget_seconds=600)
        ss.SLICE_CEILING = wide
        b = ss.replay(bars, [("smart_money", inst)], "EURUSD", "M15", budget_seconds=600)
    finally:
        ss.SLICE_CEILING = wide

    def shape(res):
        return [(s["index"], s["type"], round(s["entry"], 5), round(s["sl"], 5), round(s["tp"], 5))
                for s in res["signals"]]

    assert shape(a) == shape(b)


# ------------------------------------------------ analysing in slabs


def test_a_range_can_be_asked_for() -> None:
    bars = _bars(1500)
    res = ss.replay(bars, [("ema_rsi", EmaRsi())], "EURUSD", "M15",
                    budget_seconds=600, first=800, last=1100)
    assert res["covered_from"] == 800
    assert res["covered_to"] == 1100
    assert all(800 <= int(s["index"]) < 1100 for s in res["signals"])


def test_running_out_of_time_says_where_it_stopped() -> None:
    """Resumable, rather than silently short.

    A truncated pass that does not report where it got to is
    indistinguishable from a stretch with no setups - the same
    confusion as the original bug, one level down.

    Which END gets sacrificed is the point. The pass runs newest-first,
    so the budget costs the OLDEST bars of the slab: the newest bar is
    always covered, and `covered_from` - not `covered_to` - is the
    boundary that moves. Reported as "the signals are never drawn on
    the newest candles"; with the old forward walk the right-hand edge
    was the part that was always dropped.
    """
    bars = _bars(4000)
    res = ss.replay(bars, [("smart_money", SmartMoney())], "EURUSD", "M15",
                    budget_seconds=0.5)
    assert res["truncated"] is True
    assert res["covered_to"] == len(bars), "the newest bar must always be analysed"
    assert ss.WARMUP_BARS < res["covered_from"] < len(bars)


def test_coverage_reaches_the_window_and_then_stops() -> None:
    """The replacement for "walks backwards for ever".

    This test used to assert that each refresh reached another 1500
    bars into the past until the whole series was covered. That is the
    behaviour that stopped the engine ever going idle with the expert
    attached. What must be true now is the opposite and much stronger:
    the covered region reaches the marked window and the planner then
    reports there is nothing left to do - on the FIRST pass, because
    one day is a single pass's worth of work.
    """
    trader = Trader.__new__(Trader)
    armed = [("ema_rsi", EmaRsi())]
    bars = _bars(5000)

    plan = trader._chart_mark_plan("EURUSD", "M15", armed, bars)
    assert plan["last"] - plan["first"] == MARKED_M15, (
        "the first pass is not one day of bars"
    )
    out = ss.replay(bars, armed, "EURUSD", "M15", budget_seconds=600,
                    first=plan["first"], last=plan["last"])
    res = trader._chart_marks_merge("EURUSD", "M15", armed, bars, plan, out)

    assert res["covered_to"] == len(bars), "the newest bar must always be covered"
    assert res["covered_from"] == len(bars) - MARKED_M15
    assert res["complete"] is True, "one day of bars took more than one pass"

    # And it stays done: a refresh with no new bars is no work at all.
    assert trader._chart_mark_plan("EURUSD", "M15", armed, bars).get("complete") is True


def test_the_work_is_bounded_however_long_the_history_is() -> None:
    """Ten times the history must not be ten times the work.

    The property that was missing before: the cost of marking a chart
    is a function of the WINDOW, not of how much history the broker
    handed over. Six months of M1 used to be 259 200 bars of eventual
    analysis per chart.
    """
    trader = Trader.__new__(Trader)
    armed = [("ema_rsi", EmaRsi())]
    for total in (500, 5000, 50_000):
        trader._marks_store().clear()
        plan = trader._chart_mark_plan("EURUSD", "M15", armed, _bars(total))
        todo = plan["last"] - plan["first"]
        assert todo <= MARKED_M15, (
            f"{total} bars of history asked for {todo} bars of analysis"
        )


def test_a_caught_up_chart_does_no_work_at_all() -> None:
    """The off-by-one that used to disable the mechanism, inverted.

    `to_time` records the LAST bar analysed, so the exclusive bound is
    one past it. Read back as the bound itself, the newest covered bar
    looks uncovered - and every refresh then re-analyses that bar for
    ever. That was a waste when the planner walked backwards; now that
    the window is finite it would be the difference between a chart
    that settles and a chart that never stops working.
    """
    trader = Trader.__new__(Trader)
    armed = [("ema_rsi", EmaRsi())]
    bars = _bars(4000)

    plan = trader._chart_mark_plan("EURUSD", "M15", armed, bars)
    out = ss.replay(bars, armed, "EURUSD", "M15", budget_seconds=600,
                    first=plan["first"], last=plan["last"])
    trader._chart_marks_merge("EURUSD", "M15", armed, bars, plan, out)

    second = trader._chart_mark_plan("EURUSD", "M15", armed, bars)
    assert second.get("complete") is True, "a settled chart asked for more work"
    assert second["last"] - second["first"] == 0


def test_new_bars_are_marked_before_coverage_reaches_further_back() -> None:
    """The newest bar is the one nobody will forgive being unmarked."""
    trader = Trader.__new__(Trader)
    armed = [("ema_rsi", EmaRsi())]
    bars = _bars(3000)
    plan = trader._chart_mark_plan("EURUSD", "M15", armed, bars)
    out = ss.replay(bars, armed, "EURUSD", "M15", budget_seconds=600,
                    first=plan["first"], last=plan["last"])
    trader._chart_marks_merge("EURUSD", "M15", armed, bars, plan, out)

    grown = _bars(3030)
    nxt = trader._chart_mark_plan("EURUSD", "M15", armed, grown)
    assert nxt["last"] == len(grown), "new bars were not analysed first"
    assert nxt["first"] < len(grown)


def test_marks_follow_their_bar_when_the_history_scrolls() -> None:
    """Indices shift; bar times do not.

    A cache keyed on indices would slide every remembered mark onto a
    different candle as soon as the history scrolled - a mark drawn on
    the wrong bar is worse than no mark.
    """
    trader = Trader.__new__(Trader)
    armed = [("ema_rsi", EmaRsi())]
    bars = _bars(2500)
    plan = trader._chart_mark_plan("EURUSD", "M15", armed, bars)
    out = ss.replay(bars, armed, "EURUSD", "M15", budget_seconds=600,
                    first=plan["first"], last=plan["last"])
    first = trader._chart_marks_merge("EURUSD", "M15", armed, bars, plan, out)
    before = {s["time"]: s["index"] for s in first["signals"]}
    assert before

    # 50 bars drop off the front; every surviving mark must move 50 left.
    rolled = _bars(2500, shift=50)
    plan2 = trader._chart_mark_plan("EURUSD", "M15", armed, rolled)
    out2 = ss.replay(rolled, armed, "EURUSD", "M15", budget_seconds=600,
                     first=plan2["first"], last=plan2["last"])
    after = trader._chart_marks_merge("EURUSD", "M15", armed, rolled, plan2, out2)
    moved = {s["time"]: s["index"] for s in after["signals"]}

    checked = 0
    for when, idx in before.items():
        if when in moved:
            assert moved[when] == idx - 50, f"the mark at {when} did not follow its bar"
            checked += 1
    assert checked, "no mark survived the scroll, so nothing was proved"


def test_arming_another_strategy_does_not_reuse_the_old_analysis() -> None:
    """The marks ARE the armed set's output; a new set is a new body of work."""
    trader = Trader.__new__(Trader)
    bars = _bars(2000)
    one = [("ema_rsi", EmaRsi())]
    two = [("ema_rsi", EmaRsi()), ("smart_money", SmartMoney())]
    assert (trader._chart_mark_key("EURUSD", "M15", one)
            != trader._chart_mark_key("EURUSD", "M15", two))
    plan = trader._chart_mark_plan("EURUSD", "M15", one, bars)
    out = ss.replay(bars, one, "EURUSD", "M15", budget_seconds=600,
                    first=plan["first"], last=plan["last"])
    trader._chart_marks_merge("EURUSD", "M15", one, bars, plan, out)
    assert trader._chart_mark_plan("EURUSD", "M15", two, bars)["fresh"] is True


def test_the_desk_is_told_whether_more_is_coming() -> None:
    """`complete` is what stops the desk polling, and what turns off
    the "still analysing" wash over the unexamined stretch."""
    trader = Trader.__new__(Trader)
    armed = [("ema_rsi", EmaRsi())]
    bars = _bars(3000)
    plan = trader._chart_mark_plan("EURUSD", "M15", armed, bars)
    out = ss.replay(bars, armed, "EURUSD", "M15", budget_seconds=600,
                    first=plan["first"], last=plan["last"])
    res = trader._chart_marks_merge("EURUSD", "M15", armed, bars, plan, out)
    # One day of M15 is one pass, so a chart is complete as soon as it
    # has been looked at - and the desk must be told, or it holds its
    # "still analysing" wash over the chart for ever.
    assert res["complete"] is True
    assert res["analysing"] is False


# ------------------------------------------------------------- speed


def test_a_full_pass_is_linear_not_quadratic() -> None:
    """The property, not a stopwatch number.

    Doubling the bars must roughly double the work, not quadruple it.
    Generous bound - this runs on whatever machine CI gives it - but a
    return to bars[:i+1] would blow straight through it.
    """
    small = _bars(1000)
    large = _bars(2000)
    inst = EmaRsi()

    t0 = time.monotonic()
    ss.replay(small, [("ema_rsi", inst)], "EURUSD", "M15", budget_seconds=600)
    a = time.monotonic() - t0

    t0 = time.monotonic()
    ss.replay(large, [("ema_rsi", inst)], "EURUSD", "M15", budget_seconds=600)
    b = time.monotonic() - t0

    # Bars analysed, not bars supplied: the first 220 are warmup.
    work = (len(large) - ss.WARMUP_BARS) / (len(small) - ss.WARMUP_BARS)
    assert b < a * work * 2.2, (
        f"{a:.2f}s for {len(small)} bars but {b:.2f}s for {len(large)} - superlinear"
    )
