from __future__ import annotations

from collections import deque
from typing import Any

import numpy as np

from ..config import ROOT, abspath, load
from ..util.clock import utc_iso
from ..util.log import get
from .features import FEATURE_COLUMNS, build_feature_frame, last_features, matrix
from .models import LiveModels
from .patterns import detect, regime_from_features

log = get("ai")


def _labels_from_frame(frame) -> np.ndarray:
    future = frame["close"].shift(-3)
    ret = (future - frame["close"]) / frame["close"]
    atr = frame["atr_pct"].replace(0, np.nan)
    threshold = (atr * 0.35).fillna(0.0004)
    y = np.where(ret > threshold, 1, np.where(ret < -threshold, -1, 0))
    return y[:-3], slice(0, len(frame) - 3)


class AIEngine:
    def __init__(self) -> None:
        cfg = load()
        directory = abspath(cfg["ai"]["model_dir"])
        if not directory.is_absolute():
            directory = ROOT / directory
        self.models = LiveModels(directory)
        self.last: dict[str, Any] = self._idle()
        # Latest AI state per chart (symbol) so multi-chart desks can show each
        # symbol's direction independently, not just whoever inferred last.
        self.by_symbol: dict[str, dict[str, Any]] = {}
        self.bars_since_train = 0
        self.enabled = bool(cfg["ai"].get("enabled", True))
        self.activity: deque[dict[str, Any]] = deque(maxlen=80)

    def _idle(self) -> dict[str, Any]:
        return {
            "ready": False,
            "status": "idle",
            "direction": "neutral",
            "confidence": 0.0,
            "regime": {"name": "unknown", "vol": "unknown"},
            "pattern": {"name": "", "bias": "neutral", "score": 0.0},
            "features": {},
            "reason": "AI is idle until real bars arrive",
            "samples": self.models.samples,
            "updated": self.models.updated,
            "symbol": "",
            "timeframe": "",
            "hint": "neutral",
            "display_direction": "neutral",
            "need": int(load().get("ai", {}).get("min_bars_to_train") or 160),
            "activity": list(self.activity)[-12:] if getattr(self, "activity", None) else [],
            "outlook": {
                "direction": "neutral",
                "live": False,
                "ready": False,
                "strength": 0.0,
                "horizon": "",
                "symbol": "",
                "votes": {"bull": 0, "bear": 0, "total": 0},
                "text": "AI is idle until a live AurionBridge chart is attached",
            },
            "ts": utc_iso(),
        }

    def note(self, text: str, extra: dict[str, Any] | None = None) -> None:
        item = {"ts": utc_iso(), "text": text, **(extra or {})}
        if not hasattr(self, "activity") or self.activity is None:
            self.activity = deque(maxlen=80)
        self.activity.append(item)

    def _remember(self, symbol: str, timeframe: str, state: dict[str, Any]) -> None:
        """Snapshot latest state per chart — now includes full regime object and
        live features so the intelligence tab slider can show direction+regime
        per chart and features per selected chart."""
        symbol = str(symbol or "").strip()
        if not symbol:
            return
        regime = state.get("regime") or {}
        pattern = state.get("pattern") or {}
        outlook = state.get("outlook") or {}
        feats = state.get("features") or {}
        # keep features compact but meaningful: top 18 keys rounded
        compact_feats: dict[str, float] = {}
        try:
            for k, v in list(feats.items())[:24]:
                try:
                    compact_feats[str(k)] = float(v) if isinstance(v, (int, float)) else 0.0
                except Exception:
                    continue
        except Exception:
            compact_feats = {}
        # regime full object for slider merge
        regime_obj = regime if isinstance(regime, dict) else {"name": str(regime or "")}
        pattern_obj = pattern if isinstance(pattern, dict) else {"name": str(pattern or "")}
        self.by_symbol[symbol] = {
            "symbol": symbol,
            "timeframe": str(timeframe or state.get("timeframe") or ""),
            "ready": bool(state.get("ready")),
            "status": str(state.get("status") or ""),
            "direction": str(state.get("direction") or "neutral"),
            "hint": str(state.get("hint") or "neutral"),
            "display_direction": str(state.get("display_direction") or "neutral"),
            "confidence": float(state.get("confidence") or 0.0),
            "reason": str(state.get("reason") or ""),
            # legacy string fields for old UI
            "regime": str(regime_obj.get("name") or "") if isinstance(regime_obj, dict) else "",
            "pattern": str(pattern_obj.get("name") or "") if isinstance(pattern_obj, dict) else "",
            # new full objects for v54 merged slider
            "regime_obj": regime_obj,
            "pattern_obj": pattern_obj,
            "features": compact_feats,
            "confidence_why": state.get("confidence_why") or {},
            "outlook_strength": float(outlook.get("strength") or 0.0) if isinstance(outlook, dict) else 0.0,
            "outlook_text": str(outlook.get("text") or "") if isinstance(outlook, dict) else "",
            "samples": int(state.get("samples") or 0),
            "ts": str(state.get("ts") or utc_iso()),
        }
        while len(self.by_symbol) > 24:
            self.by_symbol.pop(next(iter(self.by_symbol)))

    def train(self, rows: list[dict[str, Any]], symbol: str, timeframe: str) -> dict[str, Any]:
        cfg = load()
        minimum = int(cfg["ai"].get("min_bars_to_train") or 160)
        frame = build_feature_frame(rows)
        feature_min = max(80, minimum - 50)
        if len(frame) < feature_min:
            prev = dict(self.last or self._idle())
            prev.update(
                {
                    "status": "waiting",
                    "reason": f"need {feature_min} feature-complete bars (from {minimum} candles), have {len(frame)}",
                    "symbol": symbol,
                    "timeframe": timeframe,
                    "samples": len(frame),
                    "need": minimum,
                    "activity": list(self.activity)[-12:],
                }
            )
            self.last = prev
            self._remember(symbol, timeframe, prev)
            self.note(f"learning {symbol} {timeframe}: {len(frame)}/{feature_min} feature bars")
            return {"ok": False, "error": self.last["reason"], "state": self.last}
        y_full = np.zeros(len(frame), dtype=int)
        y, sl = _labels_from_frame(frame)
        y_full[sl] = y
        X = matrix(frame.iloc[sl])
        y = y_full[sl]
        # Drop the leftover tail already sliced; also drop pure-noise if any NaN.
        mask = np.isfinite(X).all(axis=1)
        X, y = X[mask], y[mask]
        result = self.models.fit(X, y)
        self.bars_since_train = 0
        if result.get("ok"):
            log.info("retrained on %s %s bars=%s", symbol, timeframe, self.models.samples)
            self.note(f"trained {symbol} {timeframe} samples={self.models.samples}")
        return {**result, "state": self.infer(rows, symbol, timeframe)}

    def infer(self, rows: list[dict[str, Any]], symbol: str, timeframe: str, strategy_votes: list[str] | None = None) -> dict[str, Any]:
        if not rows:
            idle = self._idle()
            idle["symbol"] = symbol
            idle["timeframe"] = timeframe
            self.last = idle
            self._remember(symbol, timeframe, idle)
            return idle
        frame = build_feature_frame(rows)
        pattern = detect(rows)
        features = last_features(frame)
        regime = regime_from_features(features)
        if frame.empty:
            state = self._idle()
            state.update({"pattern": pattern, "symbol": symbol, "timeframe": timeframe, "status": "waiting"})
            self.last = state
            self._remember(symbol, timeframe, state)
            return state
        x = matrix(frame.iloc[[-1]])
        prediction = self.models.infer(x[0] if len(x) else np.zeros(len(FEATURE_COLUMNS)))
        direction = prediction["direction"] if prediction["ready"] else "neutral"
        confidence = float(prediction["confidence"] if prediction["ready"] else 0.0)
        atr_now = float(features.get("atr_pct") or 0)
        mom = float(features.get("ema_spread") or 0) + 0.35 * float(features.get("ret5") or 0)
        mom_dir = "bull" if mom > 0.0004 else "bear" if mom < -0.0004 else "neutral"
        macd_h = float(features.get("macd_hist") or 0)
        di = float(features.get("di_spread") or 0)
        er = float(features.get("er10") or 0)
        macd_dir = "bull" if macd_h > 1e-5 else "bear" if macd_h < -1e-5 else "neutral"
        di_dir = "bull" if di > 0.05 else "bear" if di < -0.05 else "neutral"
        votes = []
        if prediction["ready"] and direction in {"bull", "bear"}:
            votes.append(direction)
        if pattern.get("bias") in {"bull", "bear"} and float(pattern.get("score") or 0) >= 0.6:
            votes.append(pattern["bias"])
        if mom_dir in {"bull", "bear"}:
            votes.append(mom_dir)
        if macd_dir in {"bull", "bear"}:
            votes.append(macd_dir)
        if di_dir in {"bull", "bear"}:
            votes.append(di_dir)
        for sv in (strategy_votes or getattr(self, "_strategy_votes", None) or []):
            if sv in {"bull", "bear"}:
                votes.append(sv)
        rsi = float(features.get("rsi14") or 50)
        if rsi >= 62:
            votes.append("bull")
        elif rsi <= 38:
            votes.append("bear")
        hint = "neutral"
        if votes:
            bull_n = votes.count("bull")
            bear_n = votes.count("bear")
            if bull_n > bear_n:
                hint = "bull"
            elif bear_n > bull_n:
                hint = "bear"
        if prediction["ready"]:
            if pattern.get("bias") in {"bull", "bear"} and pattern.get("bias") == direction:
                confidence = min(0.98, confidence + 0.05 * float(pattern.get("score") or 0))
            elif pattern.get("bias") in {"bull", "bear"} and pattern.get("bias") != direction:
                confidence *= 0.72
            if mom_dir in {"bull", "bear"} and mom_dir != direction:
                confidence *= 0.82
            if macd_dir in {"bull", "bear"} and macd_dir != direction:
                confidence *= 0.88
            if di_dir in {"bull", "bear"} and di_dir != direction:
                confidence *= 0.88
            if atr_now and atr_now < 0.00025:
                confidence *= 0.55
            if er and er < 0.18:
                confidence *= 0.78
            if abs(di) < 0.025 and abs(float(features.get("ema_spread") or 0)) < 0.0005:
                confidence *= 0.8
            if votes:
                agree = votes.count(direction) / len(votes) if direction in {"bull", "bear"} else 0.0
                confidence *= 0.55 + 0.45 * agree
                if agree < 0.34:
                    direction = "neutral"
                    confidence *= 0.5
        else:
            # Never invent a tradeable direction before the model is trained.
            direction = "neutral"
            confidence = 0.0
        model_p = float(prediction.get("confidence") or 0)
        agree = 0.0
        if votes and direction in {"bull", "bear"}:
            agree = votes.count(direction) / len(votes)
        why = {
            "model": round(model_p, 3),
            "agreement": round(agree, 3),
            "pattern": str(pattern.get("name") or ""),
            "pattern_score": round(float(pattern.get("score") or 0), 3),
            "votes": votes[-8:],
            "text": (
                f"Model probability {model_p:.0%} of the last live bars, "
                f"then scaled by candle-pattern / EMA / MACD / DI / RSI agreement "
                f"({agree:.0%} with {direction}). Low ATR or chop cuts the score. "
                f"The setting in Robot is the minimum of this number required to allow a robot entry."
            ),
        }
        display = direction if prediction["ready"] else (hint if hint != "neutral" else "neutral")
        reason_parts = []
        if prediction["ready"]:
            reason_parts.append(f"model={prediction['direction']} p={confidence:.2f}")
            reason_parts.append(f"agree={agree:.2f}")
        else:
            reason_parts.append("learning automatically from live EA candles — no train button needed")
            if hint != "neutral":
                reason_parts.append(f"hint={hint} (untrained)")
        if pattern.get("name"):
            reason_parts.append(f"pattern={pattern['name']}")
        if regime.get("name"):
            reason_parts.append(f"regime={regime['name']}/{regime.get('vol')}")
        if mom_dir != "neutral":
            reason_parts.append(f"mom={mom_dir}")
        if macd_dir != "neutral":
            reason_parts.append(f"macd={macd_dir}")
        if di_dir != "neutral":
            reason_parts.append(f"di={di_dir}")
        state = {
            "ready": bool(prediction["ready"]),
            "status": "ready" if prediction["ready"] else "waiting",
            "direction": direction,
            "hint": hint,
            "display_direction": display,
            "need": int(load().get("ai", {}).get("min_bars_to_train") or 160),
            "activity": list(self.activity)[-16:],
            "confidence": confidence,
            "confidence_why": why,
            "proba": prediction.get("proba") or {},
            "regime": regime,
            "pattern": pattern,
            "features": features,
            "reason": "; ".join(reason_parts),
            "samples": self.models.samples,
            "updated": self.models.updated,
            "metrics": dict(self.models.metrics or {}),
            "symbol": symbol,
            "timeframe": timeframe,
            "ts": utc_iso(),
        }
        bull_n = votes.count("bull")
        bear_n = votes.count("bear")
        outlook_dir = display if display != "neutral" else hint
        strength = float(confidence) if prediction["ready"] else min(0.45, 0.18 + 0.08 * max(bull_n, bear_n))
        if outlook_dir == "neutral":
            strength = min(strength, 0.34)
        state["outlook"] = {
            "direction": outlook_dir,
            "live": True,
            "ready": bool(prediction["ready"]),
            "strength": round(strength, 3),
            "horizon": timeframe,
            "symbol": symbol,
            "votes": {"bull": bull_n, "bear": bear_n, "total": len(votes)},
            "text": (
                f"{outlook_dir} {timeframe} · conf={strength:.0%} · "
                f"votes {bull_n}↑/{bear_n}↓ · {pattern.get('name') or 'no pattern'} · "
                f"{regime.get('name') or 'regime?'}"
            ),
        }
        shown = outlook_dir
        self.note(
            f"{symbol} {timeframe} {shown} conf={confidence:.2f} "
            f"{'ready' if prediction['ready'] else 'learning'} bars={len(rows)}"
        )
        state["activity"] = list(self.activity)[-16:]
        self.last = state
        self._remember(symbol, timeframe, state)
        return state

    def on_closed_bar(self, rows: list[dict[str, Any]], symbol: str, timeframe: str) -> dict[str, Any]:
        cfg = load()
        state = self.infer(rows, symbol, timeframe)
        self.bars_since_train += 1
        need = int(cfg["ai"].get("min_bars_to_train") or 160)
        every = int(cfg["ai"].get("retrain_every_bars") or 40)
        if (not self.models.ready and len(rows) >= min(need, 80)) or (self.models.ready and self.bars_since_train >= every):
            state = {**state, "retrain_due": True}
            return state
        if self.models.ready and bool(cfg["ai"].get("online_learning")):
            try:
                frame = build_feature_frame(rows)
                if len(frame) > 5:
                    y, sl = _labels_from_frame(frame)
                    if len(y):
                        X = matrix(frame.iloc[sl])
                        if len(X):
                            self.models.partial(X[-1], int(y[-1]))
            except Exception:
                log.exception("online partial_fit skipped")
        return state
