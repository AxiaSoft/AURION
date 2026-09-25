from __future__ import annotations

from typing import Any

from ...ai.features import candles_to_frame
from ..base import BaseStrategy, StrategyContext, StrategySignal


class ATRBreakout(BaseStrategy):
    name = "atr_breakout"
    version = "1.0.0"
    language = "en"
    params: dict[str, Any] = {
        "lookback": 20,
        "volume": 0.10,
        "sl_atr": 1.2,
        "tp_atr": 2.0,
        "min_atr_pct": 0.0004,
    }

    def on_candle(self, ctx: StrategyContext) -> StrategySignal | None:
        frame = candles_to_frame(ctx.candles)
        n = int(self.params["lookback"])
        if len(frame) < n + 2:
            return None
        window = frame.iloc[-n - 1 : -1]
        last = frame.iloc[-1]
        high = float(window["high"].max())
        low = float(window["low"].min())
        close = float(last["close"])
        atr = float((frame["high"] - frame["low"]).rolling(14).mean().iloc[-1] or 0)
        if atr / close < float(self.params["min_atr_pct"]):
            return None
        pos = ctx.position()
        vol = float(self.params["volume"])
        if close > high:
            if pos and pos.get("type") == "sell":
                return StrategySignal("close", ctx.symbol, reason="breakout against short", comment="AURION brk")
            if not pos:
                return StrategySignal("buy", ctx.symbol, volume=vol, sl=close - atr * float(self.params["sl_atr"]), tp=close + atr * float(self.params["tp_atr"]), reason=f"close {close} broke {n}-bar high {high}", comment="AURION brk")
        if close < low:
            if pos and pos.get("type") == "buy":
                return StrategySignal("close", ctx.symbol, reason="breakdown against long", comment="AURION brk")
            if not pos:
                return StrategySignal("sell", ctx.symbol, volume=vol, sl=close + atr * float(self.params["sl_atr"]), tp=close - atr * float(self.params["tp_atr"]), reason=f"close {close} broke {n}-bar low {low}", comment="AURION brk")
        return None
