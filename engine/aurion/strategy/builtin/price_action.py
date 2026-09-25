from __future__ import annotations

from typing import Any

from ...ai.features import candles_to_frame
from ...ai.patterns import detect
from ..base import BaseStrategy, StrategyContext, StrategySignal


class PriceAction(BaseStrategy):
    name = "price_action"
    version = "1.0.0"
    language = "en"
    params: dict[str, Any] = {
        "volume": 0.10,
        "min_score": 0.62,
        "sl_atr": 1.4,
        "tp_atr": 2.2,
        "require_ai_agree": True,
    }

    def on_candle(self, ctx: StrategyContext) -> StrategySignal | None:
        pattern = detect(ctx.candles)
        if not pattern.get("name") or pattern.get("bias") not in {"bull", "bear"}:
            return None
        if float(pattern.get("score") or 0) < float(self.params["min_score"]):
            return None
        ai = ctx.ai or {}
        if self.params.get("require_ai_agree") and ai.get("ready"):
            if ai.get("direction") != pattern["bias"]:
                return None
        frame = candles_to_frame(ctx.candles)
        if frame.empty:
            return None
        price = float(frame["close"].iloc[-1])
        atr = float((frame["high"] - frame["low"]).rolling(14).mean().iloc[-1] or 0)
        pos = ctx.position()
        vol = float(self.params["volume"])
        if pattern["bias"] == "bull":
            if pos and pos.get("type") == "sell":
                return StrategySignal("close", ctx.symbol, reason=f"pattern {pattern['name']} against short", comment="AURION pa")
            if not pos:
                return StrategySignal(
                    "buy",
                    ctx.symbol,
                    volume=vol,
                    sl=price - atr * float(self.params["sl_atr"]) if atr else 0.0,
                    tp=price + atr * float(self.params["tp_atr"]) if atr else 0.0,
                    reason=pattern.get("reason") or pattern["name"],
                    comment="AURION pa",
                    confidence=float(pattern["score"]),
                )
        if pattern["bias"] == "bear":
            if pos and pos.get("type") == "buy":
                return StrategySignal("close", ctx.symbol, reason=f"pattern {pattern['name']} against long", comment="AURION pa")
            if not pos:
                return StrategySignal(
                    "sell",
                    ctx.symbol,
                    volume=vol,
                    sl=price + atr * float(self.params["sl_atr"]) if atr else 0.0,
                    tp=price - atr * float(self.params["tp_atr"]) if atr else 0.0,
                    reason=pattern.get("reason") or pattern["name"],
                    comment="AURION pa",
                    confidence=float(pattern["score"]),
                )
        return None
