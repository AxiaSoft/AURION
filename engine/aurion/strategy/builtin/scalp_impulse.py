from __future__ import annotations

from typing import Any

from ...ai.features import candles_to_frame
from ..base import BaseStrategy, StrategyContext, StrategySignal
from ._confluence import atr_value, efficiency, entry_allowed, risk_levels, swing_levels


class ScalpImpulse(BaseStrategy):
    """Short bursts, taken only when the burst has body and direction.

    Scalping dies of spread and of chop, so this build demands a real body,
    a close at the end of the bar, a minimum efficiency ratio and agreement
    with the slow trend before it takes the impulse — and it sizes the target
    so a winner still pays for the last loser.
    """

    name = "scalp_impulse"
    version = "2.0.0"
    language = "en"
    params: dict[str, Any] = {
        "lookback": 5,
        "volume": 0.05,
        "sl_atr": 0.55,
        "tp_atr": 0.85,
        "min_rr": 1.2,
        "min_body": 0.35,
        "min_close_loc": 0.65,
        "with_trend": True,
        "trend_fast": 20,
        "trend_slow": 50,
        "counter_trend_block": 0.35,
        "require_momentum": False,
        "require_volatility": True,
        "min_atr_pct": 0.00015,
        "min_efficiency": 0.2,
    }

    def on_candle(self, ctx: StrategyContext) -> StrategySignal | None:
        frame = candles_to_frame(ctx.candles)
        n = int(self.params["lookback"])
        if len(frame) < n + 35:
            return None
        last = frame.iloc[-1]
        prev = frame.iloc[-n - 1 : -1]
        close = float(last["close"])
        open_ = float(last["open"])
        bar_high = float(last["high"])
        bar_low = float(last["low"])
        high = float(prev["high"].max())
        low = float(prev["low"].min())
        atr = atr_value(frame, 8)
        if atr <= 0 or close <= 0:
            return None
        body = abs(close - open_)
        if body < atr * float(self.params["min_body"]):
            return None
        span = max(1e-12, bar_high - bar_low)
        close_loc = (close - bar_low) / span
        pos = ctx.position()
        vol = float(self.params["volume"])

        side = ""
        if close > high and close > open_ and close_loc >= float(self.params.get("min_close_loc") or 0.65):
            side = "buy"
        elif close < low and close < open_ and (1 - close_loc) >= float(self.params.get("min_close_loc") or 0.65):
            side = "sell"
        if not side:
            return None
        if pos and pos.get("type") and pos.get("type") != side:
            return StrategySignal(
                "close", ctx.symbol, reason=f"scalp flip {side}", comment="AURION scalp"
            )
        ok, why = entry_allowed(frame, side, self.params, ctx.ai or {})
        if not ok:
            return None
        sl, tp = risk_levels(
            side,
            close,
            atr,
            float(self.params["sl_atr"]),
            float(self.params["tp_atr"]),
            float(self.params.get("min_rr") or 1.2),
            swing_levels(frame, n * 2),
        )
        return StrategySignal(
            side,
            ctx.symbol,
            volume=vol,
            sl=sl,
            tp=tp,
            confidence=round(min(0.99, 0.5 + 0.35 * efficiency(frame)), 3),
            reason=f"impulse broke the {n}-bar {'high' if side == 'buy' else 'low'} — {why}",
            comment="AURION scalp",
        )
