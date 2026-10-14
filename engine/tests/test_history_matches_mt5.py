"""The stored history must become MetaTrader's history, and stay it.

``test_close_reconciliation`` covers the arithmetic on a pile of deals. This
covers the storage around it: what reaches the desk, what the reconciliation
writes back, and whether a row that was right yesterday is still right after
the broker posts an overnight charge against it.

Real SQLite in a temp directory, no MT5 - the behaviour under test is SQL and
JSON, so that is what is exercised.
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest

from aurion.runtime.deals import aggregate_close_deals, history_row_matches
from aurion.runtime.store import Store


@pytest.fixture()
def store(tmp_path):
    return Store(tmp_path / "history.db")


def record_close(store, **over):
    trade = {
        "time": "2026-04-01T12:00:00Z",
        "ticket": 7001,
        "symbol": "XAUUSD",
        "side": "buy",
        "volume": 0.50,
        "price": 2410.5,
        "price_open": 2400.0,
        "time_open": "2026-04-01T09:30:00Z",
        "sl": 2390.0,
        "tp": 2440.0,
        "profit": 52.5,
        "swap": -1.2,
        "commission": -3.0,
        "net": 48.3,
        "parts": 1,
        "source": "mt5",
        "strategy": "king",
        "comment": "AURION king",
        "kind": "close",
        "entry": "out",
    }
    trade.update(over)
    store.record_trade(trade)
    return trade


def row_for(store, ticket=7001):
    for row in store.history(50, closed_only=False):
        if int(row.get("ticket") or 0) == ticket:
            return row
    raise AssertionError(f"no history row for {ticket}")


# ============================================ what actually reaches the desk ==

def test_net_and_source_are_expanded_from_the_blob(store):
    """The desk read row.net and row.source off rows that carried neither.

    Every figure MT5 reports has a column; everything else - net, the open
    side of the position, whether the numbers are MetaTrader's or an
    estimate - lives in the ``raw`` JSON, which was handed to the client as
    an unparsed string. Net was silently recomputed in the browser and the
    "this is an estimate" marker could never appear, however many estimated
    rows there were.
    """
    record_close(store)
    row = row_for(store)
    assert row["net"] == 48.3
    assert row["source"] == "mt5"


def test_the_open_side_of_the_position_reaches_the_desk(store):
    """Without these a desk row cannot be matched to a terminal row."""
    record_close(store)
    row = row_for(store)
    assert row["price_open"] == 2400.0
    assert row["time_open"] == "2026-04-01T09:30:00Z"


def test_an_estimated_close_is_marked_as_one(store):
    record_close(store, ticket=7002, source="estimate")
    assert row_for(store, 7002)["source"] == "estimate"


def test_a_column_is_never_overwritten_by_the_blob(store):
    """The reconciliation writes columns; the blob is the older copy."""
    record_close(store, ticket=7003)
    store.execute("UPDATE trades SET profit=99.0 WHERE ticket=?", (7003,))
    assert row_for(store, 7003)["profit"] == 99.0


def test_a_corrupt_blob_does_not_take_the_history_down(store):
    record_close(store, ticket=7004)
    store.execute("UPDATE trades SET raw='{not json' WHERE ticket=?", (7004,))
    row = row_for(store, 7004)
    assert row["profit"] == 52.5, "the columns still answer"


# ====================================================== the reconciliation ====

def deal(**kw):
    base = {"position_id": 7001, "ticket": 1, "entry": "out", "volume": 0.5,
            "price": 2410.5, "profit": 0.0, "swap": 0.0, "commission": 0.0,
            "time": "2026-04-01T12:00:00Z", "symbol": "XAUUSD"}
    base.update(kw)
    return base


def test_an_estimate_is_replaced_with_metatrader_s_numbers(store):
    record_close(store, profit=50.0, swap=0.0, commission=0.0, net=50.0,
                 time="2026-04-01T12:00:09Z", source="estimate")
    pending = store.pending_reconcile(10)
    assert len(pending) == 1, "an estimated row must be queued for a second look"

    totals = aggregate_close_deals([
        deal(ticket=9, entry="in", price=2400.0, commission=-3.0,
             time="2026-04-01T09:30:00Z"),
        deal(ticket=10, profit=52.5, swap=-1.2, time="2026-04-01T12:00:00Z"),
    ], 7001)
    assert store.apply_reconciliation(int(pending[0]["id"]), totals) is True

    row = row_for(store)
    assert row["profit"] == 52.5
    assert row["commission"] == -3.0, "the entry-leg commission must land too"
    assert row["net"] == 48.3
    assert row["source"] == "mt5", "no longer an estimate"


def test_the_reconciliation_corrects_the_timestamp_too(store):
    """The estimated row is stamped with the moment the desk noticed.

    A history sorted on that does not line up with the terminal's however
    right the profit is - which is the whole point of the exercise.
    """
    record_close(store, time="2026-04-01T12:00:09Z", source="estimate")
    pending = store.pending_reconcile(10)
    totals = aggregate_close_deals([deal(profit=52.5, time="2026-04-01T12:00:00Z")], 7001)
    store.apply_reconciliation(int(pending[0]["id"]), totals)

    row = row_for(store)
    assert row["ts"] == "2026-04-01T12:00:00Z"
    # The blob keeps its own copy of everything; if the two disagree, a later
    # reader picks whichever it happens to trust.
    assert json.loads(row["raw"])["time"] == "2026-04-01T12:00:00Z"


def test_the_reconciliation_corrects_a_partial_close_s_volume(store):
    record_close(store, volume=2.0, source="estimate")
    pending = store.pending_reconcile(10)
    totals = aggregate_close_deals([deal(volume=0.5, profit=5.0)], 7001)
    store.apply_reconciliation(int(pending[0]["id"]), totals)
    assert row_for(store)["volume"] == 0.5


def test_a_reconciled_row_leaves_the_queue(store):
    record_close(store, source="estimate")
    pending = store.pending_reconcile(10)
    store.apply_reconciliation(int(pending[0]["id"]),
                               aggregate_close_deals([deal(profit=1.0)], 7001))
    assert store.pending_reconcile(10) == [], "it would be corrected forever otherwise"


# ============================================================= the drift audit =

def test_a_finished_row_is_still_offered_for_checking(store):
    """Rows that were never estimates are the ones that drift.

    MT5 posts swap at rollover and some brokers book commission as its own
    deal minutes later. Both land on a position whose row is finished, and
    the estimate sweep will never look at it again.
    """
    record_close(store, source="mt5")
    audit = store.closed_rows_for_audit(10)
    assert [r["ticket"] for r in audit] == [7001]
    assert audit[0]["net"] == 48.3, "net comes from the blob, for comparison"


def test_an_overnight_swap_shows_up_as_drift(store):
    record_close(store, swap=0.0, net=49.5, source="mt5")
    row = store.closed_rows_for_audit(10)[0]
    later = aggregate_close_deals([
        deal(ticket=9, entry="in", price=2400.0, commission=-3.0),
        deal(ticket=10, profit=52.5, swap=-1.2),
    ], 7001)
    assert set(history_row_matches(row, later)) == {"swap", "net"}

    assert store.apply_reconciliation(int(row["id"]), later) is True
    fixed = store.closed_rows_for_audit(10)[0]
    assert history_row_matches(fixed, later) == [], "one pass must settle it"


def test_an_agreeing_row_is_left_alone(store):
    record_close(store)
    row = store.closed_rows_for_audit(10)[0]
    totals = aggregate_close_deals([
        deal(ticket=9, entry="in", price=2400.0, commission=-3.0),
        deal(ticket=10, profit=52.5, swap=-1.2),
    ], 7001)
    assert history_row_matches(row, totals) == []


def test_only_closed_rows_are_audited(store):
    store.record_trade({
        "time": "2026-04-01T09:30:00Z", "ticket": 7009, "symbol": "XAUUSD",
        "side": "buy", "volume": 0.5, "price": 2400.0, "profit": 0,
        "kind": "entry", "entry": "in",
    })
    record_close(store)
    assert [r["ticket"] for r in store.closed_rows_for_audit(10)] == [7001]


# ================================================== the ledger stays honest ===

def test_the_strategy_ledger_uses_the_net_the_broker_charged(store):
    """A strategy whose gross wins are eaten by swap is not a winner."""
    record_close(store, strategy="king", profit=52.5, swap=-1.2,
                 commission=-3.0, net=48.3)
    led = store.strategy_ledger()
    assert led["king"]["net"] == 48.3
