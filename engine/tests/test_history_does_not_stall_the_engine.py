"""The engine must keep answering while it archives history.

Reported four times, in four voices that are all one bug:

  "the engine goes connected, disconnected, connected in the header"
  "after that no setting can be touched - it says the engine is off -
   and only closing AURION completely brings it back"
  "dropping the expert on a chart blocks the whole desk and the live
   prices stop"

None of those are three bugs. They are one: `MT5Bridge._archive()`
writes a whole series to SQLite, it was called straight from inside
`async def`, and a synchronous write inside a coroutine stops the
event loop dead. Nothing else in the engine runs while it is in
there - not the `/health` route the desk polls, not the tick
broadcast, not the socket the expert is streaming down.

The numbers, measured on this machine before the fix:

    6 months of M15   17 280 bars   0.11s
    6 months of M5    51 840 bars   0.54s
    6 months of M1   259 200 bars   2.44s   <- and 48 MB of JSON

The desk calls the engine offline after ENGINE_BUSY_GRACE_MS, 15
seconds. One 2.4-second stall does not reach that on its own, which
is exactly why this survived three reports: on a developer's SSD it
looks like a stutter. Attaching an expert archives several series
back to back, on a phone or a laptop with a slow disk, and the
stalls add up until the grace runs out - and then every route the
desk needs to unlock a setting is behind the same frozen loop.

So this measures the thing that actually breaks: how long the event
loop is unable to run anything, while a realistic archive happens.
There is no assertion here about how fast SQLite is. The write may
take as long as it likes - in a thread.

    python -m pytest engine/tests/test_history_does_not_stall_the_engine.py
"""

from __future__ import annotations

import ast
import asyncio
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from aurion.mt5.bridge import MT5Bridge
from aurion.mt5.types import Candle

BRIDGE_SRC = Path(__file__).resolve().parents[1] / "aurion" / "mt5" / "bridge.py"

#: The longest the loop may be blocked by one archive, in seconds.
#:
#: Generous on purpose. The point is not to police milliseconds, it
#: is that the stall must not scale with the size of the history:
#: before the fix this was 2.44s for six months of M1 and rising with
#: HISTORY_DAYS, and the budget below is comfortably under one health
#: timeout (5s) let alone the offline grace (15s). A regression that
#: puts the write back on the loop lands at seconds, not at 0.3.
MAX_LOOP_STALL = 0.30

#: Six months of M1, the worst series the product promises.
M1_SIX_MONTHS = 259_200


def _series(n: int) -> list[Candle]:
    first = datetime(2025, 1, 1, tzinfo=timezone.utc)
    return [
        Candle(
            symbol="EURUSD",
            timeframe="M1",
            time=(first + timedelta(minutes=i)).isoformat(),
            time_msc=0,
            open=1.1,
            high=1.2,
            low=1.0,
            close=1.15,
            volume=10,
            spread=2,
        )
        for i in range(n)
    ]


class _Heartbeat:
    """The /health poll, standing in for everything else on the loop.

    Ticks every 10ms and remembers the longest gap between two ticks.
    That gap IS the stall: a coroutine that never yields keeps this
    from being scheduled, and the desk's health check is exactly such
    a coroutine waiting its turn.
    """

    def __init__(self) -> None:
        self.worst = 0.0
        self._stop = False

    async def run(self) -> None:
        last = time.perf_counter()
        while not self._stop:
            await asyncio.sleep(0.01)
            now = time.perf_counter()
            self.worst = max(self.worst, now - last)
            last = now

    def stop(self) -> None:
        self._stop = True


async def _stall_while(work) -> float:
    beat = _Heartbeat()
    task = asyncio.create_task(beat.run())
    await asyncio.sleep(0.05)  # let it settle into its rhythm
    try:
        await work()
    finally:
        beat.stop()
        await task
    return beat.worst


def _slow_save(delay: float):
    """A disk that takes `delay` seconds, deterministically.

    Timing a real SQLite write makes this test a benchmark of
    whichever machine runs it, and a benchmark that is green on a
    fast disk is not a test. The archive is handed a save that
    sleeps - the blocking kind, `time.sleep`, because that is what a
    synchronous database call does to a coroutine.
    """
    seen: list[int] = []

    def save(symbol: str, timeframe: str, rows) -> None:
        time.sleep(delay)
        seen.append(len(rows))

    save.seen = seen  # type: ignore[attr-defined]
    return save


async def _body_test_archiving_a_series_does_not_stop_the_engine_answering() -> None:
    """The whole bug, in one measurement."""
    bridge = MT5Bridge()
    save = _slow_save(1.0)
    bridge.use_candle_archive(save=save, load=None)
    rows = _series(2000)

    async def work() -> None:
        await bridge.archive_candles("EURUSD", "M1", rows)

    stall = await _stall_while(work)
    assert save.seen == [2000], "the bars must still reach the disk"
    assert stall < MAX_LOOP_STALL, (
        f"the event loop was blocked for {stall:.2f}s archiving one series. "
        "The desk calls the engine offline after 15s of this, and every "
        "settings route is behind the same loop."
    )


async def _body_test_warming_a_series_from_disk_does_not_stop_the_engine_either() -> None:
    """The read is the same hazard as the write.

    `_warm_from_disk` is the first thing `pull_candles` does when the
    cache is short, which is every chart opened after a restart. A
    six-month M1 read out of SQLite is the same order of cost as the
    write, on the same loop.
    """
    bridge = MT5Bridge()

    def load(symbol: str, timeframe: str, count: int):
        time.sleep(1.0)
        return []

    bridge.use_candle_archive(save=None, load=load)

    async def work() -> None:
        await bridge.warm_candles_from_disk("EURUSD", "M1", 1000)

    stall = await _stall_while(work)
    assert stall < MAX_LOOP_STALL, (
        f"the event loop was blocked for {stall:.2f}s reading stored bars"
    )


async def _body_test_attaching_an_expert_archives_several_series_without_freezing() -> None:
    """Why it shows up when the expert is dropped on a chart.

    An attaching expert pushes its depth for every series it has, one
    after another. Each archive was a stall; several in a row is the
    15-second grace gone and the desk locked out - "the engine is
    off", with only a full restart to clear it.
    """
    bridge = MT5Bridge()
    save = _slow_save(0.5)
    bridge.use_candle_archive(save=save, load=None)
    rows = _series(500)

    async def work() -> None:
        await asyncio.gather(*(
            bridge.archive_candles("EURUSD", tf, rows)
            for tf in ("M1", "M5", "M15", "M30", "H1", "H4")
        ))

    stall = await _stall_while(work)
    assert len(save.seen) == 6, "every series must still be written"
    assert stall < MAX_LOOP_STALL, (
        f"six series froze the loop for {stall:.2f}s - this is the "
        "expert-attach freeze"
    )


def test_no_coroutine_calls_the_archive_synchronously() -> None:
    """The guard that stops this coming back a fourth time.

    Fixing the three call sites fixes today. It does nothing about
    the next `async def` somebody writes that reaches for `_archive`
    because it is right there and looks like a plain method - which
    is precisely how the three got there. So the rule is checked
    against the source: inside a coroutine, the blocking forms are
    not allowed to appear at all.
    """
    tree = ast.parse(BRIDGE_SRC.read_text(encoding="utf-8"))
    banned = {"_archive", "_warm_from_disk", "_tape_save", "_tape_load"}
    offences: list[str] = []

    class Walk(ast.NodeVisitor):
        def __init__(self) -> None:
            self.depth = 0

        def visit_FunctionDef(self, node: ast.FunctionDef) -> None:
            # A plain def nested in a coroutine has its own context:
            # it is not the coroutine's body and may block freely.
            outer, self.depth = self.depth, 0
            self.generic_visit(node)
            self.depth = outer

        def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef) -> None:
            self.depth += 1
            self.generic_visit(node)
            self.depth -= 1

        def visit_Call(self, node: ast.Call) -> None:
            if self.depth > 0:
                func = node.func
                name = ""
                if isinstance(func, ast.Attribute):
                    name = func.attr
                elif isinstance(func, ast.Name):
                    name = func.id
                if name in banned:
                    offences.append(f"{name}() at bridge.py:{node.lineno}")
            self.generic_visit(node)

    Walk().visit(tree)
    assert not offences, (
        "these block the event loop - call the awaitable wrapper, or wrap "
        "them in asyncio.to_thread: " + ", ".join(offences)
    )


def test_a_big_write_lets_a_reader_in_between_chunks() -> None:
    """The database lock is the second half of the same freeze.

    Moving the write off the event loop stops it blocking the ENGINE.
    It does nothing for anything else that wants the database while
    259 200 rows go in, because one `executemany` holds the lock for
    the whole of it - measured at 2.44 seconds - and some of those
    waiting callers are serving the desk.

    So the series is written in chunks. Counted rather than timed: a
    timing test here would be a benchmark of whichever disk runs it,
    and would pass on a fast one with the bug present. What matters
    is that the lock is taken and released more than once, and far
    fewer times than once per row - which was the original stall.
    """
    import tempfile

    from aurion.runtime.store import CANDLE_WRITE_CHUNK, Store

    rows = [c.to_dict() for c in _series(10_000)]
    with tempfile.TemporaryDirectory() as home:
        store = Store(str(Path(home) / "t.db"))

        class CountingConn:
            """sqlite3.Connection.commit is read-only, so wrap it."""

            def __init__(self, inner: Any) -> None:
                self.inner = inner
                self.commits = 0

            def commit(self) -> None:
                self.commits += 1
                self.inner.commit()

            def __getattr__(self, name: str) -> Any:
                return getattr(self.inner, name)

        counting = CountingConn(store._conn)
        store._conn = counting  # type: ignore[assignment]
        written = store.save_candles("EURUSD", "M1", rows)
        commits = counting.commits
        store._conn = counting.inner  # type: ignore[assignment]

    assert written == 10_000, "every bar must still be written"
    expected = -(-10_000 // CANDLE_WRITE_CHUNK)
    assert commits == expected, (
        f"{commits} commits for 10 000 bars, expected {expected}. "
        "One commit means the lock is held for the whole series again."
    )
    assert commits > 1, "a whole series in one lock is the stall this fixes"
    assert commits < 100, "this is drifting back towards a commit per row"


def test_the_measurement_that_started_this_is_recorded() -> None:
    """Six months of M1 is the worst case, and it is a real number."""
    from aurion.util.history import bars_for_days

    assert bars_for_days("M1", 180) == M1_SIX_MONTHS


# ---------------------------------------------------------------------
# The three measurements above are coroutines because the thing they
# measure only exists on an event loop. Nothing else in this suite
# uses pytest-asyncio, and one test file is not a reason to add a
# plugin to the engine's dependencies, so each is run the way the rest
# of the repository runs async code.
# ---------------------------------------------------------------------


def test_archiving_a_series_does_not_stop_the_engine_answering() -> None:
    asyncio.run(_body_test_archiving_a_series_does_not_stop_the_engine_answering())


def test_warming_a_series_from_disk_does_not_stop_the_engine_either() -> None:
    asyncio.run(_body_test_warming_a_series_from_disk_does_not_stop_the_engine_either())


def test_attaching_an_expert_archives_several_series_without_freezing() -> None:
    asyncio.run(_body_test_attaching_an_expert_archives_several_series_without_freezing())
