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

from aurion.runtime.deals import aggregate_close_deals, history_row_matches


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


# ===========================================================================
# Identity with MetaTrader, not merely agreement
# ===========================================================================
# The standard: open a trade, close it, and every figure on AURION's history
# row equals the figure the terminal shows for the same position. These cover
# the fields that were taken from somewhere other than the deals.

def test_commission_charged_on_entry_is_counted():
    """Most brokers bill on the way in, and only the entry deal carries it.

    Summing commission over closing deals alone under-reported the cost of
    every single trade - silently, and always in the flattering direction.
    """
    deals = [
        deal(ticket=10, entry="in", volume=1.0, price=100.0, commission=-3.5),
        deal(ticket=11, entry="out", volume=1.0, price=110.0, profit=10.0, commission=0.0),
    ]
    got = aggregate_close_deals(deals, 500)
    assert got["commission"] == -3.5
    assert got["entry_commission"] == -3.5
    assert got["net"] == 6.5, "net must be what the balance actually did"


def test_commission_on_both_legs_is_counted_once_each():
    deals = [
        deal(ticket=10, entry="in", commission=-2.0),
        deal(ticket=11, entry="out", profit=5.0, commission=-2.0),
    ]
    got = aggregate_close_deals(deals, 500)
    assert got["commission"] == -4.0
    assert got["entry_commission"] == -2.0


def test_the_close_time_is_metatrader_s():
    """Not the moment the desk noticed. A history sorted on the wrong
    timestamp does not line up with the terminal's, however right the
    profit is."""
    deals = [
        deal(ticket=11, time="2026-03-02T09:14:07Z", profit=1.0),
        deal(ticket=12, time="2026-03-02T09:14:31Z", profit=1.0),
    ]
    got = aggregate_close_deals(deals, 500)
    assert got["close_time"] == "2026-03-02T09:14:31Z"
    assert got["first_close_time"] == "2026-03-02T09:14:07Z"
    assert got["time"] == got["close_time"], "the legacy key must not drift"


def test_the_open_side_is_carried_so_rows_can_be_matched():
    deals = [
        deal(ticket=9, entry="in", volume=1.0, price=1.2000, time="2026-03-01T08:00:00Z",
             order=777, comment="AURION king"),
        deal(ticket=10, entry="out", volume=1.0, price=1.2100, time="2026-03-01T12:00:00Z", profit=100.0),
    ]
    got = aggregate_close_deals(deals, 500)
    assert got["open_price"] == 1.2
    assert got["open_time"] == "2026-03-01T08:00:00Z"
    assert got["order"] == 777
    assert got["comment"] == "AURION king", "the strategy tag lives on the entry deal"


def test_a_scaled_in_position_averages_its_entry():
    deals = [
        deal(ticket=1, entry="in", volume=1.0, price=100.0, time="2026-03-01T08:00:00Z"),
        deal(ticket=2, entry="in", volume=3.0, price=108.0, time="2026-03-01T09:00:00Z"),
        deal(ticket=3, entry="out", volume=4.0, price=110.0, profit=20.0),
    ]
    got = aggregate_close_deals(deals, 500)
    assert got["open_price"] == 106.0, "volume-weighted, like MT5's own average"
    assert got["open_volume"] == 4.0
    assert got["open_time"] == "2026-03-01T08:00:00Z", "the position opened at the first fill"


def test_a_partial_close_reports_the_volume_that_moved():
    deals = [
        deal(ticket=1, entry="in", volume=2.0, price=100.0),
        deal(ticket=2, entry="out", volume=0.5, price=110.0, profit=5.0),
    ]
    got = aggregate_close_deals(deals, 500)
    assert got["volume"] == 0.5, "not the 2.0 the position was carrying"


def test_every_closing_deal_is_listed():
    """So a row can be matched against the terminal deal by deal."""
    deals = [deal(ticket=21, profit=1.0), deal(ticket=22, profit=1.0), deal(ticket=23, profit=1.0)]
    got = aggregate_close_deals(deals, 500)
    assert got["deals"] == [21, 22, 23]
    assert got["parts"] == 3


def test_an_inout_reversal_counts_as_both_legs():
    """A reversal closes one position and opens the next with one deal."""
    got = aggregate_close_deals(
        [deal(ticket=30, entry="inout", volume=1.0, price=100.0, profit=4.0, commission=-1.0)], 500)
    assert got["profit"] == 4.0
    assert got["commission"] == -1.0
    assert got["open_price"] == 100.0, "the inout deal is an opening deal too"
    # ...but it is not *only* an opening deal, so its commission is not
    # double-counted as an entry charge.
    assert got["entry_commission"] == 0.0


# --------------------------------------------------------- the drift audit --

def test_a_row_that_matches_reports_no_drift():
    totals = aggregate_close_deals([deal(profit=12.5, swap=-0.4, commission=-0.7)], 500)
    row = {
        "profit": 12.5, "swap": -0.4, "commission": -0.7, "net": 11.4,
        "price": 100.0, "volume": 1.0, "time": "2026-01-01T00:00:00Z",
    }
    assert history_row_matches(row, totals) == []


def test_an_overnight_swap_posted_later_is_detected():
    """Nothing marks a finished row as an estimate, so without this check a
    swap charged at rollover never reaches the desk's history."""
    totals = aggregate_close_deals([deal(profit=12.5, swap=-2.8, commission=-0.7)], 500)
    row = {
        "profit": 12.5, "swap": 0.0, "commission": -0.7, "net": 11.8,
        "price": 100.0, "volume": 1.0, "time": "2026-01-01T00:00:00Z",
    }
    assert set(history_row_matches(row, totals)) == {"swap", "net"}


def test_a_timestamp_from_the_desk_clock_is_detected():
    totals = aggregate_close_deals([deal(profit=1.0, time="2026-01-01T00:00:00Z")], 500)
    row = {"profit": 1.0, "swap": 0.0, "commission": 0.0, "net": 1.0,
           "price": 100.0, "volume": 1.0, "time": "2026-01-01T00:00:09Z"}
    assert history_row_matches(row, totals) == ["time"]


def test_rounding_is_not_reported_as_drift():
    """These are rounded currency amounts; comparing floats for equality
    would report a disagreement that is not on anybody's screen."""
    totals = aggregate_close_deals([deal(profit=12.5, swap=-0.4, commission=-0.7)], 500)
    row = {"profit": 12.5000001, "swap": -0.4, "commission": -0.7, "net": 11.4,
           "price": 100.0, "volume": 1.0, "time": "2026-01-01T00:00:00Z"}
    assert history_row_matches(row, totals) == []


def test_a_position_with_no_deals_is_not_called_wrong():
    assert history_row_matches({"profit": 1.0}, None) == ["no_mt5_deals"]
