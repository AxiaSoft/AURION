from __future__ import annotations

import re
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
    """Common behaviour, including the one thing a strategy owes the desk.

    A strategy that declines returns ``None``, and from the outside every
    refusal looks the same. That is how "the strategies give no signal at
    the important places" becomes unanswerable: nobody can tell a quiet
    market from a filter set too tight, a chart with too few bars, or a
    condition that can never be true on this instrument.

    So declining is a method. ``self.decline("...")`` returns None and
    records the reason on the instance, where the desk, the journal and
    scripts/strategy-xray.py can read it. The counts persist across bars,
    which is what turns an opinion about a parameter into arithmetic.
    """

    name = "base"
    version = "1.0.0"
    language = "en"
    params: dict[str, Any] = {}

    def __init__(self, params: dict[str, Any] | None = None) -> None:
        merged = dict(self.params)
        if params:
            merged.update(params)
        self.params = merged
        self.last_refusal: str = ""
        self.last_refusal_kind: str = ""
        self.refusals: dict[str, int] = {}

    # ------------------------------------------------------------ refusals

    def decline(self, kind: str, detail: str = "") -> None:
        """Record why this bar produced nothing, and produce nothing.

        ``kind`` is the stable bucket ("price is premium for a buy") and
        ``detail`` carries the numbers ("0.98"). They are separate because
        counting the detail puts every price level in its own bucket and
        hides the shape of the problem, which is the only thing the tally
        was for.
        """
        self.last_refusal_kind = kind
        self.last_refusal = f"{kind} ({detail})" if detail else kind
        # Numbers belong in the detail, but shared helpers return reasons
        # with the number already inside the sentence ("RSI 80 is
        # exhausted"). Collapsing digits keeps those in one bucket instead
        # of one bucket per value, which is the whole point of counting.
        bucket = re.sub(r"\d+(?:\.\d+)?", "#", kind)
        self.refusals[bucket] = self.refusals.get(bucket, 0) + 1
        return None

    def accepted(self) -> None:
        """Clear the last refusal when a signal is actually returned."""
        self.last_refusal = ""
        self.last_refusal_kind = ""

    def refusal_report(self, top: int = 6) -> list[tuple[str, int]]:
        """The commonest reasons this strategy has stayed out, worst first."""
        return sorted(self.refusals.items(), key=lambda kv: -kv[1])[:top]

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
