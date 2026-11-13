"""The ICT liquidity-sweep / fair-value-gap example must keep working.

Written to be handed to a customer and dropped straight onto a desk, so
"it loads" is not enough: a strategy that loads and returns None forever
is exactly the failure this example exists to demonstrate the cure for.

These tests therefore check behaviour on a chart built to contain the
setup, not on random data. Random bars rarely contain a real pattern, so
"it returned None" there proves nothing at all - which is trap 4 at the
top of template.py, and the reason the previous example shipped broken.

What is pinned:
  * it fires on a hand-built sell setup, and on the mirrored buy;
  * the stop and target land on the correct sides with the asked-for R;
  * the four template traps are genuinely avoided (decline everywhere,
    dict positions, both candle key styles, no crash on bad data);
  * one setup produces one signal;
  * it passes validate_source, so it can actually be uploaded.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from aurion.strategy.base import StrategyContext
from aurion.strategy.loader import StrategyLoader, validate_source

EXAMPLE = (
    Path(__file__).resolve().parents[1]
    / "strategies"
    / "examples"
    / "aurion_ict_fvg_sweep.py"
)


def _bar(o, h, l, c):
    return {"open": o, "high": h, "low": l, "close": c}


@pytest.fixture()
def strat(tmp_path, monkeypatch):
    """The example, loaded the way the engine loads an upload."""
    loader = StrategyLoader.__new__(StrategyLoader)
    loader.dir = tmp_path / "strategies"
    loader.dir.mkdir(parents=True)
    loader.vault = tmp_path / "vault"
    loader.loaded = {}
    return loader.load_path(EXAMPLE, {})


def _ctx(bars, symbol="XAUUSD", positions=None):
    return StrategyContext(
        symbol=symbol,
        timeframe="M15",
        candles=bars,
        tick=None,
        account={"equity": 10_000.0},
        positions=positions or [],
        orders=[],
        ai={},
        params={},
        now="2026-01-01T00:00:00Z",
    )


def _sell_chart():
    """A textbook bearish setup: swing high, sweep, displacement, gap, retrace."""
    bars = []
    px = 99.0
    for _ in range(60):
        px += 0.02
        bars.append(_bar(px, px + 0.25, px - 0.25, px + 0.01))
    base = bars[-1]["close"]
    bars.append(_bar(base, base + 0.3, base - 0.3, base + 0.2))
    bars.append(_bar(base + 0.2, base + 0.4, base - 0.1, base + 0.3))
    peak_open = base + 0.3
    bars.append(_bar(peak_open, peak_open + 3.0, peak_open - 0.2, peak_open + 0.5))
    pivot_high = peak_open + 3.0
    bars.append(_bar(peak_open + 0.5, peak_open + 0.8, peak_open - 0.2, peak_open + 0.1))
    bars.append(_bar(peak_open + 0.1, peak_open + 0.5, peak_open - 0.6, peak_open - 0.4))
    # the sweep: wick through the high, close back under it
    sw_open = peak_open - 0.4
    bars.append(_bar(sw_open, pivot_high + 1.2, sw_open - 0.5, pivot_high - 1.0))
    a_low = pivot_high - 2.0
    bars.append(_bar(pivot_high - 1.0, pivot_high - 0.8, a_low, a_low + 0.1))
    bars.append(_bar(a_low + 0.1, a_low + 0.2, a_low - 3.0, a_low - 2.8))
    bars.append(_bar(a_low - 2.8, a_low - 2.6, a_low - 4.0, a_low - 3.8))
    bars.append(_bar(a_low - 3.8, a_low - 3.6, a_low - 4.4, a_low - 4.2))
    bars.append(_bar(a_low - 4.2, a_low - 3.0, a_low - 4.3, a_low - 3.2))
    gap_bot = a_low - 2.6
    bars.append(_bar(a_low - 2.0, gap_bot + 0.4, a_low - 3.0, a_low - 2.9))
    return bars


def _buy_chart():
    bars = []
    px = 101.0
    for _ in range(60):
        px -= 0.02
        bars.append(_bar(px, px + 0.25, px - 0.25, px - 0.01))
    base = bars[-1]["close"]
    bars.append(_bar(base, base + 0.3, base - 0.3, base - 0.2))
    bars.append(_bar(base - 0.2, base + 0.1, base - 0.4, base - 0.3))
    tr = base - 0.3
    bars.append(_bar(tr, tr + 0.2, tr - 3.0, tr - 0.5))
    pivot_low = tr - 3.0
    bars.append(_bar(tr - 0.5, tr + 0.2, tr - 0.8, tr - 0.1))
    bars.append(_bar(tr - 0.1, tr + 0.6, tr - 0.5, tr + 0.4))
    bars.append(_bar(tr + 0.4, tr + 0.5, pivot_low - 1.2, pivot_low + 1.0))
    a_high = pivot_low + 2.0
    bars.append(_bar(pivot_low + 1.0, a_high, pivot_low + 0.8, a_high - 0.1))
    bars.append(_bar(a_high - 0.1, a_high + 3.0, a_high - 0.2, a_high + 2.8))
    bars.append(_bar(a_high + 2.8, a_high + 4.0, a_high + 2.6, a_high + 3.8))
    bars.append(_bar(a_high + 3.8, a_high + 4.4, a_high + 3.6, a_high + 4.2))
    bars.append(_bar(a_high + 4.2, a_high + 4.3, a_high + 3.0, a_high + 3.2))
    gap_top = a_high + 2.6
    bars.append(_bar(a_high + 2.0, a_high + 3.0, gap_top - 0.4, a_high + 2.9))
    return bars


# --------------------------------------------------------------------- basics


def test_it_can_be_uploaded_at_all():
    """No forbidden import, or the desk refuses the file on upload."""
    assert validate_source(EXAMPLE.read_text(encoding="utf-8")) == {"ok": True}


def test_the_loader_picks_the_right_class(strat):
    assert strat.name == "ict_fvg_sweep"
    assert type(strat).__name__ == "MyStrategy"


def test_it_does_not_claim_to_be_profitable(strat):
    """The one thing this file must not do.

    It is known to fire and known to trade. Whether it makes money on
    anybody's instrument has not been measured, and the desk shows this
    field to the trader before they arm the robot.
    """
    assert strat.evidence["state"] == "unmeasured"
    assert len(strat.evidence["basis"]) > 40


# ---------------------------------------------------------------- it fires


def test_it_fires_on_a_built_sell_setup(strat):
    bars = _sell_chart()
    strat.on_start(_ctx(bars))
    sig = strat.on_candle(_ctx(bars))
    assert sig is not None, f"stood aside: {strat.last_refusal}"
    assert sig.action == "sell"
    assert sig.volume > 0


def test_it_fires_on_the_mirrored_buy_setup(strat):
    bars = _buy_chart()
    strat.on_start(_ctx(bars, symbol="EURUSD"))
    sig = strat.on_candle(_ctx(bars, symbol="EURUSD"))
    assert sig is not None, f"stood aside: {strat.last_refusal}"
    assert sig.action == "buy"


def test_the_stop_and_target_are_on_the_right_sides(strat):
    bars = _sell_chart()
    strat.on_start(_ctx(bars))
    sig = strat.on_candle(_ctx(bars))
    entry = bars[-1]["close"]
    assert sig.sl > entry, "a sell whose stop is below the entry"
    assert sig.tp < entry, "a sell whose target is above the entry"


def test_the_target_honours_the_rr_parameter(strat):
    bars = _sell_chart()
    strat.params["rr"] = 3.0
    strat.on_start(_ctx(bars))
    sig = strat.on_candle(_ctx(bars))
    entry = bars[-1]["close"]
    risk = sig.sl - entry
    reward = entry - sig.tp
    assert reward == pytest.approx(risk * 3.0, rel=1e-6)


def test_the_reason_says_what_was_seen(strat):
    """A signal nobody can audit is a signal nobody should take."""
    bars = _sell_chart()
    strat.on_start(_ctx(bars))
    sig = strat.on_candle(_ctx(bars))
    for word in ("swept", "gap", "retraced"):
        assert word in sig.reason


def test_one_setup_gives_one_signal(strat):
    bars = _sell_chart()
    strat.on_start(_ctx(bars))
    assert strat.on_candle(_ctx(bars)) is not None
    assert strat.on_candle(_ctx(bars)) is None
    assert "already taken" in strat.last_refusal


# ------------------------------------------------- the four template traps


def test_every_refusal_is_named(strat):
    """Trap 1. A bare None makes ten different refusals look identical."""
    source = EXAMPLE.read_text(encoding="utf-8")
    body = source[source.index("def on_candle("):]
    for line in body.splitlines():
        stripped = line.strip()
        if stripped.startswith("#"):
            continue
        assert stripped != "return None", "a bare return None is back in on_candle"

    strat.on_start(_ctx([]))
    assert strat.on_candle(_ctx([])) is None
    assert strat.last_refusal_kind == "no candles"
    assert strat.refusals


def test_the_position_guard_reads_a_dict(strat):
    """Trap 2. getattr(pos, "volume") is always None and silences it."""
    bars = _sell_chart()
    strat.on_start(_ctx(bars))
    ctx = _ctx(bars, positions=[{"symbol": "XAUUSD", "volume": 0.5}])
    assert strat.on_candle(ctx) is None
    assert "already in this symbol" in strat.last_refusal
    assert "0.5" in strat.last_refusal


def test_it_reads_both_candle_key_styles(strat):
    """Trap 3. The backtester says "close", the live bridge says "c"."""
    long_keys = _sell_chart()
    short_keys = [
        {"o": b["open"], "h": b["high"], "l": b["low"], "c": b["close"]}
        for b in long_keys
    ]
    strat.on_start(_ctx(short_keys))
    sig = strat.on_candle(_ctx(short_keys))
    assert sig is not None, f"live key names silenced it: {strat.last_refusal}"
    assert sig.action == "sell"


def test_bad_data_is_a_refusal_not_a_crash(strat):
    """A raise inside on_candle is logged as "the strategy crashed"."""
    bars = _sell_chart()
    bars[-1] = dict(bars[-1])
    bars[-1]["close"] = None
    strat.on_start(_ctx(bars))
    assert strat.on_candle(_ctx(bars)) is None
    assert "missing a price field" in strat.last_refusal


# ------------------------------------------------------------- it stands aside


def test_it_stands_aside_on_a_flat_chart(strat):
    """No pattern, no trade - and it says which gate stopped it."""
    bars = [_bar(100.0, 100.1, 99.9, 100.0) for _ in range(200)]
    strat.on_start(_ctx(bars))
    assert strat.on_candle(_ctx(bars)) is None
    assert strat.last_refusal_kind


def test_short_history_is_refused_by_name(strat):
    bars = _sell_chart()[:20]
    strat.on_start(_ctx(bars))
    assert strat.on_candle(_ctx(bars)) is None
    assert "not enough history" in strat.last_refusal


def test_switching_a_direction_off_is_obeyed(strat):
    bars = _sell_chart()
    strat.params["allow_sell"] = False
    strat.on_start(_ctx(bars))
    assert strat.on_candle(_ctx(bars)) is None


def test_the_reported_refusal_is_the_furthest_one_reached(strat):
    """Both directions are scanned, so both must be able to be reported.

    Taking the first refusal meant the sell scan's generic "found
    nothing" always won and a buy setup that failed only its final
    confirmation was never mentioned - the tally said the strategy had
    seen nothing when it had seen and rejected a setup.
    """
    bars = _buy_chart()
    # Kill the confirmation on the last bar: close below open on what
    # would otherwise be a valid long entry.
    last = dict(bars[-1])
    last["close"] = last["open"] - 0.5
    bars[-1] = last
    strat.on_start(_ctx(bars))
    assert strat.on_candle(_ctx(bars)) is None
    assert "bullish confirmation" in strat.last_refusal, strat.last_refusal


# ------------------------------------------------------- it runs in the engine


def test_it_trades_in_the_real_backtester(strat):
    """The acceptance test: does it actually run where the desk runs it?"""
    import random

    from aurion.backtest.engine import Backtester

    random.seed(11)
    bars = []
    px = 2000.0
    for _ in range(900):
        drift = random.gauss(0, 1.1)
        spike = random.choice([-1, 1]) * random.uniform(3, 7) if random.random() < 0.04 else 0.0
        o = px
        c = px + drift - spike * 0.6
        h = max(o, c) + abs(random.gauss(0, 0.8)) + max(spike, 0.0)
        l = min(o, c) - abs(random.gauss(0, 0.8)) + min(spike, 0.0)
        bars.append({"open": o, "high": h, "low": l, "close": c})
        px = c

    result = Backtester().run(strat, bars, "XAUUSD", "M15", warmup=80)
    assert result.get("ok") is True
    assert len(result.get("trades") or []) > 0, "it never opened a position"
