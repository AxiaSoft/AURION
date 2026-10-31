"""MetaTrader as one provider among several, instead of as the world.

Nothing about the terminal's behaviour changes here. This is the
adapter that lets the rest of the engine stop naming MetaTrader: it
answers the four provider questions by delegating to MT5Bridge, and
keeps the bridge's own notion of what it covers - a symbol some
AurionBridge chart is actually attached to - rather than inventing a
looser one.

That last point is the whole safety property of this file. Once a
second provider exists, "can MetaTrader price this?" must keep meaning
exactly what it meant before, or the hub will route a symbol to a
terminal that has no chart on it and get silence back.
"""

from __future__ import annotations

from typing import Any

from ..mt5.types import Candle, Tick
from .provider import Instrument, MarketDataProvider


class MT5Provider(MarketDataProvider):
    name = "mt5"
    label = "MetaTrader 5"

    def __init__(self, bridge: Any) -> None:
        self.bridge = bridge

    def instruments(self) -> list[Instrument]:
        """The symbols the terminal is charting right now.

        A terminal with no chart attached carries no instruments, which
        is the honest answer and the reason the desk has an empty state
        at all. It is not a list of everything the broker offers -
        nobody has asked the terminal for that.
        """
        out: list[Instrument] = []
        seen: set[str] = set()
        for agent in self.bridge.active_agents():
            symbol = str(getattr(agent, "symbol", "") or "")
            if not symbol or symbol in seen:
                continue
            seen.add(symbol)
            spec = {}
            try:
                spec = self.bridge.symbol_spec(symbol) or {}
            except Exception:
                spec = {}
            out.append(Instrument(
                symbol=symbol,
                description=str(spec.get("description") or ""),
                digits=int(spec.get("digits") or 0),
                point=float(spec.get("point") or 0.0),
                source=self.name,
                meta={"timeframe": str(getattr(agent, "timeframe", "") or "")},
            ))
        return out

    async def history(self, symbol: str, timeframe: str, count: int = 800) -> list[Candle]:
        rows = await self.bridge.pull_candles(symbol, timeframe, count)
        # pull_candles hands back Candle.to_dict(), which is a plain
        # asdict with no extra keys, so this round-trip is exact.
        out: list[Candle] = []
        for row in rows or []:
            try:
                out.append(Candle(**row))
            except TypeError:
                continue
        return out

    def ticks(self) -> dict[str, Tick]:
        return self.bridge.public_ticks()

    def covers(self, symbol: str) -> bool:
        """Unchanged from the rule the endpoint used before this layer.

        `is_ea_symbol` alone would drop a symbol whose chart has just
        detached but whose bars are still cached, and the desk would
        blank a chart the user is looking at.
        """
        try:
            if self.bridge.is_ea_symbol(symbol):
                return True
        except Exception:
            return False
        try:
            return bool(self.bridge._candles_for(symbol, "M15"))
        except Exception:
            return False

    def status(self) -> dict[str, Any]:
        items = self.instruments()
        return {
            "name": self.name,
            "label": self.label,
            "connected": bool(items),
            "instruments": len(items),
            "tape": self.bridge.active_tape(),
            "native": bool(getattr(self.bridge.native, "connected", False)),
        }
