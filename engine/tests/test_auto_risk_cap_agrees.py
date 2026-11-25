"""The automatic cap is one rule, and the desk must be able to reproduce it.

In automatic mode the trader states a percentage and the engine turns it
into the currency cap that the next ticket is sized and stop-capped
against. The desk previews that number while the trader is still typing,
which means the rule is evaluated twice, in two languages.

It had drifted. The desk reused ``risk_pct_effective`` - the resolved
answer for the *saved* percentage - as though it were a ceiling on the
percentage being typed, so the preview never moved off the saved value.
On a 10,000 account with 1% saved, typing 3% still previewed a 100 cap
while the engine would go on to apply 300.

The repair is not "fix the JavaScript". It is to make the rule
reproducible: the engine publishes the rule's *inputs* - the floor, the
ceiling and the prop ceiling - and both sides run the same arithmetic
over them, pinned by tests/fixtures/auto-risk-cap.json.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from aurion.runtime.risk import auto_risk_cap

FIXTURE = Path(__file__).resolve().parents[2] / "tests" / "fixtures" / "auto-risk-cap.json"


def _fixture() -> dict:
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


def _cases() -> list:
    data = _fixture()
    d = data["defaults"]
    return [
        pytest.param(case, d["risk_pct_min"], d["risk_pct_max"], id=case["why"][:60])
        for case in data["cases"]
    ]


@pytest.mark.parametrize("case,lo,hi", _cases())
def test_the_shared_cases_hold_in_python(case, lo, hi):
    pct, cap = auto_risk_cap(
        case["equity"], case["typed"],
        min_pct=lo, max_pct=hi, prop_pct=case["prop"],
    )
    assert pct == pytest.approx(case["pct"]), case["why"]
    assert cap == pytest.approx(case["cap"]), case["why"]


def test_a_cap_is_never_negative_whatever_arrives():
    """Junk in does not become a negative loss limit.

    A negative cap would read as "no rule" at every call site that tests
    ``cap > 0``, which is the one reading that must never be reached by
    accident.
    """
    for equity in (-1e9, -0.01, 0, None, "", "abc", float("nan")):
        pct, cap = auto_risk_cap(equity, 1.0, min_pct=0.05, max_pct=10.0, prop_pct=0)
        assert cap >= 0.0, equity
        assert pct > 0.0, equity


def test_the_percentage_stays_inside_its_own_bounds():
    for typed in (-100, -0.01, 0, 0.0001, 0.05, 1, 9.99, 10, 10.01, 1e9):
        pct, _ = auto_risk_cap(10_000, typed, min_pct=0.05, max_pct=10.0, prop_pct=0)
        assert 0.05 <= pct <= 10.0, typed


def test_a_prop_ceiling_only_ever_lowers_the_percentage():
    """The tighter of the two promises is the only one that keeps both."""
    for typed in (0.1, 0.5, 1.0, 2.0, 10.0):
        for prop in (0.4, 0.75, 1.0, 1.25):
            plain, _ = auto_risk_cap(10_000, typed, min_pct=0.05, max_pct=10.0, prop_pct=0)
            ceiled, _ = auto_risk_cap(10_000, typed, min_pct=0.05, max_pct=10.0, prop_pct=prop)
            assert ceiled <= plain + 1e-12, (typed, prop)
            assert ceiled <= prop + 1e-12, (typed, prop)


def test_rounding_is_half_up_and_not_the_language_default():
    """2250 x 0.05% is 1.125 exactly. Python's round() answers 1.12.

    Money rounding has to be stated, not inherited, or the C# port
    inherits a third answer - Math.Round is half-to-even there too.
    """
    assert round(2250 * 0.05 / 100.0, 2) == 1.12       # the language default
    _, cap = auto_risk_cap(2250, 0.05, min_pct=0.05, max_pct=10.0, prop_pct=0)
    assert cap == pytest.approx(1.13)                   # the rule


def test_the_engine_itself_goes_through_the_shared_rule():
    """_auto_risk_pct must not keep a second copy of the clamp.

    This is the whole point of the exercise: one implementation, used by
    the engine's own sizing as well as by the published inputs.
    """
    import inspect

    from aurion.runtime.trader import Trader

    src = inspect.getsource(Trader._auto_risk_pct)
    assert "auto_risk_pct" in src or "auto_risk_cap" in src, (
        "_auto_risk_pct still clamps by hand instead of calling the shared rule"
    )


def test_the_desk_is_given_the_inputs_it_needs_to_reproduce_the_rule():
    """A preview cannot be correct unless the bounds are published.

    Without the floor, the ceiling and the prop ceiling, the desk has to
    guess at what the engine will do with the number being typed - and
    the guess it used to make was frozen at the saved value.
    """
    import inspect

    from aurion.runtime.trader import Trader

    src = inspect.getsource(Trader._money_state)
    for key in ("risk_pct_min", "risk_pct_max", "risk_pct_cap"):
        assert f'"{key}"' in src, f"_money_state does not publish {key}"
