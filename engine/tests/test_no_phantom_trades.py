"""A position that has closed must never appear to open again.

Reported, three times, each time more precisely. The last one named the
trigger:

    "It still fires phantom trades. When I enter or close a position
     the behaviour starts - and it is when I do it BY HAND. When the
     robot enters it is usually fine."

The close path was careful. A ticket has to be missing from several
consecutive snapshots, or carry a closing deal, before the book calls it
closed - there is a whole counter for it, because a feed with a hole in
it looks exactly like a position that has gone.

The open path had none of that care. One frame containing a ticket the
book did not know was enough to declare an entry.

So a positions frame built just before a close and delivered just after
it resurrected the position. An entry was announced - at the old
position's own opening price, which is why it looked like re-entering
the trade just closed - the ticket then went missing again, and an exit
was announced with a profit or a loss. Neither reached the history: the
entry row for that ticket already existed, and _record_close had already
banked the close. "It enters and closes but nothing is recorded, because
it never opened at all."

By hand is when it shows, because that is when the terminal sends
several frames at once - OnTrade pushes account, positions, orders and
deals together - and the deals among them make the close immediately
provable, so there is no strike counter left to absorb the late frame.

    /tmp/v/bin/python -m pytest engine/tests/test_no_phantom_trades.py
"""
from __future__ import annotations

import asyncio
import sys
import tempfile
import time
from collections import deque
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from aurion.runtime.store import Store  # noqa: E402
from aurion.runtime.trader import Trader  # noqa: E402

POS = {
    "ticket": 11,
    "symbol": "EURUSD",
    "type": "buy",
    "volume": 0.2,
    "profit": 3.5,
    "comment": "manual",
    "price_open": 1.0865,
    "price_current": 1.0870,
}


class Bridge:
    """No terminal. ``deals`` is set per test: it is the broker's word."""

    native = type("_N", (), {"connected": False})()
    account = type("_A", (), {"currency": ""})()

    def __init__(self, deals: list[dict[str, Any]] | None = None) -> None:
        self.deals = deals or []


def build(deals: list[dict[str, Any]] | None = None) -> tuple[Trader, list]:
    """A Trader with just enough wired to run the position book."""
    tmp = Path(tempfile.mkdtemp()) / "book.db"
    t = Trader.__new__(Trader)
    t.store = Store(tmp)
    t._known_pos = {11: dict(POS)}
    t._pending_tag = []
    t._closed_tickets = set()
    t._closed_at = {}
    t._pos_bootstrapped = True
    t.book = {}
    t.strategy = None
    t.auto_trade = False
    t.robot_log = deque(maxlen=20)
    t.prop = type("P", (), {"note_closed_trade": lambda self, x: None})()
    t.bridge = Bridge(deals)
    t.strategy_meta = {}
    t._sync_book_meta = lambda: None
    t.telegram = None
    t._parked_entries = {}

    announced: list[tuple[str, int]] = []

    async def announce(kind, row):
        announced.append((kind, int((row or {}).get("ticket") or 0)))

    async def dummy(*_a, **_k):
        return None

    t._announce_trade = announce
    t.journal = dummy
    t.bus = type("B", (), {"publish": dummy})()
    return t, announced


#: A closing deal for ticket 11 - the broker's own word that it is gone.
CLOSING_DEAL = {
    "ticket": 99, "position_id": 11, "symbol": "EURUSD", "entry": "out",
    "type": "sell", "volume": 0.2, "price": 1.0870, "profit": 3.5,
    "swap": 0.0, "commission": 0.0, "time": "2026-10-05T10:00:00",
}


def test_a_frame_that_arrives_late_does_not_reopen_the_position() -> None:
    """The report, exactly.

    Frame A still holds the ticket and was built before the close.
    Frame B does not and is delivered first. With the broker's deal
    there, B closes the position at once - and then A must not undo it.
    """
    t, announced = build([CLOSING_DEAL])
    asyncio.run(t._sync_position_book([]))          # B: the close
    assert ("exit", 11) in announced
    asyncio.run(t._sync_position_book([dict(POS)]))  # A: the late frame

    entries = [k for k, _ in announced if k == "entry"]
    assert not entries, "a closed position was announced as a new entry"
    assert 11 not in t._known_pos, "the stale frame put the position back on the book"
    t.store.close()


def test_the_phantom_pair_is_not_merely_unrecorded() -> None:
    """It was invisible in the history and loud on the desk, which is the
    worst combination: nothing to point at afterwards."""
    t, announced = build([CLOSING_DEAL])
    asyncio.run(t._sync_position_book([]))
    for _ in range(4):
        asyncio.run(t._sync_position_book([dict(POS)]))
        asyncio.run(t._sync_position_book([]))
    kinds = [k for k, _ in announced]
    assert kinds.count("entry") == 0
    assert kinds.count("exit") == 1, f"the exit was announced {kinds.count('exit')} times"
    t.store.close()


def test_a_genuinely_new_position_still_opens() -> None:
    """The guard is about one ticket, not about the symbol or the book."""
    t, announced = build([CLOSING_DEAL])
    asyncio.run(t._sync_position_book([]))
    fresh = {**POS, "ticket": 12, "price_open": 1.0900}
    asyncio.run(t._sync_position_book([fresh]))
    assert ("entry", 12) in announced, "a real new position was swallowed"
    assert 12 in t._known_pos
    t.store.close()


def test_an_open_position_is_untouched_by_the_guard() -> None:
    t, announced = build()
    asyncio.run(t._sync_position_book([dict(POS)]))
    assert announced == [], "a position that never went anywhere was re-announced"
    assert 11 in t._known_pos
    t.store.close()


def test_a_hole_in_the_feed_still_waits_before_closing() -> None:
    """The strike counter is the other half of the same care, and this
    fix must not have traded one failure for the other."""
    t, announced = build()          # no deal: nothing proves the close
    asyncio.run(t._sync_position_book([]))
    assert announced == [], "one missing snapshot was enough to call it closed"
    asyncio.run(t._sync_position_book([dict(POS)]))
    assert announced == [], "a position that came back was re-announced as an entry"
    assert 11 in t._known_pos
    t.store.close()


def test_the_echo_is_refused_on_the_clock_too() -> None:
    """Deals can lag the position vanishing by a second or two, so the
    recent-close window has to stand on its own."""
    t, announced = build()          # no deal evidence at all
    t._closed_tickets = set()
    t._closed_at = {}
    for _ in range(5):              # strike it out instead
        asyncio.run(t._sync_position_book([]))
    assert ("exit", 11) in announced
    asyncio.run(t._sync_position_book([dict(POS)]))
    assert not [k for k, _ in announced if k == "entry"]
    t.store.close()


def test_an_old_ticket_cannot_mute_a_live_position() -> None:
    """_closed_tickets is hydrated from the whole trade history. Outside
    the grace window only the broker's own deals may speak, or a row from
    months ago could silence a position that is genuinely open."""
    t, announced = build()          # bridge has NO deal for 11
    t._known_pos = {}
    t._closed_tickets = {11}
    t._closed_at = {11: time.time() - (Trader.RESURRECTION_GRACE_SEC + 60)}
    asyncio.run(t._sync_position_book([dict(POS)]))
    assert ("entry", 11) in announced, "a live position was muted by an old history row"
    t.store.close()
