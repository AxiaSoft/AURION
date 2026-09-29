from __future__ import annotations

from typing import Any

from ...ai.features import candles_to_frame
from ..base import BaseStrategy, StrategyContext, StrategySignal
from ._confluence import atr_value, efficiency, entry_allowed, risk_levels, swing_levels, trend_bias


class ATRBreakout(BaseStrategy):
    """Range breakouts that have a reason to keep going.

    Most breakouts fail. The ones worth taking break a range that has been
    squeezing, clear the level by a real fraction of ATR (not by a tick),
    close strong into the break and run with the slow trend. All four are now
    required, and the stop sits back inside the broken range.
    """

    name = "atr_breakout"
    version = "2.0.0"
    language = "en"
    params: dict[str, Any] = {
        "lookback": 20,
        "volume": 0.10,
        "sl_atr": 1.2,
        "tp_atr": 2.0,
        "min_rr": 1.5,
        "min_atr_pct": 0.0004,
        "break_atr": 0.15,
        "min_close_loc": 0.6,
        "require_squeeze": True,
        "with_trend": True,
        "require_momentum": True,
        "require_volatility": True,
        "min_efficiency": 0.18,
    }

    def on_candle(self, ctx: StrategyContext) -> StrategySignal | None:
        frame = candles_to_frame(ctx.candles)
        n = int(self.params["lookback"])
        if len(frame) < n + 35:
            return None
        window = frame.iloc[-n - 1 : -1]
        last = frame.iloc[-1]
        high = float(window["high"].max())
        low = float(window["low"].min())
        close = float(last["close"])
        bar_high = float(last["high"])
        bar_low = float(last["low"])
        atr = atr_value(frame)
        if close <= 0 or atr <= 0:
            return None
        if atr / close < float(self.params["min_atr_pct"]):
            return None
        # Where in its own bar did price close? A breakout that closes mid-bar
        # is a wick, not a break.
        span = max(1e-12, bar_high - bar_low)
        close_loc = (close - bar_low) / span
        buffer = atr * float(self.params.get("break_atr") or 0.15)
        # Squeeze check: the range we are breaking should be tight versus ATR,
        # otherwise we are buying the top of an already-extended leg.
        squeeze_ok = True
        if self.params.get("require_squeeze", True):
            squeeze_ok = (high - low) <= atr * (n ** 0.5) * 1.35
        pos = ctx.position()
        vol = float(self.params["volume"])

        side = ""
        if close > high + buffer and close_loc >= float(self.params.get("min_close_loc") or 0.6):
            side = "buy"
        elif close < low - buffer and (1 - close_loc) >= float(self.params.get("min_close_loc") or 0.6):
            side = "sell"
        if not side:
            return None
        if pos and pos.get("type") and pos.get("type") != side:
            return StrategySignal(
                "close", ctx.symbol, reason=f"{side} break against the open {pos.get('type')}", comment="AURION brk"
            )
        if not squeeze_ok:
            return None
        ok, why = entry_allowed(frame, side, self.params, ctx.ai or {})
        if not ok:
            return None
        structure = swing_levels(frame, n)
        sl, tp = risk_levels(
            side,
            close,
            atr,
            float(self.params["sl_atr"]),
            float(self.params["tp_atr"]),
            float(self.params.get("min_rr") or 1.5),
            structure,
        )
        bias, strength = trend_bias(frame)
        confidence = 0.5 + 0.25 * efficiency(frame)
        if bias == ("bull" if side == "buy" else "bear"):
            confidence += 0.2 * strength
        return StrategySignal(
            side,
            ctx.symbol,
            volume=vol,
            sl=sl,
            tp=tp,
            confidence=round(min(0.99, confidence), 3),
            reason=(
                f"close {close:.5f} cleared the {n}-bar "
                f"{'high ' + format(high, '.5f') if side == 'buy' else 'low ' + format(low, '.5f')} "
                f"by {buffer:.5f} — {why}"
            ),
            comment="AURION brk",
        )
