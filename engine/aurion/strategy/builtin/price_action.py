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
    This is the weakest of the four built-ins and it is not going to be
    dressed up. Measured on scripts/strategy-xray.py - five instruments,
    2 200 M15 bars each, the AI frozen so only the rules move, spread and
    commission not modelled - across a six-seed tuning set and an eight-
    seed set that was never tuned on:

        arm                                   tuning        held out
        as it shipped                        -0.259R       -0.223R
        higher-timeframe filter              -0.254R          -
        pullback filter                      -0.218R          -
        reversal patterns only               -0.240R          -
        continuation patterns only           -0.318R          -
        min_score 0.72                       -0.207R          -
        wider target / tighter stop          -0.261R / -0.253R
        wider stop buffer, higher floor      -0.259R / -0.252R
        level that already held              -0.196R       -0.163R
        trend read at 21/55                  -0.146R       -0.152R
        both of the last two                 -0.168R       -0.099R

    Sixteen arms, every one of them negative. The last line is what
    ships: it is the only change that improved both samples at once, and
    it roughly halves the loss. It is still a loss.

    Why it was losing is worth writing down, because it was not bad luck.
    ``swing_levels`` measured its window up to and including the bar
    being traded, so "the pattern is at support" was true exactly when
    price was *making* a new 20-bar low - a level that is breaking, not
    one that has held - and the strategy bought it. Meanwhile
    ``with_trend`` was reading a 50/200 EMA pair, which on this
    timeframe has no opinion about the last twenty bars at all. So the
    two gates that were supposed to agree were measuring different
    markets, and the binding one was buying falling knives. ``skip`` on
    swing_levels and a 21/55 trend read are both fixes to that, and both
    helped - which is the evidence that the diagnosis is right.

    What it does not fix: run the same test with every entry taken on
    the opposite side and the result is +0.440R on the tuning seeds and
    +0.475R on the held-out ones, profit factor 2.2 and 2.4. A rule that
    is reliably wrong is still information, and the honest reading is
    that a candle pattern at a 20-bar extreme in these markets is a
    continuation signal being traded as a reversal. That is not shipped,
    for two reasons: inverting a rule to fit a synthetic generator is
    curve-fitting with extra steps, and the costs that would eat most of
    a 0.4R edge are not in the model.

    So it ships honest rather than over-fitted, and the strategy card now
    says so in the trader's own language before the switch is touched
    (BaseStrategy.evidence). The defaults are the plain ones; the
    stricter ideas are all here as switches - ``require_htf``,
    ``require_pullback``, ``pattern_kinds``, ``require_level_touch`` -
    for a trader who wants the pattern only as a confirmation of
    something they have already decided. Treat it as a second opinion,
    not as a robot you leave alone with an account.
    """

    evidence = {
        "state": "negative",
        "trades": 590,
        "win": 0.388,
        "pf": 0.81,
        "expectancy": -0.099,
        "basis": "8 seeds x 5 instruments x 2 200 M15 bars of seeded synthetic market (scripts/strategy-xray.py), frozen AI, spread and commission not modelled",
    }
    name = "price_action"
    version = "2.1.0"

    # Nothing here reaches further back than the slow EMA, the RSI and
    # the ATR, all of which are well inside a hundred bars. Declaring the
    # window keeps a thirty-day replay linear instead of quadratic; the
    # A/B that proved the results are byte-identical either way is in
    # engine/tests/test_backtest_window.py.
    history_window = 1500
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
        # Read the trend at the scale the level is measured on. The
        # shared default is 50/200, which on M15 says nothing about the
        # last twenty bars - so "with the trend" and "at a level" were
        # answers about two different markets. 21/55 with a lower block
        # threshold took the strategy from -0.259R to -0.146R on the
        # tuning seeds and -0.223R to -0.152R on held-out seeds.
        "trend_fast": 21,
        "trend_slow": 55,
        "counter_trend_block": 0.2,
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
        # How the stop is drawn once recent structure is taken into
        # account - see risk_levels(). Today's values, named so they can
        # be measured rather than guessed at.
        # Leave the newest bars out of the level the pattern has to sit
        # at. With 0 the window ends on the bar being traded, so "at
        # support" means "making a new low right now" - a level that is
        # breaking. With 4 it means a low that was already there and
        # that price has come back to, which is what support is. On its
        # own: -0.259R to -0.196R tuning, -0.223R to -0.163R held out.
        # Together with the 21/55 trend read: -0.168R and -0.099R.
        "level_skip": 4,
        "stop_buffer_atr": 0.15,
        "stop_floor": 0.6,
        "stop_ceiling": 1.8,
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
        high, low = swing_levels(frame, 20, int(self.params.get("level_skip", 0) or 0))
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
            buffer_atr=float(self.params.get("stop_buffer_atr", 0.15) or 0.0),
            floor=float(self.params.get("stop_floor", 0.6) or 0.6),
            ceiling=float(self.params.get("stop_ceiling", 1.8) or 1.8),
        )
        self.accepted()
        confidence = min(0.99, 0.45 * score + 0.3 + 0.25 * efficiency(frame))
        # This strategy only takes a pattern that is *at* a level - it
        # refuses one that is not - so the level is the honest place to
        # rest the order: support for a long, resistance for a short.
        # The zone runs from that level to the market, and the planner's
        # depth setting decides how far back into it to wait.
        level = low if side == "buy" else high
        extra: dict[str, Any] = {"atr": atr, "entry": price, "setup": pattern.get("name") or "pattern"}
        if level > 0 and atr > 0:
            extra["zone"] = {"low": min(level, price), "high": max(level, price)}
        return StrategySignal(
            side,
            ctx.symbol,
            volume=float(self.params["volume"]),
            sl=sl,
            tp=tp,
            reason=f"{pattern.get('reason') or pattern['name']} — {why}",
            comment="AURION pa",
            confidence=round(confidence, 3),
            extra=extra,
        )
