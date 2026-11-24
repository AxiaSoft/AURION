"""The engine must stay up, and must not invent a close it never saw.

From one reported session, with the MetaTrader Experts log and the
engine log read side by side. What the trader described as four
separate faults - "the engine keeps dropping", "it deactivates an EA
that is active in MetaTrader", "it opens and closes the trade over and
over, it writes the stop before the stop is touched and the target
before the target is touched" - came out of three bugs:

  1. the expert failed over between 18765 and 8080, which are the same
     engine one hop apart, so a busy engine was asked twice and every
     switch looked to the desk like a new transport;

  2. the calendar refresh loop woke on exactly the period its own
     cache expired on, so EVERY pass went to the network, and part of
     each pass ran on the event loop - a stall on the stroke of every
     fifth minute, which is where the terminal's "status 1003" bursts
     line up to the second;

  3. a position missing from ONE feed snapshot was recorded as closed.
     A gap in the feed is not a close, and treating it as one wrote a
     phantom exit, then a phantom entry when it came back, round and
     round until the kill switch.

The desk's half of the same three lives in tests/engine-stays-up.test.cjs.

    python3 -m pytest engine/tests/test_engine_stays_up.py
"""
from __future__ import annotations

import asyncio
import re
import sys
import time
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "engine"))

from aurion import news_feed                                # noqa: E402
from aurion.runtime import trader as trader_mod             # noqa: E402

EA_SRC = (ROOT / "engine" / "ea" / "AurionBridge.mq5").read_text(encoding="utf-8")


def _strip_block_comments(src: str) -> str:
    """Assertions must read the code, not the prose explaining it.

    These sources describe themselves at length, and a comment quoting
    the broken line it replaced would otherwise fail the very test that
    proves the line is gone.
    """
    return re.sub(r"/\*.*?\*/", " ", src, flags=re.S)


# ====================================================== 1. one engine, one port

def test_the_expert_no_longer_fails_over_to_the_desk() -> None:
    """8080 is the desk, and the desk just hands ingest to the engine.

    So failing over to it when the engine is busy asks the same busy
    process again, one hop further away, inside the same four second
    budget. That is not redundancy, it is the stall feeding itself.
    """
    body = _strip_block_comments(
        EA_SRC[EA_SRC.rindex("bool FlushOut()"):EA_SRC.index("string JsonEsc(")]
    )
    assert "int alt" not in body, "the expert still keeps an alternate ingest port"
    assert "8080" not in body, "the desk's port still appears in the flush path"
    assert re.search(r"int\s+primary\s*=\s*InpHttpPort\s*;", body), \
        "the expert should post to the engine's own port and only that"


def test_nothing_can_announce_a_port_switch_any_more() -> None:
    assert "ingest switched to port" not in _strip_block_comments(EA_SRC)


def test_the_file_inbox_is_the_only_fallback() -> None:
    """It cannot time out and a busy event loop cannot refuse it."""
    body = _strip_block_comments(
        EA_SRC[EA_SRC.rindex("bool FlushOut()"):EA_SRC.index("string JsonEsc(")]
    )
    assert "WriteInbox(json)" in body


def test_a_full_queue_sheds_its_oldest_messages() -> None:
    """Dropping the newest is the wrong end of the queue.

    When the engine stalls the queue is what stands between a four
    second hiccup and a death spiral: a bigger bundle takes longer to
    post, and a post that no longer fits the budget can never succeed.
    But shedding the NEWEST message feeds the desk a backlog of stale
    prices and throws the current one away.
    """
    cap = re.search(r"#define\s+AURION_HTTP_QUEUE_MAX\s+(\d+)", EA_SRC)
    assert cap, "the outbound queue has no declared ceiling"
    assert 0 < int(cap.group(1)) <= 64

    queue = _strip_block_comments(
        EA_SRC[EA_SRC.index("void QueueOut("):EA_SRC.index("bool SendRaw(")]
    )
    assert "AURION_HTTP_QUEUE_MAX" in queue
    assert re.search(r"g_http_q\[i\]\s*=\s*g_http_q\[i\s*\+\s*drop\]", queue), \
        "a full queue should drop its oldest entries, not its newest"


# ============================================ 2. the calendar stops the stalls

def test_the_calendar_cache_outlives_the_loop_that_refreshes_it() -> None:
    """The whole bug is arithmetic.

    The loop woke every 300 seconds and the cache expired at 300
    seconds, so every single pass found the cache one second too old
    and went to the network. For hours. The terminal's refused-ingest
    bursts land on the stroke of every fifth minute because of this.
    """
    assert news_feed.MIN_AGE_SECONDS > trader_mod.NEWS_REFRESH_SECONDS, (
        "the cache expires no later than the loop wakes, so every pass "
        "downloads"
    )


def test_a_dead_name_server_cannot_hold_a_thread_for_a_minute() -> None:
    import inspect

    sig = inspect.signature(news_feed.fetch)
    assert float(sig.parameters["timeout"].default) <= 10.0


def test_the_whole_calendar_pass_runs_off_the_event_loop() -> None:
    """reload_news() re-reads the calendar and builds a datetime per
    release. It was being awaited straight from the coroutine."""
    import inspect

    src = inspect.getsource(trader_mod.Trader._news_refresh_loop)
    body = src[src.index("while not self._news_stop"):]
    assert "self.prop.reload_news()" not in body, \
        "reload_news still runs on the event loop"
    assert "asyncio.to_thread(" in body
    assert "NEWS_PASS_BUDGET" in body


def test_the_calendar_pass_is_on_a_hard_clock() -> None:
    assert isinstance(trader_mod.NEWS_PASS_BUDGET, (int, float))
    assert 0 < trader_mod.NEWS_PASS_BUDGET <= 120


# ======================================= 3. silence is not absence (the sweep)

class _Agent:
    def __init__(self) -> None:
        self.status = "online"

    def to_dict(self) -> dict:
        return {"status": self.status}


def _sweep_source() -> str:
    import inspect

    from aurion.mt5.bridge import MT5Bridge

    return inspect.getsource(MT5Bridge._http_sweep_loop)


def test_http_silence_alone_no_longer_retires_a_chart() -> None:
    """A chart speaks over three transports.

    HTTP going quiet says nothing about the socket or the file inbox,
    and retiring a chart on that alone is why an expert plainly
    attached in MetaTrader kept being drawn as detached.
    """
    src = _sweep_source()
    http_block = src[src.index("_http_seen.items()"):src.index("_agent_beat.items()")]
    assert "_mark_agent_offline" not in http_block


def test_the_beat_every_transport_winds_is_what_retires_a_chart() -> None:
    src = _sweep_source()
    tail = src[src.index("_agent_beat.items()"):]
    assert "_mark_agent_offline" in tail


def test_the_watchdog_does_not_count_time_it_was_asleep_for() -> None:
    """When the engine stalls, nothing is read.

    So every chart looks stale the instant the loop runs again, and the
    sweep used to fire on all of them at once: the desk went dark, the
    experts went grey, and the only thing that had happened was that
    the engine was busy.
    """
    src = _sweep_source()
    assert "overrun" in src, "the sweep does not measure its own lateness"
    assert re.search(r"\+\s*grace", src), "and does not forgive it"
    assert re.search(r"min\(overrun,", src), \
        "the forgiveness is unbounded; a clock jump would disable the watchdog"


# ============================= 4. a close is shown, never inferred from silence

class _Store:
    def __init__(self) -> None:
        self.trades: list[dict] = []

    def query(self, *a, **k):
        return []

    def record_trade(self, row):
        self.trades.append(row)

    def history(self, *a, **k):
        return []

    def strategy_ledger(self, *a, **k):
        return {}


class _Account:
    currency = "USD"


class _Bridge:
    def __init__(self) -> None:
        self.deals: list[dict] = []
        self.account = _Account()

        class _N:
            connected = False

        self.native = _N()


class _Bus:
    async def publish(self, *a, **k) -> None:
        return None


def _book() -> trader_mod.Trader:
    """A Trader with just enough of one to sync a position book.

    Built field by field rather than through __init__ on purpose: a
    real Trader opens a database, loads a licence and starts four
    background loops, none of which has anything to say about whether
    a missing ticket means a closed position.
    """
    from collections import deque

    t = object.__new__(trader_mod.Trader)
    t._known_pos = {}
    t._pos_missing = {}
    t._closed_tickets = set()
    t._pending_tag = []
    t._auto_entry_tickets = set()
    t._pos_bootstrapped = True
    t.robot_log = deque(maxlen=600)
    t.bus = _Bus()
    t.book = {}
    t.store = _Store()
    t.bridge = _Bridge()
    #: The close path repaints the strategy ledger on its way out. That
    #: wants a licence, the loaded strategy instances and an auto-trade
    #: flag, and it has nothing to say about whether a missing ticket
    #: means a closed position - which is the only question here.
    t._sync_book_meta = lambda: None          # type: ignore[method-assign]
    t.strategy_meta = {}
    return t


def _pos(ticket: int = 1) -> dict:
    return {
        "ticket": ticket, "symbol": "XAUUSD", "type": "buy", "volume": 0.1,
        "price_open": 2000.0, "sl": 1990.0, "tp": 2020.0, "comment": "",
    }


def test_one_gap_in_the_feed_is_not_a_close(monkeypatch) -> None:
    """The reported loop, exactly.

    A snapshot arrives short or empty - the expert's post was refused,
    the engine was mid-stall, the terminal answered while it was still
    building the list - and every ticket in it looked closed. An exit
    was written against a stop that was never touched; the next
    snapshot brought the position back, so an entry was written.
    """
    t = _book()
    recorded: list[int] = []
    monkeypatch.setattr(
        trader_mod.Trader, "_record_close",
        lambda self, *a, **k: recorded.append(1), raising=False,
    )

    asyncio.run(t._sync_position_book([_pos()]))
    assert 1 in t._known_pos

    # One empty snapshot. The position is still open at the broker.
    asyncio.run(t._sync_position_book([]))
    assert 1 in t._known_pos, "a single gap in the feed was read as a close"
    assert t._pos_missing.get(1) == 1

    # It comes back, as it always did.
    asyncio.run(t._sync_position_book([_pos()]))
    assert t._pos_missing.get(1) is None, \
        "a position that reappeared kept its strikes and would close early"


def test_a_position_that_really_goes_is_still_closed() -> None:
    """Patience must not become blindness."""
    t = _book()
    asyncio.run(t._sync_position_book([_pos()]))
    for _ in range(trader_mod.POSITION_MISSING_STRIKES):
        asyncio.run(t._sync_position_book([]))
    assert 1 not in t._known_pos, "a position gone for good was never closed"


def test_the_brokers_own_deal_closes_it_at_once() -> None:
    """No waiting when there is proof.

    A closing deal carrying the position's id is the broker's own word
    for it, and the blotter should not lag three snapshots behind it.
    """
    t = _book()
    asyncio.run(t._sync_position_book([_pos()]))
    t.bridge.deals = [{
        "position_id": 1, "entry": "out", "profit": 5.0, "swap": 0.0,
        "commission": 0.0, "price": 2010.0, "volume": 0.1,
    }]
    asyncio.run(t._sync_position_book([]))
    assert 1 not in t._known_pos, "a confirmed close was made to wait"


def test_strikes_are_counted_per_ticket() -> None:
    """Two positions, one of them flickering, must not drag the other."""
    t = _book()
    asyncio.run(t._sync_position_book([_pos(1), _pos(2)]))
    asyncio.run(t._sync_position_book([_pos(1)]))
    asyncio.run(t._sync_position_book([_pos(1), _pos(2)]))
    asyncio.run(t._sync_position_book([_pos(1)]))
    assert 2 in t._known_pos, "a position that keeps reappearing was closed anyway"
    assert t._pos_missing.get(1) is None, "the steady position collected strikes"


def test_the_number_of_strikes_is_patient_but_not_asleep() -> None:
    assert trader_mod.POSITION_MISSING_STRIKES >= 2
    assert trader_mod.POSITION_MISSING_STRIKES <= 10


def test_an_unproven_close_never_raises_on_a_missing_deal_feed() -> None:
    """"Not proven" is an answer. A crash is not."""
    t = _book()
    t.bridge.deals = None            # type: ignore[assignment]
    assert t._close_is_evidenced(1) is False
    t.bridge.deals = ["nonsense", 17, None]   # type: ignore[list-item]
    assert t._close_is_evidenced(1) is False
