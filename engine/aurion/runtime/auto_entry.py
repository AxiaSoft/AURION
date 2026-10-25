"""Turning a strategy's market order into a resting order at its own entry.

Some brokers are hostile to robots, and the tell they watch for is a stream
of market orders arriving milliseconds after a candle closes. A trader who
works that book wants the same decisions expressed the way a discretionary
trader expresses them: a resting order at a price, with the stop and target
already attached, that fills only if the market comes to it.

That is not merely camouflage, and the honest reason to offer it is the
second one. A structural strategy picks its trade because price is at - or
heading back to - a particular level. Buying at market the instant the
signal fires pays whatever the spread and the last impulse candle happen to
cost; resting an order at the level pays the level. The trade-off is real
and goes the other way too: if price never comes back, the trade is missed
entirely. That is a choice for the trader, which is why this is a setting
and not a behaviour.

Pure arithmetic, no MT5 import, so the rules can be tested without a
terminal.
"""
from __future__ import annotations

from typing import Any

#: How far inside a zone to rest the order, as a fraction of the zone's
#: depth measured from the edge price would reach first. 0.5 is the middle.
#: Deeper fills better and misses more often; the midpoint is the usual
#: compromise and the one a trader can reason about.
DEFAULT_ZONE_DEPTH = 0.5

#: With no zone to work with, rest this far back from the market in ATR.
DEFAULT_OFFSET_ATR = 0.35

#: A pending order closer to the market than this (in ATR) is pointless: it
#: will either fill immediately, which is a market order with extra steps,
#: or be rejected for sitting inside the broker's freeze level.
MIN_DISTANCE_ATR = 0.08


def _num(value: Any, default: float = 0.0) -> float:
    try:
        out = float(value)
    except (TypeError, ValueError):
        return default
    return out if out == out else default  # NaN check without importing math


class Plan(dict):
    """A resting order, or the reason there isn't one.

    A dict so it can cross the bus unchanged, with the keys the native
    bridge's ``action: "pending"`` branch already understands.
    """


def plan_entry(
    side: str,
    bid: float,
    ask: float,
    sl: float,
    tp: float,
    extra: dict[str, Any] | None = None,
    *,
    zone_depth: float = DEFAULT_ZONE_DEPTH,
    offset_atr: float = DEFAULT_OFFSET_ATR,
    expiry_minutes: int = 120,
) -> Plan | None:
    """Where to rest this trade, or None to send it at market after all.

    Returning None rather than refusing is deliberate. Auto entry is a
    preference about *how* to enter, not a veto on entering: when the price
    cannot be improved - no zone, no ATR, or the level is already behind us -
    the honest outcome is the market order the strategy asked for, not a
    silently skipped trade.
    """
    side = str(side or "").lower()
    if side not in {"buy", "sell"}:
        return None
    bid, ask = _num(bid), _num(ask)
    if bid <= 0 or ask <= 0:
        return None

    extra = extra if isinstance(extra, dict) else {}
    atr = _num(extra.get("atr"))
    market = ask if side == "buy" else bid

    price = _zone_price(side, extra.get("zone"), zone_depth)
    if price is None and atr > 0:
        step = atr * max(0.0, float(offset_atr))
        price = market - step if side == "buy" else market + step
    if price is None or price <= 0:
        return None

    # Too close to be worth resting. Without an ATR there is no scale to
    # judge "close" on, so fall back to the spread, which is the only other
    # distance the market has given us.
    floor = atr * MIN_DISTANCE_ATR if atr > 0 else max(abs(ask - bid), 0.0)
    if abs(price - market) <= floor:
        return None

    # A resting buy below the market is a limit; above it, a stop. Getting
    # this backwards is the single most common way a pending order is
    # rejected, and the broker's error message does not say so.
    if side == "buy":
        order_type = "buy_limit" if price < market else "buy_stop"
    else:
        order_type = "sell_limit" if price > market else "sell_stop"

    sl, tp = _num(sl), _num(tp)
    # The stop belongs to the structure, not to the entry, so it is carried
    # over untouched - which is what makes the better entry worth having:
    # same invalidation, less risk, more reward. But a stop that ends up on
    # the wrong side of the new entry is not a stop, and MT5 would reject
    # the order with a code the desk cannot explain.
    if sl > 0:
        if side == "buy" and sl >= price:
            return None
        if side == "sell" and sl <= price:
            return None
    if tp > 0:
        if side == "buy" and tp <= price:
            return None
        if side == "sell" and tp >= price:
            return None

    risk = abs(price - sl) if sl > 0 else 0.0
    reward = abs(tp - price) if tp > 0 else 0.0
    return Plan({
        "order_type": order_type,
        "price": round(price, 6),
        "sl": sl,
        "tp": tp,
        "market": round(market, 6),
        "improvement": round(abs(market - price), 6),
        "rr": round(reward / risk, 2) if risk > 0 and reward > 0 else 0.0,
        "expiry_minutes": max(0, int(expiry_minutes or 0)),
        "why": _why(side, extra.get("zone"), order_type),
    })


def _zone_price(side: str, zone: Any, depth: float) -> float | None:
    """The price inside the strategy's own zone to wait at.

    A buy is taken from a zone below the market, so the order rests on the
    way down into it; ``depth`` says how far in. The edge price reaches
    first is the high for a buy and the low for a sell.
    """
    if not isinstance(zone, dict):
        return None
    low, high = _num(zone.get("low")), _num(zone.get("high"))
    if low <= 0 or high <= 0 or high < low:
        return None
    depth = max(0.0, min(1.0, float(depth)))
    size = high - low
    return high - size * depth if side == "buy" else low + size * depth


def _why(side: str, zone: Any, order_type: str) -> str:
    where = "inside the strategy's zone" if isinstance(zone, dict) and zone else "back from the market"
    return f"{order_type.replace('_', ' ')} resting {where}"


def expired_orders(
    orders: list[dict[str, Any]],
    now_epoch: float,
    expiry_minutes: int,
    magic: int,
) -> list[int]:
    """Tickets of our own resting orders that have waited long enough.

    A setup has a shelf life. The structure that justified the level is
    still there an hour later, probably; a day later the market has made
    several new decisions and an order resting on last session's logic is
    not a trade anyone chose to take. Only orders carrying AURION's magic
    number are considered - a trader's own pending orders are theirs.
    """
    if expiry_minutes <= 0:
        return []
    cutoff = now_epoch - expiry_minutes * 60
    out: list[int] = []
    for order in orders or []:
        if not isinstance(order, dict):
            continue
        try:
            if int(order.get("magic") or 0) != int(magic):
                continue
            ticket = int(order.get("ticket") or 0)
        except (TypeError, ValueError):
            continue
        if not ticket:
            continue
        placed = _epoch(order.get("time"))
        if placed is None or placed > cutoff:
            continue
        out.append(ticket)
    return out


def _epoch(stamp: Any) -> float | None:
    """Seconds since the epoch from whatever the bridge put in ``time``."""
    if isinstance(stamp, (int, float)):
        return float(stamp)
    text = str(stamp or "").strip()
    if not text:
        return None
    from datetime import datetime, timezone

    cleaned = text.replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(cleaned)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.timestamp()
