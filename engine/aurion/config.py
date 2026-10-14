from __future__ import annotations

import json
import os
import stat
import threading
from copy import deepcopy
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]

# Everything the engine writes at runtime lives under one directory, so a
# deployment can point it at a volume or a throwaway sandbox instead of the
# source tree. Unset keeps the historical <repo>/data layout. The Node desk
# honours the same variable.
DATA_DIR = Path(os.environ["AURION_DATA_DIR"]).resolve() if os.environ.get("AURION_DATA_DIR") else ROOT / "data"

CONFIG_DIR = Path(os.environ["AURION_CONFIG_DIR"]).resolve() if os.environ.get("AURION_CONFIG_DIR") else ROOT / "config"
CONFIG_PATH = CONFIG_DIR / "aurion.json"
FACTORY_PATH = CONFIG_DIR / "aurion.factory.json"
if not FACTORY_PATH.exists():
    FACTORY_PATH = ROOT / "config" / "aurion.factory.json"
STATE_PATH = DATA_DIR / "runtime-state.json"
BACKUP_PATH = DATA_DIR / "settings-backup.json"

_lock = threading.RLock()
_cache: dict[str, Any] | None = None

# Sections written from the dashboard. When the main config is lost, reset or
# corrupted, these are what the backup restores.
_MUTABLE_SECTIONS = ("runtime", "prop", "execution", "mt5", "ai", "telegram", "default_language")


def _read_json(path: Path) -> dict[str, Any] | None:
    try:
        blob = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(blob, dict):
            return blob
    except Exception:
        pass
    return None


def _matches_factory(data: dict[str, Any]) -> bool:
    """True when every mutable section still looks factory-fresh."""
    factory = _read_json(FACTORY_PATH)
    if not factory:
        return False
    for section in _MUTABLE_SECTIONS:
        if data.get(section) != factory.get(section):
            return False
    return True


def ensure_config() -> None:
    """Bootstrap config/aurion.json on first run.

    The MSI ships only config/aurion.factory.json (a factory copy of
    aurion.json would be overwritten on every installer upgrade, wiping the
    user's live settings). When aurion.json is missing — a fresh install —
    create it from the factory defaults so the config is writable and
    survives any later update.
    """
    if CONFIG_PATH.exists():
        return
    if not FACTORY_PATH.exists():
        return
    try:
        raw = FACTORY_PATH.read_text(encoding="utf-8")
        json.loads(raw)  # refuse to bootstrap from a corrupted factory file
    except Exception:
        return
    try:
        clear_readonly(CONFIG_PATH)
        CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
        tmp = CONFIG_PATH.parent / (CONFIG_PATH.name + ".tmp")
        tmp.write_text(raw, encoding="utf-8")
        os.replace(tmp, CONFIG_PATH)
        try:
            os.chmod(CONFIG_PATH, 0o600)
        except OSError:
            pass
    except OSError:
        pass  # read-only tree handled by heal_packaged_files / fallback below


def _read() -> dict[str, Any]:
    ensure_config()
    data = _read_json(CONFIG_PATH)
    backup = _read_json(BACKUP_PATH)
    if data is None:
        # Main config missing or corrupted — recover what stop-aurion saved.
        data = backup
    elif backup and _matches_factory(data) and not _matches_factory(backup):
        # aurion.json was reset to factory defaults from the outside (update,
        # reinstall, manual copy). The last saved dashboard state wins.
        data = backup
    if data is None:
        data = _read_json(FACTORY_PATH)
    if data is None:
        raise RuntimeError(f"AURION config unreadable: {CONFIG_PATH}")
    overlay = None
    for path in (STATE_PATH, STATE_PATH.with_name("runtime-state.bak.json")):
        if not path.exists():
            continue
        blob = _read_json(path)
        if blob is not None:
            overlay = blob
            break
    if overlay and not (_matches_factory(overlay) and not _matches_factory(data)):
        # Skip the overlay only when it was reset to factory while the base
        # still carries real settings.
        _deep_update(data, overlay)
    return data


def load(force: bool = False) -> dict[str, Any]:
    global _cache
    with _lock:
        if _cache is None or force:
            _cache = _read()
        return deepcopy(_cache)


def clear_readonly(path: Path) -> None:
    """Clear the read-only bit on an existing file so it can be overwritten.

    Some installers ship installed files with the read-only
    attribute, which makes ``os.replace()`` die with WinError 5 and
    ``open(path, "w")`` with PermissionError on every save. Clearing the bit
    before writing is the fix; no-op on POSIX and when the file is missing.
    """
    if os.name != "nt":
        return
    try:
        if path.exists():
            os.chmod(path, stat.S_IWRITE)
    except OSError:
        pass


def heal_packaged_files() -> None:
    """One-shot repair of the MSI-installed tree (read-only files).

    Called at engine startup: clears the read-only bit on every file the app
    writes at runtime, so saves work even on the very first write and the
    user can delete/replace these files manually as well.
    """
    for p in (
        CONFIG_PATH,
        CONFIG_PATH.parent / "news_calendar.csv",
        CONFIG_PATH.parent / "news_calendar.fetched",
        CONFIG_PATH.parent / "owner.gmail",
    ):
        clear_readonly(p)


def _atomic_write(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(path.parent, 0o700)
    except Exception:
        pass
    tmp = path.with_suffix(path.suffix + ".tmp")
    with tmp.open("w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=2)
        fh.write("\n")
        fh.flush()
        os.fsync(fh.fileno())
    try:
        os.chmod(tmp, 0o600)
    except Exception:
        pass
    clear_readonly(path)
    try:
        os.replace(tmp, path)
    except PermissionError:
        # The target could not be replaced (read-only attribute or ACL).
        # If it is writable in place, write it directly so the save still
        # sticks instead of 500-ing the whole endpoint.
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(data, fh, ensure_ascii=False, indent=2)
            fh.write("\n")
            fh.flush()
            os.fsync(fh.fileno())
        try:
            tmp.unlink()
        except Exception:
            pass
    try:
        os.chmod(path, 0o600)
    except Exception:
        pass


def _slim_state(data: dict[str, Any]) -> dict[str, Any]:
    runtime = dict(data.get("runtime") or {})
    prop = data.get("prop") or {}
    mt5 = data.get("mt5") or {}
    execution = data.get("execution") or {}
    ai = data.get("ai") or {}
    return {
        "runtime": runtime,
        "prop": {
            "enabled": prop.get("enabled"),
            "active_profile": prop.get("active_profile"),
            "profile": prop.get("profile"),
        },
        "execution": {
            "kill_switch_default": execution.get("kill_switch_default"),
            "flatten_on_disconnect": execution.get("flatten_on_disconnect"),
        },
        "mt5": {
            "terminal_path": mt5.get("terminal_path"),
            "login": mt5.get("login"),
            "server": mt5.get("server"),
            "portable": mt5.get("portable"),
        },
        "ai": {
            "enabled": ai.get("enabled"),
            "min_bars_to_train": ai.get("min_bars_to_train"),
            "retrain_every_bars": ai.get("retrain_every_bars"),
            "online_learning": ai.get("online_learning"),
            "confidence_threshold": ai.get("confidence_threshold"),
        },
        "default_language": data.get("default_language"),
        "telegram": {
            "enabled": (data.get("telegram") or {}).get("enabled"),
            "language": (data.get("telegram") or {}).get("language"),
            "notify_open": (data.get("telegram") or {}).get("notify_open"),
            "notify_close": (data.get("telegram") or {}).get("notify_close"),
            "chats": (data.get("telegram") or {}).get("chats"),
            "username": (data.get("telegram") or {}).get("username"),
        },
    }


def save(data: dict[str, Any]) -> dict[str, Any]:
    global _cache
    with _lock:
        _atomic_write(CONFIG_PATH, data)
        slim = _slim_state(data)
        bak = STATE_PATH.with_name("runtime-state.bak.json")
        if STATE_PATH.exists():
            try:
                txt = STATE_PATH.read_text(encoding="utf-8")
                if len(txt) < 64*1024:
                    bak.write_text(txt, encoding="utf-8")
                    try:
                        os.chmod(bak, 0o600)
                    except Exception:
                        pass
            except Exception:
                pass
        _atomic_write(STATE_PATH, slim)
        try:
            # Backup without secrets
            safe = json.loads(json.dumps(data))
            if safe.get("mt5") and safe["mt5"].get("password"):
                del safe["mt5"]["password"]
            if safe.get("telegram") and safe["telegram"].get("bot_token"):
                safe["telegram"]["bot_token"] = "***"
            if safe.get("license") and safe["license"].get("otp"):
                safe["license"]["otp"] = {"configured": bool(safe["license"]["otp"].get("smtp_host"))}
            if safe.get("billing") and safe["billing"].get("zarinpal"):
                safe["billing"]["zarinpal"] = {"sandbox": safe["billing"]["zarinpal"].get("sandbox")}
            _atomic_write(BACKUP_PATH, safe)
        except Exception:
            pass
        _cache = deepcopy(data)
        return deepcopy(_cache)


def drop_backup() -> None:
    """Factory reset also erases the settings backup so defaults stick."""
    try:
        if BACKUP_PATH.exists():
            BACKUP_PATH.unlink()
    except Exception:
        pass


def merge(patch: dict[str, Any]) -> dict[str, Any]:
    # The backend (Node) writes aurion.json directly, bypassing this process'
    # in-memory cache. Always re-read from disk so an engine merge can never
    # resurrect stale cached sections over values the backend already saved
    # (previously: silent lost-update of backend-only settings on restart).
    current = load(force=True)
    _deep_update(current, patch)
    return save(current)


def _deep_update(base: dict[str, Any], patch: dict[str, Any]) -> None:
    for key, value in patch.items():
        if key in ("__proto__", "constructor", "prototype"):
            continue
        if isinstance(value, dict) and isinstance(base.get(key), dict):
            _deep_update(base[key], value)
        else:
            # prevent injecting secrets via overlay
            if key in ("password",) and isinstance(base, dict) and "mt5" in str(base.keys()):
                # mt5.password must not be overwritten by runtime-state
                if base is not None and key == "password":
                    # only allow if explicitly from main config, not overlay
                    # we check caller via stack? For now skip if value is *** mask
                    if str(value) == "***":
                        continue
            base[key] = value


def resolve(*parts: str) -> Path:
    path = ROOT
    for part in parts:
        path = path / part
    return path


def abspath(maybe_relative: str) -> Path:
    p = Path(maybe_relative)
    if p.is_absolute():
        return p
    return ROOT / p


def env_secret(name: str, default: str = "") -> str:
    return os.environ.get(name, default)
