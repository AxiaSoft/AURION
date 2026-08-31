from __future__ import annotations

import hashlib
import hmac
import json
import os
import platform
import re
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from ..config import ROOT, load
from .ed25519 import sign as _ed_sign
from .ed25519 import verify as _ed_verify
from .material import ED25519_PUBLIC_HEX, ISSUER, PRODUCT

# freemium = no key yet / key expired. Everything above that line is premium.
PLANS: dict[str, dict[str, Any]] = {
    "freemium": {"days": 0, "bot_limit": None, "label": "freemium", "months": 0},
    "trial": {"days": 0, "bot_limit": None, "label": "freemium", "months": 0},
    "m1": {"days": 30, "bot_limit": None, "label": "1 month", "months": 1},
    "m3": {"days": 90, "bot_limit": None, "label": "3 months", "months": 3},
    "m6": {"days": 180, "bot_limit": None, "label": "6 months", "months": 6},
    "y1": {"days": 365, "bot_limit": None, "label": "12 months", "months": 12},
    "developer": {"days": 0, "bot_limit": None, "label": "developer", "months": 0},
}
PAID_PLANS = ("m1", "m3", "m6", "y1")

# Features locked in freemium mode (server-side enforced).
FREEMIUM_LOCKED = ("prop", "scalping", "strategy_upload", "telegram", "news", "chart_signals", "volume_mode")

# Freemium auto-trade allowance: N robot trades per rolling window, then the
# window locks and auto-resets after the cooldown.
FREE_BOT_LIMIT = 3
FREE_BOT_WINDOW_SEC = 5 * 3600
FREE_BOT_WINDOW_HOURS = 5

# Heartbeat cadence: at most one report per 12h (plus one on engine boot).
HEARTBEAT_MIN_INTERVAL_SEC = 12 * 3600

DIR = ROOT / "data" / "license"
STATE = DIR / "state.json"
USED = DIR / "used.json"
KEY_RE = re.compile(r"^(AXIA|AXI-DEV)(?:-[A-Z0-9]{2,4})+$")


def _pub() -> bytes:
    # Engine ships ONLY the Ed25519 public key (safe in a public repo).
    extra = os.environ.get("AXIASOFT_KEY_PUBLIC", "").strip()
    try:
        return bytes.fromhex(extra or ED25519_PUBLIC_HEX)
    except ValueError:
        return bytes.fromhex(ED25519_PUBLIC_HEX)


def _priv() -> bytes | None:
    # Private signing seed — owner machines only (never shipped). Minting is
    # impossible without it, even with the full client source code in hand.
    # Supports multiple env names for convenience:
    # - AXIASOFT_KEY_PRIVATE (primary, engine)
    # - AURION_KEY_PRIVATE_HEX (keyserver)
    # - AURION_KEY_PRIVATE / KEY_PRIVATE (fallbacks)
    for name in ("AXIASOFT_KEY_PRIVATE", "AURION_KEY_PRIVATE_HEX", "AURION_KEY_PRIVATE", "KEY_PRIVATE"):
        raw = os.environ.get(name, "").strip()
        if raw:
            try:
                return bytes.fromhex(raw)
            except ValueError:
                continue
    return None

def _priv_source() -> str:
    for name in ("AXIASOFT_KEY_PRIVATE", "AURION_KEY_PRIVATE_HEX", "AURION_KEY_PRIVATE", "KEY_PRIVATE"):
        if os.environ.get(name, "").strip():
            return name
    return ""


def _b32(data: bytes, n: int = 4) -> str:
    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    num = int.from_bytes(data, "big")
    out = []
    for _ in range(n):
        out.append(alphabet[num % 32])
        num //= 32
    return "".join(out)


def _b32dec(s: str, nbytes: int) -> bytes:
    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    num = 0
    for i, ch in enumerate(s):
        idx = alphabet.find(ch)
        if idx < 0:
            raise ValueError("bad base32")
        num += idx * (32**i)  # _b32 emits LSB-first
    return num.to_bytes(nbytes, "big")


def _local_secret() -> bytes:
    """Local HMAC secret for state.json - random 32 bytes, 0o600, per machine.
    Preserves Ed25519 license model, but makes state tampering require secret extraction."""
    try:
        DIR.mkdir(parents=True, exist_ok=True)
        try:
            os.chmod(DIR, 0o700)
        except Exception:
            pass
        sec_path = DIR / "secret.key"
        if sec_path.exists():
            try:
                data = sec_path.read_bytes()
                if len(data) >= 32:
                    try:
                        os.chmod(sec_path, 0o600)
                    except Exception:
                        pass
                    return data[:32]
            except Exception:
                pass
        sec = os.urandom(32)
        try:
            tmp = sec_path.with_suffix(".key.tmp")
            tmp.write_bytes(sec)
            try:
                os.chmod(tmp, 0o600)
            except Exception:
                pass
            tmp.replace(sec_path)
            try:
                os.chmod(sec_path, 0o600)
            except Exception:
                pass
        except Exception:
            try:
                sec_path.write_bytes(sec)
            except Exception:
                pass
        return sec
    except Exception:
        return hashlib.sha256((_pub() + machine_id().encode())).digest()

def _mac(msg: str) -> str:
    """Tamper-evidence tag for local license state file using local secret, not public key."""
    return hmac.new(_local_secret(), msg.encode("utf-8"), hashlib.sha256).hexdigest()


def _tag(body: str) -> str:
    """Short key tag — recomputable ONLY where the private seed lives."""
    priv = _priv()
    if not priv:
        raise RuntimeError("AXIASOFT_KEY_PRIVATE is not set")
    return _b32(_ed_sign(priv, body.encode("utf-8"))[:15], 24)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(dt: datetime | None) -> str | None:
    if not dt:
        return None
    return dt.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def parse_iso(s: str | None) -> datetime | None:
    if not s:
        return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return None


def normalize_identity(raw: str) -> tuple[str, str] | None:
    s = str(raw or "").strip()
    if not s:
        return None
    compact = re.sub(r"[\s\-]", "", s)
    phone = compact
    if phone.startswith("0098"):
        phone = "+98" + phone[4:]
    if phone.startswith("98") and len(phone) == 12:
        phone = "+" + phone
    if phone.startswith("09") and len(phone) == 11 and phone.isdigit():
        return "phone", phone
    if phone.startswith("+989") and len(phone) == 13 and phone[1:].isdigit():
        return "phone", "0" + phone[3:]
    email = s.lower()
    if re.fullmatch(r"[a-z0-9._%+\-]+@gmail\.com", email) or re.fullmatch(r"[a-z0-9._%+\-]+@googlemail\.com", email):
        return "gmail", email.replace("@googlemail.com", "@gmail.com")
    return None


def machine_id() -> str:
    # Stronger machine binding: tries Windows MachineGuid, MAC, CPU, disk serial
    bits = []
    try:
        # Windows MachineGuid from registry
        if platform.system() == "Windows":
            try:
                import winreg
                with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\Cryptography") as k:
                    guid, _ = winreg.QueryValueEx(k, "MachineGuid")
                    bits.append(str(guid))
            except Exception:
                pass
            try:
                # BIOS serial via wmic
                import subprocess
                out = subprocess.check_output("wmic bios get serialnumber", shell=True, timeout=3).decode(errors="ignore")
                for line in out.splitlines():
                    s = line.strip()
                    if s and s.lower() != "serialnumber":
                        bits.append(s)
                        break
            except Exception:
                pass
    except Exception:
        pass
    try:
        import uuid as _uuid
        mac = _uuid.getnode()
        bits.append(str(mac))
    except Exception:
        pass
    try:
        # /etc/machine-id on Linux
        mid_path = pathlib.Path("/etc/machine-id")
        if mid_path.exists():
            bits.append(mid_path.read_text().strip()[:64])
    except Exception:
        pass
    bits.extend([
        platform.node(),
        platform.system(),
        platform.machine(),
        os.environ.get("USERNAME") or os.environ.get("USER") or "",
        str(ROOT),
    ])
    # hash all
    return hashlib.sha256("|".join(bits).encode("utf-8")).hexdigest()[:32]


def key_hash(key: str) -> str:
    return hashlib.sha256(normalize_key(key).encode("utf-8")).hexdigest()


def normalize_key(key: str) -> str:
    return re.sub(r"[^A-Z0-9\-]", "", str(key or "").upper())


def mint(plan: str, note: str = "") -> str:
    """Mint a license key. Runs ONLY on the owner signing machine: without the
    AXIASOFT_KEY_PRIVATE seed there is no way to produce valid keys — that is
    the whole point of the asymmetric (Ed25519) design."""
    plan = str(plan or "").lower()
    if plan not in PLANS or plan == "trial":
        raise ValueError("plan must be m1, m3, m6, y1 or developer")
    priv = _priv()
    if not priv:
        raise RuntimeError(
            "Private key not set — set AXIASOFT_KEY_PRIVATE or AURION_KEY_PRIVATE_HEX "
            "(64 hex chars) in env. Keys can only be minted on the owner signing machine."
        )
    nonce = os.urandom(8).hex().upper()
    body = f"{PRODUCT}|{plan}|{nonce}"
    if plan == "developer":
        # Owner key: FULL Ed25519 signature — self-verifying offline anywhere
        # with only the public key (leak-proof authenticity). 103 base32 chars.
        sig = _b32(_ed_sign(priv, body.encode("utf-8")), 103)
        sgroups = [sig[i : i + 4] for i in range(0, len(sig), 4)]
        groups = [nonce[:4], nonce[4:8], nonce[8:12], nonce[12:16]] + sgroups
        return "AXI-DEV-" + "-".join(groups)
    sig = _b32(_ed_sign(priv, body.encode("utf-8"))[:15], 24)
    sgroups = [sig[i : i + 4] for i in range(0, 24, 4)]
    groups = [plan.upper(), nonce[:4], nonce[4:8], nonce[8:12], nonce[12:16]] + sgroups
    return "AXIA-" + "-".join(groups)


def decode_key(key: str) -> dict[str, Any] | None:
    """Parse a key. Developer keys are fully VERIFIED here (Ed25519 + public
    key — unforgeable offline). Customer keys carry a short tag that only the
    key server (private-seed holder) can recompute, so the client just parses
    them and the online activation verdict is the authenticity proof."""
    k = normalize_key(key)
    parts = k.split("-")
    if k.startswith("AXI-DEV-"):
        plan = "developer"
        rest = parts[2:]
        if len(rest) != 30:
            return None
        nonce = "".join(rest[:4])
        sig_s = "".join(rest[4:])
        if len(sig_s) != 103:
            return None
        try:
            raw_sig = _b32dec(sig_s, 64)
        except (ValueError, OverflowError):
            return None
        body = f"{PRODUCT}|{plan}|{nonce}"
        if not _ed_verify(raw_sig, body.encode("utf-8"), _pub()):
            return None
        return {"plan": plan, "nonce": nonce, "key": k, "verified": True}
    if k.startswith("AXIA-"):
        if len(parts) != 12:
            return None
        tag = parts[1].lower()
        if tag not in PLANS:
            return None
        plan = tag
        rest = parts[2:]
        nonce = "".join(rest[:4])
        if len(nonce) != 16 or len("".join(rest[4:])) != 24:
            return None
        return {"plan": plan, "nonce": nonce, "key": k, "verified": False}
    return None


class Guard:
    def __init__(self) -> None:
        DIR.mkdir(parents=True, exist_ok=True)
        self.state = self._load()

    def _empty(self) -> dict[str, Any]:
        return {
            "plan": "freemium",
            "identity": "",
            "activated": None,
            "expires": None,
            "key_hash": "",
            "machine": machine_id(),
            "bot_trades": 0,
            "last_seen": _iso(_now()),
            "issuer": ISSUER,
            "product": PRODUCT,
        }

    def _sign_state(self, st: dict[str, Any]) -> str:
        payload = json.dumps(
            {k: st.get(k) for k in ("plan", "identity", "activated", "expires", "key_hash", "machine", "bot_trades")},
            sort_keys=True,
            separators=(",", ":"),
        )
        return _mac(payload)

    def _load(self) -> dict[str, Any]:
        if not STATE.exists():
            st = self._empty()
            self._write(st)
            return st
        try:
            raw = STATE.read_text(encoding="utf-8")
            if len(raw) > 1024*1024:
                return self._empty()
            st = json.loads(raw)
        except Exception:
            return self._empty()
        sig = str(st.pop("signature", "") or "")
        # verify with local secret (not public)
        if sig and not hmac.compare_digest(sig, self._sign_state(st)):
            st = self._empty()
            st["tampered"] = True
            st["tamper_time"] = _iso(_now())
        last = parse_iso(st.get("last_seen"))
        now = _now()
        if last and last - now > timedelta(hours=12):
            st["clock_rollback"] = True
            # enforce: if rollback >12h, clear premium until heartbeat clears it
            # keep plan but premium_active will check flag
        st["last_seen"] = _iso(now)
        st["machine_now"] = machine_id()
        self._write(st)
        return st

    def _write(self, st: dict[str, Any]) -> None:
        blob = dict(st)
        blob.pop("machine_now", None)
        blob["signature"] = self._sign_state(blob)
        tmp = STATE.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(blob, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        try:
            import os
            os.chmod(tmp, 0o600)
        except Exception:
            pass
        tmp.replace(STATE)
        try:
            import os
            os.chmod(STATE, 0o600)
            os.chmod(DIR, 0o700)
        except Exception:
            pass
        self.state = st

    def _used(self) -> dict[str, Any]:
        if not USED.exists():
            return {"keys": {}}
        try:
            return json.loads(USED.read_text(encoding="utf-8"))
        except Exception:
            return {"keys": {}}

    def _mark_used(self, key: str, identity: str, plan: str) -> None:
        db = self._used()
        db.setdefault("keys", {})
        db["keys"][key_hash(key)] = {
            "used": _iso(_now()),
            "identity": identity,
            "plan": plan,
            "machine": machine_id(),
        }
        USED.write_text(json.dumps(db, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        try:
            import os
            os.chmod(USED, 0o600)
            os.chmod(DIR, 0o700)
        except Exception:
            pass

    # ------------------------------------------------------------------
    # Freemium / premium state
    # ------------------------------------------------------------------
    def _is_paid_plan(self) -> bool:
        return str(self.state.get("plan") or "") in set(PAID_PLANS) | {"developer"}

    def expired(self) -> bool:
        plan = str(self.state.get("plan") or "")
        if plan in {"", "freemium", "trial", "developer"}:
            return False
        exp = parse_iso(self.state.get("expires"))
        return bool(exp) and exp <= _now()

    def premium_active(self) -> bool:
        if not self._is_paid_plan():
            return False
        if self.state.get("remote_revoked"):
            return False
        if self.state.get("tampered"):
            return False
        if self.state.get("clock_rollback"):
            # clock rollback detected - require successful heartbeat to clear
            return False
        bound = str(self.state.get("machine") or "").strip()
        if bound and bound != machine_id():
            return False
        if str(self.state.get("plan")) == "developer":
            return True
        return not self.expired()

    def feature(self, name: str) -> bool:
        if name not in FREEMIUM_LOCKED:
            return True
        return self.premium_active()

    def features(self) -> dict[str, bool]:
        premium = self.premium_active()
        return {name: premium for name in FREEMIUM_LOCKED}

    def license_urls(self) -> dict[str, str]:
        try:
            cfg = load()
            lic = cfg.get("license") or {}
        except Exception:
            lic = {}
        server = os.environ.get("AURION_KEYSERVER_URL", "").strip() or str(lic.get("keyserver_url") or "").strip()
        store = os.environ.get("AURION_STORE_URL", "").strip() or str(lic.get("store_url") or "").strip() or server
        return {"keyserver_url": server.rstrip("/"), "store_url": store.rstrip("/")}

    def public(self) -> dict[str, Any]:
        now = _now()
        plan = str(self.state.get("plan") or "freemium")
        if plan == "trial":
            plan = "freemium"
        exp_dt = parse_iso(self.state.get("expires"))
        expired = self.expired()
        premium = self.premium_active()
        account_type = "premium" if premium else "freemium"
        days_left = None
        hours_left = None
        if exp_dt and plan not in {"freemium", "developer"}:
            delta = exp_dt - now
            days_left = max(0, delta.days)
            hours_left = max(0, int(delta.total_seconds() // 3600))
        return {
            "issuer": ISSUER,
            "product": PRODUCT,
            "plan": plan,
            "plan_label": PLANS.get(plan, PLANS["freemium"])["label"],
            "months": PLANS.get(plan, {}).get("months") or 0,
            "account_type": account_type,
            "premium": premium,
            "paid": premium,
            "identity": str(self.state.get("identity") or ""),
            "activated": self.state.get("activated"),
            "expires": self.state.get("expires"),
            "days_left": days_left,
            "hours_left": hours_left,
            "expired": expired,
            "trial": not premium,
            "developer": plan == "developer",
            "bot_trades": int(self.state.get("bot_trades") or 0),
            "bot_limit": (self.bot_usage().get("limit")),
            "bot_remaining": (self.bot_usage().get("left")),
            "bot_ok": bool(self.bot_usage().get("ok")),
            "bot_lock_until": (
                datetime.fromtimestamp(float(self.bot_usage()["lock_until"]), tz=timezone.utc)
                .isoformat()
                .replace("+00:00", "Z")
                if self.bot_usage().get("lock_until")
                else None
            ),
            "bot_window_hours": FREE_BOT_WINDOW_HOURS,
            "machine_ok": str(self.state.get("machine") or "") == machine_id(),
            "remote_revoked": self.state.get("remote_revoked") or "",
            "last_heartbeat": self.state.get("last_heartbeat") or "",
            "tampered": bool(self.state.get("tampered")),
            "clock_rollback": bool(self.state.get("clock_rollback")),
            "features": self.features(),
            "locked": [k for k, v in self.features().items() if not v],
            "keyserver_url": self.license_urls().get("keyserver_url") or "",
            "store_url": self.license_urls().get("store_url") or "",
            "plans": {k: {"days": v["days"], "label": v["label"], "months": v.get("months") or 0} for k, v in PLANS.items() if k in PAID_PLANS},
        }

    def bot_usage(self) -> dict[str, Any]:
        """Freemium auto-trade window state; premium is unlimited."""
        if self.premium_active():
            return {"premium": True, "ok": True, "limit": None, "used": 0, "left": None, "lock_until": None}
        now = time.time()
        lock_until = float(self.state.get("bot_lock_until") or 0)
        if lock_until and now >= lock_until:
            # Window expired -> fresh allowance.
            self.state["bot_window_count"] = 0
            self.state["bot_lock_until"] = 0
            lock_until = 0
            self._write(self.state)
        used = int(self.state.get("bot_window_count") or 0)
        left = max(0, FREE_BOT_LIMIT - used)
        locked = bool(lock_until) and now < lock_until
        return {
            "premium": False,
            "ok": (not locked) and left > 0,
            "limit": FREE_BOT_LIMIT,
            "used": used,
            "left": 0 if locked else left,
            "lock_until": lock_until or None,
        }

    def allow_bot_entry(self) -> dict[str, Any]:
        usage = self.bot_usage()
        if usage["ok"]:
            return {"ok": True, "license": self.public()}
        until = usage.get("lock_until")
        return {
            "ok": False,
            "error": "freemium_trade_limit",
            "license": self.public(),
            "limit": FREE_BOT_LIMIT,
            "limit_until": datetime.fromtimestamp(float(until or time.time()), tz=timezone.utc).isoformat().replace("+00:00", "Z"),
            "window_hours": FREE_BOT_WINDOW_HOURS,
        }

    def note_bot_fill(self) -> None:
        self.state["bot_trades"] = int(self.state.get("bot_trades") or 0) + 1
        if not self.premium_active():
            count = int(self.state.get("bot_window_count") or 0) + 1
            self.state["bot_window_count"] = count
            if count >= FREE_BOT_LIMIT:
                self.state["bot_lock_until"] = time.time() + FREE_BOT_WINDOW_SEC
        self._write(self.state)

    def bind_identity(self, identity: str) -> None:
        ident = normalize_identity(identity)
        value = ident[1] if ident else str(identity or "").strip().lower()
        if value and not self.state.get("identity"):
            self.state["identity"] = value
            self._write(self.state)

    def heartbeat(self, force: bool = False) -> dict[str, Any]:
        """Report 'this key lives on this machine' to the key server with TLS verification."""
        skipped = {"ok": True, "skipped": True}
        if not self._is_paid_plan():
            return skipped
        bound = str(self.state.get("machine") or "").strip()
        if bound and bound != machine_id():
            return skipped
        if str(self.state.get("plan")) != "developer" and self.expired():
            return skipped
        # Clock rollback enforcement: if rollback detected, force freemium until heartbeat ok
        if self.state.get("clock_rollback") and not force:
            # allow heartbeat to try to clear, but premium is blocked in premium_active via flag
            pass
        server = self.license_urls().get("keyserver_url") or ""
        kh = str(self.state.get("key_hash") or "")
        if not server or not kh:
            return skipped
        last = parse_iso(self.state.get("last_heartbeat"))
        if not force and last and (_now() - last).total_seconds() < HEARTBEAT_MIN_INTERVAL_SEC:
            return skipped
        import urllib.request
        import ssl
        body = json.dumps(
            {
                "key_hash": kh,
                "machine": machine_id(),
                "plan": str(self.state.get("plan") or ""),
                "product": PRODUCT,
            }
        ).encode("utf-8")
        req = urllib.request.Request(
            server + "/api/desk/heartbeat",
            data=body,
            headers={"content-type": "application/json"},
            method="POST",
        )
        try:
            ctx = ssl.create_default_context()
            # enforce TLS verification
            with urllib.request.urlopen(req, timeout=8, context=ctx) as res:
                payload = json.loads(res.read().decode("utf-8") or "{}")
        except Exception as exc:
            return {"ok": True, "skipped": True, "detail": str(exc)}
        self.state["last_heartbeat"] = _iso(_now())
        # clear rollback flag on successful heartbeat (time is now trusted)
        self.state.pop("clock_rollback", None)
        if payload.get("ok"):
            self.state.pop("remote_revoked", None)
            self._write(self.state)
            return {"ok": True}
        self.state["remote_revoked"] = f"{payload.get('error') or 'unknown'} @ {self.state['last_heartbeat']}"
        self._write(self.state)
        return {"ok": False, "error": self.state["remote_revoked"]}

    def _consume_online(self, key: str) -> dict[str, Any] | None:
        """Ask the key server to consume the key with TLS verification."""
        import urllib.request
        import ssl
        server = self.license_urls().get("keyserver_url") or ""
        if not server:
            return None
        body = json.dumps({"key": key, "machine": machine_id(), "product": PRODUCT}).encode("utf-8")
        req = urllib.request.Request(
            server + "/api/desk/activate",
            data=body,
            headers={"content-type": "application/json"},
            method="POST",
        )
        ctx = ssl.create_default_context()
        with urllib.request.urlopen(req, timeout=12, context=ctx) as res:
            return json.loads(res.read().decode("utf-8") or "{}")

    def activate(self, key: str, identity: str) -> dict[str, Any]:
        ident = normalize_identity(identity)
        who = ident[1] if ident else str(identity or "").strip().lower()
        parsed = decode_key(key)
        if not parsed:
            return {"ok": False, "error": "invalid_key"}
        parsed_key = parsed["key"]
        plan = parsed["plan"]
        is_dev = plan == "developer"
        kh = key_hash(parsed_key)
        used = self._used().get("keys") or {}
        if kh in used and not is_dev:
            return {"ok": False, "error": "key_used"}

        expires = None
        activated_iso = None
        if is_dev:
            # Owner key (AXI-DEV-…, full Ed25519 — already signature-verified
            # locally with the public key). When a key server is reachable it
            # also REGISTERS there: machine cap + one-click revocation, so a
            # leaked owner key can be killed without rotating anything.
            try:
                verdict = self._consume_online(parsed_key)
            except Exception as exc:
                return {"ok": False, "error": "internet_required", "detail": str(exc)}
            if verdict is not None:
                if not verdict.get("ok"):
                    return {"ok": False, "error": str(verdict.get("error") or "activation_failed")}
                activated_iso = str(verdict.get("activated_at") or _iso(_now()))
            else:
                activated_iso = _iso(_now())
        else:
            try:
                verdict = self._consume_online(parsed_key)
            except Exception as exc:
                log_warning = str(exc)
                return {"ok": False, "error": "internet_required", "detail": log_warning}
            if verdict is None:
                # Customer keys carry a short tag that only the key server can
                # recompute (private seed). Without the server there is no
                # legitimate way to check authenticity — refuse offline use.
                return {"ok": False, "error": "internet_required"}
            if not verdict.get("ok"):
                out = {"ok": False, "error": str(verdict.get("error") or "activation_failed")}
                if verdict.get("recover"):
                    out["recover"] = True
                return out
            plan = str(verdict.get("plan") or plan)
            activated_iso = str(verdict.get("activated_at") or _iso(_now()))
            expires = parse_iso(str(verdict.get("expires_at") or ""))
        self._mark_used(parsed_key, who, plan)
        self.state = {
            "plan": plan,
            "identity": who,
            "activated": activated_iso,
            "expires": _iso(expires),
            "key_hash": kh,
            "machine": machine_id(),
            "bot_trades": 0,
            "last_seen": _iso(_now()),
            "issuer": ISSUER,
            "product": PRODUCT,
        }
        self._write(self.state)
        return {"ok": True, "license": self.public()}


if __name__ == "__main__":  # CLI key mint:  python -m aurion.license.guard <plan> [note]
    import sys

    _plan = str(sys.argv[1] if len(sys.argv) > 1 else "developer").lower()
    _note = str(sys.argv[2] if len(sys.argv) > 2 else "cli")
    try:
        key = mint(_plan, _note)
        src = _priv_source()
        print(key)
        if src:
            print(f"# minted via {src} plan={_plan} note={_note}", file=sys.stderr)
    except ValueError as exc:
        print(f"error: {exc}  (plans: m1, m3, m6, y1, developer)", file=sys.stderr)
        sys.exit(2)
    except RuntimeError as exc:
        print(f"error: {exc}", file=sys.stderr)
        print("hint:  set AXIASOFT_KEY_PRIVATE or AURION_KEY_PRIVATE_HEX=<64-hex-seed> first (owner machine only)", file=sys.stderr)
        print("hint:  Windows: set AXIASOFT_KEY_PRIVATE=...  then python scripts/mint_local.py developer", file=sys.stderr)
        sys.exit(3)
