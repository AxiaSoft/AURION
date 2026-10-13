"""The stop may move forward. It may never move back.

This is the one piece of the runtime where a wrong sign produces no error
and no log line - it just widens somebody's risk on a live position. So
the tests here spend most of their effort on what must NOT happen, and
the single most important one is the last: that no input, in any
combination, can make resolve_stop ask for a worse stop than the position
already has.
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from aurion.runtime.stops import breakeven_target, resolve_stop, trailing_target


# --------------------------------------------------------------- arming --

def test_breakeven_waits_until_the_trade_has_earned_it():
    # 100 in, trigger at 20, only 19 earned.
    assert breakeven_target("buy", entry=100.0, price=119.0, trigger_points=20.0) is None
    # And now it has.
    assert breakeven_target("buy", entry=100.0, price=120.0, trigger_points=20.0) is not None


def test_breakeven_never_fires_on_a_losing_trade():
    assert breakeven_target("buy", entry=100.0, price=90.0, trigger_points=20.0) is None
    assert breakeven_target("sell", entry=100.0, price=110.0, trigger_points=20.0) is None


def test_the_stop_lands_past_the_entry_not_on_it():
    """A stop exactly on the open price still closes at a loss.

    The spread has to be crossed to get out, and the commission was
    charged to get in. "Risk free" has to mean past the entry.
    """
    sl = breakeven_target("buy", entry=100.0, price=130.0, trigger_points=20.0, spread=0.5)
    assert sl is not None and sl > 100.0

    sl = breakeven_target("sell", entry=100.0, price=70.0, trigger_points=20.0, spread=0.5)
    assert sl is not None and sl < 100.0


def test_the_lock_clears_the_spread_by_default():
    # No explicit lock: spread + a tenth of the trigger.
    sl = breakeven_target("buy", entry=100.0, price=130.0, trigger_points=20.0, spread=0.8)
    assert sl == 100.0 + 0.8 + 2.0


def test_an_explicit_lock_is_honoured():
    sl = breakeven_target("buy", entry=100.0, price=130.0,
                          trigger_points=20.0, lock_points=5.0, spread=0.8)
    assert sl == 105.0


def test_a_lock_that_would_land_beyond_the_market_is_refused():
    """Asking for a long's stop above the bid is a rejection, not a stop."""
    sl = breakeven_target("buy", entry=100.0, price=101.0,
                          trigger_points=1.0, lock_points=50.0)
    assert sl is None


def test_off_by_default():
    assert breakeven_target("buy", 100.0, 200.0, trigger_points=0.0) is None
    assert trailing_target("buy", 200.0, distance_points=0.0) is None


# -------------------------------------------------------------- choosing --

def test_whichever_rule_is_further_forward_wins():
    # Long, well in profit. Trailing wants 145, break-even wants ~102.
    plan = resolve_stop("buy", entry=100.0, price=150.0, current_sl=95.0,
                        breakeven_points=10.0, trailing_points=5.0)
    assert plan is not None
    assert plan.reason == "trailing"
    assert plan.sl == 145.0

    # Just armed. Break-even is ahead of a distant trailing stop.
    plan = resolve_stop("buy", entry=100.0, price=111.0, current_sl=90.0,
                        breakeven_points=10.0, breakeven_lock_points=2.0,
                        trailing_points=40.0)
    assert plan is not None
    assert plan.reason == "breakeven"
    assert plan.sl == 102.0


def test_nothing_is_sent_when_the_stop_is_already_there():
    """Idempotent, or it modifies the same position on every tick."""
    plan = resolve_stop("buy", entry=100.0, price=150.0, current_sl=145.0,
                        trailing_points=5.0)
    assert plan is None


def test_a_move_too_small_to_matter_is_skipped():
    plan = resolve_stop("buy", entry=100.0, price=150.0, current_sl=144.9,
                        trailing_points=5.0, min_step=0.5)
    assert plan is None


# ----------------------------------------------------- the whole point --

def test_a_long_stop_never_moves_down():
    plan = resolve_stop("buy", entry=100.0, price=120.0, current_sl=118.0,
                        trailing_points=10.0)      # would want 110
    assert plan is None


def test_a_short_stop_never_moves_up():
    plan = resolve_stop("sell", entry=100.0, price=80.0, current_sl=82.0,
                        trailing_points=10.0)      # would want 90
    assert plan is None


def test_breakeven_cannot_give_back_a_trailed_stop():
    """Price retraces after trailing got ahead; break-even must not pull in.

    This is the failure that would matter in real money: a trade runs to
    +50, the trail takes the stop to +40, price comes back to +12, and a
    naive break-even rule drags the stop from +40 down to +2.
    """
    plan = resolve_stop("buy", entry=100.0, price=112.0, current_sl=140.0,
                        breakeven_points=10.0, breakeven_lock_points=2.0,
                        trailing_points=0.0)
    assert plan is None


def test_no_input_can_ever_produce_a_worse_stop():
    """Swept, because one wrong comparison here is silent and expensive."""
    checked = 0
    for side in ("buy", "sell"):
        for entry in (50.0, 100.0, 2000.0):
            for offset in (-30.0, -1.0, 0.0, 1.0, 5.0, 30.0, 400.0):
                price = entry + offset if side == "buy" else entry - offset
                if price <= 0:
                    continue
                for current in (0.0, entry * 0.5, entry, entry * 1.5):
                    for be in (0.0, 1.0, 10.0):
                        for tr in (0.0, 1.0, 10.0):
                            plan = resolve_stop(
                                side, entry, price, current,
                                breakeven_points=be, trailing_points=tr,
                                spread=0.2,
                            )
                            checked += 1
                            if plan is None or current <= 0:
                                continue
                            if side == "buy":
                                assert plan.sl > current, (
                                    f"buy stop moved down: {current} -> {plan.sl}")
                                assert plan.sl < price, (
                                    f"buy stop at or above market: {plan.sl} >= {price}")
                            else:
                                assert plan.sl < current, (
                                    f"sell stop moved up: {current} -> {plan.sl}")
                                assert plan.sl > price, (
                                    f"sell stop at or below market: {plan.sl} <= {price}")
    assert checked > 1000, checked


def test_an_unknown_side_does_nothing():
    assert resolve_stop("", 100.0, 110.0, 0.0, trailing_points=5.0) is None
    assert resolve_stop("hedge", 100.0, 110.0, 0.0, trailing_points=5.0) is None


if __name__ == "__main__":
    passed = 0
    for name, fn in sorted(globals().items()):
        if not name.startswith("test_") or not callable(fn):
            continue
        fn()
        passed += 1
        print(f"ok   {name}")
    print(f"\n{passed}/{passed} stop checks passed")
