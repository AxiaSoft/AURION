"""Danger guard — fast protective exit when an open trade turns dangerous.

The guard watches every live position tick-by-tick (not just on closed bars)
and scores how dangerous the trade looks right now:

* adverse excursion — how far price moved against the entry, in ATR units
* adverse momentum — the last few bars pushing against the position
* AI opposition — the AI now points the other way with confidence
* floating loss — unrealised loss relative to the account balance

When the score reaches the threshold derived from the user's sensitivity,
the position is closed immediately.  Scoring uses only real MT5 data
(positions, ticks, candles, AI state) — nothing is ever invented.

The guard is hard-disabled while prop rules are enabled: on a challenge
account every exit must go through the prop book, never through this guard.
"""

from __future__ import annotations

from typing import Any

# Score budget (sums to 100).
EXCURSION_W = 40.0
MOMENTUM_W = 25.0
AI_W = 25.0
LOSS_W = 10.0

# Fresh positions get a short grace period so the entry spread alone can
# never trigger an instant close, even at maximum sensitivity.
GRACE_SECONDS = 10.0
# After a guard close attempt, leave the ticket alone for a while so a
# rejected close cannot spin into a close-request loop.
COOLDOWN_SECONDS = 30.0

ATR_PERIOD = 14
MOMENTUM_BARS = 3


def clamp_sensitivity(value: Any, default: int = 50) -> int:
    try:
        v = int(round(float(value)))
    except (TypeError, ValueError):
        v = default
    return max(1, min(100, v))


def threshold_for(sensitivity: Any) -> float:
    """Close threshold for a sensitivity of 1..100.

    Higher sensitivity = lower threshold = the guard fires sooner.
    Sensitivity 50 (default) needs a score of 50; sensitivity 90 fires
    on almost any warning sign; sensitivity 10 only fires on real danger.
    """
    return max(5.0, min(95.0, 100.0 - float(clamp_sensitivity(sensitivity))))


def _num(value: Any) -> float:
    try:
        out = float(value)
    except (TypeError, ValueError):
        return 0.0
    return out if out == out else 0.0  # NaN -> 0


def atr(candles: list[dict[str, Any]] | None, period: int = ATR_PERIOD) -> float:
    """Average true range over the last ``period`` bars (0 when unknown)."""
    rows = list(candles or [])
    if len(rows) < period + 1:
        return 0.0
    rows = rows[-(period + 1):]
    total = 0.0
    for prev, cur in zip(rows, rows[1:]):
        high = _num(cur.get("high"))
        low = _num(cur.get("low"))
        prev_close = _num(prev.get("close"))
        if high <= 0 or low <= 0 or prev_close <= 0:
            return 0.0
        total += max(high - low, abs(high - prev_close), abs(low - prev_close))
    return total / float(period)


def _side_sign(pos_type: str) -> int:
    return -1 if str(pos_type or "").lower() == "sell" else 1


def score_position(
    pos: dict[str, Any] | Any,
    *,
    candles: list[dict[str, Any]] | None = None,
    ai: dict[str, Any] | None = None,
    balance: float = 0.0,
) -> dict[str, Any]:
    """Score a position's danger from 0 (safe) to 100 (close it now).

    ``pos`` may be a dict or an object with ``type``/``price_open``/
    ``price_current``/``profit``/``sl`` attributes.  Missing inputs simply
    contribute 0 — the guard never guesses.
    """
    if isinstance(pos, dict):
        get = pos.get
    else:
        def get(key: str, default: Any = 0) -> Any:  # type: ignore[no-redef]
            return getattr(pos, key, default)

    side = _side_sign(str(get("type", "buy")))
    open_px = _num(get("price_open", 0))
    cur_px = _num(get("price_current", 0))
    profit = _num(get("profit", 0))
    sl = _num(get("sl", 0))

    parts: dict[str, float] = {"excursion": 0.0, "momentum": 0.0, "ai": 0.0, "loss": 0.0}
    reasons: list[str] = []

    if open_px > 0 and cur_px > 0:
        adverse = side * (open_px - cur_px)  # > 0 means price moved against us
        atr_v = atr(candles)
        if atr_v > 0 and adverse > 0:
            units = adverse / atr_v
            parts["excursion"] = min(EXCURSION_W, units * 20.0)
            if parts["excursion"] >= 5:
                reasons.append(f"against entry {units:.1f}xATR")
        elif atr_v <= 0 and adverse > 0 and sl > 0:
            # No ATR available (too few bars): fall back to the stop-loss
            # distance — halfway to the stop is already serious danger.
            stop_dist = abs(open_px - sl)
            if stop_dist > 0:
                frac = adverse / stop_dist
                parts["excursion"] = min(EXCURSION_W, frac * EXCURSION_W)
                if parts["excursion"] >= 5:
                    reasons.append(f"{frac * 100:.0f}% of the way to SL")
        # Adverse momentum over the last few bars, in ATR units.
        rows = list(candles or [])
        if atr_v > 0 and len(rows) >= MOMENTUM_BARS:
            drift = 0.0
            for bar in rows[-MOMENTUM_BARS:]:
                o, c = _num(bar.get("open")), _num(bar.get("close"))
                if o > 0 and c > 0:
                    drift += side * (o - c)
            adverse_drift = drift / atr_v
            if adverse_drift > 0:
                parts["momentum"] = min(MOMENTUM_W, adverse_drift * 12.0)
                if parts["momentum"] >= 5:
                    reasons.append(f"momentum {adverse_drift:.1f}ATR/{MOMENTUM_BARS}b")

    ai = ai or {}
    if ai.get("ready"):
        direction = str(ai.get("direction") or "neutral")
        conf = _num(ai.get("confidence", 0))
        danger_dir = "bear" if side > 0 else "bull"  # direction that hurts us
        if direction == danger_dir and conf > 0:
            parts["ai"] = min(AI_W, AI_W * conf)
            if parts["ai"] >= 5:
                reasons.append(f"AI {direction} vs position ({conf:.2f})")

    balance_v = _num(balance)
    if profit < 0 and balance_v > 0:
        loss_pct = -profit / balance_v * 100.0
        parts["loss"] = min(LOSS_W, loss_pct * 5.0)
        if parts["loss"] >= 5:
            reasons.append(f"floating {loss_pct:.1f}% of balance")

    score = min(100.0, sum(parts.values()))
    return {"score": round(score, 1), "parts": {k: round(v, 1) for k, v in parts.items()}, "reasons": reasons}
