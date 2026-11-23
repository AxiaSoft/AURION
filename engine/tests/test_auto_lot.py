"""Auto lot has to be a decision, not a constant.

Reported, in these words: on auto lot the robot only ever trades 0.1 —
make it decide for itself how much to stake, between 0.01 and 1 lot,
from how strong its own signal is; that way there is some money
management too.

That is exactly what it did. "Auto" meant "whatever volume the
strategy named", and every built-in strategy names 0.10 in its
defaults, so a setup three filters agreed on was staked identically to
one that barely cleared the floor. The confidence each strategy
publishes with its signal — the same number the quality floor filters
on — was computed, carried all the way to the order, and spent on
nothing.

Two separate things decide a size now, and this file keeps them
separate:

  * conviction decides how much of the available room is used;
  * equity decides how much room exists at all.

The second is the money management. A full lot behind a two-hundred
dollar account is not confidence.

The live robot and the replay must agree to the lot, or a backtest is
a test of a robot nobody is running — the last test here is the one
that holds those two together.
"""

from __future__ import annotations

from typing import Any

import pytest

from aurion.runtime.sizing import LOT_MAX, LOT_MIN, auto_lot, lot_ceiling


# A ten-thousand account: the size at which the ceiling is a full lot,
# so conviction alone is what is being read in most of these.
RICH = 10_000.0


# ─────────────────────────────── conviction moves the size ──────────

def test_a_stronger_signal_is_staked_harder():
    sizes = [auto_lot(c, RICH) for c in (0.55, 0.65, 0.75, 0.85, 0.90)]
    assert sizes == sorted(sizes), f"size did not rise with confidence: {sizes}"
    assert len(set(sizes)) > 1, "every confidence produced the same lot — that is the bug"


def test_the_weakest_signal_gets_the_smallest_lot():
    for conf in (0.0, 0.1, 0.49, 0.5):
        assert auto_lot(conf, RICH) == LOT_MIN


def test_the_strongest_signal_gets_a_full_lot_when_the_account_carries_it():
    assert auto_lot(0.90, RICH) == LOT_MAX
    assert auto_lot(0.99, RICH) == LOT_MAX
    # Nothing above the ceiling, whatever is claimed.
    assert auto_lot(5.0, RICH) == LOT_MAX


def test_nothing_ever_leaves_the_stated_range():
    for conf in (-1, 0, 0.3, 0.61, 0.9, 1.0, 2.5, None, "", "nonsense", float("nan")):
        for eq in (0, -5, 1, 250, 9_999, 1_000_000):
            lot = auto_lot(conf, eq)
            assert LOT_MIN <= lot <= LOT_MAX, f"{conf!r} at {eq}: {lot}"
            # Lots are quoted in hundredths; a broker takes nothing finer.
            assert round(lot * 100) == pytest.approx(lot * 100, abs=1e-9)


# ──────────────────────────── the account sets the ceiling ──────────

def test_a_small_account_cannot_be_talked_into_a_big_trade():
    """The whole of the money management, in one line: the same signal,
    the same certainty, a different account."""
    certain = 0.99
    assert auto_lot(certain, 200.0) < auto_lot(certain, 2_000.0) < auto_lot(certain, 20_000.0)
    assert auto_lot(certain, 200.0) <= 0.02
    assert auto_lot(certain, 1_000.0) == pytest.approx(0.10, abs=1e-9)


def test_the_ceiling_rises_with_equity_and_then_stops():
    assert lot_ceiling(10_000.0) == LOT_MAX
    assert lot_ceiling(1_000_000.0) == LOT_MAX, "a huge account is still capped at one lot"
    assert lot_ceiling(1_000.0) == pytest.approx(0.10)
    assert lot_ceiling(50.0) == LOT_MIN


def test_an_unreadable_account_is_not_permission_to_trade_big():
    """Equity of zero means the account could not be read, not that it
    is empty and not that it is unlimited."""
    assert auto_lot(0.99, 0.0) <= 0.10
    assert auto_lot(0.99, None) <= 0.10


def test_a_drawdown_shrinks_the_next_trade_on_its_own():
    before = auto_lot(0.8, 10_000.0)
    after = auto_lot(0.8, 4_000.0)
    assert after < before, "losing half the account did not shrink the size"


# ───────────────────────────────── the live robot uses it ───────────

class _Trader:
    """Just enough of the trader to exercise _robot_volume."""

    def __init__(self, mode: str = "auto", manual: float = 0.0, equity: float = RICH) -> None:
        self.volume_mode = mode
        self.manual_volume = manual
        self._equity = equity

    def _equity_now(self) -> float:
        return self._equity

    _robot_volume = None  # bound below


def _trader(**kw) -> _Trader:
    from aurion.runtime.trader import Trader

    t = _Trader(**kw)
    t._robot_volume = Trader._robot_volume.__get__(t, _Trader)
    return t


def test_the_live_robot_sizes_an_auto_entry_from_its_confidence():
    t = _trader()
    weak = t._robot_volume({"action": "buy", "volume": 0.10, "confidence": 0.52})
    strong = t._robot_volume({"action": "buy", "volume": 0.10, "confidence": 0.95})
    assert weak < strong
    assert strong == LOT_MAX
    assert weak <= 0.05, "a signal barely over the floor was staked heavily"

    # And neither is the 0.10 the strategy asked for, which is the
    # complaint: auto was returning that number every single time.
    assert 0.10 not in {weak, strong}


def test_manual_still_pins_every_entry():
    t = _trader(mode="manual", manual=0.35)
    for conf in (0.0, 0.5, 0.99):
        assert t._robot_volume({"action": "buy", "volume": 0.10, "confidence": conf}) == 0.35


def test_a_signal_with_no_confidence_keeps_the_volume_it_asked_for():
    """A custom strategy that sizes its own trades and reports no
    conviction has nothing to be sized from; it is not overruled."""
    t = _trader()
    assert t._robot_volume({"action": "buy", "volume": 0.42}) == 0.42
    assert t._robot_volume({"action": "buy", "volume": 0.42, "confidence": 0}) == 0.42


# ───────────────────────── and the replay sizes it the same ─────────

def test_the_replay_and_the_live_robot_agree_on_the_lot():
    """A backtest sized differently from the desk is a test of a robot
    nobody is running."""
    from aurion.backtest.engine import Backtester

    bt = Backtester()
    live = _trader(equity=RICH)
    for conf in (0.0, 0.55, 0.7, 0.88, 0.99):
        payload = {"action": "buy", "volume": 0.10, "confidence": conf}
        assert bt._entry_volume(payload, "auto", 0.0, RICH) == live._robot_volume(payload)


def test_the_replay_sizes_against_the_equity_it_had_at_that_bar():
    from aurion.backtest.engine import Backtester

    bt = Backtester()
    payload = {"action": "buy", "volume": 0.10, "confidence": 0.85}
    rich = bt._entry_volume(payload, "auto", 0.0, 20_000.0)
    poor = bt._entry_volume(payload, "auto", 0.0, 2_000.0)
    assert poor < rich, "a replay in drawdown kept trading the same size"


def test_the_replay_still_obeys_a_fixed_lot():
    from aurion.backtest.engine import Backtester

    bt = Backtester()
    payload = {"action": "buy", "volume": 0.10, "confidence": 0.95}
    assert bt._entry_volume(payload, "manual", 1.5, RICH) == 1.5


def test_the_built_in_strategies_all_report_something_to_size_from():
    """If a shipped strategy published no confidence, auto would quietly
    stay the constant it was for that strategy."""
    import inspect

    from aurion.strategy.builtin import atr_breakout, ema_rsi, price_action, smart_money

    for mod in (atr_breakout, ema_rsi, price_action, smart_money):
        src = inspect.getsource(mod)
        assert "confidence=" in src, f"{mod.__name__} names no confidence on its signals"
