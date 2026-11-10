"""A stop may not cost more than the cap, anywhere it is written.

The complaint these rules answer is that stops are too wide: a strategy
that measures risk in ATR has no idea what an ATR is worth in money on
this broker's contract for this symbol, so the same "1.4 × ATR" stop is
twelve dollars a lot on one instrument and four hundred on another.

The cap is one number in money, quoted against one micro lot (0.01) -
see REFERENCE_LOT in runtime/risk.py. It used to be read against a full
1.00 lot, which made the ceiling a hundred times tighter than the
trader's own setting on the 0.01-lot tickets most people actually send:
"max loss $10" placed a ten-pip stop and the position died in the noise.

That per-0.01-lot reading has itself since been replaced: the cap is a
per-trade number by default, because a field labelled "maximum loss"
that multiplies by the lot gave a 0.10-lot manual trade a $100 stop
from a setting that said 10. The scaling reading is still available as
scope="lot" and is pinned below alongside the new default.

These tests pin the places the rule has to hold - the arithmetic, the
lot size derived from it, and the refusal to guess when the broker has
not said what a tick is worth - and they pin the direction: this rule
may only ever move a stop *closer* to the entry.
"""

from __future__ import annotations

import pytest

from aurion.runtime.risk import (
    REFERENCE_LOT,
    normalise_scope,
    risk_budget,
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
    # $10 at 0.01 lot is 0.10000 of price on this contract, so a stop
    # 0.20000 away is twice the allowance and comes back to the limit.
    out = cap_stop("buy", 1.30000, 1.10000, FX, 10.0, 0.01)
    assert out is not None and out.capped
    assert out.sl == pytest.approx(1.20000)
    assert out.money_per_lot == pytest.approx(10.0)
    assert "capped at 10.00" in out.reason


def test_a_sell_is_capped_above_the_entry() -> None:
    out = cap_stop("sell", 1.10000, 1.30000, FX, 10.0, 0.01)
    assert out is not None and out.capped
    assert out.sl == pytest.approx(1.20000)


def test_a_stop_already_inside_the_cap_is_left_exactly_alone() -> None:
    out = cap_stop("buy", 1.10000, 1.05000, FX, 10.0, 0.01)   # half the allowance
    assert out is not None
    assert not out.capped
    assert out.sl == pytest.approx(1.05000)
    assert out.money_per_lot == pytest.approx(5.0)


def test_the_rule_never_widens_a_stop() -> None:
    """The one direction that would turn protection into damage."""
    for sl in (1.09999, 1.09990, 1.09950, 1.09900):
        out = cap_stop("buy", 1.10000, sl, FX, 10.0, 0.01)
        assert out is not None
        assert out.sl >= sl - 1e-12, f"{sl} was widened to {out.sl}"


def test_a_ticket_with_no_stop_gets_one_at_the_cap() -> None:
    out = cap_stop("buy", 1.10000, 0.0, FX, 10.0, 0.01)
    assert out is not None and out.capped
    assert out.sl == pytest.approx(1.00000)
    assert out.reason == "no stop was attached"
    assert protective_stop("sell", 1.10000, FX, 10.0, 0.01) == pytest.approx(1.20000)


def test_the_cap_is_quoted_against_one_micro_lot() -> None:
    """The setting's promise: a 0.01-lot ticket may lose exactly the cap."""
    sl = protective_stop("buy", 1.10000, FX, 10.0, REFERENCE_LOT)
    assert money_at_risk("buy", 1.10000, sl, REFERENCE_LOT, FX) == pytest.approx(10.0)


def test_the_cap_is_the_same_money_at_every_lot() -> None:
    """The reported fault: a 0.10-lot trade given a $100 stop from a 10.

    This check used to assert the opposite, and said so in its own name
    - "a bigger lot risks more rather than being stopped sooner". The
    reasoning behind it was sound as far as it went: before that, the
    cap was read against a full 1.00 lot, which on the 0.01-lot tickets
    most people send placed a ten-pip stop and killed the position in
    the noise. Rebasing onto 0.01 fixed that case.

    What it missed is that a field labelled "maximum loss" must not
    multiply by anything. Quoting it per 0.01 lot meant the number on
    screen was only true for one particular size, and wrong by exactly
    the factor the trader raised their lot by - always in the expensive
    direction, because people raise size long before they revisit risk
    settings. $10 and 0.10 lots gave a $100 stop.

    Both halves are kept. The default scope is "trade" and pins the
    money; the scope deliberately chosen by someone who wants risk to
    scale with size is "lot", and it still behaves exactly as this test
    used to demand.
    """
    monies = []
    for volume in (0.01, 0.02, 0.10, 1.00):
        sl = protective_stop("buy", 1.10000, FX, 10.0, volume)
        risked = money_at_risk("buy", 1.10000, sl, volume, FX)
        # Never a cent over: the distance is floored to whole ticks so
        # the cap stays a ceiling rather than becoming a target.
        assert risked <= 10.0 + 1e-9
        assert risked == pytest.approx(10.0, rel=2e-3)
        monies.append(risked)
    assert max(monies) - min(monies) < 0.05, f"the cap moved with the lot: {monies}"


def test_the_per_lot_scope_still_scales_with_the_size() -> None:
    """The old behaviour, now something you ask for rather than get."""
    distances = []
    for volume, expected in ((0.01, 10.0), (0.02, 20.0), (0.10, 100.0)):
        sl = protective_stop("buy", 1.10000, FX, 10.0, volume, "lot")
        distances.append(1.10000 - sl)
        risked = money_at_risk("buy", 1.10000, sl, volume, FX)
        assert risked <= expected + 1e-9
        assert risked == pytest.approx(expected, rel=1e-3)
    # Same distance every time, to within the tick it was floored to.
    assert max(distances) - min(distances) <= FX.tick_size + 1e-12, (
        f"the stop distance moved with the lot: {distances}"
    )


def test_an_unknown_scope_is_the_safe_one_rather_than_an_error() -> None:
    """Nothing in the money path may raise on a bad string from a config."""
    assert normalise_scope("per-trade-ish") == "trade"
    assert normalise_scope(None) == "trade"
    assert normalise_scope("LOT") == "lot"
    assert risk_budget(10.0, 0.10, "nonsense") == pytest.approx(10.0)
    assert risk_budget(10.0, 0.10, "lot") == pytest.approx(100.0)


def test_a_stop_on_the_wrong_side_is_replaced_not_capped() -> None:
    out = cap_stop("buy", 1.10000, 1.10500, FX, 10.0, 0.01)
    assert out is not None and out.capped
    assert out.sl < 1.10000
    assert "wrong side" in out.reason


def test_rounding_never_rounds_the_cost_upwards() -> None:
    """Truncated to whole ticks, so the cap is a ceiling and not a target."""
    out = cap_stop("buy", 100.00, 50.00, INDEX, 0.10, 0.01)
    assert out is not None and out.capped
    assert INDEX.money(100.00 - out.sl, 0.01) <= 0.10 + 1e-9


def test_without_a_tick_value_it_refuses_to_guess() -> None:
    blind = SymbolSpec(symbol="???", tick_size=0.0, tick_value=0.0)
    assert not blind.usable
    assert cap_stop("buy", 1.1, 1.0, blind, 10.0, 0.01) is None
    assert protective_stop("buy", 1.1, blind, 10.0, 0.01) == 0.0
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
