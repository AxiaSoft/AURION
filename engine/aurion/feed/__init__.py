"""AURION's own market data layer.

Prices used to arrive only through the MetaTrader bridge, which made the
terminal both the data source and the execution venue: no terminal, no
chart.  This package is the independent source.  The bridge stays -- it is
still how a real broker account connects -- but it is no longer the only way
a price can reach the screen.

    from aurion.feed import build_feed, symbols

    feed = build_feed()          # live provider, or the offline one
    feed.start()
    feed.subscribe("EURUSD")
    feed.candles("EURUSD", "M15", 240)

Provider choice is config-driven and fails *visibly*: if a live provider is
asked for and cannot be reached, the manager reports the error rather than
quietly swapping in simulated prices.  Falling back to the simulator without
saying so would put invented numbers on a trading screen.
"""

from __future__ import annotations

from typing import Any

from .base import FeedProvider, FeedResult, Quote, TIMEFRAMES, tf_minutes, tf_seconds
from .manager import FeedManager
from .symbols import (
    ALL_CURRENCIES,
    DEFAULT_WATCHLIST,
    EXOTICS,
    MAJORS,
    METALS,
    UNIVERSE,
    Symbol,
    get,
    grouped,
    is_known,
    normalise,
    search,
)
from .synthetic import SyntheticFeed
from .yahoo import YahooFeed

#: Everything the desk may pick from, in preference order.
PROVIDERS: dict[str, type] = {
    "yahoo": YahooFeed,
    "synthetic": SyntheticFeed,
}

DEFAULT_PROVIDER = "yahoo"


def make_provider(name: Any = "", **kwargs: Any) -> Any:
    key = str(name or DEFAULT_PROVIDER).strip().lower()
    cls = PROVIDERS.get(key) or PROVIDERS[DEFAULT_PROVIDER]
    return cls(**kwargs)


def build_feed(
    provider: Any = "",
    interval: float = 1.0,
    watchlist: Any = None,
    **kwargs: Any,
) -> FeedManager:
    """A manager wired to the named provider, not yet started."""
    return FeedManager(
        provider=make_provider(provider, **kwargs),
        interval=interval,
        watchlist=watchlist,
    )


__all__ = [
    "ALL_CURRENCIES", "DEFAULT_PROVIDER", "DEFAULT_WATCHLIST", "EXOTICS",
    "FeedManager", "FeedProvider", "FeedResult", "MAJORS", "METALS",
    "PROVIDERS", "Quote", "Symbol", "SyntheticFeed", "TIMEFRAMES",
    "UNIVERSE", "YahooFeed", "build_feed", "get", "grouped", "is_known",
    "make_provider", "normalise", "search", "tf_minutes", "tf_seconds",
]
