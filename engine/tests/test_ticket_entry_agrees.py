"""A market order opens at bid or ask, and the desk must price it there.

The desk draws what the stop on a ticket will cost before the order is
sent. It measured that from the MID, which is not a price anybody
trades at; the engine fills a buy at the ask and a sell at the bid. So
every market stop was understated by half the spread - 0.5% on EURUSD,
4% on US30, 12% on BTCUSD, 15% on XAUUSD - always in the direction that
looks safer than it is.

The consequence is not cosmetic. A trader working to a 100 cap sets a
stop the desk prices at 100; the engine prices the same stop at 118,
finds it over the cap and pulls it in to fit. The stop that reaches the
broker is not the stop that was agreed to.

The rule now lives in risk.market_entry and is pinned from both
languages by tests/fixtures/ticket-entry.json.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from aurion.runtime.risk import SymbolSpec, market_entry, money_at_risk

FIXTURE = Path(__file__).resolve().parents[2] / "tests" / "fixtures" / "ticket-entry.json"


def _cases() -> list:
    data = json.loads(FIXTURE.read_text(encoding="utf-8"))
    return [pytest.param(c, id=c["why"][:60]) for c in data["market"]]


@pytest.mark.parametrize("case", _cases())
def test_the_shared_cases_hold_in_python(case):
    got = market_entry(case["side"], case["bid"], case["ask"])
    assert got == pytest.approx(case["entry"]), case["why"]


def test_an_unknown_side_never_becomes_the_mid():
    """0 is the answer, and the caller has to deal with it.

    Returning the mid as a "reasonable" fallback is exactly the defect
    this function was extracted to remove.
    """
    mid = (100.0 + 101.0) / 2
    for side in ("", None, "close", "cancel", "pending", "BUYSELL"):
        assert market_entry(side, 100.0, 101.0) != mid
        assert market_entry(side, 100.0, 101.0) == 0.0


def test_the_entry_is_always_the_worse_side_for_the_trader():
    """Buying costs the ask, selling receives the bid - never the mid."""
    bid, ask = 2650.0, 2650.3
    assert market_entry("buy", bid, ask) >= ask
    assert market_entry("sell", bid, ask) <= bid


def test_the_trader_uses_the_shared_rule_rather_than_its_own_fork():
    import inspect

    from aurion.runtime.trader import Trader

    src = inspect.getsource(Trader)
    assert 'tick.get("ask" if side == "buy" else "bid")' not in src, (
        "the bid/ask fork is written out again instead of calling market_entry"
    )
    assert "market_entry(" in src, "the trader does not use the shared rule"


@pytest.mark.parametrize(
    "name,tick_size,tick_value,bid,spread,sl_ticks",
    [
        ("EURUSD", 0.00001, 1.0, 1.08500, 0.00002, 200),
        ("XAUUSD", 0.01, 1.0, 2650.00, 0.30, 100),
        ("US30", 1.0, 1.0, 39200.0, 4.0, 50),
        ("BTCUSD", 0.01, 0.01, 67000.0, 12.0, 5000),
    ],
)
def test_pricing_from_the_mid_understates_every_market_stop(
    name, tick_size, tick_value, bid, spread, sl_ticks,
):
    """The regression itself, stated as money rather than as a price.

    Measured on both sides, because the old reading was wrong on both:
    half the spread is missing from a buy's stop and from a sell's.
    """
    spec = SymbolSpec(
        tick_size=tick_size, tick_value=tick_value, digits=5,
        currency="USD", volume_min=0.01, volume_step=0.01, contract_size=1.0,
    )
    ask = bid + spread
    mid = (bid + ask) / 2
    for side in ("buy", "sell"):
        entry = market_entry(side, bid, ask)
        sl = entry - sl_ticks * tick_size if side == "buy" else entry + sl_ticks * tick_size
        real = money_at_risk(side, entry, sl, 1.0, spec)
        from_mid = money_at_risk(side, mid, sl, 1.0, spec)
        assert from_mid < real, f"{name} {side}: the mid did not understate"
        # ...and by exactly half the spread, which is the whole point.
        half = spec.money(spread / 2.0, 1.0)
        assert real - from_mid == pytest.approx(half, rel=1e-6), name
