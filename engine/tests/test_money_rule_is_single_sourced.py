"""One money rule, wherever the numbers came from.

Phase zero of making the engine the single source of truth: before a
second front end exists, every rule that decides money has to live in
one place and give one answer. A rule that is written twice is a rule
that will disagree with itself, and the disagreement will be found by
a trader rather than by a test.

This file pins the first of those rules - what a price distance costs
- and the thing that makes it subtle: the engine reads contract
specifications from two different sources that spell the same fields
differently.
"""

from __future__ import annotations

import sys
from pathlib import Path

ENGINE = str(Path(__file__).resolve().parents[1])
if ENGINE not in sys.path:
    sys.path.insert(0, ENGINE)

from aurion.runtime.risk import SymbolSpec


# The same instrument, described by each source in its own words.
# Gold at a broker whose loss tick value is not its profit tick value,
# which is ordinary for metals, indices and anything quoted in a
# currency that is not the account's.
EA_SPEC = {
    "tick_size": 0.01,
    "tick_value": 1.00,          # SYMBOL_TRADE_TICK_VALUE
    "tick_value_loss": 1.30,     # SYMBOL_TRADE_TICK_VALUE_LOSS
    "digits": 2,
    "currency": "USD",
    "volume_min": 0.01,
    "volume_step": 0.01,
    "contract_size": 100.0,
}

PACKAGE_SPEC = {
    "trade_tick_size": 0.01,
    "trade_tick_value": 1.00,
    "trade_tick_value_loss": 1.30,
    "digits": 2,
    "currency_profit": "USD",
    "volume_min": 0.01,
    "volume_step": 0.01,
    "trade_contract_size": 100.0,
}


def test_a_stop_is_priced_by_the_loss_tick_value() -> None:
    """A stop is a loss, so it is priced with the loss tick value.

    MetaTrader publishes two tick values. SYMBOL_TRADE_TICK_VALUE is
    what a tick is worth in profit; SYMBOL_TRADE_TICK_VALUE_LOSS is
    what it is worth against you, and on a great many instruments
    they are not the same number. Everything this module exists for -
    "no trade may lose more than ten dollars" - is about the second
    one.
    """
    spec = SymbolSpec.from_info(EA_SPEC, "XAUUSD")
    assert spec.tick_value == 1.30, "the profit tick value was used to size a loss"


def test_both_sources_describe_the_same_instrument_the_same_way() -> None:
    """The bug this file was written for.

    The engine learns a contract specification either from the expert
    over the socket or from the MetaTrader5 package, and the two spell
    these fields differently - `tick_value_loss` against
    `trade_tick_value_loss`. The reader knew the prefixed spelling of
    the loss field and not the plain one, so a spec that arrived from
    the expert quietly fell back to the PROFIT tick value.

    Same broker, same symbol, same numbers, two answers: a 100-tick
    stop on one lot cost 100 by one route and 130 by the other. The
    trader's ten-dollar cap was really a thirteen-dollar cap, and
    nothing anywhere said so - which is exactly the failure this
    module's own docstring warns about: a wrong number here does not
    raise, it widens somebody's risk in silence.
    """
    from_ea = SymbolSpec.from_info(EA_SPEC, "XAUUSD")
    from_pkg = SymbolSpec.from_info(PACKAGE_SPEC, "XAUUSD")

    assert from_ea.tick_value == from_pkg.tick_value, (
        "the same instrument is priced differently depending on which source "
        "described it"
    )
    assert from_ea.money(1.0, 1.0) == from_pkg.money(1.0, 1.0)
    assert from_ea.tick_size == from_pkg.tick_size
    assert int(from_ea.digits) == int(from_pkg.digits)


def test_the_profit_value_is_still_the_fallback() -> None:
    """A broker that reports only one tick value is not broken.

    Plenty of symbols have the same value either way and some sources
    send only the one field. Preferring the loss value must not mean
    requiring it.
    """
    only_profit = {"tick_size": 0.01, "tick_value": 1.00, "digits": 2}
    assert SymbolSpec.from_info(only_profit, "X").tick_value == 1.00

    # And a loss value of zero is not an answer - zero money per tick
    # would price every stop at nothing.
    zero_loss = {"tick_size": 0.01, "tick_value_loss": 0.0, "tick_value": 1.00, "digits": 2}
    assert SymbolSpec.from_info(zero_loss, "X").tick_value == 1.00


def test_the_cap_a_trader_sets_is_the_cap_they_get() -> None:
    """The consequence, stated in the trader's own terms.

    This is the sentence the fix is for: a ten-dollar cap must stop a
    trade at ten dollars, whichever source described the symbol.
    """
    cap = 10.0
    for name, info in (("expert", EA_SPEC), ("package", PACKAGE_SPEC)):
        spec = SymbolSpec.from_info(info, "XAUUSD")
        # The widest stop that still costs no more than the cap, at one lot.
        distance = spec.distance_for(cap, 1.0)
        cost = spec.money(distance, 1.0)
        assert abs(cost - cap) < 1e-9, f"via the {name}, a {cap} cap really costs {cost}"


def test_the_desk_is_handed_a_resolved_number_not_a_choice() -> None:
    """Why the fix belongs here rather than in the front end.

    The desk prices its own tickets in the browser - it has to, a
    round trip per mouse move while dragging a stop is not a thing
    anyone would ship - but it must never be the place that DECIDES
    which of the broker's fields to believe. The engine resolves that
    once and publishes the answer, so the desk, the expert and any
    future front end all multiply the same number.

    Pinned here because it is the whole principle of this phase, and
    because the cheapest way to break it is for someone to add
    `tick_value_loss` to the table the desk receives and let the
    browser choose again.
    """
    published = {
        "tick_size": SymbolSpec.from_info(EA_SPEC, "XAUUSD").tick_size,
        "tick_value": SymbolSpec.from_info(EA_SPEC, "XAUUSD").tick_value,
    }
    assert published["tick_value"] == 1.30, "the published value is not the resolved one"
    assert "tick_value_loss" not in published, (
        "the front end was handed the raw fields and the choice along with them"
    )
