from __future__ import annotations

from typing import Any

from ...ai.features import candles_to_frame
from ..base import BaseStrategy, StrategyContext, StrategySignal


class ScalpImpulse(BaseStrategy):
    name = "scalp_impulse"
    version = "1.0.0"
    language = "en"
    params: dict[str, Any] = {
        "lookback": 5,
        "volume": 0.05,
        "sl_atr": 0.55,
        "tp_atr": 0.85,
        "min_body": 0.12,
    }

    def on_candle(self, ctx: StrategyContext) -> StrategySignal | None:
        frame = candles_to_frame(ctx.candles)
        n = int(self.params["lookback"])
        if len(frame) < n + 3:
            return None
        last = frame.iloc[-1]
        prev = frame.iloc[-n - 1 : -1]
        close = float(last["close"])
        open_ = float(last["open"])
        high = float(prev["high"].max())
        low = float(prev["low"].min())
        atr = float((frame["high"] - frame["low"]).rolling(8).mean().iloc[-1] or 0)
        body = abs(close - open_)
        if atr and body < atr * float(self.params["min_body"]):
            return None
        pos = ctx.position()
        vol = float(self.params["volume"])
        if close > high and close > open_:
            if pos and pos.get("type") == "sell":
                return StrategySignal("close", ctx.symbol, reason="scalp flip long", comment="AURION scalp")
            if not pos:
                return StrategySignal(
                    "buy",
                    ctx.symbol,
                    volume=vol,
                    sl=close - atr * float(self.params["sl_atr"]) if atr else 0.0,
                    tp=close + atr * float(self.params["tp_atr"]) if atr else 0.0,
                    reason=f"impulse broke {n}-bar high",
                    comment="AURION scalp",
                )
        if close < low and close < open_:
            if pos and pos.get("type") == "buy":
                return StrategySignal("close", ctx.symbol, reason="scalp flip short", comment="AURION scalp")
            if not pos:
                return StrategySignal(
                    "sell",
                    ctx.symbol,
                    volume=vol,
                    sl=close + atr * float(self.params["sl_atr"]) if atr else 0.0,
                    tp=close - atr * float(self.params["tp_atr"]) if atr else 0.0,
                    reason=f"impulse broke {n}-bar low",
                    comment="AURION scalp",
                )
        return None
