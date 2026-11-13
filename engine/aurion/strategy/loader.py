from __future__ import annotations

import ast
import importlib.util
import inspect
import sys
from pathlib import Path
from typing import Any

from ..config import DATA_DIR, ROOT, load
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
    """Loads strategies, and makes sure the user's own ones still exist.

    The working folder is engine/strategies, which is inside the
    installation. That is fine for the shipped template and examples and
    was wrong for everything the user wrote: Windows Installer owns that
    folder. A major upgrade removes the old product before it lays the
    new one down - deliberately, so that files dropped from a build
    leave no orphans - and the install tree is not a place where a
    customer's work can be expected to survive it. An update, a repair,
    a reinstall, an antivirus quarantine: every one of them can take a
    file out of there, and when one did, the only trace was

        [Errno 2] No such file or directory:
          'C:\\...\\AURION\\engine\\strategies\\aurion_gold_pullback'

    reported twice, months apart, for two different strategies. The
    loader was blamed both times and the loader was never at fault: it
    was asked for a file that genuinely was not there any more.

    So the user's copy now lives in the vault - data/strategies - which
    is user data by every definition this product already uses: the
    installer excludes data\ on purpose, the updater's protected list
    refuses to write anything under it, and a factory reset keeps it.
    Nothing that installs or updates AURION can reach into it.

    engine/strategies stays the working folder, so every caller, glob
    and import path below is unchanged. The two are reconciled at
    startup: anything in the vault that is missing from the working
    folder is written back, and anything in the working folder that the
    vault has never seen is taken into it. A strategy can therefore
    survive an upgrade that empties the install tree, and one uploaded
    by an older build is adopted the first time this runs.
    """

    def __init__(self) -> None:
        cfg = load()
        self.dir = ROOT / cfg["paths"]["strategies"]
        self.dir.mkdir(parents=True, exist_ok=True)
        # Outside the installation on purpose. See the class docstring.
        self.vault = DATA_DIR / "strategies"
        self.loaded: dict[str, Any] = {}
        try:
            self.sync_vault()
        except Exception:
            # A strategy folder that cannot be reconciled must never stop
            # the engine from starting: the desk would be gone as well.
            log.exception("could not reconcile the strategy vault")

    # Shipped with the product, not written by the user. These live in
    # the install tree because that is where they come from, and copying
    # them into a user's vault would resurrect an old template after an
    # update replaced it.
    _SHIPPED = {"template"}

    def _is_user_file(self, path: Path) -> bool:
        return (
            path.is_file()
            and path.suffix == ".py"
            and not path.name.startswith("_")
            and path.stem not in self._SHIPPED
        )

    def sync_vault(self) -> dict[str, list[str]]:
        """Reconcile the install folder with the user's own copy.

        Returns what it did, so the caller can log it - a strategy
        quietly reappearing is more alarming than one that is announced.

        Content is compared before writing in either direction: an
        unconditional copy would undo an edit made through the desk, and
        an unconditional copy the other way would undo one made in the
        file itself.
        """
        restored: list[str] = []
        adopted: list[str] = []
        self.vault.mkdir(parents=True, exist_ok=True)

        # The vault is the record of what the user has. Anything in it
        # that is not in the working folder was taken away by something
        # that had no business touching it.
        for src in sorted(self.vault.glob("*.py")):
            if not self._is_user_file(src):
                continue
            live = self.dir / src.name
            try:
                if not live.exists():
                    live.write_text(src.read_text(encoding="utf-8"), encoding="utf-8")
                    restored.append(src.stem)
            except OSError:
                log.exception("could not restore strategy %s from the vault", src.stem)

        # And anything in the working folder the vault has never seen was
        # uploaded by a build that predates this, or dropped in by hand.
        for live in sorted(self.dir.glob("*.py")):
            if not self._is_user_file(live):
                continue
            keep = self.vault / live.name
            try:
                source = live.read_text(encoding="utf-8")
                if not keep.exists():
                    keep.write_text(source, encoding="utf-8")
                    adopted.append(live.stem)
                elif keep.read_text(encoding="utf-8") != source:
                    # The working copy is the one the engine runs and the
                    # desk edits, so it wins.
                    keep.write_text(source, encoding="utf-8")
            except OSError:
                log.exception("could not take strategy %s into the vault", live.stem)

        if restored:
            log.warning(
                "restored %d strategy file(s) that had gone missing from the installation: %s",
                len(restored), ", ".join(restored),
            )
        if adopted:
            log.info("took %d existing strategy file(s) into the vault: %s", len(adopted), ", ".join(adopted))
        return {"restored": restored, "adopted": adopted}

    def forget(self, stem: str) -> None:
        """Delete a user strategy from both places.

        Without the second half a deleted strategy would be restored by
        the next startup, which is the vault turning from a safety net
        into a bug.
        """
        name = str(stem or "").strip()
        if name.endswith(".py"):
            name = name[:-3]
        if not name:
            return
        for base in (self.dir, self.vault):
            try:
                (base / f"{name}.py").unlink(missing_ok=True)
            except OSError:
                log.exception("could not delete %s.py from %s", name, base)

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

    @staticmethod
    def _implements(cls: Any, method: str) -> bool:
        """True when `cls` actually writes `method`, rather than inheriting it.

        BaseStrategy supplies no-op on_candle/on_tick so a subclass always
        *has* them. hasattr() therefore says yes to a helper class that
        happens to inherit from BaseStrategy, which is how a file with two
        classes could load the wrong one.

        The answer is read off the MRO rather than compared against the
        BaseStrategy imported here: a user file is imported under its own
        module name, and the engine can end up holding two copies of
        aurion.strategy.base (the test suite does). Identity comparison
        then said "yes, it implements it" for every class in the file and
        the helper won again, from a different direction.
        """
        base_names = {"BaseStrategy", "Strategy", "object"}
        for klass in getattr(cls, "__mro__", ()):
            if method in getattr(klass, "__dict__", {}):
                return klass.__name__ not in base_names
        return False

    def _instantiate(self, module: Any, params: dict[str, Any] | None) -> BaseStrategy:
        """Pick the strategy class in a loaded module, deterministically.

        This used to take candidates[0], and inspect.getmembers sorts by
        NAME — so a file containing a helper and the real strategy loaded
        whichever came first in the alphabet. `class Helper(BaseStrategy)`
        beat `class MyStrategy(BaseStrategy)` and the desk armed a
        strategy that does nothing, with no complaint anywhere.

        The order of preference is now what the author actually wrote:
        a class that implements on_candle or on_tick wins over one that
        merely inherits them, and ties are broken by position in the file
        rather than by name.
        """
        defined = [
            obj
            for _, obj in inspect.getmembers(module, inspect.isclass)
            if obj.__module__ == module.__name__
            and obj.__name__ not in {"BaseStrategy", "Strategy"}
        ]
        # Source order, so "the first strategy in the file" means what it
        # looks like it means. Classes without a line number sort last.
        def where(cls: Any) -> int:
            try:
                return int(inspect.getsourcelines(cls)[1])
            except (OSError, TypeError):
                return 10**9

        defined.sort(key=where)

        real = [c for c in defined
                if self._implements(c, "on_candle") or self._implements(c, "on_tick")]
        if real:
            if len(real) > 1:
                log.info(
                    "%s defines %d strategies (%s); using the first one",
                    module.__name__, len(real), ", ".join(c.__name__ for c in real),
                )
            cls = real[0]
        else:
            inherited = [c for c in defined
                         if hasattr(c, "on_candle") or hasattr(c, "on_tick")]
            if not inherited:
                found = ", ".join(c.__name__ for c in defined) or "none"
                raise StrategyValidationError(
                    "no strategy class found — a class must define on_candle "
                    f"or on_tick (classes in this file: {found})"
                )
            # Inherits the no-op base methods and overrides neither: it will
            # load and then never say anything, which is worth naming here
            # rather than leaving the trader to discover it in silence.
            cls = inherited[0]
            log.warning(
                "strategy class %s overrides neither on_candle nor on_tick; "
                "it can never produce a signal", cls.__name__,
            )
        try:
            return cls(params or {})
        except StrategyValidationError:
            raise
        except Exception as exc:
            raise StrategyValidationError(
                f"{cls.__name__}.__init__ failed: {type(exc).__name__}: {exc}"
            ) from exc

    def load_path(self, path: Path, params: dict[str, Any] | None = None) -> BaseStrategy:
        """Import one strategy file and build the class inside it.

        Everything that can go wrong here comes back as
        StrategyValidationError carrying a sentence a trader can act on.
        It used to let the raw exception out, so a missing file reached
        the desk as "[Errno 2] No such file or directory: 'C:\\Users\\...
        \\engine\\strategies\\my_strategy'" — a path the trader never
        typed, with no hint that the extension had been lost on the way.
        """
        path = Path(path)
        # An explicit path that lost its extension is still answerable.
        #
        # This is the shape of the fault that was reported twice from a
        # Windows desk: a path ending in the strategy's name with no
        # ".py" on it, which nobody typed. The joins that produced it are
        # gone, but a spec stored by an older build is still on disk in
        # data/, and a caller outside this file can always make the same
        # mistake again. If the file beside it exists, use it rather than
        # refusing something that is plainly there.
        if not path.suffix and not path.exists():
            with_py = path.with_suffix(".py")
            if with_py.is_file():
                log.info("strategy path '%s' had no extension; using %s", path.name, with_py.name)
                path = with_py
        try:
            source = path.read_text(encoding="utf-8")
        except FileNotFoundError:
            raise StrategyValidationError(self._unknown(path.stem)) from None
        except IsADirectoryError:
            raise StrategyValidationError(f"'{path.name}' is a folder, not a strategy file") from None
        except UnicodeDecodeError:
            raise StrategyValidationError(
                f"'{path.name}' is not UTF-8 text — save it as UTF-8 and upload it again"
            ) from None
        except OSError as exc:
            raise StrategyValidationError(f"cannot read '{path.name}': {exc}") from exc

        validate_source(source)
        key = path.stem
        mod_name = f"aurion_user_strategy_{key}"
        spec = importlib.util.spec_from_file_location(mod_name, path)
        if spec is None or spec.loader is None:
            raise StrategyValidationError(f"cannot import '{path.name}'")
        module = importlib.util.module_from_spec(spec)
        sys.modules[mod_name] = module
        try:
            spec.loader.exec_module(module)
        except Exception as exc:
            # The file ran and threw: a typo in a name, a bad default, an
            # import of something that is not installed. Name the line, and
            # do not leave a half-built module behind for the next load to
            # find.
            sys.modules.pop(mod_name, None)
            line = ""
            tb = exc.__traceback__
            while tb is not None:
                if tb.tb_frame.f_code.co_filename == str(path):
                    line = f" at line {tb.tb_lineno}"
                tb = tb.tb_next
            raise StrategyValidationError(
                f"'{path.name}' failed while loading{line}: {type(exc).__name__}: {exc}"
            ) from exc
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

        if not str(name or "").strip():
            # Without this the message read "no strategy called 'None'",
            # which sends the trader looking for a strategy of that name.
            raise StrategyValidationError(
                "no strategy was named — pick one from the list: "
                + ", ".join(list(BUILTIN_NAMES) + self.uploaded_names())
            )

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
        # The user's copy, outside the installation, written in the same
        # breath. A strategy that exists for even a moment only inside a
        # folder the installer owns is a strategy an upgrade can take.
        try:
            self.vault.mkdir(parents=True, exist_ok=True)
            (self.vault / f"{stem}.py").write_text(source, encoding="utf-8")
        except OSError:
            # Never fail an upload over the backup: the strategy is on
            # disk and working, and the next sync will pick it up.
            log.exception("could not copy strategy %s into the vault", stem)
        return dest
