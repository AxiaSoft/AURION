"""Reconciling AURION's trade history with MetaTrader's.

Deliberately free of every heavy import - no numpy, no MT5, no AI engine - so
the arithmetic that decides what a trader sees in their history can be tested
on any machine in milliseconds. It was written inside trader.py first, and the
test could not even import it.
"""
from __future__ import annotations

from typing import Any


def aggregate_close_deals(deals: list[dict[str, Any]], ticket: int) -> dict[str, Any] | None:
    """Sum every closing deal that belongs to one MT5 position.

    MT5 does not close a position with a single deal. A partial close, a TP
    that fills in two chunks, or a manual close on top of a stop all produce
    several `out` deals sharing one position_id. The desk used to take the
    FIRST match and stop, so a position closed in two parts showed one part's
    profit while MetaTrader showed the total - which is exactly the kind of
    disagreement that makes a trader stop trusting the numbers.

    It also returns the net, because that is what the account balance actually
    moved by: MT5's Profit column excludes swap and commission, and a desk that
    reports gross where the statement reports net will never reconcile.

    Returns None when no closing deal for the position is present yet.
    """
    profit = swap = commission = 0.0
    volume = 0.0
    weighted_price = 0.0
    last_time = ""
    found = False

    for deal in deals or []:
        if not isinstance(deal, dict):
            continue
        try:
            pos_id = int(deal.get("position_id") or 0)
            deal_ticket = int(deal.get("ticket") or 0)
        except (TypeError, ValueError):
            continue
        if pos_id != ticket and deal_ticket != ticket:
            continue
        if str(deal.get("entry") or "").lower() not in {"out", "inout"}:
            continue

        found = True
        try:
            vol = float(deal.get("volume") or 0)
            price = float(deal.get("price") or 0)
            profit += float(deal.get("profit") or 0)
            swap += float(deal.get("swap") or 0)
            commission += float(deal.get("commission") or 0)
        except (TypeError, ValueError):
            continue
        if vol > 0 and price > 0:
            volume += vol
            weighted_price += price * vol
        stamp = str(deal.get("time") or "")
        if stamp > last_time:
            last_time = stamp

    if not found:
        return None
    return {
        "profit": round(profit, 2),
        "swap": round(swap, 2),
        "commission": round(commission, 2),
        # What the balance moved by. MT5's own Profit column is gross.
        "net": round(profit + swap + commission, 2),
        # Volume-weighted, so a two-part close reports one honest average.
        "price": round(weighted_price / volume, 6) if volume > 0 else 0.0,
        "volume": round(volume, 4),
        "time": last_time or None,
        "parts": sum(
            1 for d in deals or []
            if isinstance(d, dict)
            and (int(d.get("position_id") or 0) == ticket or int(d.get("ticket") or 0) == ticket)
            and str(d.get("entry") or "").lower() in {"out", "inout"}
        ),
    }
