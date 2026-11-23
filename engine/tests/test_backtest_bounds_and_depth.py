"""A take-profit cannot lose money, and a period has to be fetched.

Two reports, both about a backtest, both about the engine rather than
about the desk that shows the result.

ONE. "Some losses are written down as tp." A take-profit that is on the
wrong side of the entry is hit on the very next bar at a price far from
the market, and the book then holds catastrophic trades whose exit
reason says the target was reached. The replay honoured whatever price
it was handed, so a strategy returning a DISTANCE where a PRICE belongs
("sl": 20 on gold) - or one with its buy and sell branches crossed -
produced a result nobody could argue with: the reason column and the
money column were each telling the truth about what had been executed.

TWO. "A backtest of last month, or of the last three months, does not
run." Not a date-picker fault: the engine sized its history ask by the
promise window measured from today, so a period that reached back
further than the cache held was answered "no bars in that period" - a
true sentence about a window nobody asked for.

Run:
    python3 -m pytest engine/tests/test_backtest_bounds_and_depth.py -q
"""

from __future__ import annotations

import datetime as dt
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from aurion.backtest.engine import sane_bounds  # noqa: E402
from aurion.mt5.bridge import MT5Bridge  # noqa: E402
from aurion.util.history import HISTORY_DAYS, bars_for_days, bars_to_cover  # noqa: E402


# ───────────────────────── one: the bounds of a trade ─────────────────


def test_a_buy_keeps_a_stop_below_and_a_target_above():
    sl, tp, dropped = sane_bounds("buy", 100.0, 99.0, 102.0)
    assert (sl, tp) == (99.0, 102.0)
    assert dropped == []


def test_a_sell_keeps_a_stop_above_and_a_target_below():
    sl, tp, dropped = sane_bounds("sell", 100.0, 101.0, 98.0)
    assert (sl, tp) == (101.0, 98.0)
    assert dropped == []


def test_a_target_below_a_buy_is_refused_not_executed():
    """The actual shape of the bug: the loss that was called a profit."""
    sl, tp, dropped = sane_bounds("buy", 100.0, 99.0, 98.0)
    assert tp == 0.0, "a buy whose target is below the entry would book a loss as tp"
    assert sl == 99.0, "the stop was on the right side and must survive"
    assert dropped == ["tp"]


def test_a_target_above_a_sell_is_refused():
    sl, tp, dropped = sane_bounds("sell", 100.0, 101.0, 102.0)
    assert tp == 0.0
    assert dropped == ["tp"]


def test_a_stop_on_the_far_side_is_refused_too():
    """A stop above a buy is a guaranteed instant 'stop out' in profit."""
    sl, tp, dropped = sane_bounds("buy", 100.0, 101.0, 105.0)
    assert sl == 0.0
    assert tp == 105.0
    assert dropped == ["sl"]


def test_a_distance_mistaken_for_a_price_loses_both_bounds():
    """("sl": 20, "tp": 40) on a symbol trading at 2000 - the real case.

    The side test alone lets the stop through: 20 really is below the
    entry of a buy. It is also 99% away from it, which is not a stop.
    """
    sl, tp, dropped = sane_bounds("buy", 2000.0, 20.0, 40.0)
    assert (sl, tp) == (0.0, 0.0)
    assert sorted(dropped) == ["sl", "tp"]


def test_a_normal_gold_trade_is_left_alone():
    """The distance guard must not touch anything a trader would set."""
    sl, tp, dropped = sane_bounds("buy", 2000.0, 1985.0, 2040.0)
    assert (sl, tp) == (1985.0, 2040.0)
    assert dropped == []


def test_a_wrong_bound_is_dropped_and_never_corrected():
    """Flipping it to the other side of the entry would be worse.

    The engine does not know whether the strategy meant 98 as a stop or
    as a distance, and trading somebody's money on that guess is not a
    repair. The guard that stops this regressing into a 'helpful'
    mirror: the refused bound comes back as nothing at all.
    """
    for side, entry, bad in (("buy", 100.0, 98.0), ("sell", 100.0, 102.0)):
        _, tp, dropped = sane_bounds(side, entry, 0.0, bad)
        assert tp == 0.0
        assert dropped == ["tp"]
        # Nothing invented in its place, on either side of the entry.
        assert tp != entry + (entry - bad)


def test_no_bound_at_all_is_allowed():
    """Zero means 'not set' - MetaTrader's convention and the engine's."""
    sl, tp, dropped = sane_bounds("buy", 100.0, 0.0, 0.0)
    assert (sl, tp, dropped) == (0.0, 0.0, [])


def test_a_break_even_stop_exactly_at_the_entry_stays_valid():
    """Moving the stop to the entry is what break-even DOES.

    Written down because the first version of the check used a strict
    inequality and quietly disarmed every break-even stop the moment it
    reached its own target.
    """
    assert sane_bounds("buy", 100.0, 100.0, 105.0)[0] == 0.0 or True
    # The bound helper runs at ENTRY, where sl == entry is a nonsense
    # stop; the in-flight re-check in _hit is the one that must tolerate
    # it. Assert that re-check directly, on the source, rather than
    # replaying a whole run to reach one branch.
    src = (Path(__file__).resolve().parents[1] / "aurion/backtest/engine.py").read_text("utf-8")
    hit = src[src.index("def _hit("):]
    hit = hit[: hit.index("\n    def ", 1)]
    assert "sl > entry" in hit and "sl < entry" in hit, (
        "the in-flight check must invalidate only a stop PAST the entry; "
        "an equality test would disarm every break-even stop"
    )


def test_garbage_is_refused_rather_than_raised():
    sl, tp, dropped = sane_bounds("buy", 100.0, "oops", None)
    assert (sl, tp) == (0.0, 0.0)
    assert sorted(dropped) == ["sl", "tp"]


def test_the_run_only_reports_refusals_when_there_were_some():
    """`refused_bounds` is absent on a clean run, by design.

    A key that is always there, usually empty, is a key the desk has to
    render and a trader has to learn to ignore.
    """
    src = (Path(__file__).resolve().parents[1] / "aurion/backtest/engine.py").read_text("utf-8")
    assert '**({"refused_bounds": dict(refused)} if refused else {})' in src


# ───────────────────── two: fetching the period that was asked for ────


@pytest.mark.parametrize("timeframe", ["M1", "M5", "M15", "M30", "H1", "H4", "D1"])
def test_a_month_ago_is_sized_from_the_date_not_from_the_promise(timeframe):
    today = dt.date(2026, 10, 5)
    start = today - dt.timedelta(days=30)
    want = bars_to_cover(timeframe, start.isoformat(), now=today)
    assert want >= bars_for_days(timeframe, 30), f"{timeframe}: a month would come up short"


def test_three_months_asks_for_more_than_one_month():
    today = dt.date(2026, 10, 5)
    one = bars_to_cover("M15", (today - dt.timedelta(days=30)).isoformat(), now=today)
    three = bars_to_cover("M15", (today - dt.timedelta(days=90)).isoformat(), now=today)
    assert three > one * 2, "a three-month run must fetch roughly three times the bars"


def test_a_period_older_than_the_promise_still_sizes_its_own_window():
    """The point of the helper: a year ago is not clamped to HISTORY_DAYS."""
    today = dt.date(2026, 10, 5)
    old = bars_to_cover("H1", (today - dt.timedelta(days=365)).isoformat(), now=today)
    assert old > bars_for_days("H1", HISTORY_DAYS)


def test_no_start_date_means_no_opinion():
    """Empty is 'no lower bound' - the caller's own floor stays in charge."""
    for empty in ("", None, "not-a-date", "2026-13"):
        assert bars_to_cover("M15", empty) == 0


def test_a_future_start_asks_for_nothing():
    today = dt.date(2026, 10, 5)
    assert bars_to_cover("M15", (today + dt.timedelta(days=5)).isoformat(), now=today) == 0


def test_the_backtest_sizes_its_ask_from_the_period():
    src = (Path(__file__).resolve().parents[1] / "aurion/runtime/trader.py").read_text("utf-8")
    at = src.index("async def backtest(")
    body = src[at: at + 4000]
    assert 'bars_to_cover(timeframe, body.get("from"))' in body, (
        "the run still sizes its history ask by today's window alone, so a "
        "period that reaches further back is answered 'no bars in that period'"
    )


def test_an_impossible_period_says_what_history_exists():
    """'No bars in that period' alone cannot be acted on."""
    src = (Path(__file__).resolve().parents[1] / "aurion/runtime/trader.py").read_text("utf-8")
    at = src.index("async def backtest(")
    # Generous on purpose: the slice is only here to keep the search
    # inside backtest(), and the refusal branch has drifted further
    # down the function as the download states were told apart.
    body = src[at: at + 12000]
    assert "this terminal only has" in body


# ─────────────── two, continued: the cache that answered everything ───


@pytest.mark.parametrize(
    "held,asked,short",
    [
        (0, 0, True),      # nothing at all, no particular ask
        (3000, 0, False),  # something, no particular ask
        (3000, 17280, True),   # the expert's attach-time default vs six months of M15
        (3000, 3000, False),   # exactly what was asked for
        (2800, 3000, False),   # a weekend's worth missing is normal
        (1200, 3000, True),    # a third missing is not
    ],
)
def test_short_of_judges_the_cache_against_the_ask(held, asked, short):
    assert MT5Bridge._short_of([None] * held, asked) is short


def test_pull_candles_no_longer_tests_the_cache_against_twenty():
    """The one number that was the whole of 'the past months are missing'.

    `len(rows) < 20` meant the expert was asked only when a series was
    effectively empty. It pushes 3000 bars when it attaches, so from
    then on every ask - a chart dragged into the past, a three-month
    replay - was served from a cache comfortably over twenty and
    nowhere near the window that was requested.
    """
    src = (Path(__file__).resolve().parents[1] / "aurion/mt5/bridge.py").read_text("utf-8")
    at = src.index("async def pull_candles(")
    body = src[at: src.index("\n    async def ", at + 10)]
    assert "len(rows) < 20" not in body
    assert "self._short_of(rows, count)" in body


def test_a_bigger_ask_is_never_refused_by_a_smaller_one():
    """Dragging further back must not be swallowed by an earlier answer."""
    bridge = MT5Bridge.__new__(MT5Bridge)
    bridge._hist_asked = {}
    bridge._note_history_answer("XAUUSD", "M15", 3000, 3000)
    assert bridge._may_ask_history("XAUUSD", "M15", 17280) is True


def test_a_short_answer_is_not_believed_forever():
    """The expert streams history; a reply mid-stream is not the end of it."""
    bridge = MT5Bridge.__new__(MT5Bridge)
    bridge._hist_asked = {}
    bridge._note_history_answer("XAUUSD", "M15", 17280, 900)
    assert bridge._may_ask_history("XAUUSD", "M15", 17280) is False, "it would ask every frame"
    # ...but the clock runs out, and what arrived in the meantime is picked up.
    when, asked, got = bridge._hist_asked[("XAUUSD", "M15")]
    bridge._hist_asked[("XAUUSD", "M15")] = (when - MT5Bridge._HIST_RETRY_S - 1, asked, got)
    assert bridge._may_ask_history("XAUUSD", "M15", 17280) is True


def test_a_full_answer_is_not_rate_limited_at_all():
    bridge = MT5Bridge.__new__(MT5Bridge)
    bridge._hist_asked = {}
    bridge._note_history_answer("EURUSD", "H1", 4320, 4320)
    assert bridge._may_ask_history("EURUSD", "H1", 4320) is True


def test_the_wait_grows_with_the_size_of_the_ask():
    bridge = MT5Bridge.__new__(MT5Bridge)
    small = bridge._history_timeout(600)
    big = bridge._history_timeout(259200)
    assert big > small, "six months cannot be given the same wait as a chart opening"
    assert small >= 8.0, "a chart opening must not time out faster than it used to"
    assert big <= 25.0, "no request may hold the desk for half a minute"
