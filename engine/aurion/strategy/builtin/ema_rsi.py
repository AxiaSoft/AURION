from __future__ import annotations

from typing import Any

from ...ai.features import candles_to_frame, ema, rsi
from ..base import BaseStrategy, StrategyContext, StrategySignal
from ._confluence import atr_value, efficiency, entry_allowed, risk_levels, swing_levels, trend_bias


class EmaRsi(BaseStrategy):
    """EMA cross, but only the crosses that the rest of the chart backs up.

    A raw cross fires constantly in a range. This version needs the slow
    trend, MACD momentum and a pullback-not-chase RSI to line up, prices the
    stop off the last swing and never accepts a ticket under the minimum
    reward-to-risk.
    """

    name = "ema_rsi"
    version = "2.0.0"
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
        "min_rr": 1.4,
        "min_ai_confidence": 0.0,
        "with_trend": True,
        # A fresh 8/21 cross is by definition early, so it is judged against
        # the medium trend (21/55) and only blocked by a strong opposite one.
        "trend_fast": 21,
        "trend_slow": 55,
        "counter_trend_block": 0.45,
        "require_momentum": True,
        "require_volatility": True,
        "min_atr_pct": 0.0003,
        "min_efficiency": 0.15,
        "confirm_bars": 1,
        "allow_pullback": True,
        "pullback_trend_strength": 0.2,
    }

    def on_candle(self, ctx: StrategyContext) -> StrategySignal | None:
        frame = candles_to_frame(ctx.candles)
        if len(frame) < int(self.params["slow"]) + 30:
            return None
        close = frame["close"]
        fast = ema(close, int(self.params["fast"]))
        slow = ema(close, int(self.params["slow"]))
        r = rsi(close, int(self.params["rsi_period"]))
        fx, sx = float(fast.iloc[-1]), float(slow.iloc[-1])
        prev_fx, prev_sx = float(fast.iloc[-2]), float(slow.iloc[-2])
        rsi_now = float(r.iloc[-1])
        atr_now = atr_value(frame)
        price = float(close.iloc[-1])
        pos = ctx.position()
        ai = ctx.ai or {}

        crossed_up = prev_fx <= prev_sx and fx > sx
        crossed_dn = prev_fx >= prev_sx and fx < sx
        # A cross that is still holding one bar later counts too — waiting for
        # confirmation loses a tick of entry and avoids most fake crosses.
        if int(self.params.get("confirm_bars") or 0) >= 1 and len(frame) > 3:
            two_fx, two_sx = float(fast.iloc[-3]), float(slow.iloc[-3])
            crossed_up = crossed_up or (two_fx <= two_sx and prev_fx > prev_sx and fx > sx)
            crossed_dn = crossed_dn or (two_fx >= two_sx and prev_fx < prev_sx and fx < sx)

        if crossed_up and pos and pos.get("type") == "sell":
            return StrategySignal("close", ctx.symbol, reason="flip to long after EMA cross", comment="AURION ema_rsi")
        if crossed_dn and pos and pos.get("type") == "buy":
            return StrategySignal("close", ctx.symbol, reason="flip to short after EMA cross", comment="AURION ema_rsi")

        side = "buy" if crossed_up else "sell" if crossed_dn else ""
        entry_kind = "cross"
        if not side and self.params.get("allow_pullback", True):
            # Continuation entry: in an established trend, wait for price to
            # dip into the slow EMA and close back on the trend side. These
            # are the entries with the best location, and they happen far more
            # often than a fresh cross.
            bias, strength = trend_bias(
                frame,
                int(self.params.get("trend_fast", 21) or 21),
                int(self.params.get("trend_slow", 55) or 55),
            )
            if strength >= float(self.params.get("pullback_trend_strength", 0.2) or 0.2):
                low_prev = float(frame["low"].iloc[-2])
                high_prev = float(frame["high"].iloc[-2])
                if bias == "bull" and fx > sx and low_prev <= float(slow.iloc[-2]) and price > float(fast.iloc[-1]):
                    side, entry_kind = "buy", "pullback"
                elif bias == "bear" and fx < sx and high_prev >= float(slow.iloc[-2]) and price < float(fast.iloc[-1]):
                    side, entry_kind = "sell", "pullback"
        if not side:
            return None
        if entry_kind == "cross":
            if side == "buy" and rsi_now < float(self.params["rsi_buy"]):
                return None
            if side == "sell" and rsi_now > float(self.params["rsi_sell"]):
                return None
        else:
            # A pullback is supposed to look weak; only refuse the extremes.
            if side == "buy" and rsi_now < 35.0:
                return None
            if side == "sell" and rsi_now > 65.0:
                return None
        ok, why = entry_allowed(frame, side, self.params, ai)
        if not ok:
            return None
        min_conf = float(self.params.get("min_ai_confidence") or 0)
        if min_conf and ai.get("ready") and float(ai.get("confidence") or 0) < min_conf:
            return None
        structure = swing_levels(frame, 20)
        sl, tp = risk_levels(
            side,
            price,
            atr_now,
            float(self.params["sl_atr"]),
            float(self.params["tp_atr"]),
            float(self.params.get("min_rr") or 1.3),
            structure,
        )
        bias, strength = trend_bias(frame)
        confidence = 0.5 + 0.25 * (1.0 if bias == ("bull" if side == "buy" else "bear") else 0.0) * strength
        confidence += 0.25 * efficiency(frame)
        return StrategySignal(
            side,
            ctx.symbol,
            volume=float(self.params["volume"]),
            sl=sl,
            tp=tp,
            confidence=round(min(0.99, confidence), 3),
            reason=(
                f"EMA{self.params['fast']}/{self.params['slow']} {entry_kind} {side} "
                f"RSI={rsi_now:.1f} — {why}"
            ),
            comment="AURION ema_rsi",
        )
