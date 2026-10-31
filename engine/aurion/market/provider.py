"""What AURION requires of anything that can price a market.

The engine has had exactly one source of prices since it was written,
and MT5Bridge says so in its own docstring: data may enter only from the
MetaTrader5 package or from AurionBridge.mq5. That is a good rule badly
placed. The rule worth keeping is "no invented prices"; the rule worth
dropping is "MetaTrader is the only thing that may speak".

This is the seam. A provider answers four questions - what instruments
do you carry, what are the historical bars, what is the current tick,
and are you actually alive - and nothing else. In particular a provider
does NOT execute orders. Quotes and fills are separate concerns with
separate failure modes, and a terminal that can fill an order is not
automatically a feed worth charting.

Deliberately absent: any method that manufactures a bar. A provider that
has no data for a symbol returns nothing. Gap filling, synthetic bars
and "last known price" are how a dead feed is made to look alive, and a
flat candle is indistinguishable from a quiet market at a glance.

Note on types: Candle and Tick still live in aurion.mt5.types. They are
broker-neutral dataclasses on a leaf module with no engine imports, so
borrowing them here costs nothing and avoids a rename across the whole
codebase. They belong in this package eventually.
"""

from __future__ import annotations

import abc
from dataclasses import asdict, dataclass, field
from typing import Any

from ..mt5.types import Candle, Tick
from . import symbols as sym


@dataclass
class Instrument:
    """One tradable - or at least chartable - thing.

    `symbol` is what the provider calls it; `canonical` is what AURION
    stores it under. Keeping both is the point: the desk can show the
    broker's own name while the engine still knows that two providers
    are talking about the same market.
    """

    symbol: str
    canonical: str = ""
    description: str = ""
    kind: str = ""          # forex | metal | crypto | index | commodity | cfd | equity
    digits: int = 0
    point: float = 0.0
    base: str = ""
    quote: str = ""
    source: str = ""        # which provider said so
    tradable: bool = True
    # A price computed from other prices (EURGBP from EURUSD and GBPUSD).
    # It has a derived spread and is nobody's dealable quote, so the desk
    # has to be able to say so rather than passing it off as a feed price.
    derived: bool = False
    meta: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if not self.canonical:
            self.canonical = sym.canonical(self.symbol)
        pair = sym.split_pair(self.symbol)
        if pair and not (self.base and self.quote):
            self.base, self.quote = pair
        if not self.kind:
            if pair:
                self.kind = "forex" if sym.is_forex(self.symbol) else "metal"

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


class MarketDataProvider(abc.ABC):
    """A source of prices. One implementation per feed or terminal."""

    #: Short stable id, used in config and in the API payloads.
    name: str = "provider"

    #: Human label for the desk.
    label: str = ""

    async def start(self) -> None:
        """Connect, authenticate, subscribe. Safe to call twice."""

    async def stop(self) -> None:
        """Disconnect. Safe to call when never started."""

    @abc.abstractmethod
    def instruments(self) -> list[Instrument]:
        """Everything this provider can price, right now.

        Returning [] is a real answer meaning "nothing available yet" -
        a terminal with no chart attached, or a feed still connecting.
        It must not be confused with "this provider is broken".
        """

    @abc.abstractmethod
    async def history(self, symbol: str, timeframe: str, count: int = 800) -> list[Candle]:
        """Closed bars, oldest first. Fewer than `count` is acceptable."""

    @abc.abstractmethod
    def ticks(self) -> dict[str, Tick]:
        """Latest tick per symbol, keyed by the provider's own name."""

    def covers(self, symbol: str) -> bool:
        """Can this provider price `symbol`?

        The default walks the instrument list with the shared matching
        rule, so a provider only overrides this when it can answer more
        cheaply or more precisely.
        """
        return any(sym.matches(i.symbol, symbol) for i in self.instruments())

    def status(self) -> dict[str, Any]:
        """Enough for the desk to say whether this feed is trustworthy."""
        items = self.instruments()
        return {
            "name": self.name,
            "label": self.label or self.name,
            "connected": bool(items),
            "instruments": len(items),
        }
