"""The engine stays answerable while a large history comes down.

Reported: "I set the backtest to three months, or to all history, and
when it went to download the many candles the engine started
connecting and disconnecting again, and then it went off."

The reproduction is arithmetic plus one measurement. Three months of
M5 is 25 920 bars and the whole window is 51 840; the expert streams
them a few hundred at a time, and a backtest asks in rounds, each
round re-streaming a wider window. Against that the desk gives the
engine five seconds to answer /health and the supervisor restarts it
after three misses - so the engine does not have to crash to "go
off", it only has to stop answering for fifteen seconds.

Three things in the ingest held the loop, and all three scaled with
the size of the download rather than with the size of the chunk:

  * the whole buffer was re-sorted after EVERY chunk. 51 840 bars in
    about a hundred chunks measured at 987 ms of event loop for one
    series, and it climbs with each chunk because the buffer grows;
  * every partial push built the whole series as dicts and JSON -
    22 ms + 120 ms and 9.6 MB at that size - inline, every three
    seconds;
  * the final push and every other whole-series broadcast did the
    same, inline.

These tests drive the real ingest and measure the longest single
stretch the loop was unavailable. They assert a budget, not a
stopwatch reading, because the figure depends on the machine - but
the budget is far below the five seconds that starts the failure,
and comfortably below what the old code did on the same data.
"""

from __future__ import annotations

import asyncio
import time

import pytest

from aurion.mt5.bridge import MT5Bridge
from aurion.mt5.types import Candle


def _bars(n: int, start_hour: int = 0) -> list[dict[str, object]]:
    """`n` M5 bars in time order, the way the expert streams them."""
    out = []
    for i in range(n):
        minute = (i * 5) % 60
        hour = ((i * 5) // 60 + start_hour) % 24
        day = ((i * 5) // (60 * 24)) % 28 + 1
        month = ((i * 5) // (60 * 24 * 28)) % 12 + 1
        out.append(
            {
                "time": f"2026.{month:02d}.{day:02d} {hour:02d}:{minute:02d}:00",
                "time_msc": i,
                "open": 1.0 + i / 1000.0,
                "high": 1.5 + i / 1000.0,
                "low": 0.5 + i / 1000.0,
                "close": 1.2 + i / 1000.0,
                "volume": 10,
                "spread": 2,
            }
        )
    return out


class _LoopWatch:
    """The longest stretch the event loop went unserved.

    A coroutine that wakes as often as it can and records the biggest
    gap between two of its own wakeups. Nothing else can measure
    this: a blocked loop by definition cannot be asked how it is.
    """

    def __init__(self, tick: float = 0.002) -> None:
        self.tick = tick
        self.worst = 0.0
        #: Everything the loop owed and did not pay, added up.
        #:
        #: The worst single gap is not the whole story and on its own
        #: it misses the fault that started this: a hundred sorts of
        #: ten milliseconds each is a second of lost engine and not
        #: one gap worth noticing. Health checks arrive on a timer, so
        #: what decides whether one is answered in time is how much of
        #: the loop is being taken overall.
        self.lost = 0.0
        self.beats = 0
        self._stop = False
        self._task: asyncio.Task | None = None

    async def _run(self) -> None:
        last = time.perf_counter()
        while not self._stop:
            await asyncio.sleep(self.tick)
            now = time.perf_counter()
            late = max(0.0, now - last - self.tick)
            self.worst = max(self.worst, late)
            self.lost += late
            self.beats += 1
            last = now

    def start(self) -> None:
        self._task = asyncio.get_running_loop().create_task(self._run())

    async def stop(self) -> None:
        self._stop = True
        if self._task:
            await asyncio.sleep(0)
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass


async def _stream_history(
    bridge: MT5Bridge, total: int, chunk: int = 500, symbol: str = "XAUUSD"
) -> _LoopWatch:
    """Feed `total` bars the way the expert does, watching the loop."""
    watch = _LoopWatch()
    watch.start()
    bars = _bars(total)
    sent = 0
    first = True
    while sent < total:
        slab = bars[sent : sent + chunk]
        sent += len(slab)
        await bridge._on_ea_message(
            None,
            {
                "type": "candles",
                "symbol": symbol,
                "timeframe": 5,
                "timeframe_name": "M5",
                "chart_id": 1,
                "bars": slab,
                # The expert replaces on the first message of a stream
                # and appends after it.
                "replace": first,
                "final": sent >= total,
                "available": total,
            },
        )
        first = False
    await watch.stop()
    return watch


def _run(coro):
    return asyncio.run(coro)


@pytest.mark.parametrize("total", [25_920, 51_840])
def test_a_long_download_never_blocks_the_loop(total: int) -> None:
    """Three months, then the whole window, of M5.

    The budget is 250 ms. The desk's health timeout is 5 000 ms and
    the supervisor needs three consecutive misses, so this leaves a
    factor of sixty before anything the trader can see goes wrong -
    while the per-chunk sort alone used to spend 987 ms of loop on
    the larger of these two.
    """

    async def go() -> None:
        # Best of two. A timing budget on a shared machine will
        # eventually catch a scheduler hiccup that has nothing to do
        # with this code, and a test that cries wolf gets deleted.
        # The regression this guards is a factor of six, not a few
        # per cent, so the better of two runs still sees it.
        best = None
        for _ in range(2):
            bridge = MT5Bridge()
            watch = await _stream_history(bridge, total)
            held = bridge.candles.get(("XAUUSD", "M5"))
            assert held is not None and len(held) == total, "every bar arrived"
            assert watch.beats > 0, "the watchdog ran at all"
            if best is None or watch.lost < best.lost:
                best = watch
        watch = best
        assert watch is not None
        assert watch.worst < 0.25, (
            f"the loop was blocked for {watch.worst * 1000:.0f} ms in one go "
            f"during a {total}-bar download; the desk calls an engine dead "
            f"at 5 000 ms"
        )
        # And in total. The per-chunk sort never produced one long
        # gap - it produced a hundred short ones, which is why a
        # worst-gap budget alone did not see it.
        budget = 0.060 * (total / 10_000)
        assert watch.lost < budget, (
            f"the ingest took {watch.lost * 1000:.0f} ms of event loop for "
            f"{total} bars, over a budget of {budget * 1000:.0f} ms; the "
            f"per-chunk sort cost 987 ms on this data"
        )

    _run(go())


def test_the_series_still_comes_out_in_time_order() -> None:
    """The sort was removed from the hot path, not abandoned.

    A series out of time order draws as a scribble, so the saving is
    only worth having if the result is identical. Here the expert
    sends a chunk whose bars are shuffled - a backfilled gap, a
    re-sent bar, two charts feeding one series - and the buffer must
    still come out ordered.
    """

    async def go() -> None:
        bridge = MT5Bridge()
        bars = _bars(900)
        shuffled = bars[:400] + list(reversed(bars[400:700])) + bars[700:]
        await bridge._on_ea_message(
            None,
            {
                "type": "candles", "symbol": "EURUSD", "timeframe": 5,
                "timeframe_name": "M5", "chart_id": 2, "bars": shuffled,
                "replace": True, "final": True, "available": 900,
            },
        )
        held = list(bridge.candles[("EURUSD", "M5")])
        times = [c.time for c in held]
        assert times == sorted(times), "a disordered stream is still put in order"
        assert len(held) == 900, "and nothing was dropped on the way"

    _run(go())


def test_an_ordered_stream_is_not_sorted_at_all() -> None:
    """The expert streams oldest first, so the common case is free.

    Measured against the behaviour rather than the clock: a stream
    that arrives in order must never mark the series as needing a
    sort, which is what the hundred redundant sorts came from.
    """

    async def go() -> None:
        bridge = MT5Bridge()
        await _stream_history(bridge, 4000, chunk=400, symbol="GBPUSD")
        assert ("GBPUSD", "M5") not in bridge._hist_unsorted, (
            "an in-order download left the series marked for sorting"
        )

    _run(go())


def test_a_big_payload_is_built_off_the_loop() -> None:
    """Whole-series payloads go to a thread above the threshold.

    Below it the handover costs more than the work, so the small case
    must stay inline - a rule that is easy to write backwards.
    """

    async def go() -> None:
        bridge = MT5Bridge()
        rows = [
            Candle(symbol="XAUUSD", timeframe="M5", time=f"t{i}", time_msc=i,
                   open=1, high=2, low=0.5, close=1.5, volume=1, spread=1)
            for i in range(bridge._OFFLOAD_BARS + 10)
        ]
        wire = await bridge._wire_bars(rows)
        assert len(wire) == len(rows) and isinstance(wire[0], dict)
        assert wire[0]["time"] == "t0", "the bars survive the trip"

        small = await bridge._wire_bars(rows[:10])
        assert len(small) == 10, "and a short series is still answered"

    _run(go())


def test_partials_back_off_as_the_series_grows() -> None:
    """A 9.6 MB push every three seconds is not a progress report.

    The interval has to grow with the series or the engine spends the
    download encoding JSON. It also has to stay bounded, or a long
    series would stop reporting progress altogether.
    """
    bridge = MT5Bridge()
    assert bridge._partial_interval(500) == bridge._PARTIAL_EVERY_S, (
        "a small series reports as often as it ever did"
    )
    assert bridge._partial_interval(2000) == bridge._PARTIAL_EVERY_S
    big = bridge._partial_interval(51_840)
    assert big > bridge._PARTIAL_EVERY_S, "a huge series reports less often"
    assert big <= 20.0, "but never stops reporting"
    assert bridge._partial_interval(10_000) < bridge._partial_interval(40_000), (
        "and it scales with the size, rather than flipping at one threshold"
    )


def test_the_desk_still_gets_its_bars_and_its_progress() -> None:
    """None of the above may cost the desk what it was being told.

    The progress line and the final series are what the loading state
    is built on; an engine that stopped sending them would look just
    as broken, for a different reason.
    """

    async def go() -> None:
        bridge = MT5Bridge()
        seen: dict[str, list] = {"candles": [], "hist_progress": []}
        bridge.on_event(lambda kind, payload: seen.setdefault(kind, []).append(payload))
        await _stream_history(bridge, 6000, chunk=600, symbol="USDJPY")
        finals = [p for p in seen["candles"] if not p.get("partial")]
        assert finals, "the finished series is still broadcast"
        assert len(finals[-1]["bars"]) == 6000, "...with every bar in it"
        assert seen["hist_progress"], "progress is still reported while it runs"
        assert seen["hist_progress"][-1]["done"] is True, "and the end is announced"

    _run(go())


def test_one_enormous_chunk_still_lets_the_engine_breathe() -> None:
    """The expert may hand over a slab, not a trickle.

    Chunk size is the expert's choice and some builds send far more
    per message than others. The yield inside the per-bar loop is
    what keeps a single large message from owning the engine, and
    nothing else in the ingest would notice it was gone.
    """

    async def go() -> None:
        bridge = MT5Bridge()
        watch = _LoopWatch()
        watch.start()
        await bridge._on_ea_message(
            None,
            {
                "type": "candles", "symbol": "NAS100", "timeframe": 5,
                "timeframe_name": "M5", "chart_id": 7, "bars": _bars(40_000),
                "replace": True, "final": True, "available": 40_000,
            },
        )
        await watch.stop()
        assert len(bridge.candles[("NAS100", "M5")]) == 40_000
        assert watch.beats > 20, (
            f"the loop ran {watch.beats} times while one 40 000-bar message "
            f"was ingested - a slab must not own the engine"
        )

    _run(go())


def test_building_a_big_payload_lets_other_work_run() -> None:
    """_wire_bars must actually leave the loop, not merely be async.

    An `async def` that never awaits anything blocks exactly as hard
    as a plain function, and this one is the last step before a
    multi-megabyte broadcast. The test is whether a second task got
    to run while it worked.
    """

    async def go() -> None:
        bridge = MT5Bridge()
        rows = [
            Candle(symbol="XAUUSD", timeframe="M5", time=f"2026.01.01 00:{i % 60:02d}:00",
                   time_msc=i, open=1, high=2, low=0.5, close=1.5, volume=1, spread=1)
            for i in range(60_000)
        ]
        ran = 0

        async def other() -> None:
            nonlocal ran
            while True:
                await asyncio.sleep(0.001)
                ran += 1

        task = asyncio.get_running_loop().create_task(other())
        await asyncio.sleep(0.005)
        before = ran
        wire = await bridge._wire_bars(rows)
        during = ran - before
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
        assert len(wire) == 60_000, "the payload is still built"
        assert during > 0, (
            "nothing else ran while 60 000 bars were turned into dicts - "
            "the build is still on the event loop"
        )

    _run(go())
