"""How much history AURION keeps, in days rather than in bars.

Every caller used to ask for a fixed number of bars - 800 here, 1500
there, 160 somewhere else - and a fixed bar count means a different
amount of time on every timeframe. 800 bars is sixteen hours of M1,
eight days of M15 and four months of H4. So the chart, the analysis
and the backtest all covered a different window depending on which
timeframe the trader happened to be looking at, and on M1 and M5 the
window was far too short to say anything about a strategy at all.

The product promise is a period, not a bar count: at least the last
HISTORY_DAYS of it, on every timeframe. That is one number, here, and
the callers convert it.

The conversion is deliberately generous. It divides calendar days by
the bar length, so for a 24/5 instrument it asks for roughly 7/5 of
the bars that can exist. Asking MetaTrader for more bars than it has
returns what it has; asking for too few silently truncates the window,
which is the bug this module exists to stop. Erring upward is free and
erring downward is not.
"""

from __future__ import annotations

from datetime import date
from typing import Any

from ..mt5.types import timeframe_minutes

#: The promise. At least this many days of history, on every timeframe.
#:
#: Was 30. Six months is what a trader needs to judge a strategy: a
#: month contains one market mood, and a robot tuned to one month is
#: tuned to noise. It is also four distinct months of news, which is
#: what the calendar-driven backtest picks from.
#:
#: The cost is real and falls almost entirely on M1: 180 days of it is
#: 259 200 bars. That is a chart the browser must hold, a deque the
#: engine must hold, and a replay that takes many minutes. It is
#: accepted deliberately - and it is why the backtest can be pointed at
#: a single month, week or day from the calendar instead of always
#: replaying everything.
HISTORY_DAYS = 180

#: Enough bars to be able to say anything at all, whatever the window
#: works out to. A strategy with a 200-bar moving average needs more
#: than the 30 D1 bars that a month of a daily chart contains.
MIN_BARS = 400

#: Hard ceiling per series, so one request cannot exhaust memory.
#:
#: Six months of M1 is 259 200 bars, so the ceiling has to clear that or
#: it silently becomes the real window - which is the exact bug this
#: module was written to stop, where a 3000-bar cap quietly turned
#: six months of M1 into a fortnight. Sized with room above the promise and no
#: more, so a future HISTORY_DAYS of 3650, or a nonsense timeframe,
#: still cannot take the engine down.
MAX_BARS = 300_000


#: How much history arrives in ONE page, measured in bars.
#:
#: Days are the wrong unit for this and asking in days is how the
#: product got here. "Load a week at a time" is the right instinct and
#: a week means two completely different things: a week of M1 is
#: 10 080 bars, a week of D1 is five. Size the page by what it costs -
#: bars - and let each timeframe work out how many days that buys.
#:
#: 10 000 was chosen against the measurements, not picked round. One
#: page is then about 1.9 MB of JSON and a tenth of a second of work,
#: against 48 MB and 3.26 seconds for the six-month M1 pull it
#: replaces. Below about 4 000 the pages get no faster in any way a
#: trader can see and M1 needs sixty of them to cross the window,
#: which is sixty round trips to drag back through six months.
PAGE_BARS = 10_000

#: Page lengths a human would recognise. A page of "104 days" is an
#: implementation detail leaking onto the screen; a quarter is not.
_PAGE_DAYS = (1, 2, 3, 5, 7, 14, 30, 45, 60, 90, HISTORY_DAYS)


def page_days(timeframe: str) -> int:
    """How many days of this timeframe make up one page.

        M1    7 days    10 080 bars
        M5   30 days     8 640 bars
        M15  90 days     8 640 bars
        M30 180 days     8 640 bars
        H1  180 days     4 320 bars
        H4  180 days     1 080 bars
        D1  180 days       400 bars

    M1 lands on exactly the week that was asked for - "load seven days
    at a time" - and that is not a coincidence being dressed up: a
    week of M1 is 10 080 bars, which is the budget. The instinct was
    right; it just needed translating for the other six timeframes.

    The rounding is to the NEAREST step, not up. Rounding up walks
    straight off the end of the ladder - M15 wants 104 days, the next
    step is 180, and a chart would then open on the entire window,
    which is the load this whole change exists to remove. Nearest
    keeps every page within a few thousand bars of the budget.

    Never more than HISTORY_DAYS: six months is the promise and also
    the ceiling, so no page can reach past the end of what the product
    undertakes to hold, and the slow timeframes - where one page is
    already the whole window - simply never page at all.
    """
    minutes = max(1, int(timeframe_minutes(timeframe)))
    per_day = (24 * 60) / minutes
    want = PAGE_BARS / per_day if per_day else HISTORY_DAYS
    # Ties go to the shorter page: the cost of being wrong upward is a
    # slower chart, downward it is one extra round trip.
    best = min(_PAGE_DAYS, key=lambda step: (abs(step - want), step))
    return min(best, HISTORY_DAYS)


def page_window(timeframe: str) -> int:
    """One page of this timeframe, in bars.

    Carries the MIN_BARS floor with it, so the slow timeframes - where
    a page is the whole window and the window is 180 bars of D1 - still
    arrive with enough bars for an indicator to have an opinion.
    """
    return bars_for_days(timeframe, page_days(timeframe))


def bars_for_days(timeframe: str, days: int = HISTORY_DAYS) -> int:
    """Bars needed to span `days` of calendar time on this timeframe."""
    minutes = max(1, int(timeframe_minutes(timeframe)))
    span = max(1, int(days)) * 24 * 60
    needed = -(-span // minutes)  # ceiling division
    return max(MIN_BARS, min(MAX_BARS, needed))


def at_least_window(timeframe: str, asked: int | None = None) -> int:
    """`asked`, raised to the HISTORY_DAYS floor for this timeframe.

    Callers keep their own number - a backtest the trader has asked to
    run over more history, a configured lookback - and this only ever
    raises it. Nothing in the product may ask for less than the window
    the product promises.

    Named for the promise rather than for a number of days: it was
    at_least_30_days, the promise became 180, and a function whose name
    states a figure it no longer enforces is worse than one with a
    vague name. Every caller reads it to decide how much history to
    fetch, so the name is the first thing anybody checks.
    """
    floor = bars_for_days(timeframe)
    try:
        want = int(asked or 0)
    except (TypeError, ValueError):
        want = 0
    return min(MAX_BARS, max(floor, want))


#: The old name, kept so an out-of-tree caller does not break on an
#: internal rename. Nothing in this repository uses it.
at_least_30_days = at_least_window


def requested_window(timeframe: str, asked: int | None = None) -> int:
    """`asked` bars when a caller really asked; the promise when it did not.

    The twin of :func:`at_least_window`, and the difference between them
    is who is asking.

    Everything inside the engine - the trader, the analysis, the
    backtest, the store - must not be allowed to under-ask, because
    under-asking silently shortens the window the product promises and
    nobody notices until a strategy is judged on a fortnight. Those
    callers use at_least_window and get the floor whatever they pass.

    The desk is different. It is a window on a screen, and it knows how
    much of the series it is actually showing: a chart opened on one
    month must be able to ask for one month, or every chart that opens
    pulls six months of bars - 259 200 of them on M1 - before anything
    is drawn. That was measured as a slow, apparently frozen start-up
    after HISTORY_DAYS went from 30 to 180, and the fix is to let the
    front end say a smaller number and be believed.

    The promise is not weakened: it is still what a caller gets when it
    does not state a number, and the six months are still there to be
    fetched the moment the trader picks that range.
    """
    try:
        want = int(asked or 0)
    except (TypeError, ValueError):
        want = 0
    if want <= 0:
        return bars_for_days(timeframe)
    #: A floor remains, because an indicator needs some bars to exist
    #: at all and a caller asking for five is a bug, not a preference.
    #:
    #: And a CEILING of the promise itself, not of MAX_BARS.
    #:
    #: MAX_BARS is a memory guard - a flat 300 000 bars, which is eight
    #: and a half YEARS of M15 and about seven months of M1. Capping a
    #: chart request there meant the bound varied wildly by timeframe
    #: and, on everything slower than M1, was no bound at all: a desk
    #: asking for a big round number got whatever the broker would
    #: part with, and the expert then streamed all of it, 250 bars at
    #: a time, into an engine that had to write and broadcast every
    #: chunk. Six months is what the product promises and what the
    #: trader asked to be the limit, so six months is the ceiling.
    return min(bars_for_days(timeframe), max(60, want))


def bars_to_cover(timeframe: str, start: Any, now: Any = None) -> int:
    """Bars needed to reach back to `start` from today, on this timeframe.

    The window every other function here talks about is measured
    forward from the present: "the last HISTORY_DAYS". A backtest is
    not - it names a period, and that period can sit anywhere inside
    the broker's history. Asking for the promise-sized window and then
    slicing it is right only while the period is inside the promise;
    a run over last month on a desk that happens to hold three weeks
    was answered "no bars in that period", which is a true sentence
    about a window nobody asked for.

    `start` is YYYY-MM-DD, or anything ISO that begins with one, or
    empty - and empty means "no lower bound", which cannot be sized, so
    it returns 0 and leaves the caller's own floor in charge.

    Generous by the same margin as bars_for_days, plus a few days of
    run-up: a strategy needs bars BEFORE the period to have an opinion
    on its first one.
    """
    text = str(start or "").strip()[:10]
    if len(text) != 10:
        return 0
    try:
        year, month, day = (int(part) for part in text.split("-"))
        first = date(year, month, day)
    except (TypeError, ValueError):
        return 0
    today = now if isinstance(now, date) else date.today()
    days = (today - first).days + 1
    if days <= 0:
        return 0
    #: Run-up, in days, so the first bar of the period is not the first
    #: bar the strategy has ever seen.
    return bars_for_days(timeframe, days + 10)


def cache_size(timeframe: str) -> int:
    """How many bars of this timeframe to keep in memory.

    A little over the window, so the oldest bar of it is not dropped
    the moment a new one arrives.
    """
    return min(MAX_BARS, bars_for_days(timeframe) + 200)
