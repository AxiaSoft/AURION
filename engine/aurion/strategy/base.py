from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Protocol


@dataclass
class StrategySignal:
    action: str  # buy, sell, close, close_all, modify, hold
    symbol: str
    volume: float = 0.0
    sl: float = 0.0
    tp: float = 0.0
    price: float = 0.0
    comment: str = ""
    confidence: float = 0.0
    reason: str = ""
    ticket: int = 0
    extra: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "action": self.action,
            "symbol": self.symbol,
            "volume": self.volume,
            "sl": self.sl,
            "tp": self.tp,
            "price": self.price,
            "comment": self.comment,
            "confidence": self.confidence,
            "reason": self.reason,
            "ticket": self.ticket,
            "extra": self.extra,
        }


@dataclass
class StrategyContext:
    symbol: str
    timeframe: str
    candles: list[dict[str, Any]]
    tick: dict[str, Any] | None
    account: dict[str, Any]
    positions: list[dict[str, Any]]
    orders: list[dict[str, Any]]
    ai: dict[str, Any]
    params: dict[str, Any]
    now: str

    def position(self, symbol: str | None = None) -> dict[str, Any] | None:
        want = symbol or self.symbol
        def _norm(s: str) -> str:
            return "".join(ch for ch in str(s or "").upper() if ch.isalnum())
        want_n = _norm(want)
        for pos in self.positions:
            pn = _norm(str(pos.get("symbol") or ""))
            if not pn or not want_n:
                continue
            if pn == want_n or pn.startswith(want_n) or want_n.startswith(pn):
                return pos
        return None


class Strategy(Protocol):
    name: str
    version: str
    language: str
    params: dict[str, Any]

    def on_start(self, ctx: StrategyContext) -> None: ...
    def on_stop(self, ctx: StrategyContext) -> None: ...
    def on_tick(self, ctx: StrategyContext) -> StrategySignal | None: ...
    def on_candle(self, ctx: StrategyContext) -> StrategySignal | None: ...


class BaseStrategy:
    name = "base"
    version = "1.0.0"
    language = "en"
    params: dict[str, Any] = {}

    def __init__(self, params: dict[str, Any] | None = None) -> None:
        merged = dict(self.params)
        if params:
            merged.update(params)
        self.params = merged

    def on_start(self, ctx: StrategyContext) -> None:
        return None

    def on_stop(self, ctx: StrategyContext) -> None:
        return None

    def on_tick(self, ctx: StrategyContext) -> StrategySignal | None:
        return None

    def on_candle(self, ctx: StrategyContext) -> StrategySignal | None:
        return None

    def describe(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "version": self.version,
            "language": self.language,
            "params": self.params,
            "class": self.__class__.__name__,
        }
