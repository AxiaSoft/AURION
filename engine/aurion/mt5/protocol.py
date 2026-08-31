"""JSON-line protocol spoken by AurionBridge.mq5 and the Python engine.

Every payload is a single UTF-8 JSON object terminated by a newline.
The engine never accepts or emits synthetic ticks — only terminal-origin data.
"""

from __future__ import annotations

import json
from typing import Any

PROTOCOL = "aurion-mt5-1"
MAX_FRAME = 1_048_576


def encode(message: dict[str, Any]) -> bytes:
    payload = json.dumps(message, ensure_ascii=False, separators=(",", ":"))
    return (payload + "\n").encode("utf-8")


def parse_ea_json(raw: Any) -> Any | None:
    """Parse EA JSON even when WebRequest appends a trailing NUL or junk."""
    if raw is None:
        return None
    if isinstance(raw, (dict, list)):
        return raw
    if isinstance(raw, bytearray):
        raw = bytes(raw)
    if isinstance(raw, bytes):
        text = raw.replace(b"\x00", b"").decode("utf-8", errors="ignore")
    else:
        text = str(raw).replace("\x00", "")
    text = text.lstrip("\ufeff").strip()
    if not text:
        return None
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    decoder = json.JSONDecoder()
    for i, ch in enumerate(text):
        if ch not in "{[":
            continue
        try:
            obj, _end = decoder.raw_decode(text[i:])
            return obj
        except json.JSONDecodeError:
            continue
    return None


def decode_buffer(buffer: bytearray) -> tuple[list[dict[str, Any]], bytearray]:
    messages: list[dict[str, Any]] = []
    while True:
        idx = buffer.find(b"\n")
        if idx < 0:
            break
        raw = bytes(buffer[:idx]).strip()
        del buffer[: idx + 1]
        if not raw:
            continue
        obj = parse_ea_json(raw)
        if isinstance(obj, dict):
            messages.append(obj)
        elif isinstance(obj, list):
            messages.extend(m for m in obj if isinstance(m, dict))
    if len(buffer) > MAX_FRAME:
        buffer.clear()
    return messages, buffer
