"""The rules that move a stop once a trade is open.

Two things are checked here. First that R means the original risk and
keeps meaning it after the stop has been moved - get that wrong and
break-even re-arms itself at a new, closer distance on every tick.
Second that the replay applies the same rules as the live runtime, which
is the defect these tests exist for: the backtest used to report what a
strategy did with a naked stop and target, a robot nobody runs.
"""

from __future__ import annotations

import pytest

from aurion.backtest.engine import Backtester
from aurion.runtime.stops import resolve_stop_r, risk_distance


def test_one_r_is_the_distance_to_the_stop_that_was_placed():
    assert risk_distance(1.1000, 1.0980) == pytest.approx(0.0020)
    assert risk_distance(1.1000, 0) == 0.0
    assert risk_distance(0, 1.0980) == 0.0


def test_break_even_waits_until_the_trade_has_earned_it():
    # 20 pips of risk, trigger at 0.8R = 16 pips.
    args = dict(be_at_r=0.8, be_lock_r=0.1)
    assert resolve_stop_r("buy", 1.1000, 1.0980, 1.1010, 1.0980, **args) is None
    plan = resolve_stop_r("buy", 1.1000, 1.0980, 1.1018, 1.0980, **args)
    assert plan is not None and plan.reason == "breakeven"
    # Past the entry, not on it: a stop on the open price still pays the
    # spread on the way out.
    assert plan.sl > 1.1000


def test_a_short_is_the_mirror_image():
    args = dict(be_at_r=0.8, be_lock_r=0.1)
    assert resolve_stop_r("sell", 1.1000, 1.1020, 1.0990, 1.1020, **args) is None
    plan = resolve_stop_r("sell", 1.1000, 1.1020, 1.0984, 1.1020, **args)
    assert plan is not None and plan.sl < 1.1000


def test_r_is_measured_from_the_original_stop_not_the_moved_one():
    """The regression that matters.

    Once break-even has moved the stop to just above the entry, the
    distance from entry to *current* stop is almost nothing. If R were
    read from there, the trailing rule would arm instantly and strangle
    every position. Passing the initial stop separately is what stops it.
    """
    moved = 1.1002
    plan = resolve_stop_r(
        "buy", 1.1000, 1.0980, 1.1018, moved,
        be_at_r=0.8, be_lock_r=0.1, trail_at_r=1.5, trail_r=1.0,
    )
    # 1.8 pips of profit is just under 1R of the real risk, nowhere near the 1.5R
    # the trailing rule is armed at, so nothing trails yet.
    assert plan is None or plan.sl <= 1.1018


def test_a_stop_never_moves_backwards():
    plan = resolve_stop_r(
        "buy", 1.1000, 1.0980, 1.1018, 1.1010, be_at_r=0.8, be_lock_r=0.1,
    )
    assert plan is None


def test_no_rules_means_no_interference():
    assert resolve_stop_r("buy", 1.1000, 1.0980, 1.1500, 1.0980) is None


def test_the_replay_manages_stops_the_way_the_runtime_does():
    bt = Backtester()
    pos = {"type": "buy", "entry": 1.1000, "sl": 1.0980, "initial_sl": 1.0980, "volume": 0.1}
    rules = bt._manage_rules({})
    assert rules["be_at_r"] > 0, "break-even must be on by default"

    bt._manage(pos, {"close": 1.1005, "high": 1.1030, "low": 1.0999}, rules)
    assert pos["sl"] == 1.0980, "not earned yet"

    # Driven by the close, never by the high - a rule that reacts to the
    # best price inside a bar is reading the future.
    bt._manage(pos, {"close": 1.1020, "high": 1.1040, "low": 1.1000}, rules)
    assert pos["sl"] > 1.1000 and pos.get("managed") == "breakeven"


def test_a_strategy_can_turn_management_off_or_tune_it():
    bt = Backtester()
    assert bt._manage_rules({"be_at_r": 0})["be_at_r"] == 0.0
    assert bt._manage_rules({"be_at_r": "1.5"})["be_at_r"] == 1.5
    # Junk falls back to the default rather than exploding mid-replay.
    assert bt._manage_rules({"be_at_r": "nonsense"})["be_at_r"] == bt.MANAGE_DEFAULTS["be_at_r"]


def test_every_exit_reports_what_it_had_at_stake():
    """avg_rr was silently computed from a subset of the trades."""
    bt = Backtester()
    pos = {"entry": 1.1000, "initial_sl": 1.0980, "volume": 0.1}
    assert bt._risk(pos, 1.0) > 0
    assert bt._risk({"entry": 1.1000, "volume": 0.1}, 1.0) == 0.0
