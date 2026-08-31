from __future__ import annotations

from typing import Any

import numpy as np
import pandas as pd


def candles_to_frame(rows: list[dict[str, Any]]) -> pd.DataFrame:
    if not rows:
        return pd.DataFrame()
    frame = pd.DataFrame(rows)
    rename = {}
    if "open" not in frame.columns and "o" in frame.columns:
        rename.update({"o": "open", "h": "high", "l": "low", "c": "close", "v": "volume"})
    if rename:
        frame = frame.rename(columns=rename)
    needed = {"open", "high", "low", "close"}
    if not needed.issubset(set(frame.columns)):
        return pd.DataFrame()
    for col in ("open", "high", "low", "close", "volume"):
        if col in frame.columns:
            frame[col] = pd.to_numeric(frame[col], errors="coerce")
    frame = frame.dropna(subset=["open", "high", "low", "close"])
    return frame.reset_index(drop=True)


def ema(series: pd.Series, span: int) -> pd.Series:
    return series.ewm(span=span, adjust=False).mean()


def rsi(series: pd.Series, period: int = 14) -> pd.Series:
    delta = series.diff()
    up = delta.clip(lower=0.0)
    down = -delta.clip(upper=0.0)
    roll_up = up.ewm(alpha=1 / period, adjust=False).mean()
    roll_down = down.ewm(alpha=1 / period, adjust=False).mean()
    rs = roll_up / roll_down.replace(0, np.nan)
    return 100 - (100 / (1 + rs))


def atr(frame: pd.DataFrame, period: int = 14) -> pd.Series:
    high, low, close = frame["high"], frame["low"], frame["close"]
    prev = close.shift(1)
    tr = pd.concat([(high - low), (high - prev).abs(), (low - prev).abs()], axis=1).max(axis=1)
    return tr.ewm(alpha=1 / period, adjust=False).mean()


def bollinger(series: pd.Series, period: int = 20, n: float = 2.0) -> tuple[pd.Series, pd.Series, pd.Series]:
    mid = series.rolling(period).mean()
    sd = series.rolling(period).std(ddof=0)
    return mid + n * sd, mid, mid - n * sd


def build_feature_frame(rows: list[dict[str, Any]]) -> pd.DataFrame:
    frame = candles_to_frame(rows)
    if frame.empty or len(frame) < 30:
        return pd.DataFrame()
    close = frame["close"]
    frame["ret1"] = close.pct_change()
    frame["ret5"] = close.pct_change(5)
    frame["ret15"] = close.pct_change(15)
    frame["ema8"] = ema(close, 8)
    frame["ema21"] = ema(close, 21)
    frame["ema55"] = ema(close, 55)
    frame["ema_fast_slope"] = frame["ema8"].pct_change(3)
    frame["ema_spread"] = (frame["ema8"] - frame["ema21"]) / close
    frame["ema_regime"] = (frame["ema21"] - frame["ema55"]) / close
    frame["rsi14"] = rsi(close, 14)
    frame["atr14"] = atr(frame, 14)
    frame["atr_pct"] = frame["atr14"] / close
    upper, mid, lower = bollinger(close, 20, 2.0)
    frame["bb_width"] = (upper - lower) / close
    frame["bb_pos"] = (close - lower) / (upper - lower).replace(0, np.nan)
    rng = (frame["high"] - frame["low"]).replace(0, np.nan)
    frame["close_loc"] = (close - frame["low"]) / rng
    frame["body"] = (close - frame["open"]) / close
    frame["wick_up"] = (frame["high"] - frame[["open", "close"]].max(axis=1)) / close
    frame["wick_dn"] = (frame[["open", "close"]].min(axis=1) - frame["low"]) / close
    if "volume" in frame.columns:
        vol = pd.to_numeric(frame["volume"], errors="coerce")
        vol_std = vol.rolling(20).std(ddof=0).replace(0, np.nan)
        frame["vol_z"] = ((vol - vol.rolling(20).mean()) / vol_std).fillna(0.0)
    else:
        frame["vol_z"] = 0.0
    frame["range_pct"] = rng / close
    frame["mom10"] = close.pct_change(10)
    frame["ret_z"] = (frame["ret1"] - frame["ret1"].rolling(20).mean()) / frame["ret1"].rolling(20).std(ddof=0).replace(0, np.nan)
    ema12 = ema(close, 12)
    ema26 = ema(close, 26)
    frame["macd"] = (ema12 - ema26) / close
    frame["macd_sig"] = ema(frame["macd"].fillna(0.0), 9)
    frame["macd_hist"] = frame["macd"] - frame["macd_sig"]
    up_move = frame["high"].diff()
    dn_move = -frame["low"].diff()
    plus_dm = up_move.where((up_move > dn_move) & (up_move > 0), 0.0)
    minus_dm = dn_move.where((dn_move > up_move) & (dn_move > 0), 0.0)
    tr = pd.concat([(frame["high"] - frame["low"]), (frame["high"] - close.shift(1)).abs(), (frame["low"] - close.shift(1)).abs()], axis=1).max(axis=1)
    atr14 = tr.ewm(alpha=1 / 14, adjust=False).mean().replace(0, np.nan)
    frame["plus_di"] = 100 * plus_dm.ewm(alpha=1 / 14, adjust=False).mean() / atr14
    frame["minus_di"] = 100 * minus_dm.ewm(alpha=1 / 14, adjust=False).mean() / atr14
    frame["di_spread"] = (frame["plus_di"] - frame["minus_di"]) / 100.0
    net = (close - close.shift(10)).abs()
    path = close.diff().abs().rolling(10).sum().replace(0, np.nan)
    frame["er10"] = net / path
    frame["hour"] = 0.0
    frame["hour_sin"] = 0.0
    frame["hour_cos"] = 1.0
    if "time" in frame.columns:
        ts = pd.to_datetime(frame["time"], utc=True, errors="coerce")
        if ts.isna().all():
            ts = pd.to_datetime(frame["time"], format="%Y.%m.%d %H:%M:%S", utc=True, errors="coerce")
        hour = (ts.dt.hour + ts.dt.minute / 60.0).fillna(0.0)
        frame["hour"] = hour
        frame["hour_sin"] = np.sin(2 * np.pi * hour / 24.0)
        frame["hour_cos"] = np.cos(2 * np.pi * hour / 24.0)
    frame = frame.replace([np.inf, -np.inf], np.nan)
    needed = [c for c in FEATURE_COLUMNS if c in frame.columns and c not in {"vol_z", "hour_sin", "hour_cos"}]
    if needed:
        frame = frame.dropna(subset=needed)
    return frame.reset_index(drop=True)


FEATURE_COLUMNS = [
    "ret1",
    "ret5",
    "ret15",
    "mom10",
    "ret_z",
    "ema_fast_slope",
    "ema_spread",
    "ema_regime",
    "rsi14",
    "atr_pct",
    "bb_width",
    "bb_pos",
    "close_loc",
    "body",
    "wick_up",
    "wick_dn",
    "vol_z",
    "range_pct",
    "macd",
    "macd_hist",
    "di_spread",
    "er10",
    "hour_sin",
    "hour_cos",
]


def matrix(frame: pd.DataFrame) -> np.ndarray:
    present = [c for c in FEATURE_COLUMNS if c in frame.columns]
    if not present:
        return np.empty((0, 0))
    values = frame[present].to_numpy(dtype=np.float64)
    return np.nan_to_num(values, nan=0.0, posinf=0.0, neginf=0.0)


def last_features(frame: pd.DataFrame) -> dict[str, float]:
    if frame.empty:
        return {}
    row = frame.iloc[-1]
    out = {}
    extra = ["ema8", "ema21", "ema55", "rsi14", "atr14", "bb_width", "macd", "plus_di", "minus_di"]
    for col in FEATURE_COLUMNS + extra:
        if col in frame.columns:
            try:
                out[col] = float(row[col])
            except Exception:
                continue
    return out
