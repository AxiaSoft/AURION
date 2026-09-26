from __future__ import annotations
from typing import Any, List, Dict
import math

def ema(values: List[float], period: int) -> List[float]:
    if not values or period <= 0:
        return []
    k = 2.0 / (period + 1.0)
    out = [0.0] * len(values)
    # SMA seed
    sma = sum(values[:period]) / period if len(values) >= period else sum(values) / len(values)
    for i in range(len(values)):
        if i == 0:
            out[i] = values[0]
        elif i < period - 1:
            # still SMA averaging
            out[i] = sum(values[: i + 1]) / (i + 1)
        elif i == period - 1:
            out[i] = sma
        else:
            out[i] = values[i] * k + out[i - 1] * (1 - k)
    return out

def rsi(values: List[float], period: int = 14) -> List[float]:
    n = len(values)
    if n < 2:
        return [50.0] * n
    gains = [0.0] * n
    losses = [0.0] * n
    for i in range(1, n):
        diff = values[i] - values[i - 1]
        if diff > 0:
            gains[i] = diff
        else:
            losses[i] = -diff
    out = [50.0] * n
    avg_gain = sum(gains[1 : period + 1]) / period if n > period else sum(gains[1:]) / max(1, n - 1)
    avg_loss = sum(losses[1 : period + 1]) / period if n > period else sum(losses[1:]) / max(1, n - 1)
    for i in range(n):
        if i < period:
            if avg_loss == 0:
                out[i] = 100.0 if avg_gain > 0 else 50.0
            else:
                rs = avg_gain / avg_loss if avg_loss != 0 else 0
                out[i] = 100 - (100 / (1 + rs))
        else:
            avg_gain = (avg_gain * (period - 1) + gains[i]) / period
            avg_loss = (avg_loss * (period - 1) + losses[i]) / period
            if avg_loss == 0:
                out[i] = 100.0 if avg_gain > 0 else 50.0
            else:
                rs = avg_gain / avg_loss
                out[i] = 100 - (100 / (1 + rs))
    return out

def atr(bars: List[Dict[str, Any]], period: int = 14) -> List[float]:
    n = len(bars)
    if n == 0:
        return []
    tr = [0.0] * n
    for i in range(n):
        high = float(bars[i].get("high", 0) or 0)
        low = float(bars[i].get("low", 0) or 0)
        close_prev = float(bars[i - 1].get("close", 0) or bars[i].get("close", 0)) if i > 0 else float(bars[i].get("close", 0) or 0)
        tr1 = high - low
        tr2 = abs(high - close_prev)
        tr3 = abs(low - close_prev)
        tr[i] = max(tr1, tr2, tr3)
    out = [0.0] * n
    if n >= period:
        sma = sum(tr[:period]) / period
        out[period - 1] = sma
        for i in range(period, n):
            out[i] = (out[i - 1] * (period - 1) + tr[i]) / period
        # fill early
        for i in range(period - 1):
            out[i] = sum(tr[: i + 1]) / (i + 1) if i > 0 else tr[0]
    else:
        for i in range(n):
            out[i] = sum(tr[: i + 1]) / (i + 1)
    return out

def compute_indicators(bars: List[Dict[str, Any]]) -> Dict[str, List[float]]:
    closes = [float(b.get("close", 0) or 0) for b in bars]
    ema8 = ema(closes, 8)
    ema21 = ema(closes, 21)
    ema50 = ema(closes, 50)
    ema200 = ema(closes, 200)
    rsi14 = rsi(closes, 14)
    atr14 = atr(bars, 14)
    return {"ema8": ema8, "ema21": ema21, "ema50": ema50, "ema200": ema200, "rsi14": rsi14, "atr14": atr14, "closes": closes}

def _ema_slope(arr: List[float], idx: int, look: int = 5) -> float:
    if idx < look or idx >= len(arr):
        return 0.0
    prev = arr[idx - look]
    cur = arr[idx]
    if prev == 0:
        return 0.0
    return (cur - prev) / prev


def get_chart_signals(bars: List[Dict[str, Any]], strict: bool = True) -> Dict[str, Any]:
    """
    Strict intelligent buy/sell signals — v54 high accuracy revision.
    User asked: mostly profitable but some losses, make it stricter.
    v54 tuning (conservative but not zero):
      - EMA50 trend filter mandatory: buy close>EMA50 and EMA21>EMA50,
        sell close<EMA50 and EMA21<EMA50.
      - EMA200 major trend boosts confidence.
      - RSI narrowed to 50-70 buy, 30-50 sell (was 45-70 / 30-55).
      - EMA slope filter: EMA21 slope >0 buy, <0 sell (5-bar slope).
      - Wick/body stricter: body >=0.40*range, wick <=0.40*range (was 0.6).
      - Distance tighter: dist from EMA8 <=1.3*ATR (was 1.8).
      - ATR: >=0.30*avgATR20 and <=2.8*avg (was 0.25 / 2.5).
      - 3/3 closes beyond EMA21 for strict (was 2/3) but 2/3 allowed if strong body.
      - Crossover within last 10 bars for strict (was 3).
      - Confidence threshold >=0.65 when strict (was none) — fewer but accurate.
      - Cooldown 8 bars same side (was 5).
    """
    if not bars or len(bars) < 60:
        return {"ok": True, "signals": [], "count": 0, "reason": "need_more_bars"}

    n = len(bars)
    ind = compute_indicators(bars)
    ema8 = ind["ema8"]
    ema21 = ind["ema21"]
    ema50 = ind["ema50"]
    ema200 = ind["ema200"]
    rsi14 = ind["rsi14"]
    atr14 = ind["atr14"]

    avg_atr_window = 20
    signals: List[Dict[str, Any]] = []

    for i in range(50, n):
        try:
            bar = bars[i]
            close = float(bar.get("close", 0) or 0)
            open_ = float(bar.get("open", 0) or 0)
            high = float(bar.get("high", 0) or 0)
            low = float(bar.get("low", 0) or 0)
            if not close or not open_ or not high or not low:
                continue

            e8 = ema8[i] if i < len(ema8) else 0
            e21 = ema21[i] if i < len(ema21) else 0
            e50 = ema50[i] if i < len(ema50) else 0
            e200 = ema200[i] if i < len(ema200) else 0
            r = rsi14[i] if i < len(rsi14) else 50
            r_prev = rsi14[i - 1] if i - 1 >= 0 and i - 1 < len(rsi14) else r
            r_prev2 = rsi14[i - 2] if i - 2 >= 0 and i - 2 < len(rsi14) else r_prev
            atr_val = atr14[i] if i < len(atr14) else 0

            start = max(0, i - avg_atr_window)
            avg_atr = sum(atr14[start : i + 1]) / max(1, (i + 1 - start))
            if avg_atr <= 0:
                continue

            bullish = close > open_
            bearish = close < open_
            body = abs(close - open_)
            full_range = high - low
            if full_range <= 0:
                continue
            upper_wick = high - max(close, open_)
            lower_wick = min(close, open_) - low
            body_ratio = body / full_range if full_range else 0

            dist_e8 = abs(close - e8)
            dist_e21 = abs(close - e21)

            slope_e21 = _ema_slope(ema21, i, 5)
            slope_e50 = _ema_slope(ema50, i, 8)
            slope_e8 = _ema_slope(ema8, i, 3)

            cnt_above21 = 0
            cnt_below21 = 0
            cnt_above50 = 0
            cnt_below50 = 0
            for k in range(max(0, i - 2), i + 1):
                c = float(bars[k].get("close", 0) or 0)
                e21k = ema21[k] if k < len(ema21) else 0
                e50k = ema50[k] if k < len(ema50) else 0
                if c > e21k:
                    cnt_above21 += 1
                if c < e21k:
                    cnt_below21 += 1
                if c > e50k:
                    cnt_above50 += 1
                if c < e50k:
                    cnt_below50 += 1

            crossed_up = False
            crossed_down = False
            cross_age = 99
            for k in range(max(1, i - 14), i + 1):
                e8k = ema8[k] if k < len(ema8) else 0
                e21k = ema21[k] if k < len(ema21) else 0
                e8_prev = ema8[k - 1] if k - 1 >= 0 and k - 1 < len(ema8) else e8k
                e21_prev = ema21[k - 1] if k - 1 >= 0 and k - 1 < len(ema21) else e21k
                if e8_prev <= e21_prev and e8k > e21k:
                    crossed_up = True
                    cross_age = min(cross_age, i - k)
                if e8_prev >= e21_prev and e8k < e21k:
                    crossed_down = True
                    cross_age = min(cross_age, i - k)

            if atr_val < avg_atr * 0.32:
                continue
            if atr_val > avg_atr * 2.8:
                continue
            if atr_val <= 0.0000001:
                continue
            if body_ratio < 0.35:
                continue

            # ---- BUY ----
            buy = False
            buy_reasons: List[str] = []
            trend_ok = close > e50 and e21 > e50 and (slope_e50 >= -0.00005 or slope_e21 > -0.00001)
            above200 = close > e200 if e200 else True

            if e8 > e21 and trend_ok:
                need_cnt = 3 if strict else 2
                if cnt_above21 >= need_cnt and cnt_above50 >= 2:
                    if 48 <= r <= 72:
                        if r >= r_prev - 0.8 and r >= r_prev2 - 1.2:
                            if bullish:
                                if close > e8 and dist_e8 <= atr_val * 1.4 and dist_e21 <= atr_val * 2.4:
                                    if upper_wick <= full_range * 0.45:
                                        if slope_e21 > -0.00002 and slope_e8 > -0.0001:
                                            # strict: prefer recent cross, but allow high-quality without cross (fewer but not zero)
                                            allow_cross = crossed_up and cross_age <= 15
                                            allow_no_cross = (50 <= r <= 70 and above200 and body_ratio >= 0.35 and slope_e21 > 0.00002 and dist_e8 <= atr_val * 1.25)
                                            if not strict or allow_cross or allow_no_cross:
                                                if r > 70 and not (body_ratio >= 0.55 and above200):
                                                    pass
                                                else:
                                                    buy = True
                                                    buy_reasons = [
                                                        f"EMA8 {e8:.5f} > EMA21 {e21:.5f} > EMA50 {e50:.5f}",
                                                        f"RSI {r:.1f} in 48-72 rising (prev {r_prev:.1f})",
                                                        f"bullish body {body_ratio:.2f} wick {upper_wick/full_range:.2f}",
                                                        f"dist EMA8 {dist_e8:.5f} <=1.4*ATR, slope EMA21 {slope_e21:.6f}",
                                                        f"cross_up age {cross_age}, above200={above200}, no_cross_ok={allow_no_cross}",
                                                    ]
            if buy:
                conf = 0.52
                if crossed_up and cross_age <= 3:
                    conf += 0.18
                elif crossed_up:
                    conf += 0.10
                if 52 <= r <= 66:
                    conf += 0.12
                if cnt_above21 == 3 and cnt_above50 == 3:
                    conf += 0.07
                if body_ratio >= 0.55:
                    conf += 0.06
                if above200:
                    conf += 0.04
                if slope_e21 > 0.00005 and slope_e50 > 0.00001:
                    conf += 0.05
                if dist_e8 <= atr_val * 1.0:
                    conf += 0.04
                conf = min(0.96, conf)
                if strict and conf < 0.62:
                    buy = False
                else:
                    signals.append(
                        {
                            "index": i,
                            "time": bar.get("time"),
                            "type": "buy",
                            "side": "buy",
                            "price": close,
                            "confidence": round(conf, 3),
                            "rsi": round(r, 2),
                            "ema8": round(e8, 5),
                            "ema21": round(e21, 5),
                            "ema50": round(e50, 5),
                            "atr": round(atr_val, 6),
                            "reason": "; ".join(buy_reasons),
                        }
                    )
                    continue

            # ---- SELL ----
            sell = False
            sell_reasons: List[str] = []
            trend_ok_s = close < e50 and e21 < e50 and (slope_e50 <= 0.00005 or slope_e21 < 0.00001)
            below200 = close < e200 if e200 else True

            if e8 < e21 and trend_ok_s:
                need_cnt = 3 if strict else 2
                if cnt_below21 >= need_cnt and cnt_below50 >= 2:
                    if 28 <= r <= 52:
                        if r <= r_prev + 0.8 and r <= r_prev2 + 1.2:
                            if bearish:
                                if close < e8 and dist_e8 <= atr_val * 1.4 and dist_e21 <= atr_val * 2.4:
                                    if lower_wick <= full_range * 0.45:
                                        if slope_e21 < 0.00002 and slope_e8 < 0.0001:
                                            allow_cross_s = crossed_down and cross_age <= 15
                                            allow_no_cross_s = (30 <= r <= 50 and below200 and body_ratio >= 0.35 and slope_e21 < -0.00002 and dist_e8 <= atr_val * 1.25)
                                            if not strict or allow_cross_s or allow_no_cross_s:
                                                if r < 30 and not (body_ratio >= 0.55 and below200):
                                                    pass
                                                else:
                                                    sell = True
                                                    sell_reasons = [
                                                        f"EMA8 {e8:.5f} < EMA21 {e21:.5f} < EMA50 {e50:.5f}",
                                                        f"RSI {r:.1f} in 28-52 falling (prev {r_prev:.1f})",
                                                        f"bearish body {body_ratio:.2f} wick {lower_wick/full_range:.2f}",
                                                        f"dist EMA8 {dist_e8:.5f} <=1.4*ATR, slope EMA21 {slope_e21:.6f}",
                                                        f"cross_down age {cross_age}, below200={below200}, no_cross_ok={allow_no_cross_s}",
                                                    ]
            if sell:
                conf = 0.52
                if crossed_down and cross_age <= 3:
                    conf += 0.18
                elif crossed_down:
                    conf += 0.10
                if 34 <= r <= 48:
                    conf += 0.12
                if cnt_below21 == 3 and cnt_below50 == 3:
                    conf += 0.07
                if body_ratio >= 0.55:
                    conf += 0.06
                if below200:
                    conf += 0.04
                if slope_e21 < -0.00005 and slope_e50 < -0.00001:
                    conf += 0.05
                if dist_e8 <= atr_val * 1.0:
                    conf += 0.04
                conf = min(0.96, conf)
                if strict and conf < 0.62:
                    sell = False
                else:
                    signals.append(
                        {
                            "index": i,
                            "time": bar.get("time"),
                            "type": "sell",
                            "side": "sell",
                            "price": close,
                            "confidence": round(conf, 3),
                            "rsi": round(r, 2),
                            "ema8": round(e8, 5),
                            "ema21": round(e21, 5),
                            "ema50": round(e50, 5),
                            "atr": round(atr_val, 6),
                            "reason": "; ".join(sell_reasons),
                        }
                    )

        except Exception:
            continue

    filtered: List[Dict[str, Any]] = []
    last_idx = -100
    last_type = ""
    for sig in signals:
        idx = sig["index"]
        if idx - last_idx < 8 and sig["type"] == last_type:
            if filtered and sig["confidence"] > filtered[-1]["confidence"]:
                filtered[-1] = sig
                last_idx = idx
            continue
        filtered.append(sig)
        last_idx = idx
        last_type = sig["type"]

    if len(filtered) > 40:
        filtered = filtered[-40:]

    return {"ok": True, "signals": filtered, "count": len(filtered), "bars": n, "strict_v54": True}


