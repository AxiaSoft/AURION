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


BUILTIN_NAMES = ("ema_rsi", "price_action", "atr_breakout", "smart_money")

# Strategies that used to ship and no longer do. Saved runtime state, MT5
# comments on open positions and a trader's own config all still name them, so
# they resolve to their replacement instead of raising. Dropping the entry
# would turn an upgrade into "unknown builtin strategy" on first boot.
# King was withdrawn. Saved runtime state, a trader's own config and the
# comment on any position it opened all still name it, so it resolves to
# price_action - the surviving strategy that also trades structure - rather
# than raising. Dropping these entries would turn an upgrade into "unknown
# builtin strategy" on the first boot after the update.
LEGACY_BUILTINS = {"scalp_impulse": "price_action", "king": "price_action"}

# Both names stay reserved after retirement: an uploaded file called either
# would collide with the aliases above and silently shadow the real target.
RESERVED_NAMES = set(BUILTIN_NAMES) | set(LEGACY_BUILTINS) | {"template", "base"}


def resolve_builtin(name: str) -> str:
    """Current id for a built-in, following one retirement if necessary."""
    key = str(name or "")
    return LEGACY_BUILTINS.get(key, key)


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

    def uploaded_names(self) -> list[str]:
        """Stems of the strategy files on disk, in the order the desk lists them."""
        return [p.stem for p in sorted(self.dir.glob("*.py")) if not p.name.startswith("_")]

    def file_for(self, name: Any) -> Path | None:
        """The uploaded file a name refers to, with or without the suffix.

        The desk's dropdown holds a strategy's *stem* ("my_strategy"), the
        upload endpoint passes the *file name* ("my_strategy.py"), and both
        have to mean the same file. Joining the raw value onto the folder
        turned the first of those into a path with no extension, which
        raised FileNotFoundError from somewhere deep in load_path.
        """
        raw = str(name or "").strip()
        if not raw:
            return None
        stem = Path(raw).name
        if stem.endswith(".py"):
            stem = stem[:-3]
        if not stem:
            return None
        candidate = self.dir / f"{stem}.py"
        return candidate if candidate.is_file() else None

    def _unknown(self, name: Any) -> str:
        """An error that says what the caller could have asked for instead.

        "unknown builtin strategy 'x'" named the thing that failed and
        nothing that would work, which on the desk read as a broken
        upload rather than a mislabelled request.
        """
        known = list(BUILTIN_NAMES) + self.uploaded_names()
        return (
            f"no strategy called '{name}' — available: {', '.join(known)}"
            if known
            else f"no strategy called '{name}' and none are installed"
        )

    def build(self, spec: dict[str, Any]):
        """Resolve a {kind, name, path} spec to a live strategy.

        `kind` is a hint, not a promise. The desk labelled every backtest
        request "builtin" whatever was picked in the dropdown, so running
        a backtest on an uploaded strategy came back as "unknown builtin
        strategy 'my_strategy'" - the file was uploaded, loaded and armed
        perfectly, and only the label was wrong. A caller that names
        something real gets it, whichever bucket they put it in.
        """
        kind = spec.get("kind") or "builtin"
        name = spec.get("name") or spec.get("file")
        params = spec.get("params") or {}

        explicit = spec.get("path")
        if explicit:
            return self.load_path(Path(explicit), params)

        is_builtin = resolve_builtin(str(name)) in set(BUILTIN_NAMES)
        found = self.file_for(name)

        if kind == "builtin":
            if is_builtin:
                return self.load_builtin(str(name), params)
            if found is not None:
                log.info("strategy %s was asked for as a builtin; it is an uploaded file", name)
                return self.load_path(found, params)
            raise StrategyValidationError(self._unknown(name))

        if found is not None:
            return self.load_path(found, params)
        if is_builtin:
            log.info("strategy %s was asked for as a file; it is a builtin", name)
            return self.load_builtin(str(name), params)
        raise StrategyValidationError(self._unknown(name))

    def load_builtin(self, name: str, params: dict[str, Any] | None = None) -> BaseStrategy:
        from .builtin.atr_breakout import ATRBreakout
        from .builtin.ema_rsi import EmaRsi
        from .builtin.price_action import PriceAction
        from .builtin.smart_money import SmartMoney

        mapping = {
            "ema_rsi": EmaRsi,
            "price_action": PriceAction,
            "atr_breakout": ATRBreakout,
            "smart_money": SmartMoney,
        }
        name = resolve_builtin(name)
        if name not in mapping:
            raise StrategyValidationError(self._unknown(name))
        inst = mapping[name](params or {})
        self.loaded[f"builtin:{name}"] = inst
        return inst

    def save_upload(self, filename: str, source: str) -> Path:
        validate_source(source)
        stem = sanitize_stem(filename)
        dest = self.dir / f"{stem}.py"
        dest.write_text(source, encoding="utf-8")
        return dest
