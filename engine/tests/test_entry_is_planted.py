"""Every shipping strategy must give the entry planner what it needs.

The bug this guards against was invisible from the outside. `plan_entry`
reads `extra["atr"]` off the signal to work out what "a better price"
even means, and returns None without it. None is not an error - it is the
documented "just take the market" answer - so a strategy that forgot to
publish an ATR did not fail, it silently stopped ever planting an entry
point. Only one strategy ever set `extra`, and it has since been removed,
which would have left the whole auto-entry feature as dead code that
looked like it was working.

So the test is not "auto entry works". It is: every built-in strategy
publishes the fields the planner needs, and the planner really does
produce a resting order from them.
"""

from __future__ import annotations

import math
import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from aurion.runtime.auto_entry import plan_entry  # noqa: E402
from aurion.strategy.base import StrategyContext  # noqa: E402
from aurion.strategy.loader import BUILTIN_NAMES, StrategyLoader  # noqa: E402

from _market import textbook  # noqa: E402


def _series(seed: int = 7, bars: int = 400) -> list[dict]:
    """A trending, breathing series - enough shape that each strategy fires."""
    rnd = random.Random(seed)
    rows: list[dict] = []
    price = 1.1000
    for i in range(bars):
        drift = 0.00018 * math.sin(i / 55.0) + 0.00004
        open_ = price
        price = max(1e-4, price * (1 + drift + rnd.gauss(0, 0.0012)))
        high = max(open_, price) * (1 + abs(rnd.gauss(0, 0.0007)))
        low = min(open_, price) * (1 - abs(rnd.gauss(0, 0.0007)))
        rows.append({
            "time": 1700000000 + i * 900,
            "open": open_, "high": high, "low": low, "close": price, "volume": 100 + i,
        })
    return rows


def _first_signal(name: str):
    """Walk a series until the strategy says something, like the robot does.

    Two series, tried in order. The breathing random walk above suits the
    indicator strategies, which fire somewhere in any reasonable market.
    It does not suit a strategy that waits for a specific sequence of
    events: ``smart_money`` wants liquidity swept, then a displacement,
    then a retrace into the imbalance, and a Gaussian walk essentially
    never produces all three in order. Standing aside on that series is
    correct behaviour, not a missing signal, so the hand-built setup in
    ``_market.textbook`` is the fallback rather than a reason to exempt
    the strategy from this file's guarantee.
    """
    inst = StrategyLoader().load_builtin(name)
    for rows, start in ((_series(), 120), (textbook("buy"), 400)):
        for end in range(start, len(rows) + 1):
            ctx = StrategyContext("EURUSD", "M15", rows[:end], None, {}, [], [], {}, {}, "now")
            sig = inst.on_candle(ctx)
            if sig is not None and sig.action in ("buy", "sell"):
                return sig
    return None


def test_every_builtin_fires_at_least_once_on_this_series() -> None:
    """If a strategy never speaks here, the tests below prove nothing."""
    for name in BUILTIN_NAMES:
        assert _first_signal(name) is not None, f"{name} produced no signal to test"


def test_every_signal_carries_the_atr_the_planner_measures_with() -> None:
    """The exact field whose absence silently disabled the feature."""
    for name in BUILTIN_NAMES:
        sig = _first_signal(name)
        extra = getattr(sig, "extra", None)
        assert isinstance(extra, dict) and extra, f"{name} published no extra at all"
        atr = float(extra.get("atr") or 0)
        assert atr > 0, f"{name} published no usable atr - entries will fall back to market"


def test_the_planner_actually_rests_an_order_for_every_builtin() -> None:
    """End to end: signal -> plan -> a real pending order, not a market one.

    Asserting on `extra` alone would pass if the planner rejected the
    numbers for some other reason, so this runs the thing itself.
    """
    for name in BUILTIN_NAMES:
        sig = _first_signal(name)
        price = float(sig.extra.get("entry") or 0) or 1.1
        spread = price * 0.00005
        plan = plan_entry(
            sig.action, price - spread, price + spread,
            float(sig.sl or 0), float(sig.tp or 0), sig.extra,
        )
        assert plan is not None, f"{name} still degrades to a market order"
        assert plan["order_type"] in {"buy_limit", "sell_limit", "buy_stop", "sell_stop"}, \
            f"{name} planned {plan['order_type']}, which is not a resting order"
        assert float(plan["price"]) > 0
        assert plan["why"], f"{name} planted an order it cannot explain"


def test_a_published_zone_is_a_real_level_not_a_placeholder() -> None:
    """A made-up zone would be worse than none: it moves real money.

    A zone is only honest if the strategy had an actual level in hand, so
    where one is published it has to bracket a price the strategy saw -
    never a constant and never inverted.
    """
    for name in BUILTIN_NAMES:
        sig = _first_signal(name)
        zone = sig.extra.get("zone")
        if zone is None:
            continue  # legitimate: no structural level on that setup
        low = float(zone["low"] if isinstance(zone, dict) else zone[1])
        high = float(zone["high"] if isinstance(zone, dict) else zone[0])
        assert high >= low > 0, f"{name} published an inverted or empty zone"
        entry = float(sig.extra.get("entry") or 0)
        assert low <= entry <= high or math.isclose(low, high), \
            f"{name}'s zone does not contain the price it traded from"


def test_the_withdrawn_strategy_is_not_what_makes_this_pass() -> None:
    """King was the only strategy that ever worked, and it is gone."""
    assert "king" not in BUILTIN_NAMES
    assert BUILTIN_NAMES, "something must still ship"
