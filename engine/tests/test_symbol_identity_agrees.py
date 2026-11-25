"""The engine's answer to "is this the same instrument", against the
shared case table.

The other half of this is tests/symbol-identity-agrees.test.cjs, which
runs the desk's copy of the rule over the same file. The rule exists
in two languages because the desk consults it while a stop is being
dragged and cannot ask over HTTP for that; the fixture is what stops
the two copies drifting apart.

Adding a case to tests/fixtures/symbol-identity.json is how the rule
changes - and it then has to pass on both sides.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ENGINE = Path(__file__).resolve().parents[1]
ROOT = ENGINE.parent
if str(ENGINE) not in sys.path:
    sys.path.insert(0, str(ENGINE))

from aurion.mt5.bridge import MT5Bridge

FIXTURE = ROOT / "tests" / "fixtures" / "symbol-identity.json"


def _cases() -> dict:
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


def test_the_fixture_is_where_the_rule_is_written_down() -> None:
    """It has to exist and have both halves, or this proves nothing."""
    assert FIXTURE.is_file(), f"the shared case table is missing: {FIXTURE}"
    cases = _cases()
    assert cases.get("same"), "no 'same instrument' cases"
    assert cases.get("different"), "no 'different instrument' cases"


def test_spellings_of_one_instrument_are_one_instrument() -> None:
    """Broker suffixes: the reason any folding exists at all."""
    for a, b in _cases()["same"]:
        assert MT5Bridge._same_series(a, b), f"{a!r} and {b!r} should be one instrument"


def test_two_instruments_are_never_one() -> None:
    """The money cases. A wrong match here prices a stop on the wrong
    contract's tick value."""
    for a, b in _cases()["different"]:
        assert not MT5Bridge._same_series(a, b), f"{a!r} and {b!r} are not one instrument"


def test_the_rule_does_not_depend_on_argument_order() -> None:
    """Otherwise the spec a ticket gets depends on the order the
    broker's book happened to be in."""
    cases = _cases()
    for a, b in cases["same"] + cases["different"]:
        assert MT5Bridge._same_series(a, b) == MT5Bridge._same_series(b, a), (
            f"the answer for {a!r}/{b!r} depends on the order"
        )
