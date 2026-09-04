"""Where the Telegram bot token comes from.

Rule: the token is provisioned **in the source**, not through the dashboard.
The desk is a client of the bot; it never supplies the credential.  A token
typed into the UI is accepted only when no source token is present, so an
existing install keeps working while the shipped configuration stays in charge.

Lookup order (first hit wins):

1. ``AURION_TELEGRAM_TOKEN`` / ``AURION_TELEGRAM_BOT_TOKEN`` environment variable
2. ``config/telegram.token``      — plain text, one token per line (gitignored)
3. ``config/telegram.local.json`` — ``{"bot_token": "..."}``        (gitignored)
4. ``telegram.bot_token`` in ``config/aurion.json`` — legacy fallback only
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from ..config import ROOT

TOKEN_FILE = ROOT / "config" / "telegram.token"
TOKEN_JSON = ROOT / "config" / "telegram.local.json"

ENV_KEYS = ("AURION_TELEGRAM_TOKEN", "AURION_TELEGRAM_BOT_TOKEN")

# Tokens are ``<bot id>:<35 chars>``.  Anything else is a typo, not a token.
MIN_LEN = 20


def _clean(value: Any) -> str:
    return str(value or "").strip()


def _looks_like_token(value: str) -> bool:
    return len(value) >= MIN_LEN and ":" in value and " " not in value


def _from_env() -> str:
    for key in ENV_KEYS:
        value = _clean(os.environ.get(key))
        if _looks_like_token(value):
            return value
    return ""


def _from_file() -> str:
    try:
        if TOKEN_FILE.exists():
            for line in TOKEN_FILE.read_text(encoding="utf-8").splitlines():
                value = _clean(line)
                if value and not value.startswith("#") and _looks_like_token(value):
                    return value
    except Exception:
        pass
    try:
        if TOKEN_JSON.exists():
            blob = json.loads(TOKEN_JSON.read_text(encoding="utf-8"))
            value = _clean(blob.get("bot_token") if isinstance(blob, dict) else "")
            if _looks_like_token(value):
                return value
    except Exception:
        pass
    return ""


def source_token() -> str:
    """Token provisioned in the source (env or config file). '' when absent."""
    return _from_env() or _from_file()


def token_origin() -> str:
    """Where the active token came from — safe to show in the admin panel."""
    if _from_env():
        return "env"
    if TOKEN_FILE.exists() and _from_file():
        return "file:config/telegram.token"
    if TOKEN_JSON.exists() and _from_file():
        return "file:config/telegram.local.json"
    return ""


def source_path_hint() -> str:
    """Path shown to the admin when no source token is configured yet."""
    try:
        return str(TOKEN_FILE.relative_to(ROOT)).replace("\\", "/")
    except ValueError:
        return str(TOKEN_FILE)


def resolve(config_token: Any = None) -> tuple[str, str]:
    """Return ``(token, origin)`` — source wins over anything the desk saved."""
    token = source_token()
    if token:
        return token, token_origin()
    legacy = _clean(config_token)
    if _looks_like_token(legacy):
        return legacy, "config:aurion.json"
    return "", ""
