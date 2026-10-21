"""The market-structure reads: swings, breaks, gaps, blocks and liquidity.

These were written for King, which has since been withdrawn. They stay
because the module they test did not go with it - price_action builds on
the same reads - and deleting a strategy is no reason to stop checking the
arithmetic underneath it.

Hand-built price series rather than random ones wherever a specific shape is
under test: a random walk that happens to contain a fair-value gap proves
nothing about whether fair-value gaps are detected.
"""

from __future__ import annotations

import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from aurion.ai.features import candles_to_frame  # noqa: E402
from aurion.strategy.base import StrategyContext  # noqa: E402
from aurion.strategy.builtin._structure import (  # noqa: E402
    fair_value_gaps,
    liquidity_target,
    order_block,
    resample,
    structure_state,
    swings,
)
from aurion.strategy.loader import (  # noqa: E402
    BUILTIN_NAMES,
    LEGACY_BUILTINS,
    RESERVED_NAMES,
    resolve_builtin,
)


# ---------------------------------------------------------------------- data


def _bar(o: float, h: float, l: float, c: float) -> dict:
    return {"open": o, "high": h, "low": l, "close": c, "volume": 100}


def _frame(rows: list[dict]):
    return candles_to_frame(rows)


def _walk(seed: int = 3, bars: int = 1200, vol: float = 0.0012) -> list[dict]:
    """A market with regimes, so both directions and both outcomes appear."""
    rnd = random.Random(seed)
    price, rows, drift, left = 1.1, [], 0.0, 0
    for _ in range(bars):
        if left <= 0:
            drift = rnd.choice([0.0010, -0.0010, 0.0, 0.0004, -0.0004])
            left = rnd.randint(40, 120)
        left -= 1
        open_ = price
        price = max(1e-4, price * (1 + drift + rnd.gauss(0, vol)))
        high = max(open_, price) * (1 + abs(rnd.gauss(0, vol * 0.6)))
        low = min(open_, price) * (1 - abs(rnd.gauss(0, vol * 0.6)))
        rows.append(_bar(open_, high, low, price))
    return rows


def _ctx(rows: list[dict], positions: list[dict] | None = None) -> StrategyContext:
    return StrategyContext("EURUSD", "M15", rows, None, {}, positions or [], [], {}, {}, "now")


# ----------------------------------------------------------------- resample


def test_resample_anchors_on_the_newest_bar() -> None:
    """The last aggregated candle must close on the last real bar.

    Anything else and the higher-timeframe read is of a candle that has not
    finished forming, which is the flicker this is designed to avoid.
    """
    rows = [_bar(i, i + 2, i - 1, i + 1.0) for i in range(1, 51)]
    out = resample(_frame(rows), 4)
    assert float(out["close"].iloc[-1]) == float(rows[-1]["close"])
    assert len(out) == 50 // 4
    # And each candle really is the aggregate of its group.
    assert float(out["high"].iloc[-1]) == max(r["high"] for r in rows[-4:])
    assert float(out["low"].iloc[-1]) == min(r["low"] for r in rows[-4:])


def test_resample_declines_when_there_is_nothing_to_aggregate() -> None:
    rows = [_bar(1, 2, 0, 1.5)] * 6
    assert len(resample(_frame(rows), 4)) == 6


# ------------------------------------------------------------------- swings


def test_swings_never_report_an_unconfirmed_pivot() -> None:
    """The last k bars cannot be pivots. A pivot that repaints is a lie."""
    rows = [_bar(1, 1 + i % 5, 1 - i % 3, 1.0) for i in range(40)]
    k = 3
    found = swings(_frame(rows), k)
    assert found, "no pivots at all on 40 bars"
    assert max(s.index for s in found) <= len(rows) - 1 - k


# ---------------------------------------------------------------- structure


def _bullish_break() -> list[dict]:
    """Up, pivot high, pull back, then close above the pivot."""
    rows = [_bar(10 + i * 0.1, 10.3 + i * 0.1, 9.9 + i * 0.1, 10.2 + i * 0.1) for i in range(12)]
    rows += [_bar(11.4, 11.6, 11.3, 11.5)]                      # the pivot high
    rows += [_bar(11.4 - i * 0.1, 11.5 - i * 0.1, 11.2 - i * 0.1, 11.3 - i * 0.1) for i in range(8)]
    rows += [_bar(10.6 + i * 0.15, 10.9 + i * 0.15, 10.5 + i * 0.15, 10.8 + i * 0.15) for i in range(8)]
    rows += [_bar(12.0, 12.4, 11.9, 12.3)]                      # closes above 11.6
    return rows


def test_structure_reports_the_break_and_keeps_the_bias() -> None:
    """The bias has to survive the pullback that follows the break.

    A read that only speaks on the breaking bar is useless to a strategy that
    enters on the retracement: by the time it speaks, price is at the extreme.
    """
    rows = _bullish_break()
    state = structure_state(_frame(rows), 2)
    assert state.bias == "bull", state.note
    assert state.broke_index >= 0

    # Three quiet bars later, well off the high, the bias must still be bull.
    rows += [_bar(12.2, 12.25, 11.95, 12.0), _bar(12.0, 12.05, 11.8, 11.85), _bar(11.85, 11.9, 11.7, 11.75)]
    later = structure_state(_frame(rows), 2)
    assert later.bias == "bull", later.note
    assert later.bars_since_break >= 3


def test_an_intrabar_poke_is_not_a_break() -> None:
    """Wicking through a swing is a liquidity grab, not a change of control."""
    rows = _bullish_break()[:-1]
    before = structure_state(_frame(rows), 2)
    # A bar whose high clears the pivot but whose close does not.
    rows.append(_bar(11.0, 12.5, 10.9, 11.1))
    after = structure_state(_frame(rows), 2)
    assert after.bias == before.bias, "a wick moved the bias"


def test_equilibrium_measures_retracement_not_position_in_a_box() -> None:
    state = structure_state(_frame(_bullish_break()), 2)
    assert state.has_range
    assert state.equilibrium(state.range_low) == 0.0
    assert state.equilibrium(state.range_high) == 1.0
    mid = (state.range_low + state.range_high) / 2
    assert abs(state.equilibrium(mid) - 0.5) < 1e-9


# ----------------------------------------------------------------- imbalance


def test_fair_value_gap_is_found_and_then_forgotten_once_filled() -> None:
    """Bar 1's high below bar 3's low is the gap; trading back through closes it."""
    rows = [
        _bar(10.0, 10.2, 9.9, 10.1),
        _bar(10.1, 11.0, 10.1, 10.9),   # the displacement bar
        _bar(11.0, 11.4, 10.6, 11.2),   # low 10.6 > bar-1 high 10.2  -> gap 10.2..10.6
        _bar(11.2, 11.3, 11.0, 11.1),
    ]
    gaps = fair_value_gaps(_frame(rows), "buy", 30)
    assert gaps, "the gap was not seen"
    assert abs(gaps[-1].low - 10.2) < 1e-9 and abs(gaps[-1].high - 10.6) < 1e-9

    # Now trade straight through it.
    rows.append(_bar(11.1, 11.2, 10.0, 10.05))
    assert not fair_value_gaps(_frame(rows), "buy", 30), "a filled gap is still being offered"


def test_order_block_is_the_last_opposing_candle() -> None:
    rows = [
        _bar(10.0, 10.1, 9.8, 9.85),    # down candle - the bullish order block
        _bar(9.85, 10.6, 9.85, 10.5),
        _bar(10.5, 11.0, 10.4, 10.9),
    ]
    block = order_block(_frame(rows), "buy", 20)
    assert block is not None
    assert abs(block.low - 9.8) < 1e-9 and abs(block.high - 10.1) < 1e-9


def test_liquidity_target_is_the_nearest_pool_not_the_furthest() -> None:
    rows = _bullish_break()
    frame = _frame(rows)
    entry = float(frame["close"].iloc[-1]) - 2.0
    pool = liquidity_target(frame, "buy", entry, 2)
    if pool:
        higher = [s.price for s in swings(frame, 2) if s.kind == "high" and s.price > entry]
        assert abs(pool - min(higher)) < 1e-9

# ------------------------------------------------------------------ retirement


def test_the_withdrawn_strategies_resolve_instead_of_raising() -> None:
    """An upgrade must not greet a trader with 'unknown builtin strategy'.

    King was withdrawn, and scalp_impulse before it. Saved runtime state,
    a trader's own config and the comment on any position either opened
    all still carry the old name, so both have to resolve to something
    that exists rather than stopping the engine on the first boot after
    the update.
    """
    assert "king" not in BUILTIN_NAMES
    assert "scalp_impulse" not in BUILTIN_NAMES
    assert resolve_builtin("king") == "price_action"
    assert resolve_builtin("scalp_impulse") == "price_action"
    # And nobody may upload a file that reclaims a retired name.
    assert "king" in RESERVED_NAMES
    assert "scalp_impulse" in RESERVED_NAMES


def test_the_surviving_builtins_are_the_three_that_ship() -> None:
    assert set(BUILTIN_NAMES) == {"ema_rsi", "price_action", "atr_breakout"}
    assert LEGACY_BUILTINS["king"] in BUILTIN_NAMES
