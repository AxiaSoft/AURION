"""The market data layer: where prices come from, and what a bar is.

Kept import-light on purpose. mt5_provider reaches into the MT5 bridge,
which pulls in the whole terminal stack, so it is imported by the code
that wires it up rather than by anyone who only wants to normalise a
symbol or bucket a timestamp.
"""

from __future__ import annotations

from .aggregate import BarAggregator, resample
from .hub import MarketHub
from .provider import Instrument, MarketDataProvider

__all__ = [
    "BarAggregator",
    "Instrument",
    "MarketDataProvider",
    "MarketHub",
    "resample",
]
