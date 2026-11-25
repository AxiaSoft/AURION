"""Whose candles are these, and how much history may one ask for at a time.

Two faults were reported together and they turn out to share a
boundary: the desk drew candles at prices the symbol never traded at,
and attaching the expert buried the engine under a six-month
download. Both are questions about how much the engine is willing to
assume - about identity in the first case and about appetite in the
second.
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

ENGINE = str(Path(__file__).resolve().parents[1])
if ENGINE not in sys.path:
    sys.path.insert(0, ENGINE)

from aurion.mt5.bridge import MT5Bridge
from aurion.mt5.types import Candle


# ------------------------------------------------------------------ #
# Identity
# ------------------------------------------------------------------ #

def test_a_broker_suffix_is_the_same_series() -> None:
    """The reason any folding exists at all.

    The same gold is XAUUSD on one broker and XAUUSD.m, XAUUSD-ECN or
    XAUUSD_i on another. A trader on one of those must not be told
    their chart has no data.
    """
    for other in ("XAUUSD.m", "XAUUSD-ECN", "XAUUSD_i", "XAUUSD.raw", "xauusd", "XAUUSD.pro"):
        assert MT5Bridge._same_series("XAUUSD", other), f"XAUUSD and {other} are one series"


def test_two_instruments_are_never_one_series() -> None:
    """The fault: a generous match delivering somebody else's prices.

    EURUSD and EURUSDT are different instruments, as are US30 and
    US3000, and XAU and XAUUSD. The old test matched on bare prefix,
    so all three pairs collapsed - and a lookup for one answered with
    the other's candles.
    """
    for a, b in (
        ("EURUSD", "EURUSDT"),
        ("US30", "US3000"),
        ("NAS100", "NAS1000"),
        ("XAU", "XAUUSD"),
        ("EURUSD", "GBPUSD"),
        ("XAUUSD", "XAUUSDm"),
    ):
        assert not MT5Bridge._same_series(a, b), f"{a} and {b} were treated as one series"


def test_a_dated_contract_is_not_a_suffixed_one() -> None:
    """CL.F25 and CL.G25 are two futures, not crude oil twice.

    The separator alone cannot decide this; the digits are what say
    the remainder names a contract rather than an account type.
    """
    assert not MT5Bridge._same_series("CL.F25", "CL.G25")
    assert not MT5Bridge._same_series("CL.F25", "CL")


def _bridge() -> MT5Bridge:
    """A bridge with just the tape store its candle lookups read.

    Built by hand rather than by constructing the real thing: this is
    about one lookup, and standing up a bridge means sockets, tasks
    and a terminal.
    """
    class _Native:
        connected = True          # pins the tape to "live"

    b = object.__new__(MT5Bridge)
    b._tapes = {"live": {"candles": {}, "positions": []}}
    b._tape_hint = "live"
    b.agents = {}
    b.native = _Native()
    return b


def _rows(symbol: str, timeframe: str, price: float, n: int = 3) -> list[Candle]:
    return [
        Candle(symbol, timeframe, f"2026-01-01T10:{i:02d}:00", 0,
               price, price + 1, price - 1, price, 10.0)
        for i in range(n)
    ]


def test_a_lookup_never_answers_with_another_symbols_candles() -> None:
    """The defect, at the exact line it came through.

    _candles_for fell back to a generous match when the exact series
    was empty, so asking for EURUSD returned EURUSDT's rows. The desk
    stamped them with the name it had asked for, and from then on
    every guard downstream was comparing a label the data had never
    earned: one candle at the real price with the rest a world away.
    """
    b = _bridge()
    b.candles[("EURUSDT", "M15")] = _rows("EURUSDT", "M15", 1.07)
    assert b._candles_for("EURUSD", "M15") == []

    # And the legitimate fold still works.
    b.candles[("XAUUSD.m", "M15")] = _rows("XAUUSD.m", "M15", 3000.0)
    assert len(b._candles_for("XAUUSD", "M15")) == 3


def test_rows_that_disown_their_key_are_refused() -> None:
    """Belt as well as braces: the bars carry their own symbol.

    A slab filed under the right key but cut from the wrong symbol is
    the same fault one layer in, and it is detectable rather than
    merely unlikely - so it is detected.
    """
    b = _bridge()
    b.candles[("XAUUSD.m", "M15")] = _rows("EURUSD", "M15", 1.07)
    assert b._candles_for("XAUUSD", "M15") == []


def test_an_exact_hit_is_still_answered_straight_away() -> None:
    """None of this may cost the ordinary case anything."""
    b = _bridge()
    b.candles[("XAUUSD", "M15")] = _rows("XAUUSD", "M15", 3000.0)
    assert len(b._candles_for("XAUUSD", "M15")) == 3


# ------------------------------------------------------------------ #
# Appetite
# ------------------------------------------------------------------ #

class _StepBridge:
    """A terminal that will only ever serve one month more per ask."""

    def __init__(self, month_bars: int, available: int) -> None:
        self.month_bars = month_bars
        self.available = available
        self.served = 0
        self.asks: list[int] = []

    async def pull_candles(self, symbol, timeframe, count=0, exact=False,
                           need_from="", tries=1):
        self.asks.append(int(count))
        reach = min(int(count), self.served + self.month_bars, self.available)
        self.served = max(self.served, reach)
        return [
            {"symbol": symbol, "timeframe": timeframe, "time": f"bar{i}", "close": 1.0}
            for i in range(self.served)
        ]


def _trader_with(bridge) -> object:
    from aurion.runtime.trader import Trader

    t = object.__new__(Trader)
    t.bridge = bridge
    return t


def test_a_backtest_assembles_its_window_one_month_at_a_time() -> None:
    """Three months arrive as three asks, not as one demand.

    The expert now refuses to serve more than a month per request -
    that is what stops the download storm - so the side that needs
    three months has to ask three times. If this loop were dropped, a
    quarter-long backtest would quietly test one month and report a
    verdict on it.
    """
    month = 2000
    bridge = _StepBridge(month_bars=month, available=month * 3)
    trader = _trader_with(bridge)
    bars = asyncio.run(trader._pull_history_in_steps("XAUUSD", "M15", month * 3))
    assert len(bars) == month * 3, "the full window was not assembled"
    assert len(bridge.asks) >= 3, f"expected several bounded asks, got {bridge.asks}"
    assert max(bridge.asks) <= month * 3, "one ask tried to take the whole window"


def test_the_walk_stops_when_the_broker_has_no_more() -> None:
    """A short archive is an answer, not a reason to keep asking.

    Without this the loop would spend its whole budget re-requesting
    history that does not exist - which is the shape of the original
    fault, just relocated.
    """
    month = 2000
    bridge = _StepBridge(month_bars=month, available=month)   # only one month exists
    trader = _trader_with(bridge)
    bars = asyncio.run(trader._pull_history_in_steps("XAUUSD", "M15", month * 6))
    assert len(bars) == month
    assert len(bridge.asks) <= 3, f"kept asking for history that is not there: {bridge.asks}"


def test_the_walk_is_bounded_even_if_nothing_satisfies_it() -> None:
    """It must not be able to run for ever under any answer."""
    from aurion.runtime.trader import Trader

    class _Greedy(_StepBridge):
        async def pull_candles(self, *a, **k):
            self.asks.append(int(a[2] if len(a) > 2 else k.get("count", 0)))
            self.served += 1          # always gains a little, never arrives
            return [{"time": f"b{i}"} for i in range(self.served)]

    bridge = _Greedy(month_bars=10, available=10**9)
    trader = _trader_with(bridge)
    asyncio.run(trader._pull_history_in_steps("XAUUSD", "M15", 10**9))
    assert len(bridge.asks) <= Trader.BACKTEST_MAX_STEPS


# ------------------------------------------------------------------ #
# Marks reaching the bars the trader is reading
# ------------------------------------------------------------------ #

def test_the_marked_region_walks_back_to_the_start_of_the_window() -> None:
    """Reported: the older candles carry no signals.

    The first pass covers the most recent day, so today's bars are
    marked within one refresh. The destination used to be that same
    day, which meant the planner declared itself complete with the
    rest of the chart unanalysed and never went back. Now each
    further call reaches one bounded slab deeper until the window the
    desk asked for is covered.
    """
    from aurion.runtime.trader import MARK_EXTEND_BARS, Trader

    t = object.__new__(Trader)
    total = 9000
    first = t._mark_floor("M15", total)
    target = t._mark_target_floor(total)
    assert first > target, "the first pass should start near the live edge"
    assert target < 500, "the walk should end at the start of the window, not a day in"

    # And a walk from `first` back to `target` terminates.
    steps, lo = 0, first
    while lo > target and steps < 1000:
        lo = max(target, lo - MARK_EXTEND_BARS)
        steps += 1
    assert lo == target and steps < 20, f"took {steps} refreshes to cover the chart"
