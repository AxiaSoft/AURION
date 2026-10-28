"""What every market data provider has to look like.

AURION used to take prices from exactly one place: the MetaTrader bridge.
That made the terminal both the data source and the execution venue, so no
terminal meant no chart.  This module is the seam that separates the two --
a provider supplies prices, and nothing more.

The contract is deliberately small, because the hard part is not the shape of
the interface but the two rules every implementation must obey:

1. **Never invent a price.**  A provider that cannot answer returns an empty
   result and sets `error`.  It does not interpolate, it does not repeat the
   last value as if it were fresh, and it does not fabricate a candle.  A
   wrong price on a trading screen is worse than a blank one.
2. **Say how old the data is.**  Every quote carries the time the *source*
   stamped it, not the time we received it, so the desk can show staleness
   instead of pretending a five-minute-old print is live.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any, Protocol, Sequence

from ..mt5.types import Candle, Tick

#: Timeframes a provider may be asked for, in minutes.
TIMEFRAMES: dict[str, int] = {
    "M1": 1, "M5": 5, "M15": 15, "M30": 30,
    "H1": 60, "H4": 240, "D1": 1440, "W1": 10080, "MN1": 43200,
}


def tf_minutes(name: Any) -> int:
    return TIMEFRAMES.get(str(name or "").upper(), 15)


def tf_seconds(name: Any) -> int:
    return tf_minutes(name) * 60


@dataclass
class Quote:
    """One price print from a provider.

    `at` is the source's own timestamp in epoch milliseconds.  `received` is
    ours.  Keeping both is what lets the desk distinguish "the market is
    quiet" from "our feed died ten minutes ago" -- with a single timestamp
    those look identical.
    """

    symbol: str
    bid: float = 0.0
    ask: float = 0.0
    last: float = 0.0
    at: int = 0
    received: int = field(default_factory=lambda: int(time.time() * 1000))

    @property
    def mid(self) -> float:
        if self.bid and self.ask:
            return (self.bid + self.ask) / 2.0
        return self.last or self.bid or self.ask

    @property
    def spread(self) -> float:
        return max(0.0, self.ask - self.bid) if (self.bid and self.ask) else 0.0

    def age_ms(self, now: int | None = None) -> int:
        """How stale the *source* says this print is."""
        if not self.at:
            return -1
        return max(0, (now if now is not None else int(time.time() * 1000)) - self.at)

    def to_tick(self) -> Tick:
        """Into the shape the rest of the engine already speaks."""
        from datetime import datetime, timezone

        stamp = self.at or self.received
        iso = datetime.fromtimestamp(stamp / 1000.0, tz=timezone.utc).isoformat()
        return Tick(
            symbol=self.symbol,
            time=iso,
            bid=self.bid,
            ask=self.ask,
            last=self.last,
            time_msc=stamp,
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "symbol": self.symbol, "bid": self.bid, "ask": self.ask,
            "last": self.last, "mid": self.mid, "spread": self.spread,
            "at": self.at, "received": self.received, "age_ms": self.age_ms(),
        }


@dataclass
class FeedResult:
    """A provider's answer, including the reason it is empty."""

    quotes: dict[str, Quote] = field(default_factory=dict)
    error: str = ""
    provider: str = ""

    @property
    def ok(self) -> bool:
        return not self.error


class FeedProvider(Protocol):
    """A source of forex prices."""

    #: Short stable id, e.g. "yahoo". Used in config and shown in the UI.
    id: str
    #: Human label.
    label: str
    #: True when the provider needs a key the user has not supplied.
    needs_key: bool

    def available(self) -> bool:
        """Can this provider be used right now (key present, import works)?"""
        ...

    def supports(self, symbol: str) -> bool:
        """Does this provider carry that symbol?"""
        ...

    def quotes(self, symbols: Sequence[str]) -> FeedResult:
        """Current price for each symbol. Partial answers are fine."""
        ...

    def candles(self, symbol: str, timeframe: str, count: int) -> list[Candle]:
        """Historical bars, oldest first. Empty list when unavailable."""
        ...


class ProviderError(RuntimeError):
    """A provider failed in a way the manager should record, not crash on."""
