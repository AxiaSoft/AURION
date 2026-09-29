from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import joblib
import numpy as np
from sklearn.cluster import MiniBatchKMeans
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.linear_model import SGDClassifier
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler

from ..util.clock import utc_iso

# A boosted tree sees the non-linear combinations a linear model cannot, but
# it needs data. Below this many labelled bars only the linear model votes.
BOOST_MIN_SAMPLES = 400


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
        # Second opinion: gradient-boosted trees on the same features. Trained
        # only when there is enough real history, blended at inference time.
        self.boost: Any = None
        # Measured out-of-sample edge (0 = no better than guessing). Every
        # confidence the desk sees is shrunk by it, so an untested model can
        # never talk the robot into a trade.
        self.edge = 0.0
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
            self.boost = blob.get("boost")
            try:
                self.edge = float(blob.get("edge") or self.metrics.get("edge") or 0.0)
            except (TypeError, ValueError):
                self.edge = 0.0
            self.updated = str(blob.get("updated") or "")
            self._seen_classes = self.ready
        except Exception:
            self.ready = False

    def persist(self) -> None:
        joblib.dump(
            {
                "direction": self.direction,
                "regime": self.regime,
                "boost": self.boost,
                "edge": self.edge,
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
        # Boosted trees on the same split — kept only if the holdout says it
        # is worth keeping (see the accuracy comparison below).
        boost = None
        if len(X_tr) >= BOOST_MIN_SAMPLES and len(np.unique(y_tr)) >= 2:
            try:
                candidate = HistGradientBoostingClassifier(
                    max_depth=3,
                    max_iter=180,
                    learning_rate=0.06,
                    l2_regularization=1.0,
                    min_samples_leaf=25,
                    early_stopping=True,
                    validation_fraction=0.15,
                    random_state=7,
                )
                candidate.fit(X_tr, y_tr, sample_weight=w_tr)
                boost = candidate
            except Exception:
                boost = None
        vol_idx = 9 if X.shape[1] > 9 else min(7, X.shape[1] - 1)
        vol = X[:, [vol_idx, min(vol_idx + 1, X.shape[1] - 1)]]
        self.regime.partial_fit(vol)
        pred_in = self.direction.predict(X_tr)
        acc_in = float((pred_in == y_tr).mean())
        acc_oos = None
        acc_boost = None
        baseline = None
        if len(X_te) >= 20:
            pred_te = self.direction.predict(X_te)
            acc_oos = float((pred_te == y_te).mean())
            # Beating the most common label is the only accuracy that counts.
            counts = np.bincount(y_te - y_te.min()) if len(y_te) else np.array([1])
            baseline = float(counts.max() / max(1, len(y_te)))
            if boost is not None:
                try:
                    acc_boost = float((boost.predict(X_te) == y_te).mean())
                except Exception:
                    acc_boost = None
        # Keep the tree only when it holds its own out of sample.
        if boost is not None and acc_oos is not None and acc_boost is not None and acc_boost + 0.01 < acc_oos:
            boost = None
        self.boost = boost
        best_acc = max([a for a in (acc_oos, acc_boost) if a is not None], default=None)
        if best_acc is not None and baseline is not None and baseline < 0.999:
            self.edge = max(0.0, min(1.0, (best_acc - baseline) / (1.0 - baseline)))
        else:
            self.edge = 0.0
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
            "accuracy_boost": acc_boost,
            "baseline_holdout": baseline,
            "edge": round(self.edge, 4),
            "ensemble": bool(self.boost is not None),
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
            if self.boost is not None:
                # Average the two opinions over the union of their classes; a
                # setup only scores high when both models like it.
                try:
                    b_proba = self.boost.predict_proba(vector)[0]
                    b_classes = list(self.boost.classes_)
                    blended: dict[int, float] = {}
                    for cls, p in zip(classes, proba):
                        blended[int(cls)] = blended.get(int(cls), 0.0) + 0.5 * float(p)
                    for cls, p in zip(b_classes, b_proba):
                        blended[int(cls)] = blended.get(int(cls), 0.0) + 0.5 * float(p)
                    classes = list(blended.keys())
                    proba = np.array([blended[c] for c in classes], dtype=float)
                    total = float(proba.sum()) or 1.0
                    proba = proba / total
                except Exception:
                    pass
            mapping = {int(cls): float(p) for cls, p in zip(classes, proba)}
            best = int(classes[int(np.argmax(proba))])
            confidence = float(np.max(proba))
            # Calibration: pull the probability back towards "no information"
            # in proportion to the edge the model actually showed out of
            # sample. No measured edge means no confident signal.
            base = 1.0 / max(2, len(classes))
            shrink = 0.30 + 0.70 * max(0.0, min(1.0, float(self.edge)))
            confidence = base + (confidence - base) * shrink
            mapping = {cls: base + (p - base) * shrink for cls, p in mapping.items()}
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
            "edge": round(float(self.edge), 4),
            "direction": direction,
            "label": best,
            "confidence": confidence,
            "proba": mapping,
            "regime_id": rid,
        }
