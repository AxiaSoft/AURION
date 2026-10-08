"""Auto entry point: where the robot rests its order, and when it gives up.

The rules worth pinning down are the ones a broker rejects you for getting
wrong - limit versus stop, a stop on the wrong side of the entry - and the
one a trader would call a bug: a strategy signal that quietly disappears
because the planner could not find a better price.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from aurion.runtime.auto_entry import expired_orders, plan_entry

ZONE_BUY = {"atr": 1.0, "zone": {"kind": "fvg", "low": 98.0, "high": 100.0}}
ZONE_SELL = {"atr": 1.0, "zone": {"kind": "fvg", "low": 110.0, "high": 112.0}}


def test_buy_below_market_is_a_limit():
    plan = plan_entry("buy", 104.0, 104.1, sl=96.0, tp=120.0, extra=ZONE_BUY)
    assert plan is not None
    assert plan["order_type"] == "buy_limit"
    assert plan["price"] == 99.0  # the middle of a 98-100 zone


def test_buy_above_market_is_a_stop():
    # The zone sits above the market: price has to break up into it, so the
    # order that gets filled there is a stop, not a limit. Sending a limit
    # is the classic "invalid price" rejection.
    plan = plan_entry("buy", 95.0, 95.1, sl=90.0, tp=120.0, extra=ZONE_BUY)
    assert plan is not None
    assert plan["order_type"] == "buy_stop"
    assert plan["price"] == 99.0


def test_sell_above_market_is_a_limit():
    plan = plan_entry("sell", 105.0, 105.1, sl=115.0, tp=90.0, extra=ZONE_SELL)
    assert plan is not None
    assert plan["order_type"] == "sell_limit"
    assert plan["price"] == 111.0


def test_sell_below_market_is_a_stop():
    plan = plan_entry("sell", 118.0, 118.1, sl=125.0, tp=90.0, extra=ZONE_SELL)
    assert plan is not None
    assert plan["order_type"] == "sell_stop"


def test_zone_depth_moves_the_price_into_the_zone():
    shallow = plan_entry("buy", 104.0, 104.1, 96.0, 120.0, ZONE_BUY, zone_depth=0.0)
    deep = plan_entry("buy", 104.0, 104.1, 96.0, 120.0, ZONE_BUY, zone_depth=1.0)
    assert shallow["price"] == 100.0  # the edge price reaches first
    assert deep["price"] == 98.0  # the far side of the zone


def test_no_zone_falls_back_to_an_atr_offset():
    plan = plan_entry("buy", 100.0, 100.0, 90.0, 120.0, {"atr": 2.0}, offset_atr=0.5)
    assert plan["order_type"] == "buy_limit"
    assert plan["price"] == 99.0


def test_no_zone_and_no_atr_sends_the_market_order():
    # Nothing to improve on is not a reason to skip a trade the strategy
    # asked for. None means "go to market", not "do nothing".
    assert plan_entry("buy", 100.0, 100.0, 90.0, 120.0, {}) is None


def test_level_too_close_sends_the_market_order():
    # A pending order a hair from the market either fills instantly or is
    # rejected for sitting inside the freeze level.
    tiny = {"atr": 100.0, "zone": {"low": 99.99, "high": 100.0}}
    assert plan_entry("buy", 100.0, 100.0, 90.0, 120.0, tiny) is None


def test_stop_on_the_wrong_side_of_the_new_entry_is_refused():
    # A buy limit at 99 with a stop at 99.5 is not a trade, and MT5 answers
    # with a retcode the desk cannot explain to anyone.
    assert plan_entry("buy", 104.0, 104.1, sl=99.5, tp=120.0, extra=ZONE_BUY) is None


def test_target_on_the_wrong_side_of_the_new_entry_is_refused():
    assert plan_entry("buy", 104.0, 104.1, sl=90.0, tp=98.5, extra=ZONE_BUY) is None


def test_stop_and_target_travel_unchanged():
    # The point of a better entry is that the invalidation does not move:
    # same stop, same target, less risk, more reward.
    plan = plan_entry("buy", 104.0, 104.1, sl=96.0, tp=120.0, extra=ZONE_BUY)
    assert plan["sl"] == 96.0
    assert plan["tp"] == 120.0
    assert plan["rr"] == 7.0  # (120-99) / (99-96)


def test_improvement_is_measured_against_the_side_that_fills():
    plan = plan_entry("buy", 104.0, 104.1, 96.0, 120.0, ZONE_BUY)
    assert plan["market"] == 104.1  # a buy pays the ask
    assert plan["improvement"] == round(104.1 - 99.0, 6)


def test_a_missing_tick_is_not_a_plan():
    assert plan_entry("buy", 0.0, 0.0, 96.0, 120.0, ZONE_BUY) is None


def test_an_unknown_side_is_not_a_plan():
    assert plan_entry("hold", 104.0, 104.1, 96.0, 120.0, ZONE_BUY) is None


def test_a_backwards_zone_is_ignored():
    bad = {"atr": 1.0, "zone": {"low": 110.0, "high": 90.0}}
    plan = plan_entry("buy", 100.0, 100.0, 80.0, 120.0, bad, offset_atr=0.5)
    assert plan["price"] == 99.5  # fell through to the ATR offset


# --- expiry ------------------------------------------------------------

MAGIC = 908173


def _order(ticket: int, minutes_ago: float, magic: int = MAGIC) -> dict:
    when = datetime.now(timezone.utc) - timedelta(minutes=minutes_ago)
    return {"ticket": ticket, "magic": magic, "time": when.isoformat()}


def test_stale_orders_are_listed():
    now = datetime.now(timezone.utc).timestamp()
    rows = [_order(1, 200), _order(2, 5)]
    assert expired_orders(rows, now, 120, MAGIC) == [1]


def test_other_peoples_orders_are_left_alone():
    # A trader's own pending orders are theirs. AURION cancels only what it
    # placed, which is what the magic number is for.
    now = datetime.now(timezone.utc).timestamp()
    rows = [_order(3, 999, magic=1234)]
    assert expired_orders(rows, now, 120, MAGIC) == []


def test_zero_expiry_never_cancels():
    now = datetime.now(timezone.utc).timestamp()
    assert expired_orders([_order(1, 99999)], now, 0, MAGIC) == []


def test_unreadable_timestamps_are_left_alone():
    now = datetime.now(timezone.utc).timestamp()
    rows = [{"ticket": 7, "magic": MAGIC, "time": "whenever"}]
    assert expired_orders(rows, now, 1, MAGIC) == []


def test_epoch_seconds_are_accepted():
    # The native bridge hands over an ISO string; the EA sends what MT5
    # gave it. Both have to work.
    now = datetime.now(timezone.utc).timestamp()
    rows = [{"ticket": 9, "magic": MAGIC, "time": now - 7200}]
    assert expired_orders(rows, now, 60, MAGIC) == [9]
