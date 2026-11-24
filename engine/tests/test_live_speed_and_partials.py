"""Five reports about the desk being slow, wrong, or both.

In the trader's own order:

  1. "The engine's state in the desk keeps going off and on, and it
     works out MetaTrader's state from the engine's rather than from
     the real link - the expert IS connected and the desk says it is
     not."

  2. "The live price of each symbol has to be correct and in the
     moment, the same as MetaTrader. It is shown much slower."

  3. "Some optimisation for speed."

  4. "The signals are not drawn on the newer candles. They must reach
     the last candle whenever there really is one there - I have never
     once seen a mark on the most recent candles."

  5. "Once the candles go back about a month the loading can go away;
     the rest can keep downloading in the background, the way the
     download status in the corner of the chart does."

This file pins the ENGINE's half of all five. The desk's half lives in
tests/engine-light.test.js and tests/waiting-and-scanning.test.cjs.

    python3 -m pytest engine/tests/test_live_speed_and_partials.py
"""
from __future__ import annotations

import asyncio
import contextlib
import re
import sys
import time
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "engine"))

from aurion.mt5.bridge import MT5Bridge  # noqa: E402
from aurion.mt5.types import Candle  # noqa: E402
from aurion.runtime.bus import DROPPABLE, QUEUE_MAX, Bus  # noqa: E402
from aurion.signals import strategy_signals as ss  # noqa: E402
from aurion.strategy.base import StrategySignal  # noqa: E402
from aurion.util.history import bars_for_days  # noqa: E402


# --------------------------------------------------------------- helpers ---

def _bridge() -> tuple[MT5Bridge, list[tuple[str, dict]]]:
    """A bridge whose broadcasts are collected instead of sent."""
    bridge = MT5Bridge()
    sent: list[tuple[str, dict]] = []

    async def emit(topic: str, payload: dict) -> None:
        sent.append((topic, payload))

    bridge.emit = emit  # type: ignore[assignment]
    return bridge, sent


def _chunk(bridge: MT5Bridge, *, n: int, first: int, tf: str = "M15",
           replace: bool = False, final: bool = False) -> dict:
    """One history chunk, oldest bar first, exactly as the expert sends it."""
    now = int(time.time())
    step = 15 * 60
    bars = [{
        "time": time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime(now - (first + n - k) * step)),
        "open": 1.0, "high": 1.1, "low": 0.9, "close": 1.05, "volume": 10,
    } for k in range(n)]
    return {"type": "candles", "chart_id": 1, "symbol": "EURUSD", "timeframe": tf,
            "bars": bars, "replace": replace, "final": final}


def _candles(n: int) -> list[dict]:
    out = []
    price = 100.0
    for i in range(n):
        price += 0.5 if (i // 7) % 2 else -0.4
        out.append({
            "time": f"2026-01-{(i // 1440) % 28 + 1:02d} {(i // 60) % 24:02d}:{i % 60:02d}:00",
            "open": price, "high": price + 1, "low": price - 1,
            "close": price + 0.2, "volume": 100 + i,
        })
    return out


# ======================================= 3. the ingest that blocked the loop ==

def test_a_history_download_no_longer_scans_the_whole_buffer_per_bar() -> None:
    """The measured cause of "the engine goes offline during a download".

    Every incoming bar used to be checked against every bar already
    held, to see whether it was a bar arriving twice. A download hands
    the bars over in time order, so that scan found nothing - once per
    bar, over a buffer that was growing - and six months of M5 cost
    about a billion comparisons on the event loop. Health checks
    queued behind it, the desk read the silence as a dead engine, and
    the light went red in the middle of a perfectly healthy download.

    Measured on this machine: 21.7s before, 0.5s after, for the same
    52 000 bars. The budget below is deliberately loose - it is there
    to catch the return of quadratic behaviour, not to time a laptop.
    """
    bridge, _ = _bridge()

    async def go() -> float:
        start = time.perf_counter()
        for chunk in range(40):
            await bridge._on_ea_message(
                None, _chunk(bridge, n=800, first=40 * 800 - chunk * 800,
                             replace=chunk == 0, final=chunk == 39))
        return time.perf_counter() - start

    took = asyncio.run(go())
    assert took < 6.0, f"32 000 bars took {took:.1f}s - the per-bar scan is back"


def test_a_bar_arriving_twice_still_replaces_the_one_held() -> None:
    """The fast path must not become a path that duplicates bars."""
    bridge, _ = _bridge()
    mk = lambda t, close: Candle(  # noqa: E731
        symbol="EURUSD", timeframe="M15", time=t, time_msc=0,
        open=1, high=1, low=1, close=close, volume=1, spread=0)

    bridge._put_candle(mk("2026-01-01 00:00:00", 1.0), "live")
    bridge._put_candle(mk("2026-01-01 00:15:00", 2.0), "live")
    # The newest bar, still forming, sent again with a new close.
    bridge._put_candle(mk("2026-01-01 00:15:00", 2.5), "live")
    # And an older one being corrected, which still pays for a scan.
    bridge._put_candle(mk("2026-01-01 00:00:00", 1.5), "live")

    held = bridge._candles_for("EURUSD", "M15")
    # Stored in the one canonical spelling, whatever they came in as.
    assert [c.time for c in held] == ["2026-01-01T00:00:00", "2026-01-01T00:15:00"]
    assert [c.close for c in held] == [1.5, 2.5]


def test_a_cached_read_is_not_broadcast_to_every_desk() -> None:
    """Answering from cache has nothing to tell anybody else.

    pull_candles used to push the whole series onto the bus on every
    call, including the common one: a cache hit, answering a question
    whose asker already receives the bars in the reply. On a six-month
    window that is megabytes of JSON encoded once per listener, on the
    event loop, for no new information at all.
    """
    bridge, sent = _bridge()

    async def go() -> list[tuple[str, dict]]:
        await bridge._on_ea_message(None, _chunk(bridge, n=900, first=900,
                                                 replace=True, final=True))
        sent.clear()
        await bridge.pull_candles("EURUSD", "M15", 500, exact=True)
        return sent

    broadcasts = asyncio.run(go())
    assert not [t for t, _ in broadcasts if t == "candles"], \
        "a cache hit still re-sent the whole series to every desk"


# ============================== 5. the veil, and the download behind it ======

def test_a_download_hands_over_a_readable_month_before_it_finishes() -> None:
    """"Once the candles reach about a month the loading can go away."

    The bars used to travel only on the expert's final chunk, so a
    six-month download meant a blank, loading chart for however long
    the broker took - even though a readable month had been sitting in
    memory for most of it.
    """
    bridge, sent = _bridge()
    month = bars_for_days("M15", 30)

    async def go() -> list[dict]:
        chunks = 0
        while chunks < 14:
            await bridge._on_ea_message(
                None, _chunk(bridge, n=800, first=14 * 800 - chunks * 800,
                             replace=chunks == 0, final=False))
            chunks += 1
            # The emit is rate-limited; this is a test, not a broker.
            bridge._hist_shown[("EURUSD", "M15")] = (
                0.0, bridge._hist_shown.get(("EURUSD", "M15"), (0.0, ""))[1])
        return [p for t, p in sent if t == "candles"]

    partials = asyncio.run(go())
    assert partials, "nothing was drawable until the download finished"
    assert all(p.get("partial") for p in partials), \
        "a half-finished download must say so, or the desk treats it as the last word"
    assert min(len(p["bars"]) for p in partials) >= month, \
        "the chart was handed less than the month that was asked for"


def test_nothing_is_handed_over_before_it_is_worth_drawing() -> None:
    bridge, sent = _bridge()

    async def go() -> list[dict]:
        await bridge._on_ea_message(None, _chunk(bridge, n=600, first=600, replace=True))
        return [p for t, p in sent if t == "candles"]

    assert not asyncio.run(go()), "six hundred bars is not a month of M15"


def test_a_partial_never_moves_the_right_hand_edge_backwards() -> None:
    """The guard that stops a partial making the chart worse.

    The expert streams oldest bar first, so the early chunks of a
    re-stream are old history with no recent end. Sending those would
    replace a current chart with a stale one - a chart that went
    BACKWARDS in time while its download ran.
    """
    bridge, sent = _bridge()

    async def go() -> list[dict]:
        # A full month, already on screen.
        await bridge._on_ea_message(None, _chunk(bridge, n=3000, first=3000, replace=True))
        bridge._hist_shown[("EURUSD", "M15")] = (0.0, bridge._hist_shown[("EURUSD", "M15")][1])
        sent.clear()
        # Now a re-stream that begins a long way back and has not yet
        # caught up to where the chart already is.
        await bridge._on_ea_message(None, _chunk(bridge, n=3000, first=40000, replace=True))
        return [p for t, p in sent if t == "candles"]

    assert not asyncio.run(go()), "a stale slab replaced a current chart"


# ================================ 4. the marks on the newest candles =========

def test_the_newest_bars_are_analysed_first() -> None:
    """Why no mark was ever seen on the last candles.

    The replay is on a time budget and used to walk the slab from its
    oldest bar forwards, so when the budget ran out - which, at
    roughly 11ms a bar over a 1200-bar slab, was every time - the bars
    it had not reached were the newest ones. The one mark a trader can
    still act on is the one on the last candle, and it was the one
    reliably thrown away.
    """
    seen: list[int] = []

    class Spy:
        # 0 means "the whole frame", so each call is handed every bar
        # up to the one being judged - which is what makes the order
        # of the walk visible here.
        history_window = 0

        def on_candle(self, ctx):
            seen.append(len(ctx.candles))
            return None

    bars = _candles(500)
    ss.replay(bars, [("spy", Spy())], "EURUSD", "M15")
    assert seen, "nothing was analysed at all"
    assert seen[0] == len(bars), "the newest bar was not the first one looked at"
    assert seen == sorted(seen, reverse=True), "the pass is not walking backwards"


def test_a_budget_that_runs_out_costs_the_oldest_bars_not_the_newest() -> None:
    class Slow:
        history_window = 50

        def on_candle(self, ctx):
            time.sleep(0.002)
            return None

    bars = _candles(1200)
    out = ss.replay(bars, [("slow", Slow())], "EURUSD", "M15", budget_seconds=0.5)
    assert out["truncated"] is True
    assert out["covered_to"] == len(bars), \
        "the newest bar was left unanalysed - this is the reported bug"
    assert out["covered_from"] > ss.WARMUP_BARS


def test_marks_are_returned_oldest_first_however_they_were_found() -> None:
    """A chart reads left to right whatever order the engine worked in."""
    class Always:
        history_window = 50

        def on_candle(self, ctx):
            return StrategySignal(action="buy", symbol=ctx.symbol,
                                  confidence=0.7, reason="test")

    out = ss.replay(_candles(400), [("always", Always())], "EURUSD", "M15")
    idx = [int(s["index"]) for s in out["signals"]]
    assert idx == sorted(idx)


def test_every_mark_names_the_bar_it_belongs_to() -> None:
    """The desk places marks by TIME, so a mark without one cannot land.

    The desk holds a different slice of the history than the engine
    analysed - it scrolls, and it asks for the window it is drawing -
    so an index means two different bars on the two sides. That
    mismatch is what slid the marks off the recent candles.
    """
    class Always:
        history_window = 50

        def on_candle(self, ctx):
            return StrategySignal(action="sell", symbol=ctx.symbol,
                                  confidence=0.8, reason="test")

    bars = _candles(400)
    out = ss.replay(bars, [("always", Always())], "EURUSD", "M15")
    assert out["signals"]
    times = {b["time"] for b in bars}
    for mark in out["signals"]:
        assert mark.get("time") in times, "a mark that no chart can place"
        assert bars[int(mark["index"])]["time"] == mark["time"], \
            "the index and the time name different bars"


# ====================================== 1./2. the feed that kept dropping ====

def test_a_slow_desk_is_not_silently_detached_from_the_bus() -> None:
    """The worst of both: connected, and permanently silent.

    A client whose queue filled used to be removed from the bus while
    its socket was left open. Nothing ever closed the connection, so
    the desk never reconnected: it sat there looking live with no
    ticks, no candles and no prices arriving, for ever.
    """
    bus = Bus()
    queue: asyncio.Queue = asyncio.Queue(maxsize=QUEUE_MAX)

    async def go() -> None:
        bus.add_client(queue)
        for i in range(QUEUE_MAX + 50):
            await bus.publish("tick", {"symbol": "EURUSD", "bid": i})
        assert queue in bus._clients, "a slow reader was detached and left silent"
        assert queue.full()

    asyncio.run(go())


def test_room_is_made_by_dropping_what_is_about_to_be_resent() -> None:
    """A tick is replaced by the next tick; an order result is not."""
    bus = Bus()
    queue: asyncio.Queue = asyncio.Queue(maxsize=4)

    async def go() -> list[str]:
        bus.add_client(queue)
        await bus.publish("order", {"ticket": 1})
        await bus.publish("tick", {"bid": 1})
        await bus.publish("tick", {"bid": 2})
        await bus.publish("order", {"ticket": 2})
        await bus.publish("tick", {"bid": 3})     # full: something must go
        return [queue.get_nowait().get("type") for _ in range(queue.qsize())]

    kinds = asyncio.run(go())
    assert kinds.count("order") == 2, "a result that happens once was thrown away"
    assert "tick" in DROPPABLE


def test_a_listener_inside_the_engine_counts_as_somebody_listening() -> None:
    """The no-listener short-cut must not blind an in-process subscriber."""
    bus = Bus()
    assert bus.client_count() == 0
    bus.subscribe("analysis", lambda topic, payload: None)
    assert bus.client_count() == 1


def test_the_analysis_push_is_not_recomputed_for_nobody() -> None:
    src = (ROOT / "engine" / "aurion" / "runtime" / "trader.py").read_text(encoding="utf-8")
    match = re.search(r"ANALYSIS_PUSH_SECONDS\s*=\s*([0-9.]+)", src)
    assert match and float(match.group(1)) >= 0.5, \
        "the analysis is rebuilt more often than twice a second on every tick"
    body = src[src.index("async def _push_analysis"):]
    body = body[:body.index("\n    async def ", 10)]
    assert "client_count()" in body, \
        "up to twelve per-symbol analyses are still built with no desk attached"


def test_the_stream_survives_a_frame_it_cannot_read() -> None:
    """One bad frame used to take the whole socket down with it.

    The reader and the writer are gathered, so an exception in either
    ends both - and the backend proxies that close to the browser as
    "the engine is offline". A frame the desk should simply ignore was
    therefore a cause of the reported flapping.
    """
    src = (ROOT / "engine" / "aurion" / "api" / "server.py").read_text(encoding="utf-8")
    stream = src[src.index('@app.websocket("/v1/stream")'):]
    stream = stream[:stream.index("\n@app.")] if "\n@app." in stream else stream
    assert "continue" in stream, "a malformed frame still ends the connection"
    assert "TypeError" in stream, "a payload that will not encode still kills every client's feed"
    assert "BUS_QUEUE_MAX" in stream, "the socket and the bus disagree about how deep a backlog may be"


@pytest.mark.parametrize("name", ["tick", "analysis", "status"])
def test_what_may_be_dropped_is_stated_rather_than_guessed(name: str) -> None:
    assert name in DROPPABLE


# ========================= the follow-up: "the candles print broken" ========

"""Reported after the round above shipped, in these words:

    "The chart in the app is printing its candles broken - lots of
     long shadows one after another, and every time the price changes
     it draws a new candle. One tick, one new broken candle."

They really were new candles. A bar's time is compared as a STRING
everywhere it matters - the buffer's duplicate check, the sort that
keeps a series in order, the desk's own de-duplication, the archive's
primary key - and the same bar was arriving under three spellings:

    the expert           2026-11-23T10:00:00
    the MetaTrader5 API  2026-11-23T10:00:00+00:00
    parts of the archive 2026-11-23 10:00:00

So the forming bar, re-sent several times a second, was a brand new
candle every time it came back by a different route - and because
" " < "T" < "+" the duplicates did not even sort beside their twins,
which is why the chart looked shuffled rather than merely doubled.
Faster ticks made an existing fault impossible to miss.
"""


def test_one_bar_has_one_spelling() -> None:
    from aurion.mt5.types import bar_time

    same = {
        bar_time("2026-11-23T10:00:00"),
        bar_time("2026-11-23T10:00:00+00:00"),
        bar_time("2026-11-23 10:00:00"),
        bar_time("2026-11-23T10:00:00Z"),
        bar_time("2026-11-23T10:00:00.750+00:00"),
    }
    assert same == {"2026-11-23T10:00:00"}, f"still more than one name for one bar: {same}"


def test_a_zone_is_converted_rather_than_chopped_off() -> None:
    """Trimming "+00:00" and trimming "-05:00" look alike; only one is safe."""
    from aurion.mt5.types import bar_time

    assert bar_time("2026-11-23T15:00:00-05:00") == "2026-11-23T20:00:00"
    # Something this cannot read is left alone rather than mangled into
    # a different unreadable string.
    assert bar_time("not a time") == "not a time"


def test_the_forming_bar_updates_instead_of_multiplying() -> None:
    """The reported symptom, reproduced and then refused."""
    bridge, _ = _bridge()

    async def go() -> list[str]:
        history = [{"time": f"2026-11-23T{h:02d}:00:00", "open": 1, "high": 1.1,
                    "low": 0.9, "close": 1.05, "volume": 5} for h in range(10)]
        await bridge._on_ea_message(None, {
            "type": "candles", "chart_id": 1, "symbol": "EURUSD", "timeframe": "H1",
            "bars": history, "replace": True, "final": True})
        # The same forming bar, arriving by both routes, as it does on a
        # machine where the MetaTrader5 package is installed beside the
        # expert - which is every Windows desk.
        for i in range(12):
            when = "2026-11-23T09:00:00" if i % 2 else "2026-11-23T09:00:00+00:00"
            await bridge._on_ea_message(None, {
                "type": "candle", "chart_id": 1, "symbol": "EURUSD", "timeframe": 60,
                "timeframe_name": "H1", "time": when, "open": 1.0,
                "high": 1.2 + i / 100, "low": 0.8, "close": 1.0 + i / 100, "volume": 9})
        return [c.time for c in bridge._candles_for("EURUSD", "M15")]

    times = asyncio.run(go())
    assert len(times) == len(set(times)), "the same bar is on the chart twice"
    assert len(times) == 10, f"twelve price updates added {len(times) - 10} candles"
    assert times == sorted(times), "the series is out of order, which draws as long wicks"


def test_an_archive_written_before_the_fix_cleans_itself_up() -> None:
    """Six months of duplicated bars will not fix themselves."""
    import tempfile
    from pathlib import Path as _Path

    from aurion.runtime.store import Store

    tmp = _Path(tempfile.mkdtemp()) / "t.db"
    store = Store(tmp)
    for when in ("2026-11-23T10:00:00", "2026-11-23T10:00:00+00:00", "2026-11-23 11:00:00"):
        store.execute(
            "INSERT INTO candles(symbol,timeframe,ts,open,high,low,close,volume,spread)"
            " VALUES(?,?,?,?,?,?,?,?,?)",
            ("EURUSD", "H1", when, 1, 2, 0.5, 1.5, 10, 0))
    store.close()

    reopened = Store(tmp)
    held = [row["ts"] for row in reopened._conn.execute("SELECT ts FROM candles ORDER BY ts")]
    reopened.close()
    assert held == ["2026-11-23T10:00:00", "2026-11-23T11:00:00"], held


# ================== the follow-up: "the engine keeps going off and on" =====

"""Reported: "when MetaTrader disconnects, or I attach and detach the
expert, the engine keeps going off and on - it is not stable."

MT5Bridge.symbol_spec() is synchronous and is called from inside
request handlers, which means it was called on the event loop; it then
called into the MetaTrader5 package, which is a blocking IPC round
trip to the terminal. While the terminal is healthy that is a
millisecond. While it is going away it is however long that call takes
to give up - and for all of that time the engine answers nothing at
all, /health included. The desk's probe times out, the light goes red,
the call returns, the next probe succeeds, the light goes green.
"""


class _SlowTerminal:
    """A MetaTrader that has gone away but has not said so yet."""

    def __init__(self, delay: float = 1.5) -> None:
        self.connected = True
        self.delay = delay
        self.calls = 0

    def symbol_info(self, symbol: str) -> dict[str, object]:
        self.calls += 1
        time.sleep(self.delay)
        return {"name": symbol, "digits": 5, "trade_tick_value": 1.0,
                "volume_step": 0.01, "trade_contract_size": 100000}


def test_a_hung_terminal_does_not_stall_the_engine() -> None:
    bridge, _ = _bridge()
    bridge.native = _SlowTerminal(delay=1.5)

    async def go() -> tuple[float, float]:
        # The event loop's own responsiveness, measured while the
        # terminal is hanging. This is what /health is competing with.
        worst = {"lag": 0.0}

        async def heartbeat() -> None:
            while True:
                mark = time.monotonic()
                await asyncio.sleep(0.02)
                worst["lag"] = max(worst["lag"], time.monotonic() - mark - 0.02)

        beat = asyncio.create_task(heartbeat())
        start = time.monotonic()
        for _ in range(5):
            bridge.symbol_spec("EURUSD")       # the call that used to block
            await asyncio.sleep(0.05)
        took = time.monotonic() - start
        await asyncio.sleep(0.1)
        beat.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await beat
        return took, worst["lag"]

    took, lag = asyncio.run(go())
    assert took < 1.0, f"five spec reads took {took:.2f}s - the terminal is still being waited on"
    assert lag < 0.5, f"the event loop was blocked for {lag * 1000:.0f}ms; /health cannot answer through that"


def test_the_spec_still_arrives_and_is_read_once_per_symbol() -> None:
    """Not waiting for the terminal must not mean never asking it."""
    bridge, _ = _bridge()
    bridge.native = _SlowTerminal(delay=0.05)

    async def go() -> dict[str, object]:
        first = bridge.symbol_spec("EURUSD")
        assert first == {}, "a spec was invented before the terminal had been asked"
        for _ in range(20):
            await asyncio.sleep(0.02)
            if bridge.symbol_spec("EURUSD"):
                break
        # Hammering it is the cost this is here to avoid.
        for _ in range(10):
            bridge.symbol_spec("EURUSD")
        return bridge.symbol_spec("EURUSD")

    spec = asyncio.run(go())
    assert spec.get("digits") == 5, "the spec never arrived from the background read"
    assert bridge.native.calls == 1, \
        f"the terminal was asked {bridge.native.calls} times for one unchanged contract spec"


def test_a_synchronous_caller_still_gets_an_answer_inline() -> None:
    """Tools and tests call this with no loop running; there is nothing
    to protect in that case, so the terminal is asked directly."""
    bridge, _ = _bridge()
    bridge.native = _SlowTerminal(delay=0.0)
    assert bridge.symbol_spec("EURUSD").get("digits") == 5


# ---------------------------------------------------------------------------
# 6. "In Settings, System, the Aurion Bridge must identify the version in
#    every case - not 'version unknown'."
#
# Only hello carries a version. An agent is also built the first time a
# tick or a candle arrives for a chart we have not met, and that happens
# routinely: the expert sends a tick in the same breath as its hello, a
# reattach throws the agent record away while the stream carries on, and
# a purged chart comes straight back through its next tick. The rebuilt
# agent had version "" forever after, and the desk has no word for an
# empty version except "unknown".
# ---------------------------------------------------------------------------


def test_a_chart_met_through_a_tick_keeps_the_version_its_hello_reported() -> None:
    bridge, _ = _bridge()

    async def go() -> tuple[str, str, str]:
        await bridge._on_ea_message(None, {
            "type": "hello", "chart_id": 11, "symbol": "EURUSD",
            "timeframe": "M15", "version": "1.24",
        })
        said = bridge.agents[11].version

        # The chart is closed, or the terminal restarts, or the expert is
        # taken off and put back: the record goes.
        await bridge._purge_chart(11, force=True)

        # ...and the very next tick rebuilds it, with no hello in sight.
        rebuilt = await bridge._touch_agent(11, "EURUSD", "M15")
        assert rebuilt is not None

        # A second chart on the same terminal, also met through a tick.
        other = await bridge._touch_agent(12, "XAUUSD", "M5")
        assert other is not None
        return said, rebuilt.version, other.version

    said, rebuilt, other = asyncio.run(go())
    assert said == "1.24"
    assert rebuilt == "1.24", "a rebuilt agent forgot which expert is running on that chart"
    assert other == "1.24", \
        "a chart we have never had a hello from is told 'unknown' when the terminal's version is known"


def test_a_version_is_never_invented() -> None:
    """Remembering is not guessing: with nothing reported, nothing is said."""
    bridge, _ = _bridge()

    async def go() -> str:
        agent = await bridge._touch_agent(31, "EURUSD", "M15")
        assert agent is not None
        return agent.version

    assert asyncio.run(go()) == ""


def test_a_hello_does_not_overwrite_another_chart_s_version() -> None:
    bridge, _ = _bridge()

    async def go() -> tuple[str, str]:
        await bridge._on_ea_message(None, {
            "type": "hello", "chart_id": 41, "symbol": "EURUSD",
            "timeframe": "M15", "version": "1.24",
        })
        await bridge._on_ea_message(None, {
            "type": "hello", "chart_id": 42, "symbol": "XAUUSD",
            "timeframe": "M5", "version": "1.19",
        })
        return bridge.remembered_ea_version(41, "EURUSD"), bridge.remembered_ea_version(42, "XAUUSD")

    first, second = asyncio.run(go())
    assert first == "1.24", "one terminal's version was written over another's"
    assert second == "1.19", "a second terminal on an older expert must still read as older"


# ---------------------------------------------------------------------------
# 7. "When a new candle arrives the candles before it come away from it,
#    get taller and read at higher prices."
#
# The expert's half of that: a shift counts bars on the timeframe it was
# counted on. Mirroring the chart's shift onto the desk's timeframe meant
# an M15 chart feeding an H4 desk re-announcing the previous H4 bar as
# freshly closed four times an hour.
# ---------------------------------------------------------------------------


def test_the_expert_mirrors_only_the_forming_bar_onto_the_desk_timeframe() -> None:
    src = (ROOT / "engine" / "ea" / "AurionBridge.mq5").read_text(encoding="utf-8")
    start = src.rindex("void SendCandle(const int shift)")
    body = src[start:src.index("\n  }", start)]
    assert "SendCandleOn(_Period, shift);" in body, "the chart's own bar is still sent"
    assert "if(shift == 0 && g_feed_tf != PERIOD_CURRENT && g_feed_tf != _Period)" in body, \
        "a closed bar is still mirrored onto a timeframe whose bars it does not count"
    # ...and the desk timeframe's own closed bar still has a sender.
    assert "SendCandleOn(g_feed_tf, 1);" in src, \
        "nothing sends the closed bar of the timeframe the desk is showing"


def test_a_bar_that_is_re_sent_is_merged_not_swapped() -> None:
    """The engine's half of the same fault: see _merged_candle."""
    bridge, _ = _bridge()

    def bar(high: float, low: float, close: float, volume: float) -> Candle:
        return Candle(symbol="EURUSD", timeframe="M15", time="2026-11-24T10:00:00",
                      time_msc=0, open=1.10, high=high, low=low, close=close, volume=volume)

    bridge._put_candle(bar(1.40, 1.05, 1.30, 10))
    # The same bar as it looked a minute earlier, arriving again.
    bridge._put_candle(bar(1.15, 1.09, 1.12, 4))
    held = bridge.candles[("EURUSD", "M15")][-1]
    assert held.high == 1.40, "a narrower re-send shrank a bar the desk had already drawn"
    assert held.low == 1.05, "...and raised its low"
    assert held.close == 1.12, "the close is what a re-send is for"
    assert held.volume == 10, "volume only ever grows within one bar"
    assert len(bridge.candles[("EURUSD", "M15")]) == 1, "a re-send is not a second bar"

    # ...and a genuinely wider one still widens it.
    bridge._put_candle(bar(1.52, 1.01, 1.50, 12))
    held = bridge.candles[("EURUSD", "M15")][-1]
    assert (held.high, held.low, held.close) == (1.52, 1.01, 1.50)


def test_a_full_history_answer_still_replaces_the_series() -> None:
    """Merging re-sends must not make a redraw impossible."""
    bridge, _ = _bridge()

    async def go() -> list[Candle]:
        await bridge._on_ea_message(None, {
            "type": "candles", "chart_id": 5, "symbol": "EURUSD", "timeframe": 15,
            "timeframe_name": "M15", "replace": True, "final": True,
            "bars": [{"time": "2026-11-24T10:00:00", "open": 1.1, "high": 1.9,
                      "low": 0.9, "close": 1.5, "volume": 99}],
        })
        await bridge._on_ea_message(None, {
            "type": "candles", "chart_id": 5, "symbol": "EURUSD", "timeframe": 15,
            "timeframe_name": "M15", "replace": True, "final": True,
            "bars": [{"time": "2026-11-24T10:00:00", "open": 1.1, "high": 1.2,
                      "low": 1.0, "close": 1.15, "volume": 7}],
        })
        return list(bridge.candles[("EURUSD", "M15")])

    rows = asyncio.run(go())
    assert len(rows) == 1
    assert rows[0].high == 1.2, "replace:true must be able to correct a bar outright"
