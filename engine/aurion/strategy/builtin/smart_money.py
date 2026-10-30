from __future__ import annotations

from typing import Any

from ...ai.features import candles_to_frame
from ..base import BaseStrategy, StrategyContext, StrategySignal
from ._confluence import atr_value, efficiency, entry_allowed, risk_levels
from ._structure import (
    Zone,
    displacement,
    fair_value_gaps,
    impulse_leg,
    liquidity_target,
    order_block,
    resample,
    structure_state,
    swings,
    swept_liquidity,  # noqa: F401  (the reference _recent_sweep is pinned to)
)


class SmartMoney(BaseStrategy):
    """Liquidity sweep, displacement, then the retrace into the zone it left.

    The sequence this trades is one idea, not five filters bolted together,
    and it only means anything in order:

    1. **A pool of liquidity is taken.** Price runs a swing high or low --
       the obvious level everyone's stop is sitting behind -- and closes
       back inside it. On its own this is just a wick.
    2. **Displacement follows, the other way.** The bars after the sweep
       move hard enough, in ATR, to say the move was not a slow drift that
       happened to cross a level. This is what separates a stop hunt from
       a genuine break that will be reclaimed within the hour.
    3. **That move leaves a zone behind.** A fast move leaves an imbalance
       (a three-bar fair value gap) or the order block that caused it.
       Both are prices that were skipped rather than traded.
    4. **Price comes back to the zone.** The entry is the retrace, not the
       displacement. Chasing the displacement is how this family of ideas
       usually loses: the stop has to go behind the sweep either way, so
       entering 1.5 ATR later turns a 2R into a 0.8R.
    5. **And the entry is on the right side of the range.** Longs in the
       discount half of the impulse leg, shorts in the premium half.

    The target is structural: ``liquidity_target`` finds the next pool of
    stops in the direction of travel, because that is what the move is
    actually reaching for. Only when there is no such pool does it fall
    back to an ATR multiple.

    What the measurements say, plainly
    ----------------------------------
    It has been measured, and it has **no measurable edge**. Over 158
    trades on five instruments the average was -0.066R with a 95%
    interval of -0.245R to +0.114R, which straddles zero: the sample
    cannot tell this apart from a coin toss, and costs are not modelled
    on top of that. See ``MEASURED`` at the bottom of this file for the
    full numbers and the exact command.

    That is the same answer the other three built-ins give, and it is
    reported rather than tuned away. The defaults here were chosen from
    the reasoning above and measured once; they have deliberately not
    been searched against this data, because a parameter picked because
    it scored well on the sample you are about to quote is not a finding.

    The one thing the numbers do say clearly is that the structure-flip
    exit loses money (16 trades, -0.441R each) -- the same defect already
    recorded in ``ema_rsi``. That is the next thing to measure a fix for.

    So: treat this as a second opinion and a well-defined setup detector,
    not as a robot to leave alone with an account.

    The pieces are all switchable (``require_sweep``, ``require_displacement``,
    ``require_zone``, ``require_htf``, ``require_discount``) so the sequence
    can be relaxed one step at a time and the effect measured, rather than
    being a black box that either fires or does not.
    """

    name = "smart_money"
    version = "1.0.0"
    language = "en"
    params: dict[str, Any] = {
        "volume": 0.10,
        # --- the sequence ------------------------------------------------
        "swing_k": 2,
        # The whole sequence -- sweep, displacement, retrace -- plays out
        # over bars, not on one. This is how far back the sweep and the
        # displacement are still allowed to be when price finally arrives
        # back at the zone. Beyond it the market has moved on and the zone
        # is stale.
        "setup_bars": 20,
        # The sweep itself: how many bars of the run-and-reclaim.
        "sweep_bars": 3,
        "require_sweep": True,
        # Displacement in ATR across `disp_bars`. 1.0 is roughly "one
        # average bar's worth of net travel per bar", which is brisk.
        "require_displacement": True,
        "disp_bars": 3,
        "min_displacement": 1.0,
        # --- the zone ----------------------------------------------------
        "require_zone": True,
        "fvg_lookback": 30,
        "ob_lookback": 20,
        # The zone is a band, not a line. Price within this much ATR of its
        # edge counts as a touch, otherwise a one-tick miss voids a setup
        # that was obviously valid on the chart.
        "zone_pad_atr": 0.15,
        # --- which side of the range -------------------------------------
        "require_discount": True,
        # Longs below this point of the leg, shorts above its mirror. 0.5
        # is the textbook midpoint; a little above it allows the entry that
        # is marginally the wrong side of a line nobody can see.
        "equilibrium": 0.62,
        # --- bias ----------------------------------------------------------
        "require_htf": True,
        "htf_factor": 4,
        # --- risk ----------------------------------------------------------
        # The stop goes behind the sweep's extreme, plus a buffer, because
        # that is the price that invalidates the idea. sl_atr is only the
        # fallback when there is no sweep extreme to use.
        "sl_atr": 1.3,
        "tp_atr": 2.6,
        "sl_buffer_atr": 0.25,
        # The stop goes behind the sweep, which is further away than an ATR
        # multiple would put it, so the same chart target is a smaller
        # multiple here than on the other built-ins. 2.0 rejected about
        # half of the setups that had passed everything else.
        "min_rr": 1.5,
        # A structural target closer than this much ATR is not worth the
        # spread; fall back to the multiple instead.
        "min_target_atr": 1.0,
        # --- shared confluence gate ----------------------------------------
        "with_trend": False,  # the HTF check above already does this job
        "require_momentum": False,
        "require_volatility": True,
        "min_atr_pct": 0.0003,
        "min_efficiency": 0.0,
        "min_ai_confidence": 0.0,
    }

    # ------------------------------------------------------------------ bias

    def _htf_bias(self, frame: Any) -> str:
        """Structure on the higher timeframe: who is in control up there."""
        factor = int(self.params.get("htf_factor") or 4)
        if factor < 2:
            return "neutral"
        htf = resample(frame, factor)
        if len(htf) < 30:
            # Not enough higher-timeframe history to have an opinion.
            # Returning "neutral" would block every trade; the caller
            # treats this as "no objection" instead.
            return ""
        return structure_state(htf, int(self.params.get("swing_k") or 2)).bias

    # --------------------------------------------------------------- recent

    def _recent_sweep(self, frame: Any, side: str, k: int) -> int:
        """How many bars ago liquidity was taken, or -1.

        ``swept_liquidity`` answers "did the LAST few bars sweep", which is
        the wrong question here: by the time price has retraced into the
        zone the sweep is ten or more bars behind. The right question is
        "was there a sweep recently", and the obvious way to ask it is to
        call that helper once per end-point going back.

        That is what this did, and it cost about sixty percent of the
        strategy's total runtime: twenty-one calls per bar, each one
        re-deriving the same fractal pivots. It does not have to.
        A pivot is confirmed by its ``k`` neighbours on each side, so the
        pivots of ``frame[:m]`` are exactly the pivots of ``frame``
        with index <= m - k - 1 -- a prefix, not a different answer. So
        the pivots are derived once and the end-points are walked over
        the result.

        ``test_recent_sweep_matches_the_helper_it_replaces`` pins this to
        ``swept_liquidity`` bar for bar, so the shortcut cannot drift
        away from the definition it is supposed to be implementing.
        """
        bars = int(self.params.get("sweep_bars") or 3)
        look = int(self.params.get("setup_bars") or 20)
        n = len(frame)
        points = swings(frame, k)
        if not points:
            return -1
        want = "low" if side == "buy" else "high"
        marks = [(s.index, s.price) for s in points if s.kind == want]
        if not marks:
            return -1
        lows = frame["low"].to_numpy()
        highs = frame["high"].to_numpy()
        closes = frame["close"].to_numpy()
        for ago in range(0, look + 1):
            end = n - ago
            if end < 2 * k + bars + 2:
                break
            cut = end - bars
            limit = cut - k - 1
            seen = [price for idx, price in marks if idx <= limit]
            if not seen:
                continue
            close = float(closes[end - 1])
            if side == "buy":
                level = max(seen)
                if float(lows[cut:end].min()) < level <= close:
                    return ago
            else:
                level = min(seen)
                if float(highs[cut:end].max()) > level >= close:
                    return ago
        return -1

    def _recent_displacement(self, frame: Any, side: str, atr: float, since: int) -> Any:
        """The strongest displacement between the sweep and now.

        Measured at every end-point from the sweep forward, because during
        the retrace the last three bars travel *against* the side -- asking
        only about them would reject every setup at exactly the moment it
        becomes tradable.
        """
        bars = int(self.params.get("disp_bars") or 3)
        floor = float(self.params.get("min_displacement") or 1.0)
        best = displacement(frame, side, atr, bars, floor)
        for ago in range(1, max(1, since) + 1):
            sub = frame.iloc[:-ago]
            if len(sub) < bars + 2:
                break
            d = displacement(sub, side, atr, bars, floor)
            if d.strength > best.strength:
                best = d
        return best

    # ------------------------------------------------------------------ zone

    def _zone(self, frame: Any, side: str, close: float, atr: float) -> Zone | None:
        """The nearest unmitigated zone price could be returning into.

        A fair value gap is preferred over an order block: the gap is the
        imbalance the displacement actually created, while the order block
        is an inference about which candle caused it.
        """
        pad = atr * float(self.params.get("zone_pad_atr") or 0.15)
        gaps = fair_value_gaps(frame, side, int(self.params.get("fvg_lookback") or 30))
        # Newest first - the most recent imbalance is the one this move left.
        for gap in reversed(gaps):
            if gap.contains(close, pad):
                return gap
        block = order_block(frame, side, int(self.params.get("ob_lookback") or 20))
        if block is not None and block.contains(close, pad):
            return block
        return None

    # ------------------------------------------------------------------ risk

    def _stop(self, frame: Any, side: str, close: float, atr: float, zone: Zone | None) -> float:
        """Behind the thing that would prove the idea wrong.

        For a long that is the low of the sweep (and of the zone, if there
        is one): if price trades back below it, the sweep was not a sweep.
        The ATR multiple is only a floor, so a very tight zone cannot
        produce a stop that any normal wick removes.
        """
        buffer = atr * float(self.params.get("sl_buffer_atr") or 0.25)
        bars = int(self.params.get("setup_bars") or 20)
        recent = frame.iloc[-bars - 1 :]
        if side == "buy":
            level = float(recent["low"].min())
            if zone is not None:
                level = min(level, zone.low)
            stop = level - buffer
            floor = close - atr * float(self.params["sl_atr"])
            return min(stop, close - buffer) if stop < close else floor
        level = float(recent["high"].max())
        if zone is not None:
            level = max(level, zone.high)
        stop = level + buffer
        ceiling = close + atr * float(self.params["sl_atr"])
        return max(stop, close + buffer) if stop > close else ceiling

    # ---------------------------------------------------------------- candle

    def on_candle(self, ctx: StrategyContext) -> StrategySignal | None:
        frame = candles_to_frame(ctx.candles)
        k = int(self.params.get("swing_k") or 2)
        need = max(60, int(self.params.get("fvg_lookback") or 30) + 30)
        if len(frame) < need:
            return self.decline("not enough history", f"{len(frame)} bars")

        close = float(frame.iloc[-1]["close"])
        atr = atr_value(frame)
        if close <= 0 or atr <= 0:
            return self.decline("no price or no ATR yet")
        if atr / close < float(self.params["min_atr_pct"]):
            return self.decline("too quiet for a displacement",
                                f"ATR {atr / close:.4%} of price")

        state = structure_state(frame, k)
        if state.bias not in ("bull", "bear"):
            return self.decline("no structural bias to trade with")
        side = "buy" if state.bias == "bull" else "sell"

        # 0. Never against the higher timeframe.
        if self.params.get("require_htf", True):
            htf = self._htf_bias(frame)
            if htf and htf != "neutral" and htf != state.bias:
                return self.decline("against the higher timeframe", f"HTF {htf}")

        pos = ctx.position()
        if pos and pos.get("type") and pos.get("type") != side:
            return StrategySignal(
                "close", ctx.symbol,
                reason=f"structure flipped to {side} against the open {pos.get('type')}",
                comment="AURION smc",
            )

        # 1. Price being back inside an unmitigated zone is the trigger --
        #    it is what says "the retrace has arrived" -- so it is tested
        #    first. It is also by far the cheapest of the three, which
        #    keeps the backwards scans below off the great majority of
        #    bars.
        zone = self._zone(frame, side, close, atr)
        if self.params.get("require_zone", True) and zone is None:
            return self.decline("price is not back in an unmitigated zone")

        # 2. Liquidity has to have been taken on the way here.
        since = self._recent_sweep(frame, side, k) if self.params.get("require_sweep", True) else 0
        if self.params.get("require_sweep", True) and since < 0:
            return self.decline("no liquidity swept recently")

        # 3. And the move away from it has to have been real.
        disp = self._recent_displacement(frame, side, atr, max(since, 1))
        if self.params.get("require_displacement", True) and not disp.ok:
            return self.decline("the move off the sweep is not a displacement",
                                disp.note or f"{disp.strength:.2f} ATR")

        # 5. On the right side of the range. The impulse leg is used rather
        #    than the dealing range because in an extending trend the range
        #    high IS the current price, and a discount rule measured that
        #    way can never be satisfied -- the strategy would stand aside
        #    through exactly the moves it exists to trade.
        leg = impulse_leg(frame, state)
        if self.params.get("require_discount", True) and leg.ok and leg.size > 0:
            where = (close - leg.low) / leg.size
            limit = float(self.params.get("equilibrium") or 0.62)
            if side == "buy" and where > limit:
                return self.decline("price is premium for a buy", f"{where:.2f}")
            if side == "sell" and where < 1.0 - limit:
                return self.decline("price is discount for a sell", f"{where:.2f}")

        ok, why = entry_allowed(frame, side, self.params, ctx.ai or {})
        if not ok:
            return self.decline(why)

        self.accepted()

        sl = self._stop(frame, side, close, atr, zone)
        risk = abs(close - sl)
        if risk <= 0:
            return self.decline("the stop would sit on the entry")

        # The target is the next pool of stops, when there is one far
        # enough away to be worth the spread.
        min_dist = atr * float(self.params.get("min_target_atr") or 1.0)
        target = liquidity_target(frame, side, close, k, min_dist)
        tp = 0.0
        setup = "sweep + displacement + zone"
        if target > 0:
            reward = abs(target - close)
            if reward / risk >= float(self.params.get("min_rr") or 1.5):
                tp = target
                setup += " -> liquidity"
        if tp <= 0:
            # No usable pool: fall back to the shared multiple, which also
            # enforces min_rr for us.
            _, tp = risk_levels(
                side, close, atr,
                float(self.params["sl_atr"]),
                float(self.params["tp_atr"]),
                float(self.params.get("min_rr") or 1.5),
                (state.swing_high, state.swing_low),
            )
        if tp <= 0:
            return self.decline("no target worth the risk")
        rr = abs(tp - close) / risk
        if rr < float(self.params.get("min_rr") or 1.5):
            return self.decline("reward does not pay for the risk", f"{rr:.2f}R")

        confidence = 0.55 + 0.15 * min(1.0, disp.strength / 2.0) + 0.1 * efficiency(frame)
        if state.event == "choch":
            # A change of character is the stronger of the two events: the
            # sweep took liquidity AND the structure turned on it.
            confidence += 0.08
        if zone is not None and zone.kind:
            confidence += 0.05

        extra: dict[str, Any] = {
            "atr": atr,
            "entry": close,
            "setup": setup,
            "structure": state.event,
            "displacement": round(disp.strength, 3),
        }
        if zone is not None:
            extra["zone"] = {"low": zone.low, "high": zone.high}
            extra["poi"] = zone.kind or "zone"

        return StrategySignal(
            side,
            ctx.symbol,
            volume=float(self.params["volume"]),
            sl=sl,
            tp=tp,
            extra=extra,
            confidence=round(min(0.99, confidence), 3),
            reason=(
                f"{state.event or 'structure'} {state.bias}, liquidity swept, "
                f"{disp.strength:.2f} ATR displacement, price back in "
                f"{(zone.kind or 'zone') if zone is not None else 'range'} "
                f"at {close:.5f} for {rr:.2f}R — {why}"
            ),
            comment="AURION smc",
        )


# ---------------------------------------------------------------------------
# MEASURED
# ---------------------------------------------------------------------------
# Filled in by scripts/strategy-bench.py. Do not edit these numbers by hand
# and do not ship a change to the defaults above without re-running it: a
# strategy's comment claiming an edge it has not been measured to have is
# worse than no comment, because the next person believes it.
MEASURED: dict[str, Any] = {
    "command": (
        "python3 scripts/strategy-bench.py --data <dir> "
        "--pairs EURUSD GBPUSD USDJPY AUDUSD USDCAD "
        "--strategies smart_money --windows 6 --size 3000"
    ),
    "data": (
        "M15 OHLC from TheSnowGuru/Stocks-Futures-Financial-Time-series-"
        "Tick-Bar-Data, forex/<pair>/<PAIR>_M15.csv, history from 2015-09-03"
    ),
    "windows": "5 pairs x 6 non-overlapping windows x 3000 bars, 200 warmup",
    "results": {
        "trades": 158,
        "win_rate": 0.430,
        "profit_factor": 0.88,
        "avg_r": -0.066,
        "total_r": -10.4,
        "profitable_windows": "11/30",
        # The number that actually matters. With 158 trades and a
        # per-trade standard deviation of 1.15R the standard error is
        # 0.092R, so the 95% interval runs from -0.245R to +0.114R.
        "ci95_avg_r": (-0.245, 0.114),
        "exits": {
            "sl": {"n": 102, "avg_r": -0.720},
            "tp": {"n": 40, "avg_r": +1.751},
            "structure_flip": {"n": 16, "avg_r": -0.441},
        },
    },
    # What that means, stated plainly rather than spun:
    #
    # This strategy HAS NO MEASURED EDGE. The interval straddles zero, so
    # the measurement cannot tell it apart from a coin toss -- it is not
    # evidence that it works and not evidence that it does not. It is
    # also slightly negative at the midpoint, and the whole of that comes
    # from one instrument (EURUSD, 27 trades, -0.476R; the other four are
    # between -0.021R and +0.074R), which at that sample size is noise
    # rather than a finding about EURUSD.
    #
    # Selectivity is the reason the sample is small: 158 trades across
    # 90,000 bars, against ~3,000 for ema_rsi on the same windows. Getting
    # an interval tight enough to resolve a 0.05R edge would need roughly
    # ten times the data. That work has not been done, so no claim is
    # made.
    #
    # The one thing the numbers do say clearly is where the leak is: the
    # 16 trades closed by a structure flip lost 0.441R each. That is the
    # same defect already recorded in ema_rsi's flip exit, and it is the
    # first thing to measure a fix for -- not another parameter.
    "verdict": "no measurable edge; interval straddles zero; sample too small",
    "caveat": (
        "Costs are not modelled -- no spread, commission, swap or "
        "slippage -- so every figure here is optimistic, and on a 0.07R "
        "effect the spread alone is the same order of magnitude as the "
        "effect. Do not read any of this as 'profitable'."
    ),
}
