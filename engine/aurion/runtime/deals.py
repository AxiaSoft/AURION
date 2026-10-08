"""Reconciling AURION's trade history with MetaTrader's.

Deliberately free of every heavy import - no numpy, no MT5, no AI engine - so
the arithmetic that decides what a trader sees in their history can be tested
on any machine in milliseconds. It was written inside trader.py first, and the
test could not even import it.

The standard this file is held to: open a position in AURION, close it, and
every figure on the desk's history row must equal the figure MetaTrader shows
for the same position. Not "about the same" - the same number. A desk that is
one cent or one second out from the terminal is a desk whose history is
checked against the terminal before it is believed, which is the same as
having no history at all.
"""
from __future__ import annotations

from typing import Any

#: MT5 marks the side of a deal relative to the position: ``in`` opens it,
#: ``out`` closes it, ``inout`` reverses it and so does both.
_CLOSING = {"out", "inout"}
_OPENING = {"in", "inout"}


def _num(value: Any) -> float:
    try:
        return float(value or 0)
    except (TypeError, ValueError):
        return 0.0


def _belongs(deal: dict[str, Any], ticket: int) -> bool:
    """Is this deal part of the position identified by ``ticket``?

    Matched on position_id first. The EA feed sometimes carries only the deal
    ticket, so that is accepted too - a deal ticket and a position id can
    collide in principle, but a wrong match there was always possible and the
    alternative is dropping the EA's deals entirely.
    """
    try:
        pos_id = int(deal.get("position_id") or 0)
        deal_ticket = int(deal.get("ticket") or 0)
    except (TypeError, ValueError):
        return False
    return pos_id == ticket or deal_ticket == ticket


def aggregate_close_deals(deals: list[dict[str, Any]], ticket: int) -> dict[str, Any] | None:
    """Rebuild one MT5 position from its deals.

    MT5 does not close a position with a single deal. A partial close, a TP
    that fills in two chunks, or a manual close on top of a stop all produce
    several `out` deals sharing one position_id. The desk used to take the
    FIRST match and stop, so a position closed in two parts showed one part's
    profit while MetaTrader showed the total - which is exactly the kind of
    disagreement that makes a trader stop trusting the numbers.

    Three things are taken from the deals rather than from anywhere else,
    because MetaTrader takes them from the same place:

    * **Commission is summed over the whole position, entry deals included.**
      Most brokers charge it on the way in, and some charge on both legs.
      Summing only the closing deals under-reported the cost of every trade
      and made `net` disagree with what the balance actually did - silently,
      and always in the flattering direction.
    * **The close time is the last closing deal's time**, not the moment the
      desk noticed the position had gone. Those differ by a second or two
      normally and by minutes after a reconnect, and a history sorted by the
      wrong one does not line up with the terminal's.
    * **The open price and open time come from the entry deals**, so a row
      can be matched against MetaTrader's History tab line by line.

    Returns None when no closing deal for the position is present yet: the
    caller must know to wait rather than record the last floating price as a
    fact.
    """
    profit = swap = commission = 0.0
    entry_commission = 0.0
    volume = 0.0
    weighted_price = 0.0
    open_volume = 0.0
    open_weighted = 0.0
    open_time = ""
    last_time = ""
    first_time = ""
    order_ticket = 0
    symbol = ""
    side = ""
    magic = 0
    comment = ""
    close_tickets: list[int] = []
    found = False

    for deal in deals or []:
        if not isinstance(deal, dict) or not _belongs(deal, ticket):
            continue
        entry = str(deal.get("entry") or "").lower()
        closing = entry in _CLOSING
        opening = entry in _OPENING

        # Commission is a cost of the position, not of one leg of it.
        commission += _num(deal.get("commission"))
        if opening and not closing:
            entry_commission += _num(deal.get("commission"))

        if opening:
            vol = _num(deal.get("volume"))
            price = _num(deal.get("price"))
            if vol > 0 and price > 0:
                open_volume += vol
                open_weighted += price * vol
            stamp = str(deal.get("time") or "")
            if stamp and (not open_time or stamp < open_time):
                open_time = stamp
            if not order_ticket:
                try:
                    order_ticket = int(deal.get("order") or 0)
                except (TypeError, ValueError):
                    order_ticket = 0
            # The entry deal carries the comment the strategy tagged the
            # order with; closing deals usually carry the broker's reason
            # ("sl", "tp") instead, which is a different and also useful
            # fact but not the one the ledger attributes trades by.
            comment = comment or str(deal.get("comment") or "")

        if not closing:
            continue

        found = True
        vol = _num(deal.get("volume"))
        price = _num(deal.get("price"))
        profit += _num(deal.get("profit"))
        swap += _num(deal.get("swap"))
        if vol > 0 and price > 0:
            volume += vol
            weighted_price += price * vol
        stamp = str(deal.get("time") or "")
        if stamp > last_time:
            last_time = stamp
        if stamp and (not first_time or stamp < first_time):
            first_time = stamp
        try:
            close_tickets.append(int(deal.get("ticket") or 0))
        except (TypeError, ValueError):
            pass
        symbol = symbol or str(deal.get("symbol") or "")
        side = side or str(deal.get("type") or deal.get("side") or "")
        try:
            magic = magic or int(deal.get("magic") or 0)
        except (TypeError, ValueError):
            pass

    if not found:
        return None
    return {
        "profit": round(profit, 2),
        "swap": round(swap, 2),
        "commission": round(commission, 2),
        # Broken out so a trader querying "why is net lower than Profit"
        # can see where the money went without opening the terminal.
        "entry_commission": round(entry_commission, 2),
        # What the balance moved by. MT5's own Profit column is gross.
        "net": round(profit + swap + commission, 2),
        # Volume-weighted, so a two-part close reports one honest average.
        "price": round(weighted_price / volume, 6) if volume > 0 else 0.0,
        "volume": round(volume, 4),
        # MetaTrader's own close time, which is what its history is sorted by.
        "time": last_time or None,
        "close_time": last_time or None,
        "first_close_time": first_time or None,
        "open_price": round(open_weighted / open_volume, 6) if open_volume > 0 else 0.0,
        "open_volume": round(open_volume, 4),
        "open_time": open_time or None,
        "order": order_ticket or None,
        "symbol": symbol or None,
        "side": side or None,
        "magic": magic or None,
        "comment": comment or None,
        "deals": close_tickets,
        "parts": len(close_tickets),
    }


def history_row_matches(row: dict[str, Any], totals: dict[str, Any], cents: float = 0.005) -> list[str]:
    """Name the fields on which a stored history row disagrees with MT5.

    Used by the reconciliation check and by its tests. Returns an empty list
    when the row is identical to MetaTrader's view of the same position, so
    the caller can log exactly what drifted rather than "mismatch".

    The tolerance is half a cent: these are rounded currency amounts, and
    comparing floats for equality would report a disagreement that does not
    exist on screen.
    """
    if not totals:
        return ["no_mt5_deals"]
    bad: list[str] = []
    for key in ("profit", "swap", "commission", "net"):
        want = totals.get(key)
        if want is None:
            continue
        if abs(_num(row.get(key)) - _num(want)) > cents:
            bad.append(key)
    for key, want in (("price", totals.get("price")), ("volume", totals.get("volume"))):
        if not want:
            continue
        # Prices carry more decimals than money does; compare at the
        # precision MT5 itself reports rather than at currency precision.
        if abs(_num(row.get(key)) - _num(want)) > 1e-6:
            bad.append(key)
    want_time = totals.get("close_time")
    if want_time and str(row.get("time") or row.get("ts") or "") != str(want_time):
        bad.append("time")
    return bad
