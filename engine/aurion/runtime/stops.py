"""Where a stop loss is allowed to move to, and never where it is not.

Pure arithmetic, no MetaTrader, no imports worth the name. That is on
purpose: this is the one piece of the runtime where a wrong sign does not
cause an error message, it widens somebody's risk on a live position and
says nothing. It needs to be testable without a terminal, a broker or
numpy, so it is.

Two rules live here.

Break-even ("risk free") moves the stop just past the entry once the trade
has earned enough to pay for it, so the position can no longer lose. Past
the entry, not to it: a stop exactly on the open price still closes at a
loss, because the spread has to be crossed to get out and the commission
was charged to get in.

Trailing drags the stop along behind price at a fixed distance.

Both are expressed the same way and resolved together, because a position
has one stop and two opinions about it. The rule is simply: whichever is
further forward wins, and nothing ever moves a stop backwards.
"""

from __future__ import annotations

from typing import Any

__all__ = ["breakeven_target", "trailing_target", "resolve_stop", "StopPlan"]


class StopPlan:
    """What to do with one position's stop on this tick."""

    __slots__ = ("sl", "reason")

    def __init__(self, sl: float, reason: str) -> None:
        self.sl = sl
        self.reason = reason

    def __repr__(self) -> str:  # pragma: no cover - debugging only
        return f"StopPlan(sl={self.sl!r}, reason={self.reason!r})"


def _f(value: Any) -> float:
    try:
        return float(value or 0.0)
    except (TypeError, ValueError):
        return 0.0


def breakeven_target(
    side: str,
    entry: float,
    price: float,
    trigger_points: float,
    lock_points: float = 0.0,
    spread: float = 0.0,
) -> float | None:
    """
    The stop that makes a position unable to lose, or None.

    `price` is the price the position would be closed at right now - the
    bid for a long, the ask for a short. Using the other side of the book
    is how a position looks profitable when closing it would not be.

    `lock_points` is how far beyond the entry to sit. Left at zero it is
    derived: the live spread plus a tenth of the trigger. The spread is
    there because it is the cost that has to be crossed on the way out and
    is the difference between "cannot lose" and "loses a little"; the
    tenth is so the rule still locks something in on an instrument quoted
    with no spread at all.
    """
    trigger = _f(trigger_points)
    if trigger <= 0:
        return None

    entry = _f(entry)
    price = _f(price)
    if entry <= 0 or price <= 0:
        return None

    lock = _f(lock_points)
    if lock <= 0:
        lock = _f(spread) + trigger * 0.1

    side = str(side or "").strip().lower()

    if side == "buy":
        # Earned enough yet?
        if price - entry < trigger:
            return None
        target = entry + lock
        # A stop has to be below the market for a long. If locking in
        # would put it at or above where we are, there is nothing safe to
        # ask for - wait for another tick rather than send a rejection.
        return target if target < price else None

    if side == "sell":
        if entry - price < trigger:
            return None
        target = entry - lock
        return target if target > price else None

    return None


def trailing_target(side: str, price: float, distance_points: float) -> float | None:
    """The stop that follows price at a fixed distance, or None."""
    distance = _f(distance_points)
    price = _f(price)
    if distance <= 0 or price <= 0:
        return None

    side = str(side or "").strip().lower()
    if side == "buy":
        return price - distance
    if side == "sell":
        return price + distance
    return None


def resolve_stop(
    side: str,
    entry: float,
    price: float,
    current_sl: float,
    *,
    breakeven_points: float = 0.0,
    breakeven_lock_points: float = 0.0,
    trailing_points: float = 0.0,
    spread: float = 0.0,
    min_step: float = 0.0,
) -> StopPlan | None:
    """
    The one move to make, or None for "leave it alone".

    Everything protective about this function is in the last few lines:
    a candidate is only returned if it is strictly *better* than the stop
    already on the position. Better means higher for a long and lower for
    a short - the direction that can only ever reduce risk.

    That check is what makes the two rules safe to combine and safe to run
    on every tick. Break-even may fire first and trailing may overtake it
    later; whichever is further forward wins, and neither can give ground
    back when price retraces.

    `min_step` suppresses moves too small to be worth a round trip to the
    broker. Without it a trailing stop sends a modify on every tick of a
    fast instrument and spends its time queueing behind itself.
    """
    side = str(side or "").strip().lower()
    if side not in {"buy", "sell"}:
        return None

    be = breakeven_target(side, entry, price, breakeven_points, breakeven_lock_points, spread)
    tr = trailing_target(side, price, trailing_points)

    candidates: list[tuple[float, str]] = []
    if be is not None:
        candidates.append((be, "breakeven"))
    if tr is not None:
        candidates.append((tr, "trailing"))
    if not candidates:
        return None

    # Furthest forward wins.
    if side == "buy":
        target, reason = max(candidates, key=lambda c: c[0])
    else:
        target, reason = min(candidates, key=lambda c: c[0])

    current = _f(current_sl)
    step = max(0.0, _f(min_step))

    if side == "buy":
        # A long with no stop at all is the one case where "better" cannot
        # be a comparison - anything is better than nothing.
        if current > 0 and target <= current + step:
            return None
        if target >= _f(price):
            return None
    else:
        if current > 0 and target >= current - step:
            return None
        if target <= _f(price):
            return None

    return StopPlan(target, reason)
