"""Shared decision helpers for the built-in strategies.

Every built-in used to fire on a single condition — one EMA cross, one broken
high, one candle pattern — which is exactly the kind of signal a live market
fills at the worst possible price. These helpers give all of them the same
extra checks a discretionary trader would run before clicking buy:

* the slow trend on the same chart (EMA 50/200),
* momentum agreement (MACD histogram) and RSI exhaustion,
* a volatility floor so dead sessions are skipped,
* structure-aware stops and a minimum reward-to-risk on every ticket.

They are deliberately dependency-free (pandas only) and pure, so strategies
stay testable and the backtester sees exactly what the live engine sees.
"""

from __future__ import annotations

from typing import Any

import pandas as pd

from ...ai.features import ema, rsi


def atr_series(frame: pd.DataFrame, period: int = 14) -> pd.Series:
    high, low, close = frame["high"], frame["low"], frame["close"]
    prev = close.shift(1)
    tr = pd.concat([(high - low), (high - prev).abs(), (low - prev).abs()], axis=1).max(axis=1)
    return tr.ewm(alpha=1 / period, adjust=False).mean()


def atr_value(frame: pd.DataFrame, period: int = 14) -> float:
    if len(frame) < period + 1:
        return 0.0
    try:
        return float(atr_series(frame, period).iloc[-1] or 0.0)
    except Exception:
        return 0.0


def trend_bias(frame: pd.DataFrame, fast: int = 50, slow: int = 200) -> tuple[str, float]:
    """Slow trend of this chart: ("bull"|"bear"|"neutral", 0..1 strength)."""
    if len(frame) < fast + 5:
        return "neutral", 0.0
    close = frame["close"]
    span_slow = slow if len(frame) >= slow else max(fast + 10, len(frame) // 2)
    f = float(ema(close, fast).iloc[-1])
    s = float(ema(close, span_slow).iloc[-1])
    price = float(close.iloc[-1]) or 1.0
    spread = (f - s) / price
    strength = max(0.0, min(1.0, abs(spread) / 0.003))
    if spread > 0.0001:
        return "bull", strength
    if spread < -0.0001:
        return "bear", strength
    return "neutral", strength


def macd_bias(frame: pd.DataFrame) -> str:
    """Momentum read that does not flicker every single bar.

    The raw histogram changes sign constantly and would veto exactly the
    pullback entries that are worth taking, so the MACD line (where momentum
    is) carries the vote and the smoothed histogram (where it is going) only
    tilts it.
    """
    if len(frame) < 40:
        return "neutral"
    close = frame["close"]
    macd = ema(close, 12) - ema(close, 26)
    signal = ema(macd, 9)
    hist = macd - signal
    price = float(close.iloc[-1]) or 1.0
    line = float(macd.iloc[-1]) / price
    hist3 = float(hist.iloc[-3:].mean()) / price
    score = line + 0.5 * hist3
    if score > 1e-5:
        return "bull"
    if score < -1e-5:
        return "bear"
    return "neutral"


def rsi_value(frame: pd.DataFrame, period: int = 14) -> float:
    if len(frame) < period + 2:
        return 50.0
    try:
        return float(rsi(frame["close"], period).iloc[-1])
    except Exception:
        return 50.0


def not_exhausted(side: str, rsi_now: float, upper: float = 80.0, lower: float = 20.0) -> bool:
    """Refuse to chase a move that is already stretched."""
    if side == "buy":
        return rsi_now < upper
    return rsi_now > lower


def volatility_ok(frame: pd.DataFrame, min_atr_pct: float = 0.0003, max_atr_pct: float = 0.05) -> bool:
    """Skip a dead market (nothing to win) and a violent one (nothing to hold)."""
    price = float(frame["close"].iloc[-1]) if len(frame) else 0.0
    if price <= 0:
        return False
    atr_pct = atr_value(frame) / price
    return min_atr_pct <= atr_pct <= max_atr_pct


def efficiency(frame: pd.DataFrame, window: int = 10) -> float:
    """Kaufman efficiency ratio: 1 = clean trend, ~0 = chop."""
    if len(frame) < window + 2:
        return 0.0
    close = frame["close"]
    net = abs(float(close.iloc[-1]) - float(close.iloc[-window - 1]))
    path = float(close.diff().abs().iloc[-window:].sum())
    if path <= 0:
        return 0.0
    return max(0.0, min(1.0, net / path))


def swing_levels(frame: pd.DataFrame, lookback: int = 20) -> tuple[float, float]:
    window = frame.iloc[-lookback:] if len(frame) > lookback else frame
    return float(window["high"].max()), float(window["low"].min())


def risk_levels(
    side: str,
    price: float,
    atr: float,
    sl_atr: float,
    tp_atr: float,
    min_rr: float = 1.3,
    structure: tuple[float, float] | None = None,
) -> tuple[float, float]:
    """Stop and target for one ticket, with a guaranteed reward-to-risk.

    When recent structure is supplied the stop is placed just beyond the swing
    that would invalidate the idea, which is both tighter and more honest than
    a pure ATR multiple; the target is then stretched so the ticket still pays
    at least ``min_rr`` times what it risks.
    """
    if price <= 0 or atr <= 0:
        return 0.0, 0.0
    risk = atr * max(0.2, float(sl_atr))
    if structure:
        high, low = structure
        if side == "buy" and low > 0 and price > low:
            risk = max(risk * 0.6, min(risk * 1.8, price - low + atr * 0.15))
        elif side == "sell" and high > 0 and high > price:
            risk = max(risk * 0.6, min(risk * 1.8, high - price + atr * 0.15))
    reward = max(atr * max(0.2, float(tp_atr)), risk * max(1.0, float(min_rr)))
    if side == "buy":
        return price - risk, price + reward
    return price + risk, price - reward


def entry_allowed(
    frame: pd.DataFrame,
    side: str,
    params: dict[str, Any],
    ai: dict[str, Any] | None = None,
) -> tuple[bool, str]:
    """One gate for every built-in: trend, momentum, exhaustion, volatility.

    Returns ``(True, why)`` when the setup survives the checks the parameters
    switch on, otherwise ``(False, reason)`` so the desk journal can say
    exactly which read rejected the trade.
    """
    if len(frame) < 30:
        return False, "not enough bars"
    if params.get("require_volatility", True) and not volatility_ok(
        frame, float(params.get("min_atr_pct", 0.0003) or 0.0003)
    ):
        return False, "volatility outside the tradeable band"
    min_er = float(params.get("min_efficiency", 0.0) or 0.0)
    if min_er > 0 and efficiency(frame) < min_er:
        return False, "market is chopping (low efficiency)"
    notes: list[str] = []
    want = "bull" if side == "buy" else "bear"
    if params.get("with_trend", True):
        bias, strength = trend_bias(
            frame,
            int(params.get("trend_fast", 50) or 50),
            int(params.get("trend_slow", 200) or 200),
        )
        if bias != "neutral" and bias != want and strength >= float(params.get("counter_trend_block", 0.25) or 0.25):
            return False, f"slow trend is {bias}"
        if bias == want:
            notes.append("with trend")
    if params.get("require_momentum", True):
        mom = macd_bias(frame)
        if mom != "neutral" and mom != want:
            return False, f"momentum is {mom}"
        if mom == want:
            notes.append("momentum agrees")
    rsi_now = rsi_value(frame, int(params.get("rsi_period", 14) or 14))
    if not not_exhausted(side, rsi_now):
        return False, f"RSI {rsi_now:.0f} is exhausted"
    ai = ai or {}
    if params.get("require_ai_agree") and ai.get("ready"):
        direction = str(ai.get("direction") or "neutral")
        if direction not in {want, "neutral"}:
            return False, f"AI reads {direction}"
        if direction == want:
            notes.append(f"AI {direction}")
    return True, ", ".join(notes) or "filters clear"
