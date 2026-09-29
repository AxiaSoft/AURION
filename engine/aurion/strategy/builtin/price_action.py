from __future__ import annotations

from typing import Any

from ...ai.features import candles_to_frame
from ...ai.patterns import detect
from ..base import BaseStrategy, StrategyContext, StrategySignal
from ._confluence import atr_value, efficiency, entry_allowed, risk_levels, swing_levels


class PriceAction(BaseStrategy):
    """Candle patterns that appear where they are supposed to appear.

    A pin bar in the middle of nowhere is noise; the same pin bar at a swing
    level, with the trend and momentum behind it, is a trade. The pattern now
    has to clear the shared confluence gate and sit near recent structure
    before it is allowed to fire.
    """

    name = "price_action"
    version = "2.0.0"
    language = "en"
    params: dict[str, Any] = {
        "volume": 0.10,
        "min_score": 0.62,
        "sl_atr": 1.4,
        "tp_atr": 2.2,
        "min_rr": 1.4,
        "require_ai_agree": True,
        "with_trend": True,
        "require_momentum": False,
        "require_volatility": True,
        "min_atr_pct": 0.0003,
        "min_efficiency": 0.12,
        "structure_atr": 1.2,
    }

    def on_candle(self, ctx: StrategyContext) -> StrategySignal | None:
        pattern = detect(ctx.candles)
        bias = pattern.get("bias")
        if not pattern.get("name") or bias not in {"bull", "bear"}:
            return None
        score = float(pattern.get("score") or 0)
        if score < float(self.params["min_score"]):
            return None
        frame = candles_to_frame(ctx.candles)
        if len(frame) < 40:
            return None
        price = float(frame["close"].iloc[-1])
        atr = atr_value(frame)
        pos = ctx.position()
        side = "buy" if bias == "bull" else "sell"

        if pos and pos.get("type") and pos.get("type") != side:
            return StrategySignal(
                "close",
                ctx.symbol,
                reason=f"pattern {pattern['name']} against the open {pos.get('type')}",
                comment="AURION pa",
            )

        ok, why = entry_allowed(frame, side, self.params, ctx.ai or {})
        if not ok:
            return None
        # The pattern has to be at a level that means something.
        high, low = swing_levels(frame, 20)
        reach = atr * float(self.params.get("structure_atr") or 1.2)
        if atr > 0:
            near_support = abs(price - low) <= reach
            near_resistance = abs(high - price) <= reach
            if side == "buy" and not (near_support or price > high):
                return None
            if side == "sell" and not (near_resistance or price < low):
                return None
        sl, tp = risk_levels(
            side,
            price,
            atr,
            float(self.params["sl_atr"]),
            float(self.params["tp_atr"]),
            float(self.params.get("min_rr") or 1.3),
            (high, low),
        )
        confidence = min(0.99, 0.45 * score + 0.3 + 0.25 * efficiency(frame))
        return StrategySignal(
            side,
            ctx.symbol,
            volume=float(self.params["volume"]),
            sl=sl,
            tp=tp,
            reason=f"{pattern.get('reason') or pattern['name']} — {why}",
            comment="AURION pa",
            confidence=round(confidence, 3),
        )
