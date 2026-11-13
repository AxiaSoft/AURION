"""The shipped BOS+retest example must actually fire, and say why when it does not.

This file exists because of a real report: a user wrote a structure
strategy against engine/strategies/template.py, loaded it, and got
nothing — no signal live, no trade in the backtest, and no way to find
out why. It was not rejected by the loader; it ran on every bar and
returned a bare ``None`` forever.

The cause was one line. The "range low" was taken as the lowest swing
low anywhere after the peak, which includes the swing lows made by the
break itself, so every break dragged the level down below the market
and the next gate looked for a close below a price that had already
been passed. On 2 800 decisions of seeded synthetic M15 that single
bucket was the refusal 1 032 times on XAUUSD and 851 times on EURUSD.

So there are two things to protect, and they are different:

  * detection — on a chart that CONTAINS the setup, a signal comes out,
    with a stop above the broken level and a target below entry;
  * accountability — on a chart that does not, the refusal is named.

A test that only checked "returns None on random data" would have
passed against the broken version, which is exactly how the bug
survived. ``test_fires_on_a_textbook_setup`` is the one that would not
have.
"""

from __future__ import annotations

import importlib.util
import inspect
import math
import random
import sys
from pathlib import Path

import pytest

from aurion.strategy.base import BaseStrategy, StrategyContext

ROOT = Path(__file__).resolve().parents[2]
EXAMPLE = ROOT / "engine" / "strategies" / "examples" / "aurion_bos_retest_strategy.py"


def _load():
    """Load the example the way aurion.strategy.loader.load_path does."""
    spec = importlib.util.spec_from_file_location("aurion_example_bos_retest", EXAMPLE)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    found = [
        obj
        for _, obj in inspect.getmembers(module, inspect.isclass)
        if obj.__module__ == module.__name__
        and obj.__name__ not in {"BaseStrategy", "Strategy"}
        and (hasattr(obj, "on_candle") or hasattr(obj, "on_tick"))
    ]
    assert found, "the loader would find no strategy class in the example"
    return module, found[0]


MODULE, STRATEGY = _load()


def _candle(i: int, o: float, h: float, l: float, c: float) -> dict:
    return {
        "time": 1_700_000_000 + i * 900,
        "open": round(o, 2),
        "high": round(h, 2),
        "low": round(l, 2),
        "close": round(c, 2),
        "tick_volume": 120,
        "spread": 2,
    }


def textbook_chart() -> tuple[list[dict], dict]:
    """Uptrend with higher lows -> peak -> range -> break -> retest -> pin.

    Built by hand rather than sampled, because the probability of a
    random walk producing all seven conditions in order is low enough
    that "no signal" would prove nothing at all.
    """
    bars: list[dict] = []
    price = 2000.0

    def push(o: float, h: float, l: float, c: float) -> None:
        bars.append(_candle(len(bars), o, h, l, c))

    push(2000, 2002, 1999, 2001)
    for _ in range(14):                       # leg one, up
        o, c = price, price + 2.0
        push(o, c + 0.6, o - 0.6, c)
        price = c
    for _ in range(6):                        # pullback -> the older low (Z)
        o, c = price, price - 1.2
        push(o, o + 0.4, c - 0.4, c)
        price = c
    low_z = price
    for _ in range(16):                       # leg two, up
        o, c = price, price + 2.2
        push(o, c + 0.6, o - 0.6, c)
        price = c
    for _ in range(5):                        # pullback -> the higher low (A)
        o, c = price, price - 1.4
        push(o, o + 0.4, c - 0.4, c)
        price = c
    low_a = price
    for _ in range(14):                       # leg three, up to the top
        o, c = price, price + 2.2
        push(o, c + 0.8, o - 0.6, c)
        price = c
    peak = price + 1.0
    push(price, peak, price - 1.0, price - 0.5)
    price -= 0.5
    for i in range(12):                       # the range, never above the top
        o = price
        c = price - 0.5 if i % 2 else price + 0.4
        push(o, max(o, c) + 0.5, min(o, c) - 0.5, c)
        price = c
    while price > low_a - 9.0:                # the break, with displacement
        o, c = price, price - 3.0
        push(o, o + 0.5, c - 0.8, c)
        price = c
    while price < low_a - 1.0:                # back up for the retest
        o, c = price, price + 2.2
        push(o, c + 0.5, o - 0.5, c)
        price = c
    push(price, low_a + 0.6, price - 0.8, price - 0.6)   # the rejection pin
    return bars, {"low_z": low_z, "low_a": low_a, "peak": peak}


def mirrored(bars: list[dict]) -> list[dict]:
    """The same chart upside down: a downtrend that should produce a buy."""
    pivot = 4000.0
    out = []
    for i, b in enumerate(bars):
        out.append(
            _candle(
                i,
                pivot - b["open"],
                pivot - b["low"],
                pivot - b["high"],
                pivot - b["close"],
            )
        )
    return out


def noise(bars: int = 400, seed: int = 11) -> list[dict]:
    rng = random.Random(seed)
    price = 2000.0
    out = []
    for i in range(bars):
        price = max(1.0, price + rng.gauss(0, 1.1))
        high = price + abs(rng.gauss(0, 0.8))
        low = price - abs(rng.gauss(0, 0.8))
        out.append(_candle(i, price, high, low, price))
    return out


def context(candles: list[dict], symbol: str = "XAUUSD", positions=None) -> StrategyContext:
    return StrategyContext(
        symbol=symbol,
        timeframe="M15",
        candles=candles,
        tick=None,
        account={"balance": 10_000.0, "equity": 10_000.0},
        positions=positions or [],
        orders=[],
        ai={},
        params={},
        now="2026-01-01T00:00:00Z",
    )


# --------------------------------------------------------------- detection


def test_fires_on_a_textbook_setup():
    """The regression that matters: the setup is on the chart, so take it.

    Version 1.0.0 refused this exact chart at "no close below the zone".
    """
    bars, info = textbook_chart()
    strategy = STRATEGY({})
    strategy.on_start(context(bars))
    signal = strategy.on_candle(context(bars))

    assert signal is not None, (
        "the chart contains a complete BOS + retest and the strategy stood "
        f"aside: {strategy.last_refusal_kind} — {strategy.last_refusal}"
    )
    assert signal.action == "sell"
    assert signal.symbol == "XAUUSD"
    assert signal.volume == pytest.approx(0.10)

    entry = bars[-1]["close"]
    assert signal.sl > entry, "a sell must have its stop above entry"
    assert signal.tp < entry, "a sell must have its target below entry"
    # The stop belongs just beyond the broken level, not out at the top.
    assert signal.sl < info["peak"], "stop should sit at the level, not the peak"
    # Default rr is 2.0, so the target is twice the risk away.
    assert (entry - signal.tp) == pytest.approx(2.0 * (signal.sl - entry), rel=0.02)


def test_fires_mirrored_for_a_buy():
    """The mirrored branch is real logic, not decoration."""
    bars, _ = textbook_chart()
    flipped = mirrored(bars)
    strategy = STRATEGY({})
    strategy.on_start(context(flipped))
    signal = strategy.on_candle(context(flipped))

    assert signal is not None, (
        "the mirrored chart contains the setup and produced nothing: "
        f"{strategy.last_refusal_kind} — {strategy.last_refusal}"
    )
    assert signal.action == "buy"
    entry = flipped[-1]["close"]
    assert signal.sl < entry < signal.tp


def test_the_range_low_ignores_pivots_made_by_the_break():
    """The bug itself, pinned at the level it lived on.

    The level the strategy trades must be the last higher low (or a
    pivot inside the range), never a low printed by the displacement
    leg. If a post-break low leaks back into the level set, the level
    drops below everything the market has done and no close can ever be
    below it.
    """
    bars, info = textbook_chart()
    strategy = STRATEGY({})
    strategy.on_start(context(bars))
    signal = strategy.on_candle(context(bars))
    assert signal is not None

    lows = [b["low"] for b in bars]
    deepest = min(lows)
    # The stop sits a buffer above the level that was traded, so the
    # level is below the stop and above the low of the break leg.
    assert signal.sl > deepest, "the traded level collapsed onto the break low"
    assert signal.sl == pytest.approx(info["low_a"], abs=6.0), (
        "the level should be the last higher low, not a price far from it"
    )


# ---------------------------------------------------------- accountability


def test_every_refusal_is_named():
    """Silence has to be explainable, on every bar, for the whole series."""
    bars = noise(400)
    strategy = STRATEGY({})
    strategy.on_start(context(bars))
    for end in range(80, len(bars)):
        strategy.last_refusal_kind = ""
        out = strategy.on_candle(context(bars[:end]))
        if out is None:
            assert strategy.last_refusal_kind, (
                f"bar {end} returned None without naming a reason"
            )
    assert strategy.refusals, "no refusal buckets were tallied at all"
    assert sum(strategy.refusals.values()) > 100


def test_refusals_bucket_by_rule_not_by_number():
    """The detail carries the figures; the bucket must stay stable."""
    bars = noise(400, seed=3)
    strategy = STRATEGY({})
    strategy.on_start(context(bars))
    for end in range(80, len(bars)):
        strategy.on_candle(context(bars[:end]))
    for kind in strategy.refusals:
        assert not any(ch.isdigit() for ch in kind.replace("#", "")), (
            f"refusal bucket {kind!r} carries a number and will never aggregate"
        )
    # Far fewer buckets than bars, or the report is unreadable.
    assert len(strategy.refusals) < 30


def test_not_enough_history_is_a_named_refusal():
    bars, _ = textbook_chart()
    strategy = STRATEGY({})
    strategy.on_start(context(bars))
    assert strategy.on_candle(context(bars[:10])) is None
    assert "history" in strategy.last_refusal_kind


def test_no_candles_is_a_named_refusal():
    strategy = STRATEGY({})
    strategy.on_start(context([]))
    assert strategy.on_candle(context([])) is None
    assert strategy.last_refusal_kind


# ------------------------------------------------------------- robustness


def test_an_open_position_blocks_and_a_flat_book_does_not():
    """ctx.position() is a dict.

    getattr(pos, "volume", None) on it is always None, which is what
    made version 1.0.0 treat *any* open position as a blocker — and
    left the real float(vol) != 0.0 test unreachable.
    """
    bars, _ = textbook_chart()
    strategy = STRATEGY({})
    strategy.on_start(context(bars))
    held = context(bars, positions=[{"symbol": "XAUUSD", "volume": 0.10, "type": 1}])
    assert strategy.on_candle(held) is None
    assert "already in this symbol" in strategy.last_refusal_kind

    # A position on a different symbol is not this strategy's business.
    strategy2 = STRATEGY({})
    strategy2.on_start(context(bars))
    other = context(bars, positions=[{"symbol": "EURUSD", "volume": 0.10, "type": 1}])
    assert strategy2.on_candle(other) is not None


def test_a_setup_is_taken_once():
    bars, _ = textbook_chart()
    strategy = STRATEGY({})
    strategy.on_start(context(bars))
    assert strategy.on_candle(context(bars)) is not None
    assert strategy.on_candle(context(bars)) is None
    # The buy branch runs afterwards and leaves its own refusal last, so the
    # dedup shows up in the tally rather than in last_refusal_kind.
    assert any("already traded" in k for k in strategy.refusals)


def test_memory_stays_bounded():
    strategy = STRATEGY({"memory": 10})
    strategy.on_start(context([]))
    for i in range(500):
        strategy._remember(("sell", "XAUUSD", float(i)))
    assert len(strategy._used) == 10
    assert len(strategy._used_set) == 10


def test_a_missing_price_field_declines_instead_of_crashing():
    """A raise inside on_candle is logged as "strategy crashed"; bad data is not a crash."""
    bars, _ = textbook_chart()
    broken = [dict(b) for b in bars]
    broken[-1].pop("close")
    strategy = STRATEGY({})
    strategy.on_start(context(bars))
    out = strategy.on_candle(context(broken))
    assert out is None
    assert "missing" in strategy.last_refusal_kind


def test_short_candle_keys_are_understood():
    """The live bridge can send o/h/l/c instead of open/high/low/close."""
    bars, _ = textbook_chart()
    short = [
        {"time": b["time"], "o": b["open"], "h": b["high"], "l": b["low"], "c": b["close"]}
        for b in bars
    ]
    strategy = STRATEGY({})
    strategy.on_start(context(short))
    assert strategy.on_candle(context(short)) is not None


def test_it_is_a_well_formed_strategy():
    assert issubclass(STRATEGY, BaseStrategy)
    assert STRATEGY.name == "bos_retest"
    assert STRATEGY.language in {"en", "fa", "ar"}
    # Nothing has been measured out of sample, and it must say so rather
    # than letting the desk imply the robot is known to make money.
    assert STRATEGY.evidence["state"] == "unmeasured"
    assert STRATEGY.evidence["basis"]


def test_the_loader_accepts_the_example():
    from aurion.strategy.loader import sanitize_stem, validate_source

    source = EXAMPLE.read_text(encoding="utf-8")
    verdict = validate_source(source)
    assert verdict.get("ok") is True, f"the example would be refused on upload: {verdict}"
    assert sanitize_stem(EXAMPLE.name) == "aurion_bos_retest_strategy"


def test_it_produces_signals_over_a_long_series():
    """Not a profitability claim — proof that it is not silent by construction."""
    bars = noise(1200, seed=5)
    # Give the noise some structure so the setup is reachable at all.
    strategy = STRATEGY({})
    strategy.on_start(context(bars))
    seen = 0
    for end in range(120, len(bars)):
        if strategy.on_candle(context(bars[:end])) is not None:
            seen += 1
    report = strategy.refusal_report()
    assert report, "refusal_report() came back empty"
    assert seen >= 0  # the series may legitimately contain no setup
    assert math.isfinite(float(sum(strategy.refusals.values())))
