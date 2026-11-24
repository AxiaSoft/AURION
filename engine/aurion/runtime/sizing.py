"""How big an entry is when the desk is sizing it.

Reported, about the lot setting: "on auto it only ever trades 0.1 -
make the robot decide between 0.01 and 1 lot from how strong its own
signal is, that way there is some money management too."

Auto used to mean "whatever volume the strategy named", and every
built-in strategy names the same 0.10 in its defaults. So "auto" was
not a decision at all - it was a constant with a different label, and
a setup the robot was barely sure of was staked exactly as heavily as
one every filter agreed on.

Two things decide the size here, and they are different kinds of
thing:

  * Conviction decides how much of the room is used. Strategies
    already publish a confidence with every signal - it is what the
    quality floor filters on - so the number exists and was simply
    never spent on anything.

  * The account decides how much room there is. A full lot behind a
    two-hundred-dollar account is not confidence, it is a margin call,
    so the ceiling rises with equity and the trader's conviction can
    only move the size inside it. That is the money management: the
    same signal is a bigger trade on a bigger account and a smaller
    one after a drawdown, without anybody changing a setting.

Nothing here knows about brokers. The result is a plain 0.01-step lot;
the order path still rounds it to the symbol's own step and bounds
(runtime/risk.py::round_volume), which can only take it down.
"""

from __future__ import annotations

#: The smallest and largest an auto-sized entry may ever be.
LOT_MIN = 0.01
LOT_MAX = 1.00
#: Lots are quoted in hundredths; nothing finer is tradeable anywhere.
LOT_STEP = 0.01

#: Confidence at or below WEAK buys the smallest size, at or above
#: STRONG the largest the account allows. The band is deliberately
#: narrow and high: a strategy that reports 0.5 is saying "this is a
#: signal", not "this is the one", and the built-ins sit between 0.5
#: and 0.99 in normal use.
WEAK = 0.50
STRONG = 0.90

#: Equity behind a full lot. At ten thousand the ceiling is 1.00, at
#: one thousand it is 0.10, at one hundred it is the floor.
EQUITY_PER_MAX_LOT = 10_000.0

#: What to allow when the account cannot be read at all. Not the
#: maximum: an unknown balance is not permission to trade big.
UNKNOWN_EQUITY_CEILING = 0.10


def _f(value: object) -> float:
    try:
        out = float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return 0.0
    return out if out == out and out not in (float("inf"), float("-inf")) else 0.0


def lot_ceiling(equity: float, *, lot_min: float = LOT_MIN, lot_max: float = LOT_MAX) -> float:
    """The largest lot this much equity may carry, whatever the signal."""
    eq = _f(equity)
    if eq <= 0:
        return max(lot_min, min(lot_max, UNKNOWN_EQUITY_CEILING))
    room = (eq / EQUITY_PER_MAX_LOT) * lot_max
    return max(lot_min, min(lot_max, room))


def auto_lot(
    confidence: object,
    equity: object = 0.0,
    *,
    lot_min: float = LOT_MIN,
    lot_max: float = LOT_MAX,
    step: float = LOT_STEP,
) -> float:
    """Size one entry from its conviction and the account behind it.

    Always inside [lot_min, lot_max], always on `step`, and never above
    what the equity allows - the conviction scales the room, it does
    not create any.
    """
    lot_min = max(0.01, _f(lot_min) or LOT_MIN)
    lot_max = max(lot_min, _f(lot_max) or LOT_MAX)
    step = _f(step) or LOT_STEP

    conf = max(0.0, min(1.0, _f(confidence)))
    ceiling = lot_ceiling(equity, lot_min=lot_min, lot_max=lot_max)

    span = STRONG - WEAK
    share = 0.0 if span <= 0 else (conf - WEAK) / span
    share = max(0.0, min(1.0, share))

    lot = lot_min + share * (ceiling - lot_min)
    # Down to the step, never up: a size is allowed to be smaller than
    # the arithmetic, never larger than the ceiling it was measured
    # against.
    lot = int(lot / step + 1e-6) * step
    return round(max(lot_min, min(ceiling, lot)), 2)


__all__ = [
    "LOT_MIN",
    "LOT_MAX",
    "LOT_STEP",
    "WEAK",
    "STRONG",
    "EQUITY_PER_MAX_LOT",
    "auto_lot",
    "lot_ceiling",
]
