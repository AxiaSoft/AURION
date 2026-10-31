"""Which provider answers for which symbol.

One object the rest of the engine can ask for prices without naming a
source. Today it holds a single provider and behaves exactly as the
direct calls to MT5Bridge did; the point is that adding a second one is
a registration rather than a rewrite.

Routing is first-registered-wins among the providers that say they
cover a symbol. That ordering is the policy, and it is the right way
round: a terminal with a live chart on EURUSD is a better answer than a
feed, because it is the price the trader's own broker is showing. A
feed registered behind it picks up everything the terminal is not
watching - which is most of the market.

There is no failover timer and no "last known price" here. A provider
that cannot answer returns nothing and the caller sees nothing. Making
a stale quote look current is the one failure a trading desk must not
have, and it is exactly what a helpful cache would cause.
"""

from __future__ import annotations

from typing import Any

from ..mt5.types import Candle, Tick
from . import symbols as sym
from .provider import Instrument, MarketDataProvider


class MarketHub:
    def __init__(self) -> None:
        self._providers: list[MarketDataProvider] = []

    # ------------------------------------------------------------ wiring

    def register(self, provider: MarketDataProvider) -> MarketDataProvider:
        """Add a provider at the end of the priority order."""
        if provider not in self._providers:
            self._providers.append(provider)
        return provider

    def unregister(self, name: str) -> None:
        self._providers = [p for p in self._providers if p.name != name]

    @property
    def providers(self) -> list[MarketDataProvider]:
        return list(self._providers)

    def get(self, name: str) -> MarketDataProvider | None:
        for provider in self._providers:
            if provider.name == name:
                return provider
        return None

    async def start(self) -> None:
        for provider in self._providers:
            await provider.start()

    async def stop(self) -> None:
        for provider in self._providers:
            try:
                await provider.stop()
            except Exception:
                pass

    # ------------------------------------------------------------ routing

    def provider_for(self, symbol: str) -> MarketDataProvider | None:
        for provider in self._providers:
            try:
                if provider.covers(symbol):
                    return provider
            except Exception:
                continue
        return None

    def covers(self, symbol: str) -> bool:
        return self.provider_for(symbol) is not None

    async def history(self, symbol: str, timeframe: str, count: int = 800) -> list[Candle]:
        provider = self.provider_for(symbol)
        if provider is None:
            return []
        return await provider.history(symbol, timeframe, count)

    def ticks(self) -> dict[str, Tick]:
        """Every provider's latest ticks, earlier providers winning.

        Keyed by the provider's own symbol name, because that is what
        the desk and the positions are already keyed by.
        """
        out: dict[str, Tick] = {}
        for provider in reversed(self._providers):
            try:
                out.update(provider.ticks() or {})
            except Exception:
                continue
        return out

    def instruments(self) -> list[Instrument]:
        """The merged instrument list, one row per market.

        Deduplicated on the canonical name, so EURUSD from a terminal
        and EUR/USD from a feed are one entry and the higher-priority
        provider's own naming survives.
        """
        out: list[Instrument] = []
        seen: set[str] = set()
        for provider in self._providers:
            try:
                items = provider.instruments() or []
            except Exception:
                continue
            for item in items:
                key = item.canonical or sym.canonical(item.symbol)
                if key in seen:
                    continue
                seen.add(key)
                if not item.source:
                    item.source = provider.name
                out.append(item)
        return out

    def status(self) -> dict[str, Any]:
        sources = []
        for provider in self._providers:
            try:
                sources.append(provider.status())
            except Exception:
                sources.append({"name": provider.name, "connected": False})
        return {
            "sources": sources,
            "instruments": len(self.instruments()),
            "connected": any(s.get("connected") for s in sources),
        }
