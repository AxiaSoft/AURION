"""The robot on its own, with no strategy underneath it.

Asked for: "the robot can trade without a strategy — put it in the
backtest too, so we can see how the robot trades independently of the
strategies."

Everywhere else in this product the AI is a filter and never a source of
signals: a strategy decides, and the model is allowed to veto. That rule
is deliberate and it stays. This is the one place the model is asked the
other question — *if nobody else had an opinion, what would you have
done?* — and it is a REPLAY ONLY. It is not in BUILTIN_NAMES, it cannot
be added to the live book, and nothing in the running engine can reach
it: the only way in is a backtest asking for ``{"kind": "robot"}``.

How it decides
--------------
One input, on purpose: ``ctx.ai``, which is the same read the live desk
shows on the intelligence page. A direction, a confidence, and the
market state the confidence was scaled by. It enters when the model is
trained, says bull or bear, and clears the confidence floor; it sizes
the stop from the ATR with the same structure-aware helper the built-ins
use, so the money arithmetic is comparable with theirs; and it leaves
the trade to that stop and target unless the model turns around, which
closes it.

What it does NOT do
-------------------
It does not peek. ``learns = True`` tells the backtester to train the
brain forward through the run — on the bars already replayed and never
on the bars ahead — and to do it in a throwaway model directory, so a
replay can neither read the desk's live model's future nor overwrite it.

A run where the model never became ready is a legitimate answer and it
says so rather than quietly reporting zero trades: every refusal is
counted through ``decline()``, which is what the result's refusal report
is built from.
"""
from __future__ import annotations

from typing import Any

from ..ai.features import candles_to_frame
from .base import BaseStrategy, StrategyContext, StrategySignal
from .builtin._confluence import atr_value, risk_levels, swing_levels


class RobotSolo(BaseStrategy):
    """The AI's own read, traded directly. Backtest only."""

    name = "robot"
    version = "1.0.0"
    language = "en"

    evidence = {
        "state": "unmeasured",
        "basis": "the robot's own read of the market; what it is worth depends "
                 "entirely on what the model has learned on this symbol",
    }

    #: Tell the backtester to train the brain as the replay moves, in a
    #: throwaway model directory. Without it a replay would be scored by
    #: whatever the desk's live model happens to know today, which is a
    #: different question and is not reproducible.
    learns = True

    #: Enough bars before the first decision for the model to have been
    #: trained at all: min_bars_to_train is 160 and the feature frame
    #: drops its own indicator warmup on top of that.
    warmup_bars = 400

    #: The AI reads the last bar of what it is handed and every feature
    #: is causal, so a window keeps a long replay linear.
    history_window = 1500

    params: dict[str, Any] = {
        # The quality floor. The default is the factory value of the
        # live setting this mirrors -- runtime.min_ai_confidence, "the
        # minimum confidence for a robot entry" on the Robot page -- and
        # a backtest started from the desk overrides it with whatever
        # the trader has that setting on, so the replay answers for the
        # robot they are actually running rather than for a default.
        "min_confidence": 0.35,
        "volume": 0.10,
        "sl_atr": 1.6,
        "tp_atr": 2.4,
        "min_rr": 1.6,
        # Close on a reversal rather than sit through it. The model is
        # the only thing in the trade; when it changes its mind there is
        # nothing else holding the position open.
        "flip_on_reverse": True,
        "stop_buffer_atr": 0.15,
        "stop_floor": 0.6,
        "stop_ceiling": 1.8,
    }

    def on_candle(self, ctx: StrategyContext) -> StrategySignal | None:
        ai = ctx.ai or {}
        if not ai:
            return self.decline("the robot has no read of this bar")
        if not ai.get("ready"):
            return self.decline("the robot has not learned this market yet")

        direction = str(ai.get("direction") or "neutral")
        confidence = float(ai.get("confidence") or 0.0)
        side = "buy" if direction == "bull" else "sell" if direction == "bear" else ""
        pos = ctx.position()

        if bool(self.params.get("flip_on_reverse", True)) and pos and side:
            holding = str(pos.get("type") or "")
            if (holding == "buy" and side == "sell") or (holding == "sell" and side == "buy"):
                return StrategySignal(
                    "close", ctx.symbol,
                    reason="the robot turned around", comment="AURION robot",
                )

        if not side:
            return self.decline("the robot sees no direction")
        floor = float(self.params.get("min_confidence") or 0.0)
        if confidence < floor:
            return self.decline("below the robot's confidence floor",
                                f"{confidence:.2f} < {floor:.2f}")

        frame = candles_to_frame(ctx.candles)
        if len(frame) < 60:
            return self.decline("not enough history")
        price = float(frame["close"].iloc[-1])
        atr_now = atr_value(frame)
        if price <= 0 or atr_now <= 0:
            return self.decline("no usable price or volatility on this bar")

        self.accepted()
        sl, tp = risk_levels(
            side,
            price,
            atr_now,
            float(self.params["sl_atr"]),
            float(self.params["tp_atr"]),
            float(self.params.get("min_rr") or 1.3),
            swing_levels(frame, 20),
            buffer_atr=float(self.params.get("stop_buffer_atr", 0.15) or 0.0),
            floor=float(self.params.get("stop_floor", 0.6) or 0.6),
            ceiling=float(self.params.get("stop_ceiling", 1.8) or 1.8),
        )
        return StrategySignal(
            side,
            ctx.symbol,
            volume=float(self.params["volume"]),
            sl=sl,
            tp=tp,
            price=price,
            confidence=confidence,
            reason=f"the robot's own read: {direction} at {confidence:.2f}",
            comment="AURION robot",
            extra={"atr": atr_now, "entry": price, "setup": "robot"},
        )
