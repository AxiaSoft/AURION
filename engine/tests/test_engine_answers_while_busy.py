"""The engine must keep answering while it is working.

Reported as the engine going offline, then online, then offline, and
then nothing working at all. The engine log showed no crash: uvicorn
answered ``GET /health 200 OK`` throughout. Nothing was dying. The desk
was deciding the engine was dead and acting on it.

The deciding is a 5-second health timeout. The acting is the
supervisor starting a replacement. And the replacement was the disaster:
uvicorn binds its listening socket AFTER running application startup,
and application startup is ``trader.start()`` - the EA socket, the
MetaTrader attach, every trading loop. So a spare engine booted the
whole product, seconds of numpy / pandas / scikit-learn, before
discovering the port was taken. Those seconds were spent on a machine
that was by definition already too busy to answer in time, so the next
checks were missed too, and another spare was launched.

Two halves to not doing that again. The desk's half - never start an
engine onto a held port - is in tests/engine-flapping.test.cjs. This
file is the engine's half: do not stop answering in the first place.

The measurements here are deliberately generous. They are not
performance targets; they are the difference between "slower than it
could be" and "the desk concludes this process is dead".
"""

from __future__ import annotations

import asyncio
import time
from dataclasses import asdict

from aurion.mt5.bridge import MT5Bridge
from aurion.mt5.types import Candle


def _bars(n: int) -> list[dict]:
    return [
        {
            "time": f"2026-01-{1 + (i // 1440) % 27:02d} {(i // 60) % 24:02d}:{i % 60:02d}:00",
            "time_msc": 1_700_000_000_000 + i * 60_000,
            "open": 1.1,
            "high": 1.2,
            "low": 1.0,
            "close": 1.15,
            "volume": 10,
            "spread": 2,
        }
        for i in range(n)
    ]


def test_candle_to_dict_matches_asdict_exactly() -> None:
    """The fast path must be indistinguishable from the slow one.

    to_dict() no longer calls dataclasses.asdict(), which recursed and
    deep-copied every field - 190,000 deepcopy calls for one history
    reply, on the event loop. Hand-written output is only safe while it
    stays identical, including when a field is added to Candle.
    """
    candle = Candle(
        symbol="XAUUSD",
        timeframe="M5",
        time="2026-01-01 00:00:00",
        time_msc=1_700_000_000_000,
        open=1.0,
        high=2.0,
        low=0.5,
        close=1.5,
        volume=3.0,
        spread=2.0,
        real_volume=7.0,
    )
    assert candle.to_dict() == asdict(candle)
    # A field added to the dataclass and forgotten here would silently
    # stop being broadcast to the desk.
    assert list(candle.to_dict()) == list(asdict(candle))


def test_a_big_history_does_not_block_the_loop() -> None:
    """A six-month history reply must not stall the event loop.

    The desk's health timeout is 5 seconds and the supervisor acts after
    three missed checks. A single ingest that holds the loop for a large
    fraction of that is how a healthy engine gets "restarted".
    """
    asyncio.run(_big_history_does_not_block())


async def _big_history_does_not_block() -> None:
    bridge = MT5Bridge()

    async def _emit(_topic, _payload=None):
        return None

    bridge.emit = _emit  # type: ignore[assignment]

    worst = 0.0
    running = True

    async def heartbeat() -> None:
        nonlocal worst
        last = time.perf_counter()
        while running:
            await asyncio.sleep(0.001)
            now = time.perf_counter()
            worst = max(worst, now - last)
            last = now

    beat = asyncio.create_task(heartbeat())
    await asyncio.sleep(0.05)
    started = time.perf_counter()

    message = {
        "type": "candles",
        "symbol": "XAUUSD",
        "timeframe": 5,
        "timeframe_name": "M5",
        "chart_id": 1,
        "bars": _bars(8640),
        "replace": True,
        "final": True,
    }
    await bridge._on_ea_message(None, message)

    took = time.perf_counter() - started
    running = False
    await beat

    # Two assertions, because an absolute millisecond figure means
    # different things on a developer machine, on CI and on a trader's
    # laptop.
    #
    # The portable one is the SHARE of the work done without letting go.
    # A handler that chunks its work can never spend most of its wall
    # time in one uninterruptible block, however fast or slow the
    # machine is. Measured here: 86% of 197 ms before the fix, 25% of
    # 53 ms after.
    share = worst / took if took > 0 else 1.0
    assert share < 0.6, (
        f"one uninterrupted block was {share * 100:.0f}% of the {took * 1000:.0f} ms "
        "this history took - the loop is not being released"
    )

    # And an absolute ceiling, for the case the ratio cannot catch: a
    # machine so slow that even chunked work is a problem. A full
    # second of silence is a fifth of the desk's patience, for one
    # message, and four charts ask at once.
    assert worst < 1.0, f"the loop was blocked for {worst * 1000:.0f} ms by one history reply"


def test_the_bars_still_arrive_intact() -> None:
    """Yielding mid-ingest must not lose or reorder a single bar.

    The loop now awaits every 500 rows. An await is a place where other
    code runs, so this is the assertion that the breathing room did not
    cost correctness.
    """
    asyncio.run(_bars_arrive_intact())


async def _bars_arrive_intact() -> None:
    bridge = MT5Bridge()
    seen: list[dict] = []

    async def _emit(topic, payload=None):
        if topic == "candles" and payload:
            seen.append(payload)

    bridge.emit = _emit  # type: ignore[assignment]

    rows = _bars(1700)          # spans four yield points
    await bridge._on_ea_message(
        None,
        {
            "type": "candles",
            "symbol": "EURUSD",
            "timeframe": 5,
            "timeframe_name": "M5",
            "chart_id": 2,
            "bars": rows,
            "replace": True,
            "final": True,
        },
    )

    assert seen, "the finished history was never broadcast"
    got = seen[-1]["bars"]
    assert len(got) == len(rows), f"{len(rows)} bars in, {len(got)} out"
    times = [b["time"] for b in got]
    assert times == sorted(times), "the series came back out of order"
    assert len(set(times)) == len(times), "a bar was duplicated"
