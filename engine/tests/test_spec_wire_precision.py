"""The broker's lot ladder has to survive the wire.

The expert sends the contract specification as JSON. The tick fields
were written with eight decimals; the three volume fields beside them
were written with two:

    json += "\\"tick_size\\":"   + DoubleToString(..., 8) + ",";
    json += "\\"volume_step\\":" + DoubleToString(..., 2) + ",";

On a book that trades in 0.001 lots the second line produces the
literal text ``"volume_step":0.00``. The ladder is destroyed at the
source, before any of the engine's arithmetic gets to see it:

  * volume_step 0.0 makes round_volume fall back to 0.01, so the
    broker's real step is unreachable no matter what the engine does;

  * volume_min 0.0 means the "below the broker's minimum" guard never
    fires, and a size the broker will refuse is sent anyway.

This is the same defect as round_volume's old ``round(out, 2)``, one
layer further out: two decimals hardcoded where the broker's own
precision belonged. Fixing the engine alone would have left it
unreachable through the expert, which is the path every real install
uses.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from aurion.runtime.risk import SymbolSpec, round_volume

EA = Path(__file__).resolve().parents[1] / "ea" / "AurionBridge.mq5"

# Fields whose value is a lot size or a price-scale number. Two decimals
# is not enough for any of them.
FINE_FIELDS = (
    "SYMBOL_TRADE_TICK_SIZE",
    "SYMBOL_TRADE_TICK_VALUE",
    "SYMBOL_TRADE_TICK_VALUE_LOSS",
    "SYMBOL_TRADE_CONTRACT_SIZE",
    "SYMBOL_VOLUME_MIN",
    "SYMBOL_VOLUME_STEP",
    "SYMBOL_VOLUME_MAX",
)


@pytest.mark.parametrize("field", FINE_FIELDS)
def test_the_expert_sends_enough_decimals_to_say_what_it_means(field):
    src = EA.read_text(encoding="utf-8", errors="surrogateescape")
    found = re.search(
        r"DoubleToString\(SymbolInfoDouble\(_Symbol,\s*" + field + r"\)\s*,\s*(\d+)\)",
        src,
    )
    assert found, f"{field} is no longer sent in the spec message"
    dp = int(found.group(1))
    assert dp >= 8, (
        f"{field} is serialised to {dp} decimals; a 0.001 lot step becomes "
        f'"0.00" and the ladder is lost before the engine sees it'
    )


def test_what_two_decimals_would_have_done_to_a_thousandth_lot_book():
    """The defect restated as the engine would have experienced it."""
    truncated = float(f"{0.001:.2f}")          # what the wire used to carry
    assert truncated == 0.0

    spec_lost = SymbolSpec(
        tick_size=0.01, tick_value=1.0, digits=2, currency="USD",
        volume_min=truncated, volume_step=truncated, volume_max=100.0,
        contract_size=1.0,
    )
    spec_real = SymbolSpec(
        tick_size=0.01, tick_value=1.0, digits=2, currency="USD",
        volume_min=0.001, volume_step=0.001, volume_max=100.0,
        contract_size=1.0,
    )
    # The step falls back to 0.01, so a 0.005 lot cannot be expressed...
    assert round_volume(0.005, spec_lost) == 0.0
    assert round_volume(0.005, spec_real) == pytest.approx(0.005)
    # ...and the minimum-lot guard has nothing to guard with.
    assert spec_lost.volume_min == 0.0


def test_the_desk_is_told_the_ceiling_as_well_as_the_floor():
    """volume_max is honoured by round_volume, so the desk needs it too.

    Without it the lot field offers sizes the engine will quietly bring
    back down, which looks to the trader like the desk ignoring them.
    """
    import inspect

    from aurion.runtime.trader import Trader

    src = inspect.getsource(Trader)
    at = src.index('"volume_step": spec.volume_step')
    window = src[at - 400:at + 400]
    assert '"volume_max"' in window, "the published spec omits the broker's maximum lot"
