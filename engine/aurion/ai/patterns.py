from __future__ import annotations

from typing import Any

import numpy as np
import pandas as pd

from .features import candles_to_frame


def _bar(frame: pd.DataFrame, i: int) -> dict[str, float]:
    row = frame.iloc[i]
    o, h, l, c = float(row["open"]), float(row["high"]), float(row["low"]), float(row["close"])
    body = abs(c - o)
    rng = max(h - l, 1e-12)
    return {
        "o": o,
        "h": h,
        "l": l,
        "c": c,
        "body": body,
        "range": rng,
        "up": h - max(o, c),
        "dn": min(o, c) - l,
        "bull": c > o,
        "bear": c < o,
    }


def detect(rows: list[dict[str, Any]]) -> dict[str, Any]:
    frame = candles_to_frame(rows)
    if frame.empty or len(frame) < 5:
        return {"name": "", "bias": "neutral", "score": 0.0, "reason": "not enough real bars"}
    i = len(frame) - 1
    a, b, c = _bar(frame, i - 2), _bar(frame, i - 1), _bar(frame, i)
    found: list[tuple[str, str, float, str]] = []

    if c["body"] / c["range"] < 0.12:
        found.append(("doji", "neutral", 0.45, "open and close collapsed inside the range"))
    if c["dn"] > 2 * c["body"] and c["up"] < c["body"] and c["bull"]:
        found.append(("hammer", "bull", 0.62, "long lower wick after selling pressure"))
    if c["up"] > 2 * c["body"] and c["dn"] < c["body"] and c["bear"]:
        found.append(("shooting_star", "bear", 0.62, "long upper wick after buying pressure"))
    if b["bear"] and c["bull"] and c["c"] > (b["o"] + b["c"]) / 2 and c["o"] < b["c"]:
        found.append(("bullish_engulfing", "bull", 0.7, "bullish close swallowed the prior bearish body"))
    if b["bull"] and c["bear"] and c["c"] < (b["o"] + b["c"]) / 2 and c["o"] > b["c"]:
        found.append(("bearish_engulfing", "bear", 0.7, "bearish close swallowed the prior bullish body"))
    if a["bear"] and b["body"] < a["body"] * 0.5 and c["bull"] and c["c"] > a["o"]:
        found.append(("morning_star", "bull", 0.74, "three-bar reversal from selling to buying"))
    if a["bull"] and b["body"] < a["body"] * 0.5 and c["bear"] and c["c"] < a["o"]:
        found.append(("evening_star", "bear", 0.74, "three-bar reversal from buying to selling"))
    if c["bull"] and c["dn"] > c["body"] and c["c"] > b["h"]:
        found.append(("pin_break_up", "bull", 0.66, "rejection low then close through prior high"))
    if c["bear"] and c["up"] > c["body"] and c["c"] < b["l"]:
        found.append(("pin_break_down", "bear", 0.66, "rejection high then close through prior low"))
    if b["bear"] and c["bull"] and c["o"] < b["c"] and c["c"] > (b["o"] + b["c"]) / 2:
        found.append(("piercing", "bull", 0.64, "bull close reclaimed more than half of the prior bear body"))
    if b["bull"] and c["bear"] and c["o"] > b["c"] and c["c"] < (b["o"] + b["c"]) / 2:
        found.append(("dark_cloud", "bear", 0.64, "bear close gave back more than half of the prior bull body"))
    if b["bull"] and c["bull"] and c["c"] > b["c"] and c["o"] > b["o"] and c["body"] > b["body"] * 0.8:
        found.append(("rising_window", "bull", 0.6, "two expanding bull bodies"))
    if b["bear"] and c["bear"] and c["c"] < b["c"] and c["o"] < b["o"] and c["body"] > b["body"] * 0.8:
        found.append(("falling_window", "bear", 0.6, "two expanding bear bodies"))
    if c["body"] / c["range"] > 0.82 and c["bull"]:
        found.append(("bull_marubozu", "bull", 0.58, "almost no wick — committed buying"))
    if c["body"] / c["range"] > 0.82 and c["bear"]:
        found.append(("bear_marubozu", "bear", 0.58, "almost no wick — committed selling"))
    if c["h"] < b["h"] and c["l"] > b["l"]:
        found.append(("inside_bar", "neutral", 0.5, "range contracted inside the prior bar"))
    if abs(c["h"] - b["h"]) / max(c["range"], 1e-12) < 0.08 and c["bear"] and b["bull"]:
        found.append(("tweezer_top", "bear", 0.6, "matching highs then a bear close"))
    if abs(c["l"] - b["l"]) / max(c["range"], 1e-12) < 0.08 and c["bull"] and b["bear"]:
        found.append(("tweezer_bottom", "bull", 0.6, "matching lows then a bull close"))

    # Simple structure: higher highs / lower lows over last 8 closes.
    closes = frame["close"].to_numpy(dtype=float)
    window = closes[-8:]
    if len(window) >= 8:
        hh = window[-1] > window[-3] > window[-5] and window.max() == window[-1]
        ll = window[-1] < window[-3] < window[-5] and window.min() == window[-1]
        if hh:
            found.append(("higher_highs", "bull", 0.58, "swing structure printing higher highs"))
        if ll:
            found.append(("lower_lows", "bear", 0.58, "swing structure printing lower lows"))

    if not found:
        return {"name": "none", "bias": "neutral", "score": 0.0, "reason": "no canonical pattern on the last real bars"}
    found.sort(key=lambda x: x[2], reverse=True)
    name, bias, score, reason = found[0]
    return {"name": name, "bias": bias, "score": float(score), "reason": reason, "alts": [{"name": n, "bias": b, "score": s} for n, b, s, _ in found[1:3]]}


def regime_from_features(features: dict[str, float]) -> dict[str, Any]:
    if not features:
        return {"name": "unknown", "vol": "unknown", "reason": "no live features"}
    spread = float(features.get("ema_regime") or 0)
    slope = float(features.get("ema_fast_slope") or 0)
    atr_pct = float(features.get("atr_pct") or 0)
    bb = float(features.get("bb_width") or 0)
    if atr_pct > 0.012 or bb > 0.04:
        vol = "high"
    elif atr_pct < 0.004 or bb < 0.012:
        vol = "low"
    else:
        vol = "normal"
    if spread > 0.0012 and slope > 0:
        name = "trend_up"
    elif spread < -0.0012 and slope < 0:
        name = "trend_down"
    else:
        name = "range"
    return {"name": name, "vol": vol, "reason": f"ema_regime={spread:.5f} slope={slope:.5f} atr={atr_pct:.5f}"}
