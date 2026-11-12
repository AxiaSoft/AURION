"""Resolve a strategy name to one of the strategies AURION ships.

Custom strategies were removed from the product. The engine no longer
imports Python written by the user: there is no upload, no editor, no
strategies folder and no vault. What a spec can name is the built-in
list below and nothing else.

Everything that made user code safe to run - the AST scan for forbidden
imports and calls, the file-name sanitiser, the per-file importer, the
reserved-name list, the vault that kept a user's file out of the
installer's reach - went with the feature it existed to protect. None
of it has a second caller.

`build()` keeps taking the same {kind, name, path} spec it always did.
`kind` and `path` are now ignored rather than rejected, because saved
runtime configs, desk requests and Telegram commands written before the
removal still carry them, and a desk that answered "unknown strategy"
to its own stored config would look broken rather than changed.
"""

from __future__ import annotations

from typing import Any

from ..util.log import get
from .base import BaseStrategy

log = get("strategy")

BUILTIN_NAMES = ("ema_rsi", "price_action", "atr_breakout", "smart_money")

# Names older builds used for strategies that have since been folded
# into another one. A saved config naming one of these still resolves.
LEGACY_BUILTINS = {"scalp_impulse": "price_action", "king": "price_action"}


def resolve_builtin(name: str) -> str:
    key = str(name or "").strip().lower()
    if key.endswith(".py"):
        # Saved configs and the desk's own dropdown kept the file name of
        # an uploaded strategy. Stripping it here means such an entry is
        # answered with the list of what exists instead of a name with a
        # suffix glued on.
        key = key[:-3]
    return LEGACY_BUILTINS.get(key, key)


class StrategyValidationError(ValueError):
    """A strategy request that cannot be honoured, in words."""


class StrategyLoader:
    """Hands out the built-in strategies.

    It holds no filesystem state. The folder, the vault and the
    reconciliation between them were deleted with custom strategies, so
    there is nothing left to keep in sync and nothing that an upgrade,
    a repair or an anti-virus sweep can take away.
    """

    def __init__(self) -> None:
        self.loaded: dict[str, Any] = {}

    def list(self) -> list[dict[str, Any]]:
        """What the desk may offer, in a shape its list already reads."""
        return [
            {
                "file": f"builtin:{name}",
                "path": f"builtin:{name}",
                "loaded": f"builtin:{name}" in self.loaded,
                "name": name,
                "builtin": True,
            }
            for name in BUILTIN_NAMES
        ]

    def uploaded_names(self) -> list[str]:
        """Nothing is uploadable any more.

        Kept because several callers ask for it when building a message
        about what is available, and an empty list is the true answer.
        """
        return []

    def _unknown(self, name: Any) -> str:
        """An error that says what the caller could have asked for instead."""
        return f"no strategy called '{name}' — available: {', '.join(BUILTIN_NAMES)}"

    def build(self, spec: dict[str, Any]) -> BaseStrategy:
        """Resolve a {kind, name, path} spec to a live strategy.

        `kind` and `path` are ignored. They described where a strategy
        came from, and now there is only one place it can come from.
        """
        name = spec.get("name") or spec.get("file")
        params = spec.get("params") or {}
        if not str(name or "").strip():
            # Without this the message read "no strategy called 'None'",
            # which sends the trader looking for a strategy of that name.
            raise StrategyValidationError(
                "no strategy was named — pick one from the list: " + ", ".join(BUILTIN_NAMES)
            )
        return self.load_builtin(str(name), params)

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
        resolved = resolve_builtin(name)
        if resolved not in mapping:
            raise StrategyValidationError(self._unknown(name))
        inst = mapping[resolved](params or {})
        self.loaded[f"builtin:{resolved}"] = inst
        return inst
