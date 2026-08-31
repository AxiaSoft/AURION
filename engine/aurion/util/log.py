from __future__ import annotations

import json
import logging
import sys
import threading
from collections import deque
from pathlib import Path
from typing import Any, Callable

from .clock import utc_iso

Listener = Callable[[dict[str, Any]], None]


class RingHandler(logging.Handler):
    def __init__(self, capacity: int = 2000) -> None:
        super().__init__()
        self.buffer: deque[dict[str, Any]] = deque(maxlen=capacity)
        self._listeners: list[Listener] = []
        self._lock = threading.RLock()

    def emit(self, record: logging.LogRecord) -> None:
        payload = {
            "ts": utc_iso(),
            "level": record.levelname.lower(),
            "logger": record.name,
            "message": record.getMessage(),
            "lang_key": getattr(record, "lang_key", ""),
            "extra": getattr(record, "payload", {}),
        }
        with self._lock:
            self.buffer.append(payload)
            listeners = list(self._listeners)
        for listener in listeners:
            try:
                listener(payload)
            except Exception:
                pass

    def subscribe(self, listener: Listener) -> None:
        with self._lock:
            self._listeners.append(listener)

    def snapshot(self, limit: int = 300) -> list[dict[str, Any]]:
        with self._lock:
            items = list(self.buffer)
        return items[-limit:]


RING = RingHandler()


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        return json.dumps(
            {
                "ts": utc_iso(),
                "level": record.levelname,
                "logger": record.name,
                "message": record.getMessage(),
            },
            ensure_ascii=False,
        )


def setup(level: str = "INFO") -> logging.Logger:
    root = logging.getLogger("aurion")
    if root.handlers:
        return root
    root.setLevel(getattr(logging, level.upper(), logging.INFO))
    stream = logging.StreamHandler(sys.stdout)
    stream.setFormatter(JsonFormatter())
    root.addHandler(stream)
    root.addHandler(RING)
    try:
        log_dir = Path(__file__).resolve().parents[3] / "data" / "logs"
        log_dir.mkdir(parents=True, exist_ok=True)
        fh = logging.FileHandler(log_dir / "engine.log", encoding="utf-8")
        fh.setFormatter(JsonFormatter())
        root.addHandler(fh)
    except Exception:
        pass
    root.propagate = False
    return root


def get(name: str = "aurion") -> logging.Logger:
    if name == "aurion":
        return logging.getLogger("aurion")
    return logging.getLogger(f"aurion.{name}")
