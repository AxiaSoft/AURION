"""The robot plants the entry, then waits for the market to agree.

A resting order fills on touch, which takes the trade where price merely
visited the level exactly as readily as the one where the level held.
These tests pin the difference.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from aurion.runtime.auto_entry import CONFIRM_CLOSE_LOC, CONFIRM_WICK, confirm_entry


def bar(o, h, l, c):
    return {"open": o, "high": h, "low": l, "close": c}


def test_a_level_that_held_is_confirmed():
    # Price dipped to 9.4, buyers took it back, bar closed near its high.
    verdict = confirm_entry("buy", [bar(10.0, 10.6, 9.4, 10.5)], 9.5)
    assert verdict["confirmed"] is True
    assert "rejected the level" in verdict["reason"]


def test_a_level_being_walked_through_is_refused():
    # Price reached the level and kept going. Nothing defended it.
    verdict = confirm_entry("buy", [bar(10.0, 10.6, 9.4, 9.5)], 9.5)
    assert verdict["confirmed"] is False
    assert verdict["reason"] == "last candle closed against the trade"


def test_an_entry_price_never_reached_is_not_an_entry():
    verdict = confirm_entry("buy", [bar(10.0, 10.6, 9.4, 10.5)], 5.0)
    assert verdict["confirmed"] is False
    assert "not reached" in verdict["reason"]


def test_sell_side_is_the_mirror_image():
    # Rallied into 10.5, sellers rejected it, closed near the low.
    assert confirm_entry("sell", [bar(10.0, 10.6, 9.4, 9.5)], 10.5)["confirmed"] is True
    assert confirm_entry("sell", [bar(10.0, 10.6, 9.4, 10.5)], 10.5)["confirmed"] is False


def test_strict_demands_all_three_and_normal_does_not():
    # Closes up, strong lower wick, but finishes mid-range.
    mid = [bar(10.0, 11.0, 9.0, 10.02)]
    assert confirm_entry("buy", mid, 9.5, mode="normal")["confirmed"] is True
    assert confirm_entry("buy", mid, 9.5, mode="strict")["confirmed"] is False


def test_off_restores_the_old_fill_on_touch_behaviour():
    # Even a candle closing hard against the trade passes when disabled,
    # because "off" means the trader asked for no confirmation at all.
    verdict = confirm_entry("buy", [bar(10.0, 10.6, 9.4, 9.5)], 9.5, mode="off")
    assert verdict["confirmed"] is True


def test_nothing_in_the_trade_path_can_raise():
    for junk in ([], None, [{}], [{"open": 0, "high": 0, "low": 0, "close": 0}],
                 ["not a dict"], [{"open": "x", "high": None, "low": [], "close": {}}]):
        verdict = confirm_entry("buy", junk, 9.5)
        assert verdict["confirmed"] is False
        assert isinstance(verdict["reason"], str) and verdict["reason"]


def test_an_unknown_side_is_refused_not_guessed():
    assert confirm_entry("", [bar(10, 11, 9, 10.5)], 9.5)["confirmed"] is False
    assert confirm_entry("long", [bar(10, 11, 9, 10.5)], 9.5)["confirmed"] is False


def test_an_unreadable_mode_falls_back_to_normal_not_to_off():
    # A typo in config must never silently disable the gate.
    verdict = confirm_entry("buy", [bar(10.0, 10.6, 9.4, 9.5)], 9.5, mode="nonsense")
    assert verdict["mode"] == "normal"
    assert verdict["confirmed"] is False


def test_the_level_may_be_reached_on_an_earlier_bar_in_the_window():
    # Touched two bars ago, confirmed now. That is the normal shape of a
    # retest and must not be missed because it was not the latest bar.
    bars = [bar(10.0, 10.2, 9.4, 9.9), bar(9.9, 10.1, 9.8, 10.0),
            bar(10.0, 10.6, 9.95, 10.55)]
    assert confirm_entry("buy", bars, 9.5)["confirmed"] is True


def test_the_thresholds_are_reported_so_the_desk_can_explain_the_wait():
    verdict = confirm_entry("buy", [bar(10.0, 11.0, 9.0, 10.8)], 9.5)
    assert 0.0 <= verdict["close_loc"] <= 1.0
    assert 0.0 <= verdict["wick"] <= 1.0
    assert verdict["close_loc"] >= CONFIRM_CLOSE_LOC
    assert CONFIRM_WICK > 0
