"""The bars from the hours AURION was not running.

Reported in these words:

    "AURION closed at 1:30 and all the candles up to then had been
     read. It was off until 2. When I opened it again it showed the
     candle for 2 so the chart would carry on, but everything from
     1:30 onwards is simply gone. Every candle must be read."

Two separate faults made that one hole, and both are pinned here.

  1. Nothing ever ASKED for the missing hours. Every "do we need to
     download?" test counted bars - is the series long enough, does it
     reach far enough back - and the series was long and deep. It just
     stopped at 1:30. A series that ends in the past is now a reason
     to ask, once per series per expert connection, so a closed market
     cannot turn it into a poll.

  2. Whatever arrived was thrown away. A fresh answer either
     overwrote the held series or was discarded whole, chosen by which
     one reached further BACK - so the deep archive beat the terminal's
     recent window every time, and the recent window was the only place
     the missing half hour existed. The two are merged now.

    cd engine && python -m pytest tests/test_no_hole_where_aurion_was_closed.py
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone

from aurion.mt5.bridge import MT5Bridge
from aurion.mt5.types import Candle


class _FakeNative:
    connected = False


def _bridge() -> MT5Bridge:
    """A bridge with one live chart attached and no MetaTrader behind it.

    `is_ea_symbol` is answered from the attached charts and their
    heartbeats, so both are set - otherwise pull_candles returns early
    and these tests would pass for the wrong reason.
    """
    import time

    from aurion.mt5.types import ChartAgent

    b = MT5Bridge()
    b.native = _FakeNative()
    b.symbols = ["EURUSD"]
    b.agents[1] = ChartAgent(chart_id=1, symbol="EURUSD", timeframe="M15",
                             ea_name="AurionBridge", version="1.22")
    b._agent_beat[1] = time.time()
    return b


def _bar(when: datetime, close: float = 1.0) -> Candle:
    return Candle(
        symbol="EURUSD", timeframe="M15",
        time=when.strftime("%Y-%m-%dT%H:%M:%S"), time_msc=0,
        open=close, high=close, low=close, close=close, volume=1, spread=0,
    )


def _series(start: datetime, count: int) -> list[Candle]:
    return [_bar(start + timedelta(minutes=15 * i), 1.0 + i) for i in range(count)]


# --------------------------------------------- 1. the hole is noticed

def test_a_series_that_stops_hours_ago_is_chased() -> None:
    """The half hour nobody asked for.

    The cache is long, deep and entirely plausible - and it ends two
    hours before now, because that is when AURION was closed.
    """
    b = _bridge()
    now = datetime.now(timezone.utc).replace(second=0, microsecond=0)
    bucket = b._tape_store("live")["candles"][("EURUSD", "M15")]
    bucket.extend(_series(now - timedelta(days=10), 900))

    asked: list[int] = []

    async def fake_request(symbol, timeframe, timeout=8.0, count=0):
        asked.append(int(count))
        return []

    b._request_ea_history = fake_request  # type: ignore[assignment]
    asyncio.run(b.pull_candles("EURUSD", "M15", 300, exact=True))
    assert asked, "a series that stops where AURION closed was never chased"


def test_a_series_that_reaches_now_is_left_alone() -> None:
    """A live chart is not a hole. Nothing is asked for."""
    b = _bridge()
    now = datetime.now(timezone.utc).replace(second=0, microsecond=0)
    bucket = b._tape_store("live")["candles"][("EURUSD", "M15")]
    bucket.extend(_series(now - timedelta(minutes=15 * 899), 900))

    asked: list[int] = []

    async def fake_request(symbol, timeframe, timeout=8.0, count=0):
        asked.append(int(count))
        return []

    b._request_ea_history = fake_request  # type: ignore[assignment]
    asyncio.run(b.pull_candles("EURUSD", "M15", 300, exact=True))
    assert asked == [], "a series that is up to date was downloaded again"


def test_the_hole_is_chased_once_per_connection_not_per_poll() -> None:
    """A shut market must not become a download every few seconds."""
    b = _bridge()
    now = datetime.now(timezone.utc).replace(second=0, microsecond=0)
    bucket = b._tape_store("live")["candles"][("EURUSD", "M15")]
    bucket.extend(_series(now - timedelta(days=10), 900))

    asked: list[int] = []

    async def fake_request(symbol, timeframe, timeout=8.0, count=0):
        asked.append(int(count))
        return []

    b._request_ea_history = fake_request  # type: ignore[assignment]
    for _ in range(5):
        asyncio.run(b.pull_candles("EURUSD", "M15", 300, exact=True))
    assert len(asked) == 1, f"the stale tail was chased {len(asked)} times"

    # ...and a new expert is a new chance: it may have the bars the
    # last one could not reach.
    b._tail_chased.clear()
    asyncio.run(b.pull_candles("EURUSD", "M15", 300, exact=True))
    assert len(asked) == 2, "a reconnecting expert was never asked"


# --------------------------------------------- 2. what arrives is kept

def test_a_recent_answer_fills_the_hole_instead_of_being_discarded() -> None:
    """The whole of the reported fault, run rather than read.

    Held: a deep series that stops at 01:30, which is what the archive
    of an installation closed at 01:30 looks like.
    Arriving: the terminal's recent window, which starts at 00:00 and
    runs to 03:00 - the only place the missing bars exist.

    The old rule kept the deep one because it reached further back and
    threw the other away, leaving the hole for good.
    """
    b = _bridge()
    day = datetime(2026, 11, 24, tzinfo=timezone.utc)
    held = _series(day - timedelta(days=5), 500)        # ... up to 01:30
    cut = day.replace(hour=1, minute=30)
    held = [c for c in held if c.time <= cut.strftime("%Y-%m-%dT%H:%M:%S")]
    bucket = b._tape_store("live")["candles"][("EURUSD", "M15")]
    bucket.extend(held)
    deepest = held[0].time

    fresh = _series(day, 13)                            # 00:00 ... 03:00
    b._install_series("EURUSD", "M15", fresh)

    times = [c.time for c in b.candles_of("EURUSD", "M15")]
    assert times == sorted(times), "the series came back out of order"
    assert len(times) == len(set(times)), "a bar was held twice"
    assert times[0] == deepest, "the merge lost the months behind it"
    for missing in ("2026-11-24T01:45:00", "2026-11-24T02:00:00",
                    "2026-11-24T02:30:00", "2026-11-24T03:00:00"):
        assert missing in times, f"{missing} is still missing from the chart"


def test_a_resend_of_a_bar_still_corrects_it() -> None:
    """Merging must not make a correction impossible."""
    b = _bridge()
    day = datetime(2026, 11, 24, tzinfo=timezone.utc)
    b._install_series("EURUSD", "M15", [_bar(day, 1.0)])
    b._install_series("EURUSD", "M15", [_bar(day, 2.0)])
    held = b.candles_of("EURUSD", "M15")
    assert len(held) == 1, "a re-sent bar became a second bar"
    assert held[0].close == 2.0, "the later reading did not win"


def test_an_experts_replace_no_longer_erases_what_came_before_it() -> None:
    """"Here is the series" is authoritative for its own window only.

    An expert that answers with a recent window used to empty the
    buffer first, which erased every bar older than that window -
    months of history, deleted by a reply about this morning.
    """
    b = _bridge()
    day = datetime(2026, 11, 24, tzinfo=timezone.utc)
    old = _series(day - timedelta(days=30), 200)
    bucket = b._tape_store("live")["candles"][("EURUSD", "M15")]
    bucket.extend(old)

    async def go() -> None:
        await b._on_ea_message(None, {
            "type": "candles", "chart_id": 1, "symbol": "EURUSD",
            "timeframe": 15, "timeframe_name": "M15",
            "replace": True, "final": True,
            "bars": [{"time": c.time, "open": c.open, "high": c.high,
                      "low": c.low, "close": c.close, "volume": c.volume}
                     for c in _series(day, 8)],
        })

    asyncio.run(go())
    times = [c.time for c in b.candles_of("EURUSD", "M15")]
    assert old[0].time in times, "a recent reply deleted the months behind it"
    assert _series(day, 8)[-1].time in times, "the reply itself did not land"
    assert len(times) == len(set(times)), "a bar was held twice"
