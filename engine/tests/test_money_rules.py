"""A stop may not cost more than the cap, anywhere it is written.

The complaint these rules answer is that stops are too wide: a strategy
that measures risk in ATR has no idea what an ATR is worth in money on
this broker's contract for this symbol, so the same "1.4 × ATR" stop is
twelve dollars a lot on one instrument and four hundred on another.

The cap is one number in money per 1.00 lot. These tests pin the three
places it has to hold — the arithmetic, the lot size derived from it,
and the refusal to guess when the broker has not said what a tick is
worth — and they pin the direction: this rule may only ever move a stop
*closer* to the entry.
"""

from __future__ import annotations

import pytest

from aurion.runtime.risk import (
    SymbolSpec,
    cap_stop,
    money_at_risk,
    protective_stop,
    round_volume,
    volume_for_risk,
)

# A five-digit FX contract: one point is $1 per lot, so a 100-point stop
# costs $10 — the default cap, which makes the numbers below readable.
FX = SymbolSpec(
    symbol="TEST",
    tick_size=0.00001,
    tick_value=0.1,
    digits=5,
    volume_min=0.01,
    volume_step=0.01,
    volume_max=50.0,
)

# An index-like contract: one price unit is $1 per lot, two digits.
INDEX = SymbolSpec(symbol="IDX", tick_size=0.01, tick_value=0.01, digits=2)


def test_money_is_the_identity_everything_else_rests_on() -> None:
    assert FX.money(0.00100) == pytest.approx(10.0)
    assert FX.money(0.00100, 0.5) == pytest.approx(5.0)
    assert FX.distance_for(10.0) == pytest.approx(0.00100)


def test_a_wide_stop_is_pulled_in_to_the_cap() -> None:
    out = cap_stop("buy", 1.10000, 1.09000, FX, 10.0)   # 1000 points = $100
    assert out is not None and out.capped
    assert out.sl == pytest.approx(1.09900)
    assert out.money_per_lot == pytest.approx(10.0)
    assert "100.00 per lot" in out.reason


def test_a_sell_is_capped_above_the_entry() -> None:
    out = cap_stop("sell", 1.10000, 1.11000, FX, 10.0)
    assert out is not None and out.capped
    assert out.sl == pytest.approx(1.10100)


def test_a_stop_already_inside_the_cap_is_left_exactly_alone() -> None:
    out = cap_stop("buy", 1.10000, 1.09950, FX, 10.0)   # 50 points = $5
    assert out is not None
    assert not out.capped
    assert out.sl == pytest.approx(1.09950)
    assert out.money_per_lot == pytest.approx(5.0)


def test_the_rule_never_widens_a_stop() -> None:
    """The one direction that would turn protection into damage."""
    for sl in (1.09999, 1.09990, 1.09950, 1.09900):
        out = cap_stop("buy", 1.10000, sl, FX, 10.0)
        assert out is not None
        assert out.sl >= sl - 1e-12, f"{sl} was widened to {out.sl}"


def test_a_ticket_with_no_stop_gets_one_at_the_cap() -> None:
    out = cap_stop("buy", 1.10000, 0.0, FX, 10.0)
    assert out is not None and out.capped
    assert out.sl == pytest.approx(1.09900)
    assert out.reason == "no stop was attached"
    assert protective_stop("sell", 1.10000, FX, 10.0) == pytest.approx(1.10100)


def test_a_stop_on_the_wrong_side_is_replaced_not_capped() -> None:
    out = cap_stop("buy", 1.10000, 1.10500, FX, 10.0)
    assert out is not None and out.capped
    assert out.sl < 1.10000
    assert "wrong side" in out.reason


def test_rounding_never_rounds_the_cost_upwards() -> None:
    """Truncated to whole ticks, so the cap is a ceiling and not a target."""
    out = cap_stop("buy", 100.00, 50.00, INDEX, 10.0)
    assert out is not None and out.capped
    assert INDEX.money(100.00 - out.sl) <= 10.0 + 1e-9


def test_without_a_tick_value_it_refuses_to_guess() -> None:
    blind = SymbolSpec(symbol="???", tick_size=0.0, tick_value=0.0)
    assert not blind.usable
    assert cap_stop("buy", 1.1, 1.0, blind, 10.0) is None
    assert protective_stop("buy", 1.1, blind, 10.0) == 0.0
    assert money_at_risk("buy", 1.1, 1.0, 1.0, blind) == 0.0


def test_a_cap_of_zero_means_the_rule_is_off() -> None:
    assert cap_stop("buy", 1.10000, 1.00000, FX, 0.0) is None


def test_money_at_risk_reads_the_whole_ticket() -> None:
    assert money_at_risk("buy", 1.10000, 1.09900, 1.0, FX) == pytest.approx(10.0)
    assert money_at_risk("buy", 1.10000, 1.09900, 0.25, FX) == pytest.approx(2.5)
    # A stop on the wrong side is not a risk of this size, it is a broken
    # ticket, and pretending otherwise would hide it.
    assert money_at_risk("buy", 1.10000, 1.10100, 1.0, FX) == 0.0


def test_sizing_spends_the_budget_and_not_a_cent_more() -> None:
    # $10 per lot of stop, $25 of budget -> 2.5 lots.
    vol = volume_for_risk("buy", 1.10000, 1.09900, FX, 25.0, requested=10.0)
    assert vol == pytest.approx(2.5)
    assert money_at_risk("buy", 1.10000, 1.09900, vol, FX) <= 25.0 + 1e-9


def test_sizing_never_trades_bigger_than_asked() -> None:
    vol = volume_for_risk("buy", 1.10000, 1.09900, FX, 1000.0, requested=0.20)
    assert vol == pytest.approx(0.20)


def test_a_budget_too_small_for_the_minimum_lot_is_no_trade() -> None:
    vol = volume_for_risk("buy", 1.10000, 1.09900, FX, 0.05, requested=1.0)
    assert vol == 0.0


def test_volumes_are_rounded_down_to_the_brokers_step() -> None:
    step = SymbolSpec(tick_size=0.00001, tick_value=0.1, volume_min=0.10, volume_step=0.10)
    assert round_volume(0.37, step) == pytest.approx(0.30)
    assert round_volume(0.09, step) == 0.0          # under the minimum
    assert round_volume(0.30, step) == pytest.approx(0.30)


def test_the_spec_reads_metatraders_own_field_names() -> None:
    spec = SymbolSpec.from_info(
        {
            "name": "EURUSD.m",
            "trade_tick_size": 0.00001,
            "trade_tick_value": 1.0,
            "digits": 5,
            "volume_min": 0.01,
            "volume_step": 0.01,
            "trade_contract_size": 100000.0,
            "currency_profit": "USD",
        }
    )
    assert spec.usable
    assert spec.currency == "USD"
    assert spec.money(0.00010) == pytest.approx(10.0)


def test_the_spec_falls_back_to_point_when_tick_size_is_absent() -> None:
    spec = SymbolSpec.from_info({"point": 0.01, "tick_value": 0.01, "digits": 2})
    assert spec.usable
    assert spec.tick_size == pytest.approx(0.01)
