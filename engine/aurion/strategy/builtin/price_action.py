from __future__ import annotations

from typing import Any

from ...ai.features import candles_to_frame
from ...ai.patterns import detect
from ..base import BaseStrategy, StrategyContext, StrategySignal
from ._confluence import atr_value, efficiency, entry_allowed, risk_levels, swing_levels
from ._structure import impulse_leg, resample, structure_state


class PriceAction(BaseStrategy):
    """Candle patterns that appear where they are supposed to appear.

    A pin bar in the middle of nowhere is noise; the same pin bar at a swing
    level, with the trend and momentum behind it, is a trade. The pattern has
    to clear the shared confluence gate and sit on recent structure before it
    is allowed to fire.

    What the measurements say, plainly
    ----------------------------------
    This is the weakest of the four built-ins and I am not going to dress it
    up. Run through ``scripts/strategy-xray.py`` over five instruments and
    two independent sets of seeds, a candle pattern on its own was between
    break-even and clearly negative, and nothing tried against it held up in
    both samples: a higher-timeframe filter, a tighter pattern score, a
    2.0 reward-to-risk, wider targets, tighter stops, continuation-only and
    reversal-only all improved one sample and spoiled the other, and the
    pullback filter below cut the trade count by two thirds without paying
    for it. King, ema_rsi and atr_breakout all have a measurable edge in
    those runs; this one does not.

    So it ships honest rather than over-fitted. The defaults are the plain
    ones; the stricter ideas are all here as switches — ``require_htf``,
    ``require_pullback``, ``pattern_kinds``, ``require_level_touch`` — for a
    trader who wants the pattern only as a confirmation of something they
    have already decided. Treat it as a second opinion, not as a robot you
    leave alone with an account.
    """

    name = "price_action"
    version = "2.0.0"
    language = "en"
    params: dict[str, Any] = {
        "volume": 0.10,
        "min_score": 0.62,
        "sl_atr": 1.4,
        "tp_atr": 2.2,
        # The AI veto is the account's rule, asked once in the trader with the
        # switch the desk actually shows. Asking it a second time here meant
        # the desk's switch did nothing on this strategy and no log could say
        # which of the two had refused the trade.
        "require_ai_agree": False,
        "with_trend": True,
        "require_momentum": False,
        "require_volatility": True,
        "min_atr_pct": 0.0003,
        "min_efficiency": 0.12,
        "structure_atr": 1.2,
        # Only a pattern that forms *at* a level counts. Without this the
        # same code also fired on closes beyond the level, which is a
        # breakout trade wearing a reversal pattern's clothes — and that
        # is atr_breakout's job, done better.
        "require_level_touch": True,
        # A pattern is a trigger, not a reason.
        #
        # On its own, "a pin bar at a level" has no edge worth the name:
        # measured over four seeds and five symbols it was break-even in
        # one sample and clearly negative in another. What the pattern is
        # good at is timing the end of a pullback — so it is now only
        # allowed to fire with the higher timeframe, inside a measured
        # retracement of the last impulse leg up there.
        "require_htf": False,
        "htf_factor": 4,
        "require_pullback": False,
        "min_pullback": 0.25,
        "max_pullback": 0.95,
        "min_rr": 1.4,
        # Which family of patterns is allowed to fire.
        "pattern_kinds": "all",
    }

    #: Patterns that say "the move continues" versus patterns that say
    #: "the move ends". They are not the same trade and they do not
    #: deserve the same rules.
    CONTINUATION = {
        "bull_marubozu", "bear_marubozu", "rising_window", "falling_window",
        "higher_highs", "lower_lows", "pin_break_up", "pin_break_down",
    }

    def on_candle(self, ctx: StrategyContext) -> StrategySignal | None:
        pattern = detect(ctx.candles)
        bias = pattern.get("bias")
        if not pattern.get("name") or bias not in {"bull", "bear"}:
            return self.decline("no candle pattern here")
        score = float(pattern.get("score") or 0)
        if score < float(self.params["min_score"]):
            return self.decline("pattern too weak",
                                f"{score:.2f} < {float(self.params['min_score']):.2f}")
        kinds = str(self.params.get("pattern_kinds") or "all")
        if kinds != "all":
            is_cont = pattern["name"] in self.CONTINUATION
            if kinds == "continuation" and not is_cont:
                return self.decline("reversal pattern, and this strategy trades continuation")
            if kinds == "reversal" and is_cont:
                return self.decline("continuation pattern, and this strategy trades reversals")
        frame = candles_to_frame(ctx.candles)
        if len(frame) < 40:
            return self.decline("not enough history", f"{len(frame)} bars")
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
            return self.decline(why)
        if self.params.get("require_pullback", True):
            # Where in the bigger move are we? A pattern at the end of a
            # retracement is an entry; the same pattern at the extreme of
            # an extended leg is the market running out of people to fill.
            factor = max(2, int(self.params.get("htf_factor", 4) or 4))
            higher = resample(frame, factor)
            state = structure_state(higher, 2)
            if state.bias not in {"bull", "bear"}:
                return self.decline("higher timeframe has no structure yet")
            if (state.bias == "bull") != (side == "buy"):
                return self.decline(
                    "the pattern is against the higher timeframe", f"{state.bias} vs {side}"
                )
            leg = impulse_leg(higher, state)
            if not leg.ok:
                return self.decline("no impulse leg to measure the pullback on")
            lo = float(self.params.get("min_pullback", 0.25) or 0.0)
            hi = float(self.params.get("max_pullback", 0.95) or 1.0)
            if leg.retracement < lo:
                return self.decline("no pullback yet", f"{leg.retracement:.0%} of the leg")
            if leg.retracement > hi:
                return self.decline("the leg is broken, not pulling back", f"{leg.retracement:.0%}")
        # The pattern has to be at a level that means something.
        high, low = swing_levels(frame, 20)
        reach = atr * float(self.params.get("structure_atr") or 1.2)
        if atr > 0:
            near_support = abs(price - low) <= reach
            near_resistance = abs(high - price) <= reach
            strict = bool(self.params.get("require_level_touch", True))
            if side == "buy" and not (near_support or (price > high and not strict)):
                return self.decline("the pattern is not at a level")
            if side == "sell" and not (near_resistance or (price < low and not strict)):
                return self.decline("the pattern is not at a level")
        sl, tp = risk_levels(
            side,
            price,
            atr,
            float(self.params["sl_atr"]),
            float(self.params["tp_atr"]),
            float(self.params.get("min_rr") or 1.3),
            (high, low),
        )
        self.accepted()
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
