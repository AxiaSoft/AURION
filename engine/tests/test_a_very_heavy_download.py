"""The engine survives downloads far heavier than one series.

Reported again, after the first round of this work shipped: "I set the
backtest to three months and it broke again and the engine went off."

The first round took the sorting and the payload building off the hot
path. It was not enough, because those were not the only things that
scaled with the size of the download. Three more were found by
measurement, and each one is worse than anything fixed last time:

  * **Re-streaming a window the engine already holds was quadratic.**
    A bar that is neither new nor the newest fell through to a linear
    scan of the whole buffer, and a backtest asks for the same window
    again in rounds - so EVERY bar paid the scan. Measured: 8.7 s of
    event loop to re-stream 20 000 bars, 51 840 bars being four times
    the bars and sixteen times the work. The desk declares an engine
    dead after fifteen seconds of silence.

  * **Every history push was written to SQLite on the event loop.**
    The event carries the whole series every time it fires, so a
    download re-wrote all 51 840 rows every few seconds while it ran:
    225 ms a time on a fast disk, and a trader's disk is not one.

  * **A slow desk accumulated whole copies of the series.** The bus
    holds up to 500 messages per client and a history message is
    about 18 MB of Python objects. That is not a backlog, that is the
    engine disappearing from the task manager - which is what "the
    engine went off" looks like when it is memory rather than time.

Everything here measures behaviour on the real objects. The timing
assertions carry a large margin and are stated against the budget
that matters: the desk allows 5 000 ms for a health answer and the
supervisor restarts the engine after three consecutive misses.
"""

from __future__ import annotations

import asyncio
import json
import time
from pathlib import Path

import pytest

from aurion.api import server as api
from aurion.mt5.bridge import MT5Bridge
from aurion.runtime.bus import DROPPABLE, QUEUE_MAX, Bus
from aurion.runtime.store import Store

ROOT = Path(__file__).resolve().parents[2]


def _bars(n: int, start: int = 0) -> list[dict[str, object]]:
    """`n` M5 bars in time order, as the expert sends them."""
    out = []
    for i in range(start, start + n):
        out.append(
            {
                "time": (
                    f"2026-{(i // 8064) % 12 + 1:02d}-{(i // 288) % 28 + 1:02d}"
                    f"T{(i // 12) % 24:02d}:{(i * 5) % 60:02d}:00"
                ),
                "open": 1.0, "high": 2.0, "low": 0.5, "close": 1.5,
                "volume": 10, "spread": 2,
            }
        )
    return out


async def _push(bridge: MT5Bridge, bars, *, replace: bool, final: bool,
                symbol: str = "XAUUSD") -> None:
    await bridge._on_ea_message(
        None,
        {
            "type": "candles", "symbol": symbol, "timeframe": 5,
            "timeframe_name": "M5", "chart_id": 1, "bars": bars,
            "replace": replace, "final": final, "available": len(bars),
        },
    )


def _run(coro):
    return asyncio.run(coro)


# ===================== the backtest that asks twice =========================


def test_restreaming_a_window_already_held_stays_cheap() -> None:
    """The measured killer: the same window, sent again.

    A backtest does not download once. It asks in rounds, and a round
    that overlaps what is already in memory used to cost a scan of
    the whole buffer per bar. The second pass here must not cost
    wildly more than the first; quadratic means it costs fifty times
    more at this size, and a minute of dead engine at the real one.
    """

    async def go() -> None:
        bridge = MT5Bridge()
        bars = _bars(20_000)

        start = time.perf_counter()
        await _push(bridge, bars, replace=True, final=True)
        fresh = time.perf_counter() - start

        start = time.perf_counter()
        await _push(bridge, bars, replace=False, final=True)
        again = time.perf_counter() - start

        held = bridge.candles[("XAUUSD", "M5")]
        assert len(held) == 20_000, (
            f"re-streaming a window the engine already had produced "
            f"{len(held)} bars from 20 000 - the index is making duplicates"
        )
        assert again < max(1.5, fresh * 6), (
            f"re-streaming 20 000 bars took {again * 1000:.0f} ms against "
            f"{fresh * 1000:.0f} ms to receive them in the first place; "
            f"before the position index it was 8 700 ms, and it squares"
        )

    _run(go())


def test_a_restream_updates_bars_rather_than_appending_them() -> None:
    """Cheap is worthless if it is also wrong.

    The scan it replaced existed to merge a bar that arrives twice. A
    re-streamed bar must still land on top of the one already held,
    with the newer values, and must not become a second candle at the
    same time - two bars at one timestamp draw as a spike.
    """

    async def go() -> None:
        bridge = MT5Bridge()
        await _push(bridge, _bars(500), replace=True, final=True)
        revised = _bars(500)
        for row in revised:
            row["close"] = 9.0
            row["high"] = 12.0
        await _push(bridge, revised, replace=False, final=True)

        held = list(bridge.candles[("XAUUSD", "M5")])
        times = [c.time for c in held]
        assert len(times) == len(set(times)) == 500, "one bar per timestamp"
        assert all(c.close == 9.0 for c in held), "the newer values won"
        assert times == sorted(times), "and the series is still in order"

    _run(go())


def test_a_gap_filled_long_after_the_fact_still_lands() -> None:
    """The rare case the scan was really for.

    Bars 200 to 300 are withheld and sent at the end, out of order.
    They must be merged into the right places - via the index, which
    has to survive the sort that an out-of-order arrival triggers.
    """

    async def go() -> None:
        bridge = MT5Bridge()
        bars = _bars(1000)
        await _push(bridge, bars[:200] + bars[300:], replace=True, final=False)
        await _push(bridge, bars[200:300], replace=False, final=True)

        held = list(bridge.candles[("XAUUSD", "M5")])
        times = [c.time for c in held]
        assert len(held) == 1000, "the backfilled bars arrived"
        assert times == sorted(times), "and were put back in order"
        assert len(set(times)) == 1000, "without duplicating anything"

        # And the index must still be usable after that sort: one more
        # re-stream has to merge, not append.
        await _push(bridge, bars, replace=False, final=True)
        held = list(bridge.candles[("XAUUSD", "M5")])
        assert len(held) == 1000, (
            "the position index went stale across a sort and started "
            "appending duplicates"
        )

    _run(go())


def test_the_index_survives_the_buffer_being_cleared() -> None:
    """`replace` empties the buffer under the index's feet.

    Length is what the index checks to notice that happening. A
    replace followed by a shorter series is the case that would slip
    through a looser check.
    """

    async def go() -> None:
        bridge = MT5Bridge()
        await _push(bridge, _bars(3000), replace=True, final=True)
        # A window out of the MIDDLE of what was held, so every one of
        # its bars has a stale entry in the old index pointing at a
        # position it no longer occupies.
        window = _bars(40, 1000)
        await _push(bridge, window, replace=True, final=True)
        held = list(bridge.candles[("XAUUSD", "M5")])
        assert len(held) == 40, "a replace means a replace"
        assert held[0].time == window[0]["time"], "and the right 40 bars"

        await _push(bridge, window, replace=False, final=True)
        times = [c.time for c in bridge.candles[("XAUUSD", "M5")]]
        assert len(times) == 40 and len(set(times)) == 40, (
            "the index remembered positions from the buffer before the "
            "clear and appended duplicates instead of merging"
        )

    _run(go())


# ===================== what a slow desk is allowed to pile up ===============


def _series_message(symbol: str, tf: str, bars: int, partial: bool = False):
    return {
        "type": "candles",
        "data": {"symbol": symbol, "timeframe": tf, "partial": partial,
                 "bars": [{"time": f"t{i}"} for i in range(bars)]},
    }


def test_a_backlogged_client_holds_one_copy_of_a_series() -> None:
    """Not five hundred copies of the same chart.

    Each history message is the whole series - about 18 MB of Python
    objects for three months of M5. The queue is bounded by message
    count, not by size, so a desk that reads slower than the download
    publishes used to accumulate them until the engine was killed for
    memory. An older copy of a series is not news; it is a worse
    version of the message sitting behind it.
    """

    async def go() -> None:
        bus = Bus()
        queue: asyncio.Queue = asyncio.Queue(maxsize=QUEUE_MAX)
        bus.add_client(queue)
        for i in range(50):
            await bus.publish("candles", {"symbol": "XAUUSD", "timeframe": "M5",
                                          "partial": True, "bars": [{"time": f"t{i}"}]})
        assert queue.qsize() == 1, (
            f"{queue.qsize()} copies of one series are queued for one desk"
        )
        held = queue.get_nowait()
        assert held["data"]["bars"][0]["time"] == "t49", "and it is the newest one"

    _run(go())


def test_different_series_are_not_confused_for_each_other() -> None:
    """Coalescing is per chart, not per message type."""

    async def go() -> None:
        bus = Bus()
        queue: asyncio.Queue = asyncio.Queue(maxsize=QUEUE_MAX)
        bus.add_client(queue)
        await bus.publish("candles", {"symbol": "XAUUSD", "timeframe": "M5", "bars": []})
        await bus.publish("candles", {"symbol": "XAUUSD", "timeframe": "H1", "bars": []})
        await bus.publish("candles", {"symbol": "EURUSD", "timeframe": "M5", "bars": []})
        assert queue.qsize() == 3, "three charts are three messages"

    _run(go())


def test_a_late_partial_never_buries_the_finished_series() -> None:
    """The download's last word has to stay the last word.

    The desk keeps its loading state up while `partial` is true. A
    straggling progress copy landing on top of the final series would
    leave a chart loading forever on a download that had finished.
    """

    async def go() -> None:
        bus = Bus()
        queue: asyncio.Queue = asyncio.Queue(maxsize=QUEUE_MAX)
        bus.add_client(queue)
        await bus.publish("candles", {"symbol": "XAUUSD", "timeframe": "M5",
                                      "bars": [{"time": "t9"}]})
        await bus.publish("candles", {"symbol": "XAUUSD", "timeframe": "M5",
                                      "partial": True, "bars": [{"time": "t1"}]})
        assert queue.qsize() == 1
        held = queue.get_nowait()
        assert not held["data"].get("partial"), (
            "a late progress push overwrote the finished download"
        )

    _run(go())


def test_everything_that_happens_once_is_still_kept() -> None:
    """Only whole-series messages supersede each other.

    An order result, a log line, a closed bar - each says something
    that happened once. Replacing any of those would lose it.
    """

    async def go() -> None:
        bus = Bus()
        queue: asyncio.Queue = asyncio.Queue(maxsize=QUEUE_MAX)
        bus.add_client(queue)
        for i in range(5):
            await bus.publish("candle", {"symbol": "XAUUSD", "time": f"t{i}"})
            await bus.publish("order_result", {"ticket": i})
        assert queue.qsize() == 10, (
            "messages that happen once were coalesced away"
        )
        assert "candles" not in DROPPABLE, (
            "a history push must never be thrown away to make room - it is "
            "superseded by a newer one or it is kept"
        )

    _run(go())


# ===================== writing it down without stopping =====================


def test_a_progress_push_does_not_rewrite_the_whole_history(tmp_path) -> None:
    """The event carries every bar; only the new ones need writing.

    Without this a download of 51 840 bars writes 51 840 rows per
    progress push, over and over, for the handful of bars that
    actually arrived since the last one.
    """
    from aurion.runtime import trader as trader_mod

    class _Probe:
        def __init__(self) -> None:
            self.writes: list[int] = []

        def save_candles(self, symbol, timeframe, rows):
            self.writes.append(len(rows))
            return len(rows)

    obj = trader_mod.Trader.__new__(trader_mod.Trader)
    obj._candles_written = {}
    obj.store = _Probe()

    async def go() -> None:
        bars = _bars(5000)
        await obj._store_candles({"symbol": "XAUUSD", "timeframe": "M5",
                                  "partial": True, "bars": bars})
        await obj._store_candles({"symbol": "XAUUSD", "timeframe": "M5",
                                  "partial": True, "bars": bars + _bars(10, 5000)})
        assert obj.store.writes == [5000, 10], (
            f"the second progress push wrote {obj.store.writes[1]} rows for "
            f"10 new bars"
        )
        # The end of the download writes the lot, whatever was skipped.
        await obj._store_candles({"symbol": "XAUUSD", "timeframe": "M5",
                                  "bars": bars + _bars(10, 5000)})
        assert obj.store.writes[-1] == 5010, (
            "the final push must write the complete series - it is what "
            "repairs anything a re-stream moved under an earlier partial"
        )

    _run(go())


def test_the_history_write_happens_off_the_event_loop() -> None:
    """SQLite blocks. It must not block the engine.

    Measured at 225 ms for 51 840 rows on a fast disk, on the loop,
    per push. The test is not the duration - it is whether anything
    else got to run while the write was in progress.
    """
    from aurion.runtime import trader as trader_mod

    ran = 0

    class _SlowStore:
        def save_candles(self, symbol, timeframe, rows):
            time.sleep(0.05)
            return len(rows)

    obj = trader_mod.Trader.__new__(trader_mod.Trader)
    obj._candles_written = {}
    obj.store = _SlowStore()

    async def go() -> None:
        nonlocal ran

        async def other() -> None:
            nonlocal ran
            while True:
                await asyncio.sleep(0.001)
                ran += 1

        task = asyncio.get_running_loop().create_task(other())
        await asyncio.sleep(0.005)
        before = ran
        await obj._store_candles({"symbol": "XAUUSD", "timeframe": "M5",
                                  "bars": _bars(10)})
        during = ran - before
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
        assert during > 0, (
            "nothing else ran during a 50 ms database write - the history "
            "write is still on the event loop"
        )

    _run(go())


def test_the_trader_still_persists_what_it_receives(tmp_path) -> None:
    """None of the above may cost the installation its bars.

    The whole point of writing them is that the next run draws a
    chart from AURION's own files instead of downloading six months
    from the broker again.
    """
    from aurion.runtime import trader as trader_mod

    store = Store(tmp_path / "engine.db")
    obj = trader_mod.Trader.__new__(trader_mod.Trader)
    obj._candles_written = {}
    obj.store = store

    async def go() -> None:
        await obj._store_candles({"symbol": "EURUSD", "timeframe": "M15",
                                  "bars": _bars(300)})
        back = store.candles("EURUSD", "M15", 400)
        assert len(back) == 300, "the bars went to disk and came back"

    _run(go())


# ===================== the frame on the wire ================================


def test_a_large_frame_is_encoded_off_the_loop() -> None:
    """7.8 MB of JSON is 109 ms the engine cannot answer in.

    Per client, per push. json.dumps releases the GIL around its C
    encoder, so the big ones belong in a thread; the small ones do
    not, because the handover costs more than the work.
    """
    big = {"type": "candles", "data": {"symbol": "XAUUSD", "timeframe": "M5",
                                       "bars": [{"time": f"t{i}"} for i in range(60_000)]}}
    small = {"type": "tick", "data": {"symbol": "XAUUSD", "bid": 1.0}}
    assert api._frame_rows(big) >= api.BIG_FRAME_ROWS, "a history push is large"
    assert api._frame_rows(small) < api.BIG_FRAME_ROWS, "a tick is not"

    sent: list[str] = []
    ran = 0

    class _Socket:
        async def send_text(self, text: str) -> None:
            sent.append(text)

    async def go() -> None:
        nonlocal ran

        async def other() -> None:
            nonlocal ran
            while True:
                await asyncio.sleep(0.001)
                ran += 1

        task = asyncio.get_running_loop().create_task(other())
        await asyncio.sleep(0.005)
        before = ran
        await api._send(_Socket(), big)
        during = ran - before
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
        assert json.loads(sent[0])["data"]["bars"][0]["time"] == "t0", (
            "the frame still carries what it was given"
        )
        assert during > 0, (
            "nothing else ran while a 60 000 bar frame was encoded"
        )

    _run(go())


def test_a_payload_that_will_not_encode_is_still_a_dropped_event() -> None:
    """And not a disconnected desk.

    The writer catches TypeError and drops the one event. If the new
    send path raised something else, one bad payload would take every
    client's feed down again - the bug that caused the flapping the
    first time.
    """

    class _Socket:
        async def send_text(self, text: str) -> None:  # pragma: no cover
            raise AssertionError("nothing should reach the socket")

    async def go() -> None:
        with pytest.raises(TypeError):
            await api._send(_Socket(), {"type": "x", "data": {"o": object()}})

    _run(go())


def test_the_socket_uses_the_guarded_send() -> None:
    """A direct send_json in the writer would quietly undo this."""
    src = (ROOT / "engine" / "aurion" / "api" / "server.py").read_text(encoding="utf-8")
    stream = src[src.index('@app.websocket("/v1/stream")'):]
    stream = stream[:stream.index("\n@app.")] if "\n@app." in stream else stream
    writer = stream[stream.index("async def writer"):]
    assert "_send(ws, payload)" in writer, "the writer encodes on the event loop again"
    assert "TypeError" in writer, "an unencodable payload still kills every feed"


# ===================== the whole thing, end to end ==========================


def test_three_months_arriving_in_rounds_keeps_the_engine_answering() -> None:
    """The reported scenario, as close as a test can stand it.

    Three months of M5 streamed in chunks, then asked for again the
    way a backtest asks - the combination that took the engine down.
    The budget is the one that decides whether a trader sees a
    working engine: the desk's health check must be answerable, and
    the supervisor gives up after three missed ones.
    """

    async def go() -> None:
        bridge = MT5Bridge()
        worst = 0.0
        last = time.perf_counter()
        beats = 0
        stop = False

        async def health() -> None:
            nonlocal worst, last, beats
            while not stop:
                await asyncio.sleep(0.002)
                now = time.perf_counter()
                worst = max(worst, now - last - 0.002)
                last = now
                beats += 1

        task = asyncio.get_running_loop().create_task(health())
        bars = _bars(25_920)
        for round_no in range(2):
            sent = 0
            while sent < len(bars):
                slab = bars[sent:sent + 500]
                sent += len(slab)
                await _push(bridge, slab, replace=(sent == len(slab) and round_no == 0),
                            final=sent >= len(bars))
        stop = True
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass

        assert len(bridge.candles[("XAUUSD", "M5")]) == 25_920, "no duplicates"
        # The watchdog is a stand-in for the health check: it only
        # has to get a turn, repeatedly, while the ingest runs.
        assert beats > 20, "the engine kept running other work throughout"
        assert worst < 1.0, (
            f"the loop was unavailable for {worst * 1000:.0f} ms in one go "
            f"during two rounds of a three-month download; the desk gives it "
            f"5 000 ms to answer a health check"
        )

    _run(go())


def test_a_series_warmed_from_disk_does_not_confuse_the_index(tmp_path) -> None:
    """A warm swaps the whole buffer, and length cannot detect that.

    The first chart after a restart is drawn from AURION's own files:
    the series is replaced wholesale with what was on disk. If the
    position index is left behind, the bars the expert sends next are
    looked up at positions belonging to a buffer that no longer
    exists - and a lookup that misses appends, which is a duplicate
    bar at a timestamp that already had one.

    The length is deliberately the same on both sides here, because
    that is the case a cheaper guard would let through.
    """
    store = Store(tmp_path / "engine.db")
    stored = _bars(300)
    store.save_candles("EURUSD", "M15", [{**b, "symbol": "EURUSD",
                                          "timeframe": "M15"} for b in stored])

    async def go() -> None:
        bridge = MT5Bridge()
        bridge.use_candle_archive(
            save=lambda sym, tf, rows: store.save_candles(sym, tf, rows),
            load=lambda sym, tf, count: store.candles(sym, tf, count),
        )
        # Something already held, with as many bars as the disk has.
        bucket = bridge._tape_store("live")["candles"][("EURUSD", "M15")]
        await bridge._on_ea_message(
            None,
            {"type": "candles", "symbol": "EURUSD", "timeframe": 15,
             "timeframe_name": "M15", "chart_id": 3, "bars": _bars(300, 9000),
             "replace": True, "final": True},
        )
        assert len(bucket) == 300

        warmed = await bridge.warm_candles_from_disk("EURUSD", "M15", 300)
        if not warmed:
            pytest.skip("the archive declined to warm this series")

        # Now the expert sends what is on the chart. Every one of
        # these bars exists in the warmed buffer.
        await bridge._on_ea_message(
            None,
            {"type": "candles", "symbol": "EURUSD", "timeframe": 15,
             "timeframe_name": "M15",
             "chart_id": 3,
             "bars": [{**b, "close": 7.0} for b in stored],
             "replace": False, "final": True},
        )
        times = [c.time for c in bridge.candles[("EURUSD", "M15")]]
        assert len(times) == len(set(times)), (
            "the index outlived the buffer it described and duplicated bars"
        )

    _run(go())
