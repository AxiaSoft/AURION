"""Thirty days of history, on every timeframe, everywhere.

The chart, the AI's training, the signals drawn on the chart and the
backtest are four different code paths that all needed history, and
each one asked for a fixed number of bars: 800 here, 1500 there, 400 in
the expert. A fixed bar count is a different period on every timeframe.
800 bars is four months of H4 and thirteen hours of M1, so the product
promised "the last month" and delivered a month, a week or half a day
depending on which button the trader had pressed.

``aurion.util.history`` is now the single place that knows the promise,
and every caller converts days to bars through it. This file holds the
promise to that: not "the helper returns a big number", but that the
number is really at least thirty days on every timeframe the desk
offers, and that none of the old fixed counts have crept back in.

Run:
    python3 -m pytest engine/tests/test_thirty_day_window.py
"""
from __future__ import annotations

import re
from pathlib import Path

import pytest

from aurion.mt5.types import TIMEFRAMES, timeframe_minutes
from aurion.util.history import (
    HISTORY_DAYS,
    MAX_BARS,
    MIN_BARS,
    at_least_30_days,
    bars_for_days,
    cache_size,
)

ROOT = Path(__file__).resolve().parents[2]

#: The timeframes the desk actually offers. W1 and MN1 exist in the map
#: but thirty days of them is a handful of bars, which is why the floor
#: below is a bar count and not a period.
DESK_TIMEFRAMES = ["M1", "M5", "M15", "M30", "H1", "H4", "D1"]


def test_the_promise_is_thirty_days() -> None:
    assert HISTORY_DAYS >= 30


@pytest.mark.parametrize("timeframe", DESK_TIMEFRAMES)
def test_every_timeframe_reaches_back_thirty_days(timeframe: str) -> None:
    """The arithmetic, stated as the trader would state it."""
    bars = bars_for_days(timeframe)
    days = bars * timeframe_minutes(timeframe) / (24 * 60)
    assert days >= HISTORY_DAYS or bars == MIN_BARS, (
        f"{timeframe}: {bars} bars is only {days:.1f} days"
    )


@pytest.mark.parametrize("timeframe", DESK_TIMEFRAMES)
def test_nothing_is_left_below_the_old_fixed_counts(timeframe: str) -> None:
    """A regression here would be invisible on the slow timeframes.

    H4 was always fine with 800 bars; M1 never was. So the check is
    stated against the bar counts the code used to hard-code.
    """
    assert bars_for_days(timeframe) >= 400
    if timeframe in ("M1", "M5", "M15"):
        assert bars_for_days(timeframe) >= 800, "this timeframe needs more than the old 800"


@pytest.mark.parametrize("timeframe", DESK_TIMEFRAMES)
def test_the_cache_can_hold_the_window(timeframe: str) -> None:
    """A buffer smaller than the window throws the oldest bars away.

    This is the trap the original 3000-bar deque fell into: every caller
    could ask MetaTrader for 43 200 M1 bars and the buffer would keep
    the last 3000 of them, so the chart still showed two days and
    nothing anywhere said why.
    """
    assert cache_size(timeframe) >= bars_for_days(timeframe)


def test_the_live_tape_sizes_its_buffers_per_timeframe() -> None:
    """Prove the buffer, not just the number that should size it."""
    from aurion.mt5.bridge import _new_tape

    tape = _new_tape()
    for timeframe in DESK_TIMEFRAMES:
        bucket = tape["candles"][("XAUUSD", timeframe)]
        assert bucket.maxlen >= bars_for_days(timeframe), (
            f"{timeframe} buffer holds {bucket.maxlen}, window needs {bars_for_days(timeframe)}"
        )
    m1 = tape["candles"][("XAUUSD", "M1")].maxlen
    d1 = tape["candles"][("XAUUSD", "D1")].maxlen
    assert m1 > d1, "one size for every timeframe is the bug this replaced"


def test_a_caller_asking_for_more_still_gets_more() -> None:
    """The floor raises, it never lowers.

    A trader who asks to backtest a year must get a year.
    """
    big = bars_for_days("H4") * 10
    assert at_least_30_days("H4", big) == big


@pytest.mark.parametrize("asked", [None, 0, -1, "", "junk", 50, 800])
def test_a_missing_or_silly_ask_falls_back_to_the_window(asked) -> None:
    for timeframe in DESK_TIMEFRAMES:
        assert at_least_30_days(timeframe, asked) >= bars_for_days(timeframe)


def test_nothing_can_ask_for_an_unbounded_number_of_bars() -> None:
    assert at_least_30_days("M1", 10**9) == MAX_BARS
    assert bars_for_days("M1", 10_000) == MAX_BARS


def test_an_unknown_timeframe_does_not_crash() -> None:
    """Timeframe strings arrive from the desk, the EA and the URL."""
    for junk in ("", "nonsense", "M", "0", None):
        assert bars_for_days(junk) >= MIN_BARS  # type: ignore[arg-type]


def test_every_timeframe_in_the_map_is_handled() -> None:
    for timeframe in TIMEFRAMES:
        assert MIN_BARS <= bars_for_days(timeframe) <= MAX_BARS


# --------------------------------------------------------------- sources

#: Where the four promises live. Each must go through the helper rather
#: than naming a bar count, because naming one is exactly the bug.
CALLERS = [
    "engine/aurion/mt5/bridge.py",       # the chart's bars
    "engine/aurion/api/server.py",       # the AI's training set
    "engine/aurion/runtime/trader.py",   # the chart signals and the backtest
    "engine/aurion/runtime/store.py",    # the stored history
]


@pytest.mark.parametrize("path", CALLERS)
def test_each_caller_derives_its_depth(path: str) -> None:
    text = (ROOT / path).read_text(encoding="utf-8")
    assert "at_least_30_days" in text, f"{path} does not derive its history depth"


@pytest.mark.parametrize("path", CALLERS)
def test_no_caller_still_hard_codes_a_candle_count(path: str) -> None:
    """The specific numbers that used to be sprinkled through these files.

    A grep is a blunt instrument, so it is narrowed to the shapes that
    actually appeared: a bar count passed to a candle call or defaulted
    into one.
    """
    text = (ROOT / path).read_text(encoding="utf-8")
    bad = re.findall(r"(?:candles?|bars)[^\n]{0,60}?\b(?:or|=|,)\s*(800|1500|3000)\b", text)
    assert not bad, f"{path} still hard-codes a bar count: {bad}"


def test_the_expert_asks_the_terminal_for_what_the_engine_wants() -> None:
    """AurionBridge clamped its own history to 400 bars.

    400 bars of M1 is under seven hours. Whatever the engine asked for,
    the fallback pipe could not deliver the window, so this is pinned in
    the expert's source: it must read the count off the request and its
    ceiling must be above the thirty-day M1 figure.
    """
    text = (ROOT / "engine/ea/AurionBridge.mq5").read_text(encoding="utf-8", errors="ignore")
    assert "g_hist_want" in text, "the expert ignores the depth the engine asks for"
    assert 'QueueHistory(tf, (int)StringToInteger(Extract(line, "count")))' in text, \
        "request_history must pass the engine's count through to QueueHistory"
    assert "if(depth > 400)" not in text, "the 400-bar clamp is back"
    ceiling = re.search(r"#define\s+AURION_HIST_MAX\s+(\d+)", text)
    assert ceiling, "the expert must define its own ceiling"
    assert int(ceiling.group(1)) >= bars_for_days("M1")


def test_the_engine_tells_the_expert_how_deep_to_go() -> None:
    text = (ROOT / "engine/aurion/mt5/bridge.py").read_text(encoding="utf-8")
    assert '"count": at_least_30_days(tf, count)' in text, \
        "request_history must carry the thirty-day depth, not a fixed 800"


def test_the_desk_ceiling_matches_the_engines() -> None:
    """app.js clamped its own ask to 3000 bars.

    The desk already derived the window from the timeframe, and then
    clamped the result to 3000 - which silently undid the derivation on
    M1 and M5, the two timeframes where it mattered.
    """
    text = (ROOT / "apps/web/js/app.js").read_text(encoding="utf-8")
    found = re.search(r"const HISTORY_MAX = (\d+);", text)
    assert found, "app.js must still declare HISTORY_MAX"
    assert int(found.group(1)) >= bars_for_days("M1"), \
        "the desk ceiling is below thirty days of M1, so the chart will truncate"
    days = re.search(r"const HISTORY_DAYS = (\d+);", text)
    assert days and int(days.group(1)) == HISTORY_DAYS, \
        "the desk and the engine must promise the same number of days"


def test_the_desk_asks_for_the_window_everywhere_it_asks_for_bars() -> None:
    """Three call sites, all of which used to name a number."""
    text = (ROOT / "apps/web/js/app.js").read_text(encoding="utf-8")
    assert "count=800" not in text, "chart signals still ask for 800 bars"
    assert "count=1500" not in text, "the backtest replay still asks for 1500 bars"
    assert text.count("barsForDays(") >= 4, "a caller stopped deriving its ask"
