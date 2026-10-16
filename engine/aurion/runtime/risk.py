"""What a stop is allowed to cost, in money.

A stop is normally written in price: "1.0840". Whether that is a small
stop or a ruinous one depends on the instrument, the lot size and the
broker's contract specification, and those three are exactly what a
trader is not thinking about at the moment a signal arrives. The result
is the complaint this module exists to answer: the stops are too wide,
every trade risks far more than intended, and nothing says so until the
loss is realised.

So risk is stated once, in the only unit that means the same thing on
every instrument: **money per 1.00 lot**. One number, "no stop may cost
more than $10 per lot", and everything else is arithmetic:

    loss(distance, volume) = distance / tick_size * tick_value * volume

That identity is the whole module. From it come the three things the
runtime needs:

  * ``cap_stop``       — pull a stop in until it costs no more than the cap
  * ``protective_stop``— invent one at exactly the cap when an order has none
  * ``volume_for_risk``— the lot size that spends a money budget on a stop

Pure arithmetic, no MetaTrader import, so it is testable without a
terminal — the same rule as runtime/stops.py, and for the same reason: a
wrong sign here does not raise, it widens somebody's risk in silence.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

__all__ = [
    "SymbolSpec",
    "StopCap",
    "cap_stop",
    "protective_stop",
    "volume_for_risk",
    "round_volume",
    "money_at_risk",
]


def _f(value: Any, default: float = 0.0) -> float:
    try:
        out = float(value)
    except (TypeError, ValueError):
        return default
    return out if out == out else default  # NaN without importing math


@dataclass(frozen=True)
class SymbolSpec:
    """The part of a broker's contract specification that prices risk.

    Everything is optional because the two sources disagree about what
    they can supply: the native MetaTrader module hands over the whole
    structure, an attached EA sends what it was asked for, and a desk
    with neither has nothing. ``usable`` is the honest answer to "can
    money be computed here", and callers must respect it rather than
    guessing a tick value — a guessed tick value is a wrong stop stated
    with confidence, which is worse than no cap at all.
    """

    symbol: str = ""
    tick_size: float = 0.0
    tick_value: float = 0.0
    digits: int = 5
    volume_min: float = 0.01
    volume_step: float = 0.01
    volume_max: float = 100.0
    contract_size: float = 0.0
    currency: str = ""

    @classmethod
    def from_info(cls, info: dict[str, Any] | None, symbol: str = "") -> "SymbolSpec":
        """Read whatever the source calls these fields.

        MetaTrader's own names (``trade_tick_value``) and the plainer
        ones an EA or a test would use (``tick_value``) are both taken,
        and ``point`` stands in for a missing tick size, which is true
        for nearly every symbol and never worse than nothing.
        """
        info = dict(info or {})

        def pick(*names: str, default: float = 0.0) -> float:
            for name in names:
                if name in info and info[name] not in (None, ""):
                    val = _f(info[name])
                    if val:
                        return val
            return default

        tick_size = pick("trade_tick_size", "tick_size", "point")
        tick_value = pick("trade_tick_value_loss", "trade_tick_value", "tick_value")
        digits = int(pick("digits", default=5))
        return cls(
            symbol=str(info.get("name") or symbol or ""),
            tick_size=tick_size,
            tick_value=tick_value,
            digits=digits if digits > 0 else 5,
            volume_min=pick("volume_min", "min_lot", default=0.01),
            volume_step=pick("volume_step", "lot_step", default=0.01),
            volume_max=pick("volume_max", "max_lot", default=100.0),
            contract_size=pick("trade_contract_size", "contract_size"),
            currency=str(info.get("currency_profit") or info.get("currency") or ""),
        )

    @property
    def usable(self) -> bool:
        """True when a price distance can be turned into money."""
        return self.tick_size > 0 and self.tick_value > 0

    def money(self, distance: float, volume: float = 1.0) -> float:
        """What ``distance`` price units cost at ``volume`` lots."""
        distance = abs(_f(distance))
        if not self.usable or distance <= 0:
            return 0.0
        return distance / self.tick_size * self.tick_value * max(0.0, _f(volume))

    def distance_for(self, money: float, volume: float = 1.0) -> float:
        """The price distance that costs ``money`` at ``volume`` lots."""
        money = abs(_f(money))
        volume = max(0.0, _f(volume))
        if not self.usable or money <= 0 or volume <= 0:
            return 0.0
        return money / (self.tick_value * volume) * self.tick_size

    def round_price(self, price: float) -> float:
        return round(_f(price), max(0, int(self.digits)))

    def floor_to_tick(self, distance: float) -> float:
        """A distance truncated to whole ticks, so money never rounds up."""
        distance = abs(_f(distance))
        if self.tick_size <= 0:
            return distance
        ticks = int(distance / self.tick_size)
        return ticks * self.tick_size


def money_at_risk(side: str, entry: float, sl: float, volume: float, spec: SymbolSpec) -> float:
    """What this ticket loses if the stop is hit. 0 when it cannot be said."""
    entry, sl = _f(entry), _f(sl)
    if not spec.usable or entry <= 0 or sl <= 0:
        return 0.0
    side = str(side or "").lower()
    distance = entry - sl if side == "buy" else sl - entry
    if distance <= 0:
        # A stop on the wrong side of the entry is not a risk of this
        # size, it is a broken ticket. Someone else's job to refuse it.
        return 0.0
    return spec.money(distance, volume)


@dataclass
class StopCap:
    """The stop after the money rule has had its say."""

    sl: float
    distance: float
    money_per_lot: float
    capped: bool
    reason: str = ""

    def __bool__(self) -> bool:  # pragma: no cover - convenience only
        return self.sl > 0


def protective_stop(side: str, entry: float, spec: SymbolSpec, max_loss_per_lot: float) -> float:
    """A stop at exactly the cap, for an order that arrived without one.

    An entry with no stop is not a small risk, it is an unbounded one,
    and the cap is the only number in the system that knows how far is
    too far. Returns 0 when it cannot be computed, and the caller must
    then refuse to improvise.
    """
    entry = _f(entry)
    cap = _f(max_loss_per_lot)
    side = str(side or "").lower()
    if not spec.usable or entry <= 0 or cap <= 0 or side not in {"buy", "sell"}:
        return 0.0
    distance = spec.floor_to_tick(spec.distance_for(cap))
    if distance <= 0:
        return 0.0
    return spec.round_price(entry - distance if side == "buy" else entry + distance)


def cap_stop(
    side: str,
    entry: float,
    sl: float,
    spec: SymbolSpec,
    max_loss_per_lot: float,
) -> StopCap | None:
    """Pull ``sl`` in until one lot cannot lose more than the cap.

    Only ever *inwards*. A stop that already costs less than the cap is
    returned untouched: this rule is a ceiling on risk, not an opinion
    about where the stop belongs, and widening somebody's stop to "use
    up" the allowance would be the opposite of what it is for.

    Returns None when the question cannot be answered — no spec, no cap,
    no entry — so the caller can say so instead of pretending.
    """
    entry, sl = _f(entry), _f(sl)
    cap = _f(max_loss_per_lot)
    side = str(side or "").lower()
    if not spec.usable or cap <= 0 or entry <= 0 or side not in {"buy", "sell"}:
        return None

    limit = spec.floor_to_tick(spec.distance_for(cap))
    if limit <= 0:
        return None

    if sl <= 0:
        placed = protective_stop(side, entry, spec, cap)
        if placed <= 0:
            return None
        return StopCap(placed, limit, spec.money(limit), True, "no stop was attached")

    distance = entry - sl if side == "buy" else sl - entry
    if distance <= 0:
        # Wrong side of the entry: replace it rather than "cap" it, since
        # the ticket as written protects nothing at all.
        placed = protective_stop(side, entry, spec, cap)
        if placed <= 0:
            return None
        return StopCap(placed, limit, spec.money(limit), True, "the stop was on the wrong side of the entry")

    if distance <= limit:
        return StopCap(spec.round_price(sl), distance, spec.money(distance), False, "")

    tightened = spec.round_price(entry - limit if side == "buy" else entry + limit)
    return StopCap(
        tightened,
        limit,
        spec.money(limit),
        True,
        f"stop was {spec.money(distance):.2f} per lot, capped at {cap:.2f}",
    )


def round_volume(volume: float, spec: SymbolSpec) -> float:
    """Down to the broker's step, inside its bounds. Down, never up."""
    volume = _f(volume)
    step = spec.volume_step if spec.volume_step > 0 else 0.01
    if volume <= 0:
        return 0.0
    # Floor, with a millionth of a step of slack. Without the slack a
    # budget that divides exactly — 100 dollars of risk at 10 dollars a
    # lot — lands on 9.999999999998 in binary and is floored to 9.99,
    # which looks like an arbitrary haircut and is really a float.
    steps = int(volume / step + 1e-6)
    out = max(0, steps) * step
    if spec.volume_max > 0:
        out = min(out, spec.volume_max)
    # Below the broker's minimum there is no tradeable size; say zero
    # rather than quietly sending a lot the broker will reject.
    if out < spec.volume_min - 1e-12:
        return 0.0
    return round(out, 2)


def volume_for_risk(
    side: str,
    entry: float,
    sl: float,
    spec: SymbolSpec,
    risk_money: float,
    requested: float = 0.0,
) -> float:
    """The largest lot whose stop costs no more than ``risk_money``.

    Never larger than ``requested`` when one is given: position sizing
    may protect a trader from their own stop distance, but it may not
    silently trade bigger than they asked for.
    """
    risk_money = _f(risk_money)
    requested = _f(requested)
    per_lot = money_at_risk(side, entry, sl, 1.0, spec)
    if per_lot <= 0 or risk_money <= 0:
        return round_volume(requested, spec) if requested > 0 else 0.0
    allowed = risk_money / per_lot
    if requested > 0:
        allowed = min(allowed, requested)
    return round_volume(allowed, spec)
