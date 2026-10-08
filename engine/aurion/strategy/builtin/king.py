from __future__ import annotations

from typing import Any

from ...ai.features import candles_to_frame
from ..base import BaseStrategy, StrategyContext, StrategySignal
from ._confluence import atr_value, entry_allowed, rsi_value
from ._structure import (
    Displacement,
    Zone,
    fair_value_gaps,
    liquidity_target,
    order_block,
    resample,
    structure_state,
    swept_liquidity,
)


class King(BaseStrategy):
    """Trade with the higher timeframe, from a discount, after the break.

    This replaces ``scalp_impulse``, and the reason it exists is the reason
    that one was retired: a strategy that fires on a single broken high takes
    every entry at the worst price in the leg. It is right about direction
    surprisingly often and still loses, because the stop has to sit where the
    move started and the move already happened.

    King will not enter until five separate things agree, and each one is
    rejected with a named reason so the journal can say which:

    1. **Higher-timeframe structure.** The entry chart is aggregated up
       (M15 to H1 by default) and only its swing structure sets direction.
       No moving average decides anything here.
    2. **Discount, not premium.** Longs only in the lower half of the
       dealing range, shorts only in the upper half. This one filter is what
       stops the strategy buying the top.
    3. **A break on the entry chart, in the same direction** — a close
       beyond the last swing, never an intrabar poke through it.
    4. **Displacement.** The leg that did the breaking has to be worth a real
       multiple of ATR. Slow grinds across a level get reclaimed.
    5. **A zone to enter from.** An unmitigated fair-value gap, or failing
       that the last opposing candle before the leg. Price has to be *in* it.
       No zone, no trade: that is the whole difference between an entry and
       a chase.

    The stop then goes beyond whatever would invalidate the idea, the target
    goes to the next pool of liquidity rather than a round multiple, and the
    ticket is dropped if the two do not add up to ``min_rr``. Fewer signals
    than the strategy it replaces, by design, and each one carries the levels
    that justify it in ``extra`` so the desk can draw them.
    """

    name = "king"
    version = "1.0.0"
    language = "en"
    params: dict[str, Any] = {
        "volume": 0.10,
        # Structure
        "htf_factor": 4,
        "htf_swing": 2,
        "swing_k": 2,
        # The entry-chart confirmation looks at a trailing window, not at the
        # whole series. It has to: during a pullback the swing that matters is
        # the micro one inside the pullback, and measuring against the swing
        # that set the whole trend would ask price to make a new extreme —
        # which is the opposite of entering from a discount.
        "ltf_window": 40,
        "require_ltf_break": True,
        "allow_choch": True,
        # Where in the range we are willing to deal. 0.5 = strictly the
        # discount half for longs. Raising it buys more expensively.
        "max_discount": 0.5,
        # Displacement, measured on the higher-timeframe leg that set the
        # bias — NOT on the entry bar. The entry bar is the turn at the end of
        # a pullback; it is small by definition, and asking it to be large is
        # asking to enter after the move instead of before it.
        "min_leg_atr": 1.5,
        # Entry zone
        "require_zone": True,
        "zone_pad_atr": 0.25,
        "zone_lookback": 30,
        # Risk
        "sl_buffer_atr": 0.25,
        "max_risk_atr": 3.0,
        "min_rr": 2.0,
        "tp_atr": 3.0,
        # Shared gate. The slow-trend and momentum filters are off on purpose:
        # structure already answers direction, better, and MACD on the entry
        # chart disagrees with precisely the pullback entries worth taking.
        "min_atr_pct": 0.0003,
        "require_volatility": True,
        "with_trend": False,
        "require_momentum": False,
        "min_efficiency": 0.0,
        "require_ai_agree": False,
    }

    # ---------------------------------------------------------------- entry

    def on_candle(self, ctx: StrategyContext) -> StrategySignal | None:
        frame = candles_to_frame(ctx.candles)
        htf_factor = max(1, int(self.params.get("htf_factor") or 4))
        # Enough for the higher timeframe to have its own structure, not just
        # enough for the entry chart.
        if len(frame) < max(80, htf_factor * 20):
            return None

        close = float(frame["close"].iloc[-1])
        atr = atr_value(frame, 14)
        if close <= 0 or atr <= 0:
            return None

        # 1. Direction belongs to the higher timeframe, and nothing else.
        htf = resample(frame, htf_factor)
        htf_state = structure_state(htf, int(self.params.get("htf_swing") or 2))
        if htf_state.bias not in {"bull", "bear"}:
            return None
        side = "buy" if htf_state.bias == "bull" else "sell"

        # An opposing position is closed before anything else is considered.
        # Holding a long through a confirmed bearish higher-timeframe break
        # while opening a short is how an account ends up hedged by accident.
        pos = ctx.position()
        if pos and pos.get("type"):
            if pos.get("type") != side:
                return StrategySignal(
                    "close",
                    ctx.symbol,
                    reason=f"higher timeframe turned {htf_state.bias} against the open {pos.get('type')}",
                    comment="AURION king",
                )
            # Already in, same way. Adding to a winner is a position-sizing
            # decision, not a signal, and emitting one every bar of a
            # retracement is how an account ends up five times its intended
            # size in a single leg.
            return None

        # 2. Premium / discount.
        eq = htf_state.equilibrium(close)
        limit = float(self.params.get("max_discount") or 0.5)
        if side == "buy" and eq > limit:
            return None
        if side == "sell" and eq < (1.0 - limit):
            return None

        # 3. The entry chart has to confirm, with a close, inside the pullback.
        window = int(self.params.get("ltf_window") or 40)
        tail = frame.iloc[-window:] if len(frame) > window else frame
        ltf_state = structure_state(tail, int(self.params.get("swing_k") or 2))
        if self.params.get("require_ltf_break", True):
            if ltf_state.bias != htf_state.bias:
                return None
            allowed = {"bos", "choch"} if self.params.get("allow_choch", True) else {"bos"}
            if ltf_state.event not in allowed:
                return None

        # 4. Was the leg that set the bias worth anything?
        disp = self._leg_strength(htf, htf_state)
        if not disp.ok:
            return None

        # 5. A zone to enter from.
        pad = atr * float(self.params.get("zone_pad_atr") or 0.25)
        zone = self._entry_zone(frame, side, close, pad)
        if zone is None and self.params.get("require_zone", True):
            return None

        # The shared gate still has the last word on volatility, exhaustion
        # and the AI veto, so one strategy cannot quietly opt out of the
        # account-wide protections.
        ok, why = entry_allowed(frame, side, self.params, ctx.ai or {})
        if not ok:
            return None

        sl, tp, risk, reward = self._levels(frame, side, close, atr, zone, ltf_state)
        if risk <= 0 or reward <= 0:
            return None
        rr = reward / risk
        if rr < float(self.params.get("min_rr") or 2.0):
            return None

        swept = swept_liquidity(frame, side, int(self.params.get("swing_k") or 2))
        confidence = self._confidence(htf_state, disp, zone, rr, eq, swept)

        return StrategySignal(
            side,
            ctx.symbol,
            volume=float(self.params.get("volume") or 0.10),
            sl=round(sl, 6),
            tp=round(tp, 6),
            confidence=confidence,
            reason=self._reason(side, htf_state, ltf_state, disp, zone, eq, rr, swept, why),
            comment="AURION king",
            extra={
                "strategy": self.name,
                "playbook": "king",
                "htf_bias": htf_state.bias,
                "htf_event": htf_state.event,
                "ltf_event": ltf_state.event,
                "equilibrium": round(eq, 3),
                "leg_atr": disp.strength,
                "bars_since_break": htf_state.bars_since_break,
                "zone": {"kind": zone.kind, "low": round(zone.low, 6), "high": round(zone.high, 6)}
                if zone
                else None,
                "swept_liquidity": swept,
                "risk": round(risk, 6),
                "reward": round(reward, 6),
                "rr": round(rr, 2),
                "entry": round(close, 6),
                "atr": round(atr, 6),
            },
        )

    # ------------------------------------------------------------- internals

    def _leg_strength(self, htf, state) -> Displacement:
        """How big was the higher-timeframe move, in its own ATR?

        A break of a swing that only travelled half an ATR is noise crossing
        a line. Measuring the whole dealing range rather than a fixed number
        of bars is what makes this independent of how long the leg took.
        """
        atr_htf = atr_value(htf, 14)
        if atr_htf <= 0:
            return Displacement(note="no higher-timeframe atr")
        leg = max(0.0, state.range_high - state.range_low)
        strength = leg / atr_htf
        floor = float(self.params.get("min_leg_atr") or 1.5)
        if strength < floor:
            return Displacement(False, round(strength, 3), 0, f"the leg is only {strength:.2f} ATR")
        return Displacement(True, round(strength, 3), max(0, state.bars_since_break), f"{strength:.2f} ATR leg")

    def _entry_zone(self, frame, side: str, price: float, pad: float) -> Zone | None:
        """The imbalance or order block price is currently sitting in."""
        lookback = int(self.params.get("zone_lookback") or 30)
        for gap in reversed(fair_value_gaps(frame, side, lookback)):
            if gap.contains(price, pad):
                return gap
        block = order_block(frame, side, lookback)
        if block and block.contains(price, pad):
            return block
        return None

    def _levels(self, frame, side: str, price: float, atr: float, zone: Zone | None, ltf) -> tuple[float, float, float, float]:
        """Stop beyond what invalidates the idea; target the next liquidity.

        The stop is not an ATR multiple. It is the far edge of the zone, or
        the swing that would prove the read wrong, whichever is further —
        plus a buffer, because the level everybody can see is the level that
        gets wicked.
        """
        buffer = atr * float(self.params.get("sl_buffer_atr") or 0.25)

        if side == "buy":
            invalidation = min(
                x for x in (zone.low if zone else price, ltf.swing_low or price, price) if x > 0
            )
            sl = invalidation - buffer
            risk = price - sl
        else:
            invalidation = max((zone.high if zone else price, ltf.swing_high or price, price))
            sl = invalidation + buffer
            risk = sl - price

        # A stop that far away is not a trade, it is a position. Refusing is
        # better than silently sizing into it.
        if risk <= 0 or risk > atr * float(self.params.get("max_risk_atr") or 3.0):
            return 0.0, 0.0, 0.0, 0.0

        pool = liquidity_target(frame, side, price, int(self.params.get("swing_k") or 2), atr * 0.2)
        if pool > 0:
            reward = (pool - price) if side == "buy" else (price - pool)
            # Stop just short of the pool: the fill happens on the way into
            # it, not at the far side of everybody else's stops.
            reward = max(0.0, reward - atr * 0.1)
        else:
            reward = 0.0
        floor = max(atr * float(self.params.get("tp_atr") or 3.0), risk * float(self.params.get("min_rr") or 2.0))
        if reward < floor * 0.5:
            # No usable pool, or one so close it would not pay. Fall back to
            # the multiple rather than taking a bad target.
            reward = floor

        tp = price + reward if side == "buy" else price - reward
        return sl, tp, risk, reward

    def _confidence(self, htf, disp, zone: Zone | None, rr: float, eq: float, swept: bool) -> float:
        """How many of the confluences actually turned up.

        Deliberately additive and bounded rather than a fitted score: the
        desk's ``min_signal_quality`` slider is only meaningful if the number
        behind it means something a human can reconstruct.
        """
        score = 0.42
        score += 0.14 if htf.event == "bos" else 0.09 if htf.event == "choch" else 0.0
        score += 0.12 * min(1.0, disp.strength / 2.0)
        score += 0.08 if zone and zone.kind == "fvg" else 0.04 if zone else 0.0
        score += 0.10 if swept else 0.0
        # Depth into the discount, for a long: 0 at equilibrium, 1 at the low.
        depth = (0.5 - eq) * 2 if eq <= 0.5 else (eq - 0.5) * 2
        score += 0.08 * max(0.0, min(1.0, depth))
        score += 0.10 * min(1.0, rr / 3.0)
        return round(min(0.99, score), 3)

    def _reason(self, side, htf, ltf, disp, zone: Zone | None, eq: float, rr: float, swept: bool, why: str) -> str:
        """Say what was actually agreed on, in the order it was checked."""
        where = "discount" if eq <= 0.5 else "premium"
        bits = [
            f"{self.params.get('htf_factor')}x higher timeframe is {htf.bias} ({htf.event or 'ranging'})",
            f"price in {where} at {eq:.0%} of range",
            f"entry chart {ltf.event or 'aligned'}",
            f"{disp.strength:.1f} ATR leg",
        ]
        if zone:
            bits.append(f"into the {'imbalance' if zone.kind == 'fvg' else 'order block'} {zone.low:.5f}-{zone.high:.5f}")
        if swept:
            bits.append("after a liquidity sweep")
        bits.append(f"{rr:.1f}R to the next pool")
        if why and why != "filters clear":
            bits.append(why)
        return " — ".join(bits)

    # Exposed so the desk can explain the strategy without duplicating this
    # text in three languages of UI copy.
    def describe(self) -> dict[str, Any]:
        base = super().describe()
        base["summary"] = (
            "Higher-timeframe structure sets direction; entries are taken only "
            "from a discount, inside an imbalance, after a displacement break, "
            "with the stop beyond invalidation and the target at liquidity."
        )
        base["checks"] = [
            "higher-timeframe break of structure",
            "premium / discount",
            "entry-chart break on a close",
            "displacement in ATR",
            "unmitigated imbalance or order block",
            "minimum reward-to-risk",
        ]
        return base
