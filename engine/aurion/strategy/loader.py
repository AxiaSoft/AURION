from __future__ import annotations

import ast
import importlib.util
import inspect
import sys
from pathlib import Path
from typing import Any

from ..config import ROOT, load
from ..util.log import get
from .base import BaseStrategy

log = get("strategy")

FORBIDDEN_NAMES = {
    "eval",
    "exec",
    "compile",
    "system",
    "popen",
    "fork",
    "kill",
    "remove",
    "unlink",
    "rmdir",
    "rmtree",
    "chmod",
    "chown",
    "socket",
    "subprocess",
    "shutil",
    "ctypes",
    "multiprocessing",
    "pickle",
    "marshal",
    "requests",
    "httpx",
    "urllib",
    "webbrowser",
    "ftplib",
    "paramiko",
}
FORBIDDEN_MODULES = {
    "os",
    "sys",
    "subprocess",
    "socket",
    "shutil",
    "ctypes",
    "multiprocessing",
    "pathlib",
    "requests",
    "httpx",
    "urllib",
    "pickle",
    "marshal",
    "ftplib",
    "paramiko",
    "webbrowser",
}


BUILTIN_NAMES = ("ema_rsi", "price_action", "atr_breakout", "scalp_impulse")
RESERVED_NAMES = set(BUILTIN_NAMES) | {"template", "base"}


class StrategyValidationError(ValueError):
    pass


def sanitize_stem(filename: str) -> str:
    """Normalise an uploaded file name to a safe strategy key."""
    import re

    stem = Path(str(filename or "")).name
    if stem.endswith(".py"):
        stem = stem[:-3]
    if stem.startswith("_") or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", stem or ""):
        raise StrategyValidationError(
            "illegal filename — use latin letters, digits and underscore (e.g. my_strategy.py)"
        )
    if stem in RESERVED_NAMES:
        raise StrategyValidationError(f"'{stem}' is a reserved strategy name — pick another file name")
    return stem


def validate_source(source: str) -> dict[str, Any]:
    try:
        tree = ast.parse(source)
    except SyntaxError as exc:
        raise StrategyValidationError(f"syntax error: {exc}") from exc
    for node in ast.walk(tree):
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            names = []
            if isinstance(node, ast.Import):
                names = [alias.name.split(".")[0] for alias in node.names]
            else:
                names = [str(node.module or "").split(".")[0]]
            for name in names:
                if name in FORBIDDEN_MODULES:
                    raise StrategyValidationError(f"import '{name}' is not allowed in user strategies")
        if isinstance(node, ast.Name) and node.id in FORBIDDEN_NAMES:
            raise StrategyValidationError(f"use of '{node.id}' is not allowed")
        if isinstance(node, ast.Attribute) and node.attr in FORBIDDEN_NAMES:
            raise StrategyValidationError(f"use of '.{node.attr}' is not allowed")
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id in {"eval", "exec", "compile", "__import__"}:
            raise StrategyValidationError(f"call to {node.func.id} is not allowed")
    return {"ok": True}


class StrategyLoader:
    def __init__(self) -> None:
        cfg = load()
        self.dir = ROOT / cfg["paths"]["strategies"]
        self.dir.mkdir(parents=True, exist_ok=True)
        self.loaded: dict[str, Any] = {}

    def list(self) -> list[dict[str, Any]]:
        items = []
        for path in sorted(self.dir.glob("*.py")):
            if path.name.startswith("_"):
                continue
            items.append(
                {
                    "file": path.name,
                    "path": str(path),
                    "loaded": path.stem in self.loaded,
                    "name": getattr(self.loaded.get(path.stem), "name", path.stem),
                }
            )
        for key, inst in self.loaded.items():
            if key.startswith("builtin:"):
                items.append({"file": key, "path": key, "loaded": True, "name": inst.name})
        return items

    def validate_file(self, path: Path) -> dict[str, Any]:
        source = path.read_text(encoding="utf-8")
        validate_source(source)
        return {"ok": True, "file": path.name}

    def _instantiate(self, module: Any, params: dict[str, Any] | None) -> BaseStrategy:
        candidates = []
        for _, obj in inspect.getmembers(module, inspect.isclass):
            if obj.__module__ != module.__name__:
                continue
            if obj.__name__ in {"BaseStrategy", "Strategy"}:
                continue
            if hasattr(obj, "on_candle") or hasattr(obj, "on_tick"):
                candidates.append(obj)
        if not candidates:
            raise StrategyValidationError("no strategy class with on_candle/on_tick found")
        cls = candidates[0]
        inst = cls(params or {})
        return inst

    def load_path(self, path: Path, params: dict[str, Any] | None = None) -> BaseStrategy:
        validate_source(path.read_text(encoding="utf-8"))
        key = path.stem
        mod_name = f"aurion_user_strategy_{key}"
        spec = importlib.util.spec_from_file_location(mod_name, path)
        if spec is None or spec.loader is None:
            raise StrategyValidationError("cannot import strategy file")
        module = importlib.util.module_from_spec(spec)
        sys.modules[mod_name] = module
        spec.loader.exec_module(module)
        inst = self._instantiate(module, params)
        self.loaded[key] = inst
        log.info("loaded strategy %s from %s", inst.name, path.name)
        return inst

    def build(self, spec: dict[str, Any]):
        kind = spec.get("kind") or "builtin"
        name = spec.get("name") or spec.get("file")
        params = spec.get("params") or {}
        if kind == "builtin":
            return self.load_builtin(str(name), params)
        from pathlib import Path

        path = Path(spec.get("path") or (self.dir / str(name)))
        return self.load_path(path, params)

    def load_builtin(self, name: str, params: dict[str, Any] | None = None) -> BaseStrategy:
        from .builtin.atr_breakout import ATRBreakout
        from .builtin.ema_rsi import EmaRsi
        from .builtin.price_action import PriceAction
        from .builtin.scalp_impulse import ScalpImpulse

        mapping = {
            "ema_rsi": EmaRsi,
            "price_action": PriceAction,
            "atr_breakout": ATRBreakout,
            "scalp_impulse": ScalpImpulse,
        }
        if name not in mapping:
            raise StrategyValidationError(f"unknown builtin strategy '{name}'")
        inst = mapping[name](params or {})
        self.loaded[f"builtin:{name}"] = inst
        return inst

    def save_upload(self, filename: str, source: str) -> Path:
        validate_source(source)
        stem = sanitize_stem(filename)
        dest = self.dir / f"{stem}.py"
        dest.write_text(source, encoding="utf-8")
        return dest
