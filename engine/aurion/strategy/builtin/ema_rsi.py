from __future__ import annotations

from typing import Any

from ...ai.features import candles_to_frame, ema, rsi
from ..base import BaseStrategy, StrategyContext, StrategySignal


class EmaRsi(BaseStrategy):
    name = "ema_rsi"
    version = "1.0.0"
    language = "en"
    params: dict[str, Any] = {
        "fast": 8,
        "slow": 21,
        "rsi_period": 14,
        "rsi_buy": 42,
        "rsi_sell": 58,
        "volume": 0.10,
        "sl_atr": 1.6,
        "tp_atr": 2.4,
        "min_ai_confidence": 0.0,
    }

    def on_candle(self, ctx: StrategyContext) -> StrategySignal | None:
        frame = candles_to_frame(ctx.candles)
        if len(frame) < int(self.params["slow"]) + 5:
            return None
        close = frame["close"]
        fast = ema(close, int(self.params["fast"]))
        slow = ema(close, int(self.params["slow"]))
        r = rsi(close, int(self.params["rsi_period"]))
        atr = (frame["high"] - frame["low"]).rolling(14).mean()
        fx, sx = float(fast.iloc[-1]), float(slow.iloc[-1])
        prev_fx, prev_sx = float(fast.iloc[-2]), float(slow.iloc[-2])
        rsi_now = float(r.iloc[-1])
        atr_now = float(atr.iloc[-1] or 0)
        price = float(close.iloc[-1])
        pos = ctx.position()
        ai = ctx.ai or {}
        if float(ai.get("confidence") or 0) < float(self.params.get("min_ai_confidence") or 0) and ai.get("ready"):
            if ai.get("direction") == "bear" and fx > sx:
                return None
            if ai.get("direction") == "bull" and fx < sx:
                return None
        vol = float(self.params["volume"])
        if prev_fx <= prev_sx and fx > sx and rsi_now >= float(self.params["rsi_buy"]):
            if pos and pos.get("type") == "sell":
                return StrategySignal("close", ctx.symbol, reason="flip to long after EMA cross", comment="AURION ema_rsi")
            if not pos:
                sl = price - atr_now * float(self.params["sl_atr"]) if atr_now else 0.0
                tp = price + atr_now * float(self.params["tp_atr"]) if atr_now else 0.0
                return StrategySignal("buy", ctx.symbol, volume=vol, sl=sl, tp=tp, reason=f"EMA{self.params['fast']} crossed above EMA{self.params['slow']} RSI={rsi_now:.1f}", comment="AURION ema_rsi")
        if prev_fx >= prev_sx and fx < sx and rsi_now <= float(self.params["rsi_sell"]):
            if pos and pos.get("type") == "buy":
                return StrategySignal("close", ctx.symbol, reason="flip to short after EMA cross", comment="AURION ema_rsi")
            if not pos:
                sl = price + atr_now * float(self.params["sl_atr"]) if atr_now else 0.0
                tp = price - atr_now * float(self.params["tp_atr"]) if atr_now else 0.0
                return StrategySignal("sell", ctx.symbol, volume=vol, sl=sl, tp=tp, reason=f"EMA{self.params['fast']} crossed below EMA{self.params['slow']} RSI={rsi_now:.1f}", comment="AURION ema_rsi")
        return None
