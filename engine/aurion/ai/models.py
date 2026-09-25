from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import joblib
import numpy as np
from sklearn.cluster import MiniBatchKMeans
from sklearn.linear_model import SGDClassifier
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler

from ..util.clock import utc_iso


class LiveModels:
    """Direction + regime models trained only on real OHLC matrices.

    No weights are shipped. Until enough live/history bars exist the models
    refuse to predict rather than emit a decorative signal.
    """

    def __init__(self, directory: Path) -> None:
        self.directory = directory
        self.directory.mkdir(parents=True, exist_ok=True)
        self.direction = Pipeline(
            [
                ("scaler", StandardScaler()),
                (
                    "clf",
                    SGDClassifier(
                        loss="log_loss",
                        penalty="l2",
                        alpha=1e-4,
                        max_iter=50,
                        tol=1e-3,
                        random_state=7,
                    ),
                ),
            ]
        )
        self.regime = MiniBatchKMeans(n_clusters=3, random_state=7, n_init=8, batch_size=64)
        self.ready = False
        self.samples = 0
        self.metrics: dict[str, Any] = {}
        self.updated = ""
        self._seen_classes = False
        self.load()

    @property
    def path(self) -> Path:
        return self.directory / "live.joblib"

    def load(self) -> None:
        if not self.path.exists():
            return
        try:
            blob = joblib.load(self.path)
            self.direction = blob["direction"]
            self.regime = blob["regime"]
            self.ready = bool(blob.get("ready"))
            self.samples = int(blob.get("samples") or 0)
            self.metrics = dict(blob.get("metrics") or {})
            self.updated = str(blob.get("updated") or "")
            self._seen_classes = self.ready
        except Exception:
            self.ready = False

    def persist(self) -> None:
        joblib.dump(
            {
                "direction": self.direction,
                "regime": self.regime,
                "ready": self.ready,
                "samples": self.samples,
                "metrics": self.metrics,
                "updated": utc_iso(),
            },
            self.path,
        )
        self.updated = utc_iso()
        meta = self.directory / "live.metrics.json"
        meta.write_text(json.dumps({"samples": self.samples, "metrics": self.metrics, "updated": self.updated}, indent=2), encoding="utf-8")

    def fit(self, X: np.ndarray, y: np.ndarray) -> dict[str, Any]:
        if X.size == 0 or len(np.unique(y)) < 2 or len(X) < 80:
            return {"ok": False, "error": "not enough labelled real bars to train"}
        n = len(X)
        recency = np.exp(np.linspace(-1.6, 0.0, n))
        weight = recency.astype(float)
        classes = np.unique(y)
        for cls in classes:
            mask = y == cls
            count = int(mask.sum()) or 1
            weight[mask] *= n / (len(classes) * count)
        cut = max(60, int(n * 0.8))
        X_tr, y_tr, w_tr = X[:cut], y[:cut], weight[:cut]
        X_te, y_te = X[cut:], y[cut:]
        self.direction.fit(X_tr, y_tr, clf__sample_weight=w_tr)
        vol_idx = 9 if X.shape[1] > 9 else min(7, X.shape[1] - 1)
        vol = X[:, [vol_idx, min(vol_idx + 1, X.shape[1] - 1)]]
        self.regime.partial_fit(vol)
        pred_in = self.direction.predict(X_tr)
        acc_in = float((pred_in == y_tr).mean())
        acc_oos = None
        if len(X_te) >= 20:
            pred_te = self.direction.predict(X_te)
            acc_oos = float((pred_te == y_te).mean())
        try:
            proba = self.direction.predict_proba(X)
            conf = float(proba.max(axis=1).mean())
        except Exception:
            conf = 0.0
        self.ready = True
        self._seen_classes = True
        self.samples = int(len(X))
        self.metrics = {
            "accuracy_in_sample": acc_in,
            "accuracy_holdout": acc_oos,
            "mean_confidence": conf,
            "bars": int(len(X)),
            "holdout_bars": int(len(X_te)),
        }
        self.persist()
        return {"ok": True, "metrics": self.metrics}

    def partial(self, x: np.ndarray, y: int) -> None:
        if not self.ready:
            return
        clf = self.direction.named_steps["clf"]
        known = set(int(c) for c in getattr(clf, "classes_", []))
        if known and int(y) not in known:
            return
        try:
            clf.partial_fit(
                self.direction.named_steps["scaler"].transform(x.reshape(1, -1)),
                np.array([y]),
            )
            self.samples += 1
        except Exception:
            return

    def infer(self, x: np.ndarray) -> dict[str, Any]:
        if not self.ready:
            return {"ready": False, "direction": "neutral", "confidence": 0.0, "proba": {}, "regime_id": -1}
        vector = x.reshape(1, -1)
        try:
            proba = self.direction.predict_proba(vector)[0]
            classes = list(self.direction.named_steps["clf"].classes_)
            mapping = {int(cls): float(p) for cls, p in zip(classes, proba)}
            best = int(classes[int(np.argmax(proba))])
            confidence = float(np.max(proba))
        except Exception:
            best = int(self.direction.predict(vector)[0])
            mapping = {best: 1.0}
            confidence = 0.5
        direction = {1: "bull", 0: "neutral", -1: "bear"}.get(best, "neutral")
        try:
            vol = vector[:, [7, 8]] if vector.shape[1] > 8 else vector[:, :2]
            rid = int(self.regime.predict(vol)[0])
        except Exception:
            rid = -1
        return {
            "ready": True,
            "direction": direction,
            "label": best,
            "confidence": confidence,
            "proba": mapping,
            "regime_id": rid,
        }
