"""How much history AURION keeps, in days rather than in bars.

Every caller used to ask for a fixed number of bars - 800 here, 1500
there, 160 somewhere else - and a fixed bar count means a different
amount of time on every timeframe. 800 bars is sixteen hours of M1,
eight days of M15 and four months of H4. So the chart, the analysis
and the backtest all covered a different window depending on which
timeframe the trader happened to be looking at, and on M1 and M5 the
window was far too short to say anything about a strategy at all.

The product promise is a period, not a bar count: at least the last
thirty days, on every timeframe. That is one number, here, and the
callers convert it.

The conversion is deliberately generous. It divides calendar days by
the bar length, so for a 24/5 instrument it asks for roughly 7/5 of
the bars that can exist. Asking MetaTrader for more bars than it has
returns what it has; asking for too few silently truncates the window,
which is the bug this module exists to stop. Erring upward is free and
erring downward is not.
"""

from __future__ import annotations

from ..mt5.types import timeframe_minutes

#: The promise. At least this many days of history, on every timeframe.
HISTORY_DAYS = 30

#: Enough bars to be able to say anything at all, whatever the window
#: works out to. A strategy with a 200-bar moving average needs more
#: than the 30 D1 bars that thirty days of a daily chart contains.
MIN_BARS = 400

#: Hard ceiling per series, so one request cannot exhaust memory. Thirty
#: days of M1 is 43 200 bars, which is the real cost of this promise and
#: is accepted deliberately; this only stops an absurd timeframe string
#: or a future HISTORY_DAYS of 3650 from taking the engine down.
MAX_BARS = 60_000


def bars_for_days(timeframe: str, days: int = HISTORY_DAYS) -> int:
    """Bars needed to span `days` of calendar time on this timeframe."""
    minutes = max(1, int(timeframe_minutes(timeframe)))
    span = max(1, int(days)) * 24 * 60
    needed = -(-span // minutes)  # ceiling division
    return max(MIN_BARS, min(MAX_BARS, needed))


def at_least_30_days(timeframe: str, asked: int | None = None) -> int:
    """`asked`, raised to the thirty-day floor for this timeframe.

    Callers keep their own number - a backtest the trader has asked to
    run over more history, a configured lookback - and this only ever
    raises it. Nothing in the product may ask for less than the window
    the product promises.
    """
    floor = bars_for_days(timeframe)
    try:
        want = int(asked or 0)
    except (TypeError, ValueError):
        want = 0
    return min(MAX_BARS, max(floor, want))


def cache_size(timeframe: str) -> int:
    """How many bars of this timeframe to keep in memory.

    A little over the window, so the oldest bar of the thirty days is
    not dropped the moment a new one arrives.
    """
    return min(MAX_BARS, bars_for_days(timeframe) + 200)
