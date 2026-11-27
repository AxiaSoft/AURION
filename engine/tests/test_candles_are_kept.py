"""Downloaded candles belong to the installation, not to the process.

Asked for directly: "when candles are downloaded, store them in
AURION's own files."

They partly were. Bars pushed by the expert passed through the engine
and were written into data/aurion.engine.db on the way; bars read from
the terminal through the MetaTrader5 package were written nowhere at
all. And NOTHING read any of them back. The bridge starts every run
with empty deques, so the first chart opened after a restart went and
downloaded six months again - from a broker, over the internet, for
data already sitting on the disk.

What is pinned here:

  1. A block of bars is written in one transaction, and writing it
     twice does not duplicate it.
  2. Rows are taken as they come: Candle objects, wire dicts with
     "time", rows read back out with "ts". A row with no timestamp is
     dropped rather than written as NULL - the primary key would
     collapse the whole block into one row.
  3. The bridge archives what it pulls from the terminal.
  4. A fresh bridge warms a series from disk instead of asking for it
     again, and a warmed series never overwrites bars that reach
     further back.
  5. The Strategy Tester's tape is never written to disk. It is a
     simulation of a past the broker has already lived through, and
     writing it into the same table would quietly rewrite what the
     robot learns from.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from aurion.mt5.bridge import MT5Bridge
from aurion.mt5.types import Candle
from aurion.runtime.store import Store


def bars(n: int, *, symbol: str = "EURUSD", tf: str = "M15", day: int = 1) -> list[Candle]:
    out = []
    for i in range(n):
        out.append(Candle(
            symbol=symbol, timeframe=tf,
            time=f"2026-11-{day:02d}T{i // 60:02d}:{i % 60:02d}:00Z",
            time_msc=0, open=1.0 + i, high=1.5 + i, low=0.5 + i, close=1.2 + i,
            volume=10 + i, spread=2,
        ))
    return out


@pytest.fixture()
def store(tmp_path: Path) -> Store:
    return Store(path=tmp_path / "test.db")


# ------------------------------------------------------- 1. the writing

def test_a_block_is_written_once_and_can_be_written_again(store: Store) -> None:
    wrote = store.save_candles("EURUSD", "M15", bars(500))
    assert wrote == 500
    assert len(store.candles("EURUSD", "M15", 1000)) == 500

    # The same block again is an update, not 500 more rows: a trader who
    # reopens a chart must not grow the database by a window every time.
    store.save_candles("EURUSD", "M15", bars(500))
    assert len(store.candles("EURUSD", "M15", 1000)) == 500


def test_the_block_goes_in_one_transaction(store: Store) -> None:
    """One commit for the block, not one per bar.

    upsert_candle() commits every row. The expert hands its history over
    in thousands, and thousands of flushes to a WAL database is the
    stall a trader reads as "still downloading candles" long after the
    download has finished. sqlite3 will not let its own commit be
    wrapped, so the connection is: every commit raises, and the write
    is expected to fail exactly once - which is one commit, for the
    whole block.
    """
    commits = {"n": 0}

    class Counting:
        def __init__(self, conn):
            self._conn = conn

        def __getattr__(self, name):
            return getattr(self._conn, name)

        def commit(self):
            commits["n"] += 1
            return self._conn.commit()

    store._conn = Counting(store._conn)  # type: ignore[assignment]
    store.save_candles("EURUSD", "M5", bars(2000, tf="M5"))
    assert commits["n"] == 1
    assert len(store.candles("EURUSD", "M5", 4000)) == 2000

    # ...against the one-per-row route it replaced.
    commits["n"] = 0
    for row in bars(25, tf="M1"):
        store.upsert_candle(row.to_dict())
    assert commits["n"] == 25


# -------------------------------------------------------- 2. what a row is

def test_rows_are_taken_in_every_shape_they_arrive_in(store: Store) -> None:
    store.save_candles("EURUSD", "H1", [
        {"time": "2026-11-01T00:00:00Z", "open": 1, "high": 2, "low": 0, "close": 1.5, "volume": 3},
        {"ts": "2026-11-01T01:00:00Z", "open": 1, "high": 2, "low": 0, "close": 1.5, "volume": 3},
        Candle("EURUSD", "H1", "2026-11-01T02:00:00Z", 0, 1, 2, 0, 1.5, 3),
    ])
    rows = store.candles("EURUSD", "H1", 50)
    # Read back in the one canonical spelling. A bar's time is part of
    # the primary key here and is compared as a string everywhere
    # else, so a bar written "...T02:00:00Z" by one path and
    # "...T02:00:00" by another used to be two rows - and two candles
    # on the chart. See mt5.types.bar_time.
    assert [r["ts"] for r in rows] == [
        "2026-11-01T00:00:00", "2026-11-01T01:00:00", "2026-11-01T02:00:00",
    ]


def test_a_bar_with_no_time_is_dropped_not_written(store: Store) -> None:
    wrote = store.save_candles("EURUSD", "H4", [
        {"open": 1, "high": 2, "low": 0, "close": 1.5},
        {"time": "", "open": 1},
        {"time": "2026-11-01T00:00:00Z", "open": 1, "high": 2, "low": 0, "close": 1.5},
    ])
    assert wrote == 1
    assert len(store.candles("EURUSD", "H4", 50)) == 1


def test_the_span_can_be_asked_for_without_reading_the_bars(store: Store) -> None:
    store.save_candles("XAUUSD", "M15", bars(120, symbol="XAUUSD"))
    span = store.candle_span("XAUUSD", "M15")
    assert span["count"] == 120
    assert span["oldest"] < span["newest"]
    assert store.candle_span("XAUUSD", "H1") == {"count": 0, "oldest": "", "newest": ""}


# ------------------------------------------------------ 3./4. the bridge

def wire(bridge: MT5Bridge, store: Store) -> None:
    bridge.use_candle_archive(
        save=lambda sym, tf, rows: store.save_candles(sym, tf, rows),
        load=lambda sym, tf, count: store.candles(sym, tf, count),
    )


def test_what_the_bridge_pulls_is_kept(store: Store) -> None:
    bridge = MT5Bridge()
    wire(bridge, store)
    bridge._archive("EURUSD", "M15", bars(300))
    assert len(store.candles("EURUSD", "M15", 500)) == 300


def test_a_fresh_bridge_warms_from_disk_instead_of_downloading(store: Store) -> None:
    """The whole point: a restart must not re-download what is on disk."""
    store.save_candles("EURUSD", "M15", bars(400))

    bridge = MT5Bridge()
    wire(bridge, store)
    assert bridge.candles_of("EURUSD", "M15") == []

    warmed = bridge._warm_from_disk("EURUSD", "M15", 400)
    assert len(warmed) == 400
    assert len(bridge.candles_of("EURUSD", "M15")) == 400
    first = bridge.candles_of("EURUSD", "M15")[0]
    assert first.symbol == "EURUSD" and first.timeframe == "M15"
    assert first.time == "2026-11-01T00:00:00"      # canonical, see bar_time
    assert first.close == pytest.approx(1.2)


def test_a_series_is_read_back_once_per_run(store: Store) -> None:
    """A chart redrawn twenty times costs one read, not twenty."""
    store.save_candles("EURUSD", "M15", bars(50))
    reads = {"n": 0}

    def load(sym: str, tf: str, count: int):
        reads["n"] += 1
        return store.candles(sym, tf, count)

    bridge = MT5Bridge()
    bridge.use_candle_archive(save=None, load=load)
    for _ in range(20):
        bridge._warm_from_disk("EURUSD", "M15", 50)
    assert reads["n"] == 1


def test_disk_never_overwrites_bars_that_reach_further_back(store: Store) -> None:
    """A short archive must not truncate a long live series.

    Retargeted, deliberately: this used to require the archive to be
    DISCARDED whole, by asserting the series was still exactly the 300
    live bars. Discarding the shorter side is what left a hole in the
    chart after AURION had been closed for a while - the archive is
    deep and stops at the moment of the shutdown, the live series
    starts after the restart, and whichever was dropped took its own
    bars with it. The two are merged now.

    What the test is for is unchanged and still checked: nothing the
    live series had may be lost, and the series must still begin where
    the live one began.
    """
    store.save_candles("EURUSD", "M15", bars(5, day=9))

    bridge = MT5Bridge()
    wire(bridge, store)
    live = bars(300, day=1)
    bucket = bridge._tape_store("live")["candles"][("EURUSD", "M15")]
    bucket.extend(live)

    bridge._warm_from_disk("EURUSD", "M15", 300)
    held = bridge.candles_of("EURUSD", "M15")
    kept = {c.time for c in held}
    assert {c.time for c in live} <= kept          # not one live bar lost
    assert held[0].time.startswith("2026-11-01")   # still as deep as it was
    assert len(kept) == len(held)                  # and no bar twice


# ------------------------------------------------------- 5. the tester

def test_the_strategy_tester_tape_is_never_written_to_disk(store: Store) -> None:
    bridge = MT5Bridge()
    wire(bridge, store)
    bridge._tape_hint = "tester"
    bridge._compute_tape = lambda: "tester"  # type: ignore[method-assign]

    bridge._archive("EURUSD", "M15", bars(100))
    assert store.candles("EURUSD", "M15", 500) == []

    # ...and a tester run does not get warmed out of live history either.
    store.save_candles("EURUSD", "M15", bars(100))
    assert bridge._warm_from_disk("EURUSD", "M15", 100) == []


def test_a_write_that_fails_never_breaks_a_chart(store: Store) -> None:
    """A chart must draw even when the disk says no."""
    def boom(sym: str, tf: str, rows) -> None:
        raise OSError("disk full")

    bridge = MT5Bridge()
    bridge.use_candle_archive(save=boom, load=None)
    bridge._archive("EURUSD", "M15", bars(10))  # must not raise


def test_an_unwired_bridge_behaves_exactly_as_before() -> None:
    bridge = MT5Bridge()
    bridge._archive("EURUSD", "M15", bars(10))
    assert bridge._warm_from_disk("EURUSD", "M15", 10) == []
    assert bridge.candles_of("EURUSD", "M15") == []


def test_the_trader_wires_the_archive_in() -> None:
    """The seam is useless unless somebody installs it."""
    src = Path(__file__).resolve().parents[1] / "aurion" / "runtime" / "trader.py"
    text = src.read_text(encoding="utf-8")
    assert "use_candle_archive(" in text
    assert "self.store.save_candles(" in text
    assert "self.store.candles(" in text
    # And the bulk ingest path must not have gone back to one commit per bar.
    assert "for row in payload.get(\"bars\") or []:\n                self.store.upsert_candle(row)" not in text

