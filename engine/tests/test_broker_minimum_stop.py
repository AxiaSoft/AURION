"""The broker's minimum stop distance, which nothing was reading.

The expert has been sending ``stops_level`` in the contract
specification since that message was written. SymbolSpec did not have
the field, so it was parsed and thrown away, and nothing in the engine
knew the number existed.

SYMBOL_TRADE_STOPS_LEVEL is the closest to the market a broker will
accept a stop. Inside it there is no trade at all: the order comes back
TRADE_RETCODE_INVALID_STOPS, with no stop and no position. The trader
meets that as an opaque rejection.

That matters because cap_stop's whole job is to pull a stop IN until it
fits the money cap. With a small cap on an expensive instrument it will
happily tighten past anything, and the only floor being enforced was
the live spread - applied on one of the four call sites, and a
different number besides. A broker quoting EURUSD at 0.2 points of
spread can still demand 20 points of stop distance, a hundred times
larger.
"""

from __future__ import annotations

import pytest

from aurion.runtime.risk import SymbolSpec, cap_stop, protective_stop

EURUSD = {
    "tick_size": 0.00001, "tick_value": 1.0, "digits": 5, "point": 0.00001,
    "currency": "USD", "volume_min": 0.01, "volume_step": 0.01,
    "contract_size": 100000,
}


def _spec(stops_level: float = 0.0, **over) -> SymbolSpec:
    return SymbolSpec.from_info({**EURUSD, "stops_level": stops_level, **over})


def test_the_field_the_expert_sends_is_finally_read():
    assert _spec(20).stops_level == 20
    assert _spec(20).min_stop_distance == pytest.approx(0.0002)


def test_both_spellings_are_taken():
    """The package says trade_stops_level, the expert says stops_level."""
    assert SymbolSpec.from_info({**EURUSD, "trade_stops_level": 15}).stops_level == 15
    assert SymbolSpec.from_info({**EURUSD, "stops_level": 15}).stops_level == 15


def test_a_broker_that_does_not_restrict_stops_says_zero():
    """Common on ECN books, and it means exactly what it says."""
    assert _spec(0).min_stop_distance == 0.0
    assert SymbolSpec.from_info(EURUSD).min_stop_distance == 0.0


def test_points_are_not_ticks():
    """stops_level is quoted in points, so point - not tick_size - scales it.

    They are equal on nearly every symbol, which is exactly why reading
    the wrong one would go unnoticed until it did not.
    """
    spec = SymbolSpec.from_info({
        **EURUSD, "point": 0.00001, "tick_size": 0.00005, "stops_level": 20,
    })
    assert spec.min_stop_distance == pytest.approx(0.0002)


def test_cap_stop_refuses_rather_than_inventing_an_illegal_stop():
    """A cap tighter than the broker's floor has no legal answer.

    Returning the tightened stop anyway produces an order the broker
    refuses outright - no stop and no position - which is strictly worse
    than being told the cap and the instrument do not fit.
    """
    loose = _spec(0)
    strict = _spec(20)
    # A cap that buys about 10 points of stop on 0.01 lots.
    cap, entry, sl = 0.1, 1.08500, 1.08000
    got_loose = cap_stop("buy", entry, sl, loose, cap, 0.01, "trade")
    assert got_loose is not None, "the unrestricted book still caps normally"
    assert got_loose.distance < strict.min_stop_distance, "the test case is not tight enough"
    assert cap_stop("buy", entry, sl, strict, cap, 0.01, "trade") is None


def test_a_cap_that_clears_the_floor_is_unaffected():
    """The common case must not change: most books set no floor at all."""
    strict = _spec(20)
    # A cap big enough for 50 points of stop, comfortably over 20.
    got = cap_stop("buy", 1.08500, 1.08000, strict, 5.0, 0.01, "trade")
    assert got is not None
    assert got.distance >= strict.min_stop_distance


def test_protective_stop_will_not_place_one_inside_the_floor():
    strict = _spec(20)
    assert protective_stop("buy", 1.08500, strict, 0.1, 0.01, "trade") == 0.0
    assert protective_stop("buy", 1.08500, strict, 5.0, 0.01, "trade") > 0


@pytest.mark.parametrize("side", ["buy", "sell"])
def test_the_floor_is_enforced_on_both_sides(side):
    strict = _spec(20)
    entry = 1.08500
    sl = entry - 0.005 if side == "buy" else entry + 0.005
    assert cap_stop(side, entry, sl, strict, 0.1, 0.01, "trade") is None
    big = cap_stop(side, entry, sl, strict, 5.0, 0.01, "trade")
    assert big is not None
    assert big.distance >= strict.min_stop_distance


def test_nothing_the_cap_produces_is_ever_inside_the_floor():
    """Swept, rather than sampled at one cap."""
    strict = _spec(20)
    floor = strict.min_stop_distance
    entry = 1.08500
    for i in range(1, 400):
        cap = i * 0.01
        got = cap_stop("buy", entry, entry - 0.01, strict, cap, 0.01, "trade")
        if got is not None:
            assert got.distance >= floor - 1e-12, f"cap {cap} produced {got.distance}"


def test_the_desk_is_told_the_distance_in_price_not_the_raw_points():
    """Publish the answer, not the fields and the choice along with them.

    The same principle as tick_value: the desk must never be the place
    that works out whether stops_level was quoted in points or ticks.
    """
    import inspect

    from aurion.runtime.trader import Trader

    src = inspect.getsource(Trader)
    at = src.index('"volume_step": spec.volume_step')
    window = src[at - 600:at + 1200]
    assert '"min_stop_distance"' in window, "the desk is not told the broker's stop floor"
    assert '"stops_level"' not in window, (
        "the desk was handed the raw points and the unit question with them"
    )


def test_the_trader_floors_on_the_larger_of_the_two():
    import inspect

    from aurion.runtime.trader import Trader

    src = inspect.getsource(Trader)
    assert "max(spread, spec.min_stop_distance)" in src, (
        "the rescue path still floors on the spread alone"
    )
