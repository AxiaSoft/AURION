"""The desk's closed-trade figures must agree with MetaTrader's.

These cover the three ways they used to disagree:
  * a position closed in parts reported only the first part;
  * gross profit was compared against a statement that nets swap and
    commission;
  * the close price of a multi-part close was whichever part came first.

Pure function, no MT5 needed - which is the point of extracting it.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from aurion.runtime.deals import aggregate_close_deals


def deal(**kw):
    base = {"position_id": 500, "ticket": 1, "entry": "out", "volume": 1.0,
            "price": 100.0, "profit": 0.0, "swap": 0.0, "commission": 0.0, "time": "2026-01-01T00:00:00Z"}
    base.update(kw)
    return base


def test_single_close_is_reported_as_is():
    got = aggregate_close_deals([deal(profit=12.5, swap=-0.4, commission=-0.7)], 500)
    assert got["profit"] == 12.5
    assert got["net"] == round(12.5 - 0.4 - 0.7, 2)
    assert got["parts"] == 1


def test_partial_closes_are_summed():
    """The regression that started this: two out deals, one position."""
    deals = [
        deal(ticket=11, volume=0.5, price=100.0, profit=10.0, commission=-0.3),
        deal(ticket=12, volume=0.5, price=110.0, profit=-4.0, commission=-0.3),
    ]
    got = aggregate_close_deals(deals, 500)
    assert got["profit"] == 6.0, "must be the sum, not the first deal"
    assert got["net"] == 5.4
    assert got["parts"] == 2
    assert got["volume"] == 1.0
    assert got["price"] == 105.0, "volume-weighted average close"


def test_entry_deals_are_ignored():
    deals = [deal(entry="in", profit=0.0), deal(ticket=13, entry="out", profit=7.0)]
    got = aggregate_close_deals(deals, 500)
    assert got["profit"] == 7.0
    assert got["parts"] == 1


def test_other_positions_are_ignored():
    deals = [deal(position_id=999, profit=1000.0), deal(ticket=14, profit=3.0)]
    assert aggregate_close_deals(deals, 500)["profit"] == 3.0


def test_matches_by_deal_ticket_too():
    """The EA feed sometimes carries the deal ticket and no position id."""
    assert aggregate_close_deals([deal(position_id=0, ticket=500, profit=2.0)], 500)["profit"] == 2.0


def test_returns_none_when_the_deal_has_not_arrived():
    """Deals lag the position disappearing; the caller must know to wait
    rather than record the last floating price as a fact."""
    assert aggregate_close_deals([deal(position_id=42)], 500) is None
    assert aggregate_close_deals([], 500) is None


def test_latest_time_wins():
    deals = [deal(ticket=1, time="2026-01-01T10:00:00Z"), deal(ticket=2, time="2026-01-01T12:00:00Z")]
    assert aggregate_close_deals(deals, 500)["time"] == "2026-01-01T12:00:00Z"


def test_zero_volume_does_not_divide_by_zero():
    got = aggregate_close_deals([deal(volume=0, price=0, profit=1.0)], 500)
    assert got["price"] == 0.0 and got["profit"] == 1.0
