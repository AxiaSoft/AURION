"""Chart work must be finite, recent, and capped at the promise.

Reported, and it is the clearest bug report in the project: with the
expert detached the engine never flaps; attach it to one or more charts
and the engine goes haywire, drops in and out, and sometimes takes the
whole desk with it.

That rules out the engine itself. Attaching the expert does exactly two
things: it makes real history available, and it makes the desk draw
charts from it. So the fault is in what the product does with history
once it finally has some, and there were two unbounded things.

**The marks walked backwards for ever.** The signal marks on the chart
were produced by replaying every armed strategy bar by bar, 1200 bars
on the first pass and 1500 more on every single refresh, until six
months were covered. On M1 that is 259 200 bars at roughly 11 ms each,
per chart, and four charts refresh at once. The work had no end, so the
machine never returned to idle, so health checks were missed, so the
desk declared the engine dead. The trader's instruction was blunt and
correct: do not analyse the whole chart - one day is what is being
looked at.

**The load had no real ceiling.** requested_window believed the desk's
bar count up to MAX_BARS, which is a flat 300 000 - a memory guard, not
a window. On M15 that is eight and a half years. The promise is six
months and the trader asked for six months to be the limit.

These tests are about boundedness, not about speed. A fast engine that
is given endless work is a slow engine an hour later.
"""

from __future__ import annotations

from aurion.runtime.trader import MARK_DAYS, MARK_EXTEND_BARS, Trader
from aurion.signals.strategy_signals import WARMUP_BARS
from aurion.util.history import HISTORY_DAYS, bars_for_days, requested_window

# Bars in six months, per timeframe, for readability below.
SIX_MONTHS = {tf: bars_for_days(tf) for tf in ("M1", "M5", "M15", "H1", "H4", "D1")}

PER_DAY = {"M1": 1440, "M5": 288, "M15": 96, "H1": 24, "H4": 6}


def _trader() -> Trader:
    # Half this suite builds a Trader this way: __init__ wants a live
    # machine, and these are pure functions of their arguments.
    return object.__new__(Trader)


def _bars(n: int, minutes: int) -> list[dict]:
    return [{"time": f"t{i:08d}", "open": 1.0, "high": 1.0, "low": 1.0,
             "close": 1.0, "volume": 1.0} for i in range(n)]


# ---------------------------------------------------------------- #
# The marked region is one day, on every timeframe
# ---------------------------------------------------------------- #

def test_marks_cover_one_day_whatever_the_timeframe() -> None:
    """One day means one day - not one bar count reused everywhere.

    A fixed bar count means a different amount of time on every
    timeframe, which is the bug util/history.py exists to prevent. The
    marked window is stated in days and converted per timeframe.
    """
    trader = _trader()
    for tf, per_day in PER_DAY.items():
        total = SIX_MONTHS[tf]
        marked = total - trader._mark_floor(tf, total)
        assert marked == per_day * MARK_DAYS, (
            f"{tf}: marked {marked} bars, which is not {MARK_DAYS} day(s) "
            f"({per_day * MARK_DAYS} bars)"
        )


def test_the_marked_region_is_the_newest_end_of_the_chart() -> None:
    """Marks belong at the right-hand edge, where the trading is.

    The window is anchored to the newest bar, so it slides forward as
    the chart does rather than sitting over a fixed piece of history.
    """
    trader = _trader()
    total = SIX_MONTHS["M15"]
    floor = trader._mark_floor("M15", total)
    assert floor + PER_DAY["M15"] == total, "the marked window is not flush with the newest bar"
    # ...and it moves when the chart does.
    assert trader._mark_floor("M15", total + 10) == floor + 10


def test_a_short_history_cannot_produce_a_backwards_range() -> None:
    """Warm-up can exceed the whole series on a slow timeframe.

    220 bars of warm-up against 180 bars of D1 gave a floor past the
    end, and a range whose start is after its end reads as "analyse
    nothing" in one place and "analyse everything" in another.
    """
    trader = _trader()
    for tf, total in (("D1", 180), ("D1", 0), ("M1", 50), ("H4", WARMUP_BARS - 1)):
        floor = trader._mark_floor(tf, total)
        assert 0 <= floor <= total, f"{tf} with {total} bars gave floor {floor}"


# ---------------------------------------------------------------- #
# The work ends
# ---------------------------------------------------------------- #

def test_the_marking_work_finishes_and_stays_finished() -> None:
    """The planner must reach "complete" and stay there.

    This is the original bug, and the guarantee still holds - but
    what counts as finished has changed, on a second report: "the
    signals only cover part of the chart; today's candles show
    none".

    The old planner stopped at the end of its first day-long pass
    and declared the chart done, so every bar older than a day was
    left permanently unanalysed. Now the first pass still covers
    one day - so the newest bars carry marks within one refresh -
    and each later call walks one bounded slab further back until
    the window the desk asked for is covered. Then, and this is the
    part that must never regress, it stops for good.

    So: bounded per call, and finite overall.
    """
    trader = _trader()
    tf = "M15"
    total = SIX_MONTHS[tf]
    bars = _bars(total, 15)
    armed: list = []
    store: dict = {}
    trader._marks_store = lambda: store                     # type: ignore[assignment]
    trader._chart_mark_key = lambda s, t, a: "k"            # type: ignore[assignment]

    first = trader._chart_mark_plan("XAUUSD", tf, armed, bars)
    assert first["fresh"] is True
    covered = first["last"] - first["first"]
    assert covered == PER_DAY[tf], f"the first pass covered {covered} bars, not one day"

    # Walk it the way the refreshes would, recording each pass.
    lo, hi = first["first"], first["last"]
    store["k"] = {"from_time": bars[lo]["time"],
                  "to_time": bars[hi - 1]["time"], "signals": []}

    passes = 0
    while True:
        plan = trader._chart_mark_plan("XAUUSD", tf, armed, bars)
        if plan.get("complete"):
            assert plan["last"] - plan["first"] == 0, "a completed plan still has bars in it"
            break
        slab = plan["last"] - plan["first"]
        assert 0 < slab <= MARK_EXTEND_BARS + 1, (
            f"one refresh asked for {slab} bars - the point is that no single "
            "call may be unbounded"
        )
        lo = min(lo, plan["first"])
        hi = max(hi, plan["last"])
        store["k"] = {"from_time": bars[lo]["time"],
                      "to_time": bars[hi - 1]["time"], "signals": []}
        passes += 1
        assert passes < 200, "the walk back never reached a finished state"

    assert passes > 1, "the chart was declared finished with most of it unanalysed"
    assert lo <= trader._mark_target_floor(total), (
        "the walk stopped before reaching the start of the window - which is "
        "the 'older candles have no signals' report"
    )

    # And once finished it stays finished, however often it is asked.
    for _ in range(3):
        assert trader._chart_mark_plan("XAUUSD", tf, armed, bars).get("complete") is True


def test_new_bars_are_the_only_work_a_settled_chart_does() -> None:
    """A closed bar is a few bars of work, not a new sweep of history."""
    trader = _trader()
    tf = "M15"
    total = SIX_MONTHS[tf]
    bars = _bars(total, 15)
    store: dict = {}
    trader._marks_store = lambda: store                     # type: ignore[assignment]
    trader._chart_mark_key = lambda s, t, a: "k"            # type: ignore[assignment]

    plan = trader._chart_mark_plan("XAUUSD", tf, [], bars)
    store["k"] = {"from_time": bars[plan["first"]]["time"],
                  "to_time": bars[plan["last"] - 1]["time"], "signals": []}

    grown = bars + _bars(3, 15)[:3]
    for i, bar in enumerate(grown[total:], start=total):
        bar["time"] = f"t{i:08d}"
    nxt = trader._chart_mark_plan("XAUUSD", tf, [], grown)
    todo = nxt["last"] - nxt["first"]
    assert todo <= 5, f"three new bars caused {todo} bars of analysis"


# ---------------------------------------------------------------- #
# Six months is the ceiling
# ---------------------------------------------------------------- #

def test_a_chart_can_never_ask_for_more_than_six_months() -> None:
    """Whatever the desk asks for, the answer is capped at the promise.

    MAX_BARS is a memory guard of 300 000 bars - eight and a half years
    of M15 - and capping here meant there was effectively no ceiling on
    anything slower than M1.
    """
    for tf in SIX_MONTHS:
        for absurd in (300_000, 1_000_000, 99_999_999):
            got = requested_window(tf, absurd)
            assert got <= SIX_MONTHS[tf], (
                f"{tf}: asking for {absurd} returned {got} bars, which is "
                f"more than the {HISTORY_DAYS}-day promise ({SIX_MONTHS[tf]})"
            )


def test_a_smaller_ask_is_still_believed() -> None:
    """The cap must not become a floor.

    A chart opened on one day must be able to fetch one day. Raising
    every request to six months is what made opening a chart feel
    frozen, and it is a separate bug from this one.
    """
    for tf in SIX_MONTHS:
        assert requested_window(tf, 500) <= max(500, 400)
    assert requested_window("M1", 500) == 500
    assert requested_window("M15", 500) == 500


def test_asking_for_nothing_still_means_the_promise() -> None:
    """A caller that states no number gets the full window, as before."""
    for tf in SIX_MONTHS:
        assert requested_window(tf, 0) == bars_for_days(tf)
        assert requested_window(tf, None) == bars_for_days(tf)


# ---------------------------------------------------------------- #
# Two instruments are not one instrument
# ---------------------------------------------------------------- #

def test_a_broker_suffix_is_still_the_same_instrument() -> None:
    """The reason prefix matching exists at all.

    The same gold is XAUUSD on one broker and XAUUSD.m, XAUUSDm,
    XAUUSD-ECN or XAUUSD_i on another, and a trader on one of those
    must not be told their expert is attached to something else.
    """
    from aurion.mt5.bridge import MT5Bridge

    bridge = object.__new__(MT5Bridge)
    for other in ("XAUUSD.m", "XAUUSDm", "XAUUSD-ECN", "XAUUSD_i", "XAUUSD.raw", "xauusd"):
        assert bridge._sym_match("XAUUSD", other), f"XAUUSD and {other} are the same gold"


def test_a_number_on_the_end_is_a_different_instrument() -> None:
    """US30 and US3000 are two indices, not one with a suffix.

    Prefix matching decides which waiters a history answer is handed
    to, so a false match here delivers one market's candles into
    another market's series - the same class of fault as the desk
    drawing a lone candle from somewhere else, one layer down. A
    broker suffix names an account type and is never a number.
    """
    from aurion.mt5.bridge import MT5Bridge

    bridge = object.__new__(MT5Bridge)
    for a, b in (("US30", "US3000"), ("NAS100", "NAS1000"), ("GER40", "GER403")):
        assert not bridge._sym_match(a, b), f"{a} and {b} were treated as one instrument"
    # And the plainly-unrelated case has not stopped working.
    assert not bridge._sym_match("EURUSD", "GBPUSD")
    assert bridge._sym_match("EURUSD", "EURUSD")
