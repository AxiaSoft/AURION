"""A lot is fitted DOWN to the broker's ladder, never up.

round_volume turns a wanted size into one the broker will accept. It
finished with ``round(out, 2)`` - two decimals, hardcoded, rather than
the precision of the broker's own volume_step. On a book quoting 0.001
lots that was wrong in both directions at once:

  * the broker's own minimum lot, 0.001, came back as 0.0 - read
    everywhere as "no tradeable size", an off switch nobody asked for;

  * 0.005 came back as 0.01, rounded UP. That size comes out of
    volume_for_risk, which divides a money budget by what the stop costs
    per lot, so rounding it up spends more than the budget: a $10 cap
    with a stop costing $2000/lot sizes to 0.005 and was sent as 0.01,
    risking $20.

0.01 is the step on nearly every retail forex book, which is why this
survived. The step-0.01 cases in the fixture exist to keep the common
path byte-identical.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from aurion.runtime.risk import SymbolSpec, round_volume, volume_for_risk

FIXTURE = Path(__file__).resolve().parents[2] / "tests" / "fixtures" / "lot-rounding.json"


def _spec(step: float, vmin: float, vmax: float) -> SymbolSpec:
    return SymbolSpec(
        tick_size=0.01, tick_value=1.0, digits=2, currency="USD",
        volume_min=vmin, volume_step=step, volume_max=vmax, contract_size=1.0,
    )


def _cases() -> list:
    data = json.loads(FIXTURE.read_text(encoding="utf-8"))
    return [pytest.param(c, id=c["why"][:60]) for c in data["cases"]]


@pytest.mark.parametrize("case", _cases())
def test_the_shared_cases_hold(case):
    spec = _spec(case["step"], case["min"], case["max"])
    got = round_volume(case["want"], spec)
    assert got == pytest.approx(case["lot"], abs=1e-9), case["why"]


@pytest.mark.parametrize("step", [0.001, 0.01, 0.1, 0.25, 1.0])
def test_it_never_returns_more_than_it_was_asked_for(step):
    """The docstring's promise, checked rather than asserted."""
    spec = _spec(step, step, 1000.0)
    want = step
    for _ in range(400):
        got = round_volume(want, spec)
        assert got <= want + 1e-12, f"step {step}: {want} rounded UP to {got}"
        want += step / 3.0


@pytest.mark.parametrize("step", [0.001, 0.01, 0.1, 0.25, 1.0])
def test_what_comes_back_sits_on_the_brokers_ladder(step):
    """An off-step lot is a rejection at the broker, not a rounding."""
    spec = _spec(step, step, 1000.0)
    want = step
    for _ in range(300):
        got = round_volume(want, spec)
        if got > 0:
            steps = got / step
            assert abs(steps - round(steps)) < 1e-6, f"{got} is not a multiple of {step}"
        want += step / 7.0


@pytest.mark.parametrize("step", [0.001, 0.01, 0.1, 0.25, 1.0])
def test_the_brokers_own_minimum_lot_is_always_tradeable(step):
    """If the broker says it will accept this size, we must not say it won't."""
    spec = _spec(step, step, 1000.0)
    assert round_volume(step, spec) == pytest.approx(step, abs=1e-12), step


def test_a_budget_is_never_overspent_by_the_rounding():
    """The money statement of the same bug.

    0.005 lots is what $10 buys when the stop costs $2000 a lot. Sending
    0.01 risks $20 - and the cap is the one number the trader agreed to.
    """
    spec = _spec(0.001, 0.001, 100.0)
    # entry 100, stop 80 -> 20.00 of distance, 0.01 tick, 1.0 per tick
    per_lot = round_volume(1.0, spec) and 2000.0
    lot = volume_for_risk("buy", 100.0, 80.0, spec, risk_money=10.0)
    assert lot == pytest.approx(0.005, abs=1e-9)
    assert lot * per_lot <= 10.0 + 1e-9, "the rounding overspent the budget"


def test_the_common_retail_step_is_unchanged():
    """0.01 books must behave exactly as they did before the repair."""
    spec = _spec(0.01, 0.01, 100.0)
    for want, expect in (
        (0.5, 0.5), (0.015, 0.01), (0.125, 0.12), (0.005, 0.0),
        (10.0, 10.0), (0.01, 0.01), (3.0, 3.0), (2.5, 2.5),
    ):
        assert round_volume(want, spec) == pytest.approx(expect, abs=1e-12), want


def test_the_precision_comes_from_the_step_not_from_a_constant():
    import inspect

    from aurion.runtime import risk

    # The docstring quotes the old line on purpose, so look at the code
    # rather than at the prose describing it.
    src = inspect.getsource(risk.round_volume)
    head, _, rest = src.partition('"""')
    _, _, body = rest.partition('"""')
    body = head + body
    assert "round(out, 2)" not in body, (
        "round_volume still rounds to two decimals regardless of the broker's step"
    )
    assert "round(out, dp)" in body, "the precision is not taken from the step"
