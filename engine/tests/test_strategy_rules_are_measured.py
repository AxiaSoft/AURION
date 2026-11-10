"""The rules that were changed on evidence, and the evidence with them.

Item 9 from the desk was three complaints in one sentence: strong
signals that never become orders, signals that make no sense, and
"make the strategies better". The measurable half of it came down to
two defects and one habit, and this file guards all three so none of
them can quietly come back.

  * ``swing_levels`` measured its window up to and including the bar
    being traded. So "the pattern is at support" was true exactly when
    price was *making* a new low — a level that is breaking, not one
    that has held — and price_action bought it. ``skip`` is what makes
    the function mean what its callers assume.

  * price_action read the trend from a 50/200 EMA pair, which on M15
    has no opinion about the last twenty bars. The level gate and the
    trend gate were answering about two different markets.

  * ema_rsi closes on an opposite cross. That is nearly half its exits
    at about -0.44R each. Measured, keeping it is still the right call
    for total return, so it stays on — but behind a switch, with the
    numbers written down, so the next person does not have to guess.

Every number quoted below comes from scripts/strategy-xray.py over five
instruments and 2 200 M15 bars, with the AI frozen so only the rules
move, split into six tuning seeds and eight seeds that were never tuned
on. Spread and commission are not modelled.

    python3 -m pytest engine/tests/test_strategy_rules_are_measured.py
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "engine"))

from aurion.strategy.builtin._confluence import risk_levels, swing_levels  # noqa: E402
from aurion.strategy.builtin.atr_breakout import ATRBreakout  # noqa: E402
from aurion.strategy.builtin.ema_rsi import EmaRsi  # noqa: E402
from aurion.strategy.builtin.price_action import PriceAction  # noqa: E402

BUILTIN = ROOT / "engine" / "aurion" / "strategy" / "builtin"


def _frame(lows: list[float]) -> pd.DataFrame:
    return pd.DataFrame({
        "open": lows,
        "high": [v + 1 for v in lows],
        "low": lows,
        "close": lows,
    })


# ------------------------------------------------------------ swing_levels


def test_a_level_that_is_breaking_is_not_a_level_that_held() -> None:
    """The defect, stated as arithmetic.

    The last bar makes the lowest low in the window. With no skip the
    answer is that bar, so "price is at support" is true at the exact
    moment support is failing. With four bars skipped the answer is the
    low that existed before, which is the one a trader means.
    """
    frame = _frame([10, 9, 8, 11, 12, 13, 14, 7])
    assert swing_levels(frame, 8, 0)[1] == 7.0
    assert swing_levels(frame, 8, 4)[1] == 8.0, \
        "skip must drop the newest bars before measuring, not after"


def test_skip_defaults_to_the_old_behaviour() -> None:
    frame = _frame([10, 9, 8, 11, 12, 13, 14, 7])
    assert swing_levels(frame, 8) == swing_levels(frame, 8, 0)


def test_skip_cannot_empty_the_window() -> None:
    """A short chart must still get an answer rather than an exception."""
    frame = _frame([10, 9, 8])
    high, low = swing_levels(frame, 20, 50)
    assert low == 8.0 and high == 11.0


# ------------------------------------------------------------ risk_levels


def test_the_stop_geometry_is_adjustable_and_unchanged_by_default() -> None:
    """buffer/floor/ceiling were literals; naming them must change nothing."""
    args = ("buy", 100.0, 1.0, 1.4, 2.2, 1.4, (120.0, 99.0))
    assert risk_levels(*args) == risk_levels(*args, buffer_atr=0.15, floor=0.6, ceiling=1.8)


def test_a_wider_buffer_really_does_move_the_stop() -> None:
    sl_tight, _ = risk_levels("buy", 100.0, 1.0, 1.4, 2.2, 1.4, (120.0, 99.0), buffer_atr=0.15)
    sl_wide, _ = risk_levels("buy", 100.0, 1.0, 1.4, 2.2, 1.4, (120.0, 99.0), buffer_atr=0.9)
    assert sl_wide < sl_tight, "more air beyond the swing means a lower stop on a long"


def test_the_floor_is_why_sl_atr_looked_inert() -> None:
    """Entering at the level pins the risk to the floor, so sl_atr stops
    doing anything visible. That is the behaviour, and it is on purpose —
    this test exists so nobody rediscovers it as a bug."""
    near = (120.0, 99.95)      # price is practically on the level
    sl_a, _ = risk_levels("buy", 100.0, 1.0, 1.4, 2.2, 1.4, near)
    sl_b, _ = risk_levels("buy", 100.0, 1.0, 2.8, 2.2, 1.4, near)
    assert sl_a != sl_b, "doubling sl_atr must still move the floor it is multiplied by"
    assert round(100.0 - sl_a, 6) == round(1.4 * 0.6, 6)


# ----------------------------------------------------------- price_action


def test_price_action_ships_the_arms_that_helped_both_samples() -> None:
    p = PriceAction().params
    assert p["level_skip"] == 4, "the level has to be one that already held"
    assert p["trend_fast"] == 21 and p["trend_slow"] == 55, \
        "the trend must be read at the scale the level is measured on"
    assert p["counter_trend_block"] == 0.2


def test_the_defaults_carry_the_measurement_that_justifies_them() -> None:
    """A changed default without a number beside it is a preference."""
    src = (BUILTIN / "price_action.py").read_text(encoding="utf-8")
    for needle in ("-0.196R", "-0.163R", "-0.146R", "-0.152R", "-0.099R"):
        assert needle in src, f"the comment lost {needle}"


def test_price_action_does_not_claim_an_edge_it_does_not_have() -> None:
    ev = PriceAction().evidence
    assert ev["state"] == "negative"
    assert float(ev["expectancy"]) < 0
    assert "not modelled" in ev["basis"]


def test_the_other_two_carry_their_own_numbers() -> None:
    for cls in (EmaRsi, ATRBreakout):
        ev = cls().evidence
        assert ev["state"] == "measured", cls.__name__
        assert float(ev["expectancy"]) > 0, cls.__name__
        assert int(ev["trades"]) > 1000, cls.__name__


def test_every_builtin_answers_the_question_at_all() -> None:
    """An uploaded strategy inherits "unmeasured", which is the truth."""
    for cls in (EmaRsi, ATRBreakout, PriceAction):
        desc = cls().describe()
        assert desc["evidence"]["state"] in {"measured", "negative", "unmeasured"}


# ----------------------------------------------------------------- ema_rsi


class _Ctx:
    def __init__(self, frame: pd.DataFrame, position: dict | None) -> None:
        self.symbol = "EURUSD"
        self.timeframe = "M15"
        self.candles = frame.to_dict("records")
        self.ai = {}
        self._pos = position

    def position(self):  # noqa: ANN201
        return self._pos


def _crossing_down_frame() -> pd.DataFrame:
    """A long rise then a sharp drop: the fast EMA crosses under the slow."""
    rows = [1.0 + 0.004 * i for i in range(90)] + [1.36 - 0.012 * i for i in range(1, 16)]
    return pd.DataFrame({
        "time": list(range(len(rows))),
        "open": rows,
        "high": [v + 0.001 for v in rows],
        "low": [v - 0.001 for v in rows],
        "close": rows,
        "volume": [1] * len(rows),
    })


def _flip_signal(flip: bool):  # noqa: ANN201
    st = EmaRsi()
    st.params = {**EmaRsi.params, "flip_on_cross": flip}
    frame = _crossing_down_frame()
    held = {"type": "buy", "volume": 0.1}
    # Walk forward until the cross lands, so the test does not depend on
    # guessing which bar it happens on.
    for end in range(60, len(frame) + 1):
        sig = st.on_candle(_Ctx(frame.iloc[:end], held))
        if sig is not None and getattr(sig, "action", "") == "close":
            return sig
    return None


def test_the_flip_is_on_by_default_because_the_measurement_says_so() -> None:
    assert EmaRsi.params["flip_on_cross"] is True
    sig = _flip_signal(True)
    assert sig is not None, "an opposite cross against an open buy must still close it"
    assert "flip to short" in str(getattr(sig, "reason", ""))


def test_the_flip_can_be_switched_off() -> None:
    assert _flip_signal(False) is None, \
        "with the switch off the trade is left to its stop and its target"


def test_the_switch_carries_the_numbers_that_decided_the_default() -> None:
    src = (BUILTIN / "ema_rsi.py").read_text(encoding="utf-8")
    block = src[src.index('"flip_on_cross"') - 1600:src.index('"flip_on_cross"')]
    assert "+0.333R" in block and "+0.368R" in block, "the per-trade figures"
    assert re.search(r"\+555R|\+530R", block), "and the totals that outvoted them"


if __name__ == "__main__":  # pragma: no cover
    import pytest

    raise SystemExit(pytest.main([__file__, "-q"]))
