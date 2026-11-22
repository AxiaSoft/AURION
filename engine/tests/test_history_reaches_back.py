"""Why the desk could not reach the months MetaTrader was showing.

Reported three times, in these words: "there are months of history in
MetaTrader and AURION will not show them", and "I pick a range in
November and it backtests some other month".

Three different places were each capping the window, and all three are
the same mistake - asking for a NUMBER OF BARS and then deciding, from
another number of bars, whether the answer was good enough.

1. ``MT5Native.candles`` called ``copy_rates_from_pos(symbol, tf, 0,
   count)``. That form is answered out of the series the terminal has
   already built. If the chart holds three thousand bars, three
   thousand bars is the answer however many were asked for, and
   nothing about the call makes the terminal fetch the rest. The
   engine's careful sizing arrived here and was silently ignored. The
   DATE RANGE form is the one that triggers a download.

2. ``AurionBridge.mq5`` had the identical call on the expert side, so
   the fallback pipe capped the window in exactly the same way. Fixed
   in 1.21/1.22 and checked by tests/history-not-abandoned.test.js.

3. ``Trader.backtest`` decided whether to fetch with
   ``len(bars) < want``. Both sides are counts, and a count says
   nothing about WHERE the bars are: a cache holding the whole recent
   window is longer than almost any ``want`` - on M1 it is the
   300 000-bar ceiling - so a request that starts before that window
   passed the test instantly, no fetch was made, and the run was
   answered out of bars that could not contain the chosen period.

Run:
    python3 -m pytest engine/tests/test_history_reaches_back.py -q
"""

from __future__ import annotations

import asyncio
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

NATIVE = (ROOT / "aurion" / "mt5" / "native.py").read_text(encoding="utf-8")
BRIDGE = (ROOT / "aurion" / "mt5" / "bridge.py").read_text(encoding="utf-8")
TRADER = (ROOT / "aurion" / "runtime" / "trader.py").read_text(encoding="utf-8")


def _fn(src: str, name: str) -> str:
    """The body of one def, to the next def at the same indentation.

    `async def` counts: two of the three functions here are coroutines.
    """
    start = re.search(rf"\n(\s*)(?:async )?def {re.escape(name)}\(", src)
    assert start, f"{name} is gone"
    indent = start.group(1)
    rest = src[start.end():]
    nxt = re.search(rf"\n{indent}(?:async )?def ", rest)
    return rest[: nxt.start()] if nxt else rest


# ----------------------------------------------- 1. the official package --

def test_the_native_adapter_asks_for_a_period_not_a_position() -> None:
    body = _fn(NATIVE, "candles")
    assert "copy_rates_range" in body, \
        "copy_rates_from_pos alone can never make the terminal download older bars"
    assert "copy_rates_from_pos" in body, \
        "the position form is still the right fallback for what the terminal already holds"
    # The range must be the one that runs first: the position form is
    # only worth taking when the broker refuses the period. Counted on
    # the CALLS rather than on the prose that explains them.
    calls = re.findall(r"mt5\.(copy_rates_range|copy_rates_from_pos)", body)
    assert calls and calls[0] == "copy_rates_range", \
        f"the first call made is {calls[0] if calls else 'none'}"


def test_the_range_is_the_window_expressed_in_time() -> None:
    body = _fn(NATIVE, "candles")
    assert "timeframe_minutes" in body, "the bar length is not used to size the period"
    assert "float(step) * float(want)" in body, \
        "the period asked for is not `count` bars of calendar time"


def test_a_cold_series_is_asked_for_more_than_once() -> None:
    """The first answer to a range the terminal lacks is short or empty."""
    body = _fn(NATIVE, "candles")
    assert "_RANGE_TRIES" in body and "time.sleep(_RANGE_WAIT_SECONDS)" in body
    tries = int(re.search(r"_RANGE_TRIES = (\d+)", NATIVE).group(1))
    wait = float(re.search(r"_RANGE_WAIT_SECONDS = ([\d.]+)", NATIVE).group(1))
    assert 2 <= tries <= 8, f"{tries} attempts is not a measured amount of patience"
    assert tries * wait <= 4.0, \
        "a desk request would block for longer than a person waits for a chart"


def test_more_than_was_asked_for_is_trimmed() -> None:
    body = _fn(NATIVE, "candles")
    assert "rates[-want:]" in body, \
        "a caller that asked for a thousand bars could be handed six thousand"


# ------------------------------------------------- 2. the bridge's floor --

def test_pull_candles_can_be_told_which_day_it_must_reach() -> None:
    body = _fn(BRIDGE, "pull_candles")
    assert "need_from" in body, "there is no way to ask for depth rather than length"
    assert "shallow" in body and "self._short_of(rows, count) or shallow" in body, \
        "a long but shallow cache still short-circuits the fetch"


def test_the_backtest_decides_by_date_as_well_as_by_count() -> None:
    body = _fn(TRADER, "backtest")
    assert "too_recent" in body, "the fetch is still decided by a count alone"
    assert "asked_from < oldest_held" in body, \
        "nothing compares the requested start against the oldest bar held"
    assert "need_from=asked_from" in body, \
        "the depth the run needs is not passed down to the bridge"


# ---------------------------------------------------- 3. and it behaves ---

class _FakeNative:
    connected = False


def _bridge():
    """A bridge with one live chart attached, and no MetaTrader behind it.

    `is_ea_symbol` is answered from the attached charts and their
    heartbeats, not from a list of names, so the agent and its beat are
    both set - otherwise every path in pull_candles returns early and
    the test would pass for the wrong reason.
    """
    import time

    from aurion.mt5.bridge import MT5Bridge
    from aurion.mt5.types import ChartAgent

    b = MT5Bridge()
    b.native = _FakeNative()
    agent = ChartAgent(chart_id=1, symbol="EURUSD", timeframe="M15",
                       ea_name="AurionBridge", version="1.22")
    b.agents[1] = agent
    b._agent_beat[1] = time.time()
    return b


def _candle(sym: str, tf: str, iso: str):
    from aurion.mt5.types import Candle

    return Candle(symbol=sym, timeframe=tf, time=iso, time_msc=0, open=1.0,
                  high=1.1, low=0.9, close=1.05, volume=1.0)


def test_a_long_but_shallow_cache_still_sends_the_expert_a_request() -> None:
    """The regression itself, run rather than read.

    The cache is deliberately longer than the ask - which is exactly
    the state a six-month window leaves it in - but every bar in it is
    recent. A request that must reach back to last November has to go
    out anyway.
    """
    b = _bridge()
    b.symbols = ["EURUSD"]
    bucket = b._tape_store("live")["candles"][("EURUSD", "M15")]
    for day in range(1, 21):
        for hour in range(24):
            bucket.append(_candle("EURUSD", "M15", f"2026-09-{day:02d}T{hour:02d}:00:00+00:00"))
    assert len(bucket) == 480

    asked: list[tuple[str, str, int]] = []

    async def fake_request(symbol, timeframe, timeout=8.0, count=0):
        asked.append((symbol, timeframe, int(count)))
        return []

    b._request_ea_history = fake_request  # type: ignore[assignment]

    # Shallower than the ask, but not shorter: no request without a date.
    asyncio.run(b.pull_candles("EURUSD", "M15", 200, exact=True))
    assert asked == [], "a cache that is long enough was re-fetched for no reason"

    # Now say which day it has to reach, and it goes out.
    asyncio.run(b.pull_candles("EURUSD", "M15", 200, exact=True, need_from="2025-11-01"))
    assert len(asked) == 1, "a cache that cannot contain the period was accepted"
    assert asked[0][0] == "EURUSD" and asked[0][1] == "M15"


def test_a_cache_that_already_reaches_that_far_is_left_alone() -> None:
    b = _bridge()
    b.symbols = ["EURUSD"]
    bucket = b._tape_store("live")["candles"][("EURUSD", "M15")]
    for day in range(1, 29):
        for hour in range(24):
            bucket.append(_candle("EURUSD", "M15", f"2025-10-{day:02d}T{hour:02d}:00:00+00:00"))

    asked: list[int] = []

    async def fake_request(symbol, timeframe, timeout=8.0, count=0):
        asked.append(int(count))
        return []

    b._request_ea_history = fake_request  # type: ignore[assignment]
    asyncio.run(b.pull_candles("EURUSD", "M15", 300, exact=True, need_from="2025-10-05"))
    assert asked == [], "a cache that does reach back was fetched again anyway"
