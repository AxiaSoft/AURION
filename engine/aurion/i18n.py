from __future__ import annotations

import json
from functools import lru_cache
from typing import Any

from .config import ROOT

SUPPORTED = ("en", "fa", "ar")


@lru_cache(maxsize=8)
def pack(lang: str) -> dict[str, Any]:
    code = lang if lang in SUPPORTED else "en"
    path = ROOT / "lang" / f"{code}.json"
    with path.open("r", encoding="utf-8") as fh:
        return json.load(fh)


def t(lang: str, dotted: str, **kwargs: Any) -> str:
    node: Any = pack(lang)
    for part in dotted.split("."):
        if not isinstance(node, dict) or part not in node:
            node = pack("en")
            for fallback in dotted.split("."):
                if not isinstance(node, dict) or fallback not in node:
                    return dotted
                node = node[fallback]
            break
        node = node[part]
    text = str(node)
    for key, value in kwargs.items():
        text = text.replace("{" + key + "}", str(value))
    return text


def direction(lang: str) -> str:
    return str(pack(lang).get("meta", {}).get("dir", "ltr"))
