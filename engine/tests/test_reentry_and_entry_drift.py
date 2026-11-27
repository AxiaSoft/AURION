"""Two reports with one root between them.

    "Sometimes the robot enters, the trade closes at a loss or a profit,
     and then it just keeps firing trade after trade, spamming entries
     and exits."

    "The entry point is still applied too late - price has already gone
     past it and the entry never activated."

The first had no rule to break: the open-position ceiling was the only
brake on entry frequency, so an exit freed the slot and the next closed
bar re-entered the same setup. Most built-in entries are STATES, not
events - "in an established trend, price pulled into the slow EMA and
closed back on the trend side" is true bar after bar - and nothing
remembered having already acted on one.

The second is the other half of the same loop. A parked entry could only
change its mind once per bar, so a level defended at 09:01 was not
actionable until the M15 bar closed at 09:15; and when the confirmation
finally arrived, the trade was taken at market AT ANY DISTANCE, with the
original stop still attached. A third of the risk given away before the
position opened is a trade that stops out quickly - which freed the slot,
which re-entered, which is the first report.

    /tmp/v/bin/python -m pytest engine/tests/test_reentry_and_entry_drift.py
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "engine"))

from aurion.runtime import reentry as r  # noqa: E402
from aurion.runtime.auto_entry import (  # noqa: E402
    CONFIRM_RECLAIM,
    DEFAULT_MAX_DRIFT,
    confirm_entry,
    drift_ok,
    entry_drift,
)

# --------------------------------------------------------------- cooldown


def test_a_loss_waits_longer_than_a_win() -> None:
    """The asymmetry is the point, not a tuning detail.

    A win means the read was right. A loss is the market saying it was
    wrong, and that is exactly the moment re-entering immediately turns
    into the loop the user reported.
    """
    assert r.cooldown_bars(-12.0) > r.cooldown_bars(+12.0)
    assert r.cooldown_bars(+12.0) >= 0


def test_break_even_counts_as_a_loss() -> None:
    """A flat trade confirmed nothing, and its setup is still on the chart."""
    assert r.cooldown_bars(0.0) == r.cooldown_bars(-1.0)


def test_the_wait_is_measured_in_bars_not_seconds() -> None:
    """Three bars of M1 and three bars of H4 are not the same wait.

    A cooldown in seconds would be most of a session on M1 and nothing at
    all on H4. What is being waited for is new information, and that
    arrives one bar at a time.
    """
    at = 1_000_000.0
    m1 = r.block_until(at, 3, "M1") - at
    h4 = r.block_until(at, 3, "H4") - at
    assert m1 == 3 * 60
    assert h4 == 3 * 14400
    assert h4 > m1


def test_an_unknown_timeframe_does_not_mean_no_wait() -> None:
    """The failure mode this module exists to prevent, in one line."""
    assert r.timeframe_seconds("") > 0
    assert r.timeframe_seconds("NONSENSE") == r.timeframe_seconds(r.FALLBACK_TF)


def test_a_cooldown_expires() -> None:
    at = 1_000_000.0
    block = {"until": r.block_until(at, 2, "M5")}
    assert r.cooldown_left(block, now=at) == 600.0
    assert r.cooldown_left(block, now=at + 599) > 0
    assert r.cooldown_left(block, now=at + 600) == 0.0
    assert r.cooldown_left(block, now=at + 10_000) == 0.0
    assert r.cooldown_left(None) == 0.0


def test_the_wait_is_readable() -> None:
    assert r.describe_wait(45) == "45s"
    assert r.describe_wait(600) == "10m"
    assert r.describe_wait(7200) == "2h"
    assert r.describe_wait(-5) == "0s"


# ---------------------------------------------------------- setup identity


def test_the_same_setup_announced_twice_is_recognised() -> None:
    """This is what turns a state back into an event."""
    a = r.setup_fingerprint({"symbol": "EURUSD", "side": "buy",
                             "strategy": "ema_rsi", "price": 1.08650})
    b = r.setup_fingerprint({"symbol": "eurusd", "side": "buy",
                             "strategy": "ema_rsi", "price": 1.08650})
    assert r.same_setup(a, b)


def test_a_level_that_moved_by_noise_is_still_the_same_level() -> None:
    """A fingerprint that changes on a tick would never block anything."""
    a = r.setup_fingerprint({"symbol": "EURUSD", "side": "buy", "price": 1.086501})
    b = r.setup_fingerprint({"symbol": "EURUSD", "side": "buy", "price": 1.086499})
    assert r.same_setup(a, b)


def test_a_real_change_is_a_new_setup() -> None:
    base = {"symbol": "EURUSD", "side": "buy", "strategy": "ema_rsi", "price": 1.08650}
    assert not r.same_setup(
        r.setup_fingerprint(base), r.setup_fingerprint({**base, "side": "sell"}))
    assert not r.same_setup(
        r.setup_fingerprint(base), r.setup_fingerprint({**base, "price": 1.09900}))
    assert not r.same_setup(
        r.setup_fingerprint(base), r.setup_fingerprint({**base, "symbol": "GBPUSD"}))


def test_two_empty_fingerprints_do_not_match() -> None:
    """Unknown must never read as "already taken" and silence the robot."""
    assert not r.same_setup("", "")


# ------------------------------------------------------------ entry drift


def test_price_at_the_level_has_given_nothing_away() -> None:
    assert entry_drift("buy", 1.3100, 1.3100, 1.3050) == 0.0


def test_price_that_has_not_reached_the_level_is_not_drift() -> None:
    """A buy level still below the market is a plan, not a missed trade."""
    assert entry_drift("buy", 1.3100, 1.3140, 1.3050) == 0.0


def test_drift_is_measured_against_the_stop_not_in_points() -> None:
    """Twenty points means nothing; twenty points of a fifty-point stop does.

    The same absolute distance is trivial on gold and the whole trade on
    a major, which is why this is a fraction of the planned risk.
    """
    # buy at 1.3100, stop 1.3050: 50 points of risk, price 20 past it.
    assert entry_drift("buy", 1.3100, 1.3080, 1.3050) == pytest.approx(0.4)
    # the mirror image on the sell side
    assert entry_drift("sell", 1.3100, 1.3120, 1.3150) == pytest.approx(0.4)


def test_the_guard_refuses_a_trade_that_is_no_longer_the_planned_trade() -> None:
    ok, drift = drift_ok("buy", 1.3100, 1.3080, 1.3050)
    assert not ok and drift > DEFAULT_MAX_DRIFT
    ok, drift = drift_ok("buy", 1.3100, 1.3095, 1.3050)
    assert ok and drift <= DEFAULT_MAX_DRIFT


def test_an_unmeasurable_drift_is_allowed_through() -> None:
    """No stop on the plan means "cannot judge", and refusing every such
    entry would silently disable the feature for strategies that attach
    the stop later."""
    ok, drift = drift_ok("buy", 1.3100, 1.2000, 0.0)
    assert ok and drift == 0.0


# ------------------------------------------- confirming without the close


def _bar(o: float, h: float, l: float, c: float) -> dict[str, float]:
    return {"open": o, "high": h, "low": l, "close": c}


def test_a_level_touched_since_the_last_close_counts_as_reached() -> None:
    """Without the tick, a level first touched inside the forming bar is
    "not reached yet" until that bar closes - a whole bar of lateness
    before the question is even asked."""
    bars = [_bar(10.0, 10.4, 10.1, 10.3)]  # never traded down to 9.5
    assert confirm_entry("buy", bars, 9.5)["reason"] == "price has not reached the entry yet"
    out = confirm_entry("buy", bars, 9.5, tick={"ask": 9.4})
    assert out["reason"] != "price has not reached the entry yet"


def test_price_reclaiming_the_level_confirms_without_waiting() -> None:
    """The fix for "the entry is applied too late".

    The bar is still red - the close-direction test fails and will keep
    failing until the bar ends - but price has come back up through the
    level by a measurable part of the range. The level was tested and
    held; waiting for the close only costs the distance the move covers.
    """
    bars = [_bar(10.0, 11.0, 9.0, 9.2)]  # range 2.0, closed against a buy
    assert not confirm_entry("buy", bars, 9.5)["confirmed"]
    out = confirm_entry("buy", bars, 9.5, tick={"ask": 9.9})
    assert out["confirmed"]
    assert "reclaimed" in out["reason"]
    assert out["reclaim"] >= CONFIRM_RECLAIM


def test_a_flicker_over_the_level_is_not_a_reclaim() -> None:
    """Otherwise every tick above the level would fire the entry, which is
    the touch-fill behaviour confirmation exists to replace."""
    bars = [_bar(10.0, 11.0, 9.0, 9.2)]
    out = confirm_entry("buy", bars, 9.5, tick={"ask": 9.55})
    assert not out["confirmed"]
    assert out["reclaim"] < CONFIRM_RECLAIM


def test_the_reclaim_is_read_from_the_right_side_for_a_sell() -> None:
    bars = [_bar(10.0, 11.0, 9.0, 10.8)]  # closed against a sell
    assert not confirm_entry("sell", bars, 10.5)["confirmed"]
    assert confirm_entry("sell", bars, 10.5, tick={"bid": 10.1})["confirmed"]


def test_a_tick_cannot_confirm_a_level_price_never_reached() -> None:
    """Reaching the level is a precondition, not something a reclaim can
    substitute for - otherwise a plan would fire on a market that never
    came near it."""
    bars = [_bar(10.0, 10.4, 10.1, 10.3)]
    out = confirm_entry("buy", bars, 9.0, tick={"ask": 10.3})
    assert not out["confirmed"]
    assert out["reason"] == "price has not reached the entry yet"


def test_confirmation_off_still_means_off() -> None:
    assert confirm_entry("buy", [], 9.5, mode="off", tick={"ask": 9.9})["confirmed"]


def test_no_tick_behaves_exactly_as_before() -> None:
    """The tick is optional everywhere; a caller that has none must get
    the old answer, not a crash and not a different verdict."""
    bars = [_bar(9.0, 10.0, 8.8, 9.9)]
    assert confirm_entry("buy", bars, 9.0) == confirm_entry("buy", bars, 9.0, tick=None)
    assert confirm_entry("buy", bars, 9.0, tick={})["confirmed"]


# ------------------------------------------- the brakes on the real Trader
#
# The arithmetic above is pure; these borrow the shipping methods off the
# class so it is the real code that runs, not a re-description of it.

from aurion.runtime.trader import Trader  # noqa: E402


class FakeBot:
    _reentry_key = Trader._reentry_key
    _reentry_memory = Trader._reentry_memory
    _note_exit = Trader._note_exit
    _reentry_ok = Trader._reentry_ok
    reentry_state = Trader.reentry_state

    def __init__(self, timeframe="M15"):
        self._reentry_block = {}
        self._loss_streak = {}
        self._taken_setups = {}
        self.reentry_guard = True
        self.reentry_loss_bars = r.DEFAULT_COOLDOWN_LOSS_BARS
        self.reentry_win_bars = r.DEFAULT_COOLDOWN_WIN_BARS
        self.max_consecutive_losses = r.DEFAULT_MAX_CONSECUTIVE_LOSSES
        self.active_timeframe = timeframe


def test_a_closed_trade_stops_the_next_one_dead() -> None:
    """The whole report, in four lines."""
    bot = FakeBot()
    assert bot._reentry_ok("EURUSD")[0]
    bot._note_exit("EURUSD", -14.0)
    allowed, why = bot._reentry_ok("EURUSD")
    assert not allowed
    assert "cooling down" in why and "after a loss" in why


def test_the_cooldown_is_per_symbol() -> None:
    """A stop-out on gold is not a reason to stop trading the euro."""
    bot = FakeBot()
    bot._note_exit("XAUUSD", -14.0)
    assert not bot._reentry_ok("XAUUSD")[0]
    assert bot._reentry_ok("EURUSD")[0]


def test_the_symbol_is_matched_however_it_is_spelled() -> None:
    bot = FakeBot()
    bot._note_exit("eurusd", -1.0)
    assert not bot._reentry_ok("EURUSD")[0]
    assert not bot._reentry_ok(" eurusd ")[0]


def test_a_run_of_losses_stands_the_robot_down_for_longer() -> None:
    """Three stop-outs in a row on one symbol is the market saying the
    robot is wrong about it right now."""
    bot = FakeBot()
    for _ in range(2):
        bot._note_exit("EURUSD", -5.0)
    short = bot._reentry_block["EURUSD"]["bars"]
    bot._note_exit("EURUSD", -5.0)
    long_ = bot._reentry_block["EURUSD"]["bars"]
    assert long_ > short
    assert "3 losses in a row" in bot._reentry_ok("EURUSD")[1]


def test_a_win_clears_the_losing_streak() -> None:
    bot = FakeBot()
    for _ in range(3):
        bot._note_exit("EURUSD", -5.0)
    bot._note_exit("EURUSD", +9.0)
    assert bot._loss_streak["EURUSD"] == 0
    assert bot._reentry_block["EURUSD"]["bars"] == bot.reentry_win_bars


def test_an_exit_lets_the_setup_look_new_again() -> None:
    """The fingerprint guard is about one signal repeating itself, not
    about never trading the same symbol twice."""
    bot = FakeBot()
    bot._taken_setups["EURUSD|buy"] = "EURUSD|buy|ema_rsi||1.08650"
    bot._taken_setups["GBPUSD|buy"] = "GBPUSD|buy|ema_rsi||1.31000"
    bot._note_exit("EURUSD", -1.0)
    assert "EURUSD|buy" not in bot._taken_setups
    assert "GBPUSD|buy" in bot._taken_setups, "another symbol's memory was wiped"


def test_the_guard_can_be_turned_off_entirely() -> None:
    bot = FakeBot()
    bot._note_exit("EURUSD", -14.0)
    bot.reentry_guard = False
    assert bot._reentry_ok("EURUSD")[0]


def test_the_desk_can_say_what_is_cooling_down_and_for_how_long() -> None:
    """A robot that goes quiet must be able to say why."""
    bot = FakeBot(timeframe="M5")
    assert bot.reentry_state() == []
    bot._note_exit("EURUSD", -14.0)
    state = bot.reentry_state()
    assert len(state) == 1
    assert state[0]["symbol"] == "EURUSD"
    assert state[0]["timeframe"] == "M5"
    assert state[0]["bars"] == r.DEFAULT_COOLDOWN_LOSS_BARS
    assert state[0]["seconds_left"] > 0
    assert state[0]["wait"]


def test_an_expired_cooldown_leaves_nothing_behind() -> None:
    bot = FakeBot()
    bot._note_exit("EURUSD", -14.0)
    bot._reentry_block["EURUSD"]["until"] = 0.0
    assert bot._reentry_ok("EURUSD")[0]
    assert bot.reentry_state() == []
    assert "EURUSD" not in bot._reentry_block, "a spent cooldown was never swept"
