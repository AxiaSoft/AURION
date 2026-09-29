from __future__ import annotations

import csv
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from ..config import ROOT, abspath, load
from ..util.clock import utc_iso
from ..util.log import get
from .profiles import LOCKED_IDS, get_profile

log = get("prop")

# Where the day baseline lives between restarts. Without it the engine would
# re-baseline on every boot (a restart in the middle of a losing day would wipe
# the daily-loss guard); with it the baseline is bound to one account + one UTC
# day and is never reused for a different login.
STATE_FILE = ROOT / "data" / "prop-day.json"


def account_key(account: dict[str, Any] | None) -> str:
    """Stable identity of the connected trading account.

    A new account (or a new broker server for the same number) must never
    inherit the previous account's day baseline — that is what produced a
    "Daily P/L 8.7%" on a brand new account that has never traded.
    """
    data = account or {}
    try:
        login = int(float(data.get("login") or 0))
    except (TypeError, ValueError):
        login = 0
    server = str(data.get("server") or "").strip()
    if not login and not server:
        return ""
    return f"{login}@{server}"


class PropEngine:
    def __init__(self) -> None:
        cfg = load()
        saved = cfg.get("prop") or {}
        active = str(saved.get("active_profile") or "conservative")
        self.profile = get_profile(active)
        saved_profile = saved.get("profile") if isinstance(saved.get("profile"), dict) else {}
        if self.profile.get("id") not in LOCKED_IDS and saved_profile:
            self.profile.update(saved_profile)
            self.profile["id"] = "custom"
            self.profile["locked"] = False
        self.day_start_equity: float | None = None
        self.day_stamp: str = ""
        self.high_water: float | None = None
        self.locked = False
        self.lock_reason = ""
        self.violations: list[dict[str, Any]] = []
        self.news_events: list[dict[str, Any]] = []
        self.consecutive_losses = 0
        self.last_entry_ts: float = 0.0
        self.entries_today = 0
        self.closed_today = 0
        self.account_key = ""
        self.last_balance: float | None = None
        self._closed_since_balance = 0
        self.enabled = bool(saved.get("enabled", True))
        self._restore_day_state()
        self.reload_news()

    # ------------------------------------------------------------------ state
    @staticmethod
    def _today() -> str:
        return datetime.now(timezone.utc).strftime("%Y-%m-%d")

    def _restore_day_state(self) -> None:
        """Reload today's baseline for the account we were last bound to."""
        try:
            blob = json.loads(STATE_FILE.read_text(encoding="utf-8"))
        except Exception:
            return
        if not isinstance(blob, dict):
            return
        if str(blob.get("day") or "") != self._today():
            return  # a different UTC day: start clean
        key = str(blob.get("account") or "")
        if not key:
            return
        self.account_key = key
        try:
            start = float(blob.get("day_start_equity") or 0) or None
            water = float(blob.get("high_water") or 0) or None
        except (TypeError, ValueError):
            return
        self.day_stamp = self._today()
        self.day_start_equity = start
        self.high_water = water
        try:
            self.entries_today = int(blob.get("entries_today") or 0)
            self.closed_today = int(blob.get("closed_today") or 0)
        except (TypeError, ValueError):
            pass
        try:
            self.last_balance = float(blob.get("balance")) if blob.get("balance") is not None else None
        except (TypeError, ValueError):
            self.last_balance = None

    def _save_day_state(self) -> None:
        if not self.account_key:
            return
        payload = {
            "account": self.account_key,
            "day": self.day_stamp or self._today(),
            "day_start_equity": self.day_start_equity,
            "high_water": self.high_water,
            "entries_today": int(self.entries_today),
            "closed_today": int(self.closed_today),
            "balance": self.last_balance,
            "saved": utc_iso(),
        }
        try:
            STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
            tmp = STATE_FILE.with_suffix(".tmp")
            tmp.write_text(json.dumps(payload, indent=2), encoding="utf-8")
            tmp.replace(STATE_FILE)
        except Exception:
            log.debug("prop day state not saved", exc_info=True)

    def rebase(self, account: dict[str, Any] | None, reason: str = "") -> None:
        """Start a brand new trading day from the account we see right now."""
        data = account or {}
        try:
            equity = float(data.get("equity") or 0)
            balance = float(data.get("balance") or 0)
        except (TypeError, ValueError):
            equity = balance = 0.0
        base = equity or balance
        self.day_stamp = self._today()
        self.day_start_equity = base or None
        self.high_water = max(base, balance) or None
        self.entries_today = 0
        self.closed_today = 0
        self.consecutive_losses = 0
        self._closed_since_balance = 0
        self.last_balance = balance or None
        if reason:
            log.info("prop baseline rebased (%s) at equity=%s", reason, base)
        self._save_day_state()

    def _sync_account(self, account: dict[str, Any]) -> None:
        """Bind the baseline to the live account and follow cash movements."""
        key = account_key(account)
        if not key:
            return  # identity unknown yet — never baseline off a blank account
        if key != self.account_key:
            self.account_key = key
            # A different login/server: nothing from the old account may leak
            # into this one (baseline, high-water, counters or a stale lock).
            self.locked = False
            self.lock_reason = ""
            self.violations = []
            self.rebase(account, reason=f"account {key}")
            return
        try:
            balance = float(account.get("balance") or 0)
        except (TypeError, ValueError):
            return
        if balance <= 0:
            return
        if self.last_balance is None:
            self.last_balance = balance
            return
        delta = balance - self.last_balance
        if abs(delta) > 1e-9:
            if self._closed_since_balance == 0 and self.day_start_equity:
                # Balance moved with no closed trade behind it: a deposit or a
                # withdrawal. Shift the baselines so it is not read as P/L.
                self.day_start_equity += delta
                if self.high_water is not None:
                    self.high_water += delta
                log.info("prop baseline shifted by cash movement %s", delta)
            self._closed_since_balance = 0
            self.last_balance = balance
            self._save_day_state()

    def _has_activity(
        self,
        positions: list[dict[str, Any]] | None = None,
        account: dict[str, Any] | None = None,
    ) -> bool:
        """True when something actually traded on this account today.

        Prop rules may only trip on trading. With no entries, no closes, no
        open position and no floating P/L, any equity wobble comes from the
        feed or from a cash movement — and locking on it is exactly what
        re-locked the desk one second after every manual unlock.
        """
        if self.entries_today or self.closed_today:
            return True
        if positions:
            return True
        if account:
            try:
                equity = float(account.get("equity") or 0)
                balance = float(account.get("balance") or 0)
            except (TypeError, ValueError):
                return False
            if equity > 0 and balance > 0:
                # Floating P/L means there is exposure, whatever opened it.
                return abs(equity - balance) > max(0.01, abs(balance) * 1e-6)
        return False

    def set_enabled(self, enabled: bool) -> dict[str, Any]:
        self.enabled = bool(enabled)
        if not self.enabled:
            self.locked = False
            self.lock_reason = ""
        return {"ok": True, "enabled": self.enabled}

    def set_profile(self, profile: dict[str, Any]) -> dict[str, Any]:
        wanted = str((profile or {}).get("id") or "custom")
        if wanted in LOCKED_IDS:
            self.profile = get_profile(wanted)
            return self.profile
        merged = get_profile("custom")
        incoming = dict(profile or {})
        incoming.pop("locked", None)
        merged.update(incoming)
        merged["id"] = "custom"
        merged["locked"] = False
        self.profile = merged
        return self.profile

    def reload_news(self) -> int:
        cfg = load()
        path = str(cfg["prop"].get("news_calendar_path") or "")
        self.news_events = []
        if not path:
            # Nothing configured: fall back to the Forex Factory cache so the
            # calendar and the blackout filter are never silently empty.
            try:
                from .. import news_feed

                news_feed.refresh()
                path = str(load()["prop"].get("news_calendar_path") or "")
            except Exception:
                return 0
        if not path:
            # Last resort: read the feed cache directly rather than trusting a
            # config value this process may have loaded before it was written.
            try:
                from .. import news_feed

                if news_feed.CACHE.exists():
                    path = str(news_feed.CACHE)
            except Exception:
                pass
        if not path:
            return 0
        file = abspath(path)
        if not file.exists():
            return 0
        with file.open("r", encoding="utf-8") as fh:
            reader = csv.DictReader(fh)
            for row in reader:
                self.news_events.append(row)
        return len(self.news_events)

    def _roll_day(self, equity: float) -> None:
        stamp = self._today()
        changed = False
        if stamp != self.day_stamp:
            self.day_stamp = stamp
            self.day_start_equity = equity
            self.entries_today = 0
            self.closed_today = 0
            changed = True
        if not self.day_start_equity and equity > 0:
            # First real reading of the session — this, not a leftover number
            # from another account, is where the day starts.
            self.day_start_equity = equity
            changed = True
        if self.high_water is None or equity > self.high_water:
            self.high_water = equity
            changed = True
        if changed:
            self._save_day_state()

    def metrics(self, account: dict[str, Any]) -> dict[str, Any]:
        equity = float(account.get("equity") or 0)
        balance = float(account.get("balance") or 0)
        if equity <= 0 and balance <= 0:
            return {
                "ready": False,
                "locked": self.locked,
                "lock_reason": self.lock_reason,
                "daily_pl_pct": 0.0,
                "drawdown_pct": 0.0,
                "day_start_equity": self.day_start_equity,
                "high_water": self.high_water,
                "profile": self.profile,
                "news_loaded": len(self.news_events),
                "violations": self.violations[-20:],
                "consecutive_losses": self.consecutive_losses,
                "enabled": self.enabled,
                "account": self.account_key,
                "traded_today": False,
            }
        self._sync_account(account)
        self._roll_day(equity or balance)
        daily = 0.0
        if self.day_start_equity:
            daily = (equity - self.day_start_equity) / self.day_start_equity * 100.0
        dd = 0.0
        if self.high_water:
            dd = (self.high_water - equity) / self.high_water * 100.0
        flat = abs(equity - balance) <= max(0.01, abs(balance) * 1e-6)
        if flat and not self._has_activity():
            # No trade today and no floating position: the day is flat by
            # definition. Re-anchor instead of echoing a stale baseline.
            if self.day_start_equity != equity or self.high_water != equity:
                self.day_start_equity = equity
                self.high_water = equity
                self._save_day_state()
            daily = 0.0
            dd = 0.0
        return {
            "ready": True,
            "locked": self.locked,
            "lock_reason": self.lock_reason,
            "daily_pl_pct": daily,
            "drawdown_pct": dd,
            "day_start_equity": self.day_start_equity,
            "high_water": self.high_water,
            "profile": self.profile,
            "news_loaded": len(self.news_events),
            "violations": self.violations[-20:],
            "consecutive_losses": self.consecutive_losses,
            "enabled": self.enabled,
            "account": self.account_key,
            "traded_today": self._has_activity(),
            "entries_today": int(self.entries_today),
            "closed_today": int(self.closed_today),
        }

    def _in_hours(self) -> tuple[bool, str]:
        hours = self.profile.get("trading_hours") or {}
        now = datetime.now(timezone.utc)
        if now.weekday() not in set(hours.get("weekdays") or [0, 1, 2, 3, 4]):
            if not self.profile.get("allow_weekend"):
                return False, "outside allowed weekdays"
        start = str(hours.get("start") or "00:00")
        end = str(hours.get("end") or "23:59")
        hm = now.strftime("%H:%M")
        if not (start <= hm <= end):
            return False, f"outside trading hours {start}-{end} UTC"
        return True, ""

    def _news_blackout(self, symbol: str, force: bool = False) -> tuple[bool, str]:
        if not force and not self.profile.get("news_filter"):
            return False, ""
        if not self.news_events:
            return False, ""
        cfg = load()
        before = int(self.profile.get("news_blackout_before") or cfg["prop"].get("news_blackout_minutes_before") or 15)
        after = int(self.profile.get("news_blackout_after") or cfg["prop"].get("news_blackout_minutes_after") or 15)
        now = datetime.now(timezone.utc)
        root = symbol[:3] + symbol[3:6] if len(symbol) >= 6 else symbol
        for event in self.news_events:
            raw = event.get("time") or event.get("datetime") or ""
            if not raw:
                continue
            try:
                when = datetime.fromisoformat(raw.replace("Z", "+00:00"))
                if when.tzinfo is None:
                    when = when.replace(tzinfo=timezone.utc)
            except Exception:
                continue
            currency = str(event.get("currency") or event.get("ccy") or "")
            if currency and currency not in root:
                continue
            impact = str(event.get("impact") or event.get("importance") or "high").lower()
            if impact not in {"high", "red", "3", "holiday"} and event.get("impact"):
                continue
            delta = (now - when).total_seconds() / 60.0
            if -before <= delta <= after:
                return True, f"news blackout {event.get('title') or event.get('event') or currency}"
        return False, ""

    def _record(self, code: str, message: str) -> None:
        item = {"ts": utc_iso(), "code": code, "message": message}
        self.violations.append(item)
        log.warning("prop violation %s %s", code, message)

    def lock(self, reason: str) -> None:
        self.locked = True
        self.lock_reason = reason
        self._record("lock", reason)

    def unlock(self, account: dict[str, Any] | None = None) -> None:
        """Release the lock and give the desk a clean slate to trade from.

        Unlocking used to leave the baseline that tripped the rule in place, so
        the very next account tick re-locked the desk. Re-anchoring the day and
        the high-water mark on the equity we unlock at is what makes the unlock
        actually stick until a *new* violation happens.
        """
        was = self.lock_reason
        self.locked = False
        self.lock_reason = ""
        self.consecutive_losses = 0
        if account:
            try:
                equity = float(account.get("equity") or 0)
            except (TypeError, ValueError):
                equity = 0.0
            if equity > 0:
                self.day_start_equity = equity
                self.high_water = equity
                self._save_day_state()
        if was:
            log.info("prop unlocked (was %s)", was)

    def evaluate_account(self, account: dict[str, Any], positions: list[dict[str, Any]]) -> dict[str, Any]:
        metrics = self.metrics(account)
        if self.locked:
            return {"ok": False, "action": "none", "code": self.lock_reason, "metrics": metrics}
        if not metrics["ready"]:
            return {"ok": True, "action": "none", "metrics": metrics}
        if not self._has_activity(positions, account):
            # Never trip a rule on an account that has not traded today.
            return {"ok": True, "action": "none", "metrics": metrics}
        if metrics["daily_pl_pct"] <= -abs(float(self.profile["max_daily_loss_pct"])):
            self._record("daily_loss", f"daily P/L {metrics['daily_pl_pct']:.2f}%")
            return self._trip("daily_loss", metrics)
        if metrics["drawdown_pct"] >= abs(float(self.profile["max_drawdown_pct"])):
            self._record("max_dd", f"drawdown {metrics['drawdown_pct']:.2f}%")
            return self._trip("max_dd", metrics)
        target = float(self.profile.get("max_daily_profit_pct") or 0)
        if target > 0 and metrics["daily_pl_pct"] >= target:
            self._record("daily_target", f"daily P/L {metrics['daily_pl_pct']:.2f}%")
            self.lock("daily_target")
            return {"ok": False, "action": "lock", "code": "daily_target", "metrics": self.metrics(account)}
        if not self.profile.get("allow_hold_over_weekend"):
            now = datetime.now(timezone.utc)
            close_h = int(self.profile.get("friday_close_utc_hour") or 21)
            if now.weekday() == 4 and now.hour >= close_h and positions:
                return {"ok": False, "action": "flatten_and_lock", "code": "weekend_flatten", "metrics": metrics}
        if len(positions) > int(self.profile["max_open_trades"]):
            self._record("max_trades", f"{len(positions)} open")
            return self._trip("max_trades", metrics)
        max_h = float(self.profile.get("max_hold_hours") or 0)
        if max_h > 0:
            for pos in positions:
                age = self._age_minutes(str(pos.get("time") or ""))
                if age is not None and age / 60.0 >= max_h:
                    return {"ok": False, "action": "flatten", "code": "max_hold", "metrics": metrics}
        return {"ok": True, "action": "none", "metrics": metrics}

    def _trip(self, code: str, metrics: dict[str, Any]) -> dict[str, Any]:
        mode = self.profile.get("on_violation") or "lock"
        if "lock" in mode:
            self.lock(code)
        return {"ok": False, "action": mode, "code": code, "metrics": self.metrics(metrics.get("account") or {}) if False else {**metrics, "locked": self.locked, "lock_reason": self.lock_reason}}

    def _age_minutes(self, stamp: str) -> float | None:
        if not stamp:
            return None
        raw = str(stamp).replace("Z", "+00:00")
        try:
            when = datetime.fromisoformat(raw)
        except Exception:
            return None
        if when.tzinfo is None:
            when = when.replace(tzinfo=timezone.utc)
        return max(0.0, (datetime.now(timezone.utc) - when).total_seconds() / 60.0)

    def allow_order(self, request: dict[str, Any], account: dict[str, Any], positions: list[dict[str, Any]]) -> dict[str, Any]:
        action = str(request.get("action") or "market").lower()
        if action == "modify":
            return {"ok": True}
        if not self.enabled:
            return {"ok": True, "bypassed": True}
        if action in {"close", "flatten"}:
            if action == "flatten" or request.get("emergency"):
                return {"ok": True}
            hold = float(self.profile.get("min_hold_minutes") or 0)
            if hold > 0:
                ticket = int(request.get("ticket") or 0)
                pos = next((p for p in positions if int(p.get("ticket") or 0) == ticket), None)
                if pos:
                    age = self._age_minutes(str(pos.get("time") or ""))
                    if age is not None and age < hold:
                        return {"ok": False, "error": f"min hold {hold:g} min — position is only {age:.1f} min old"}
            return {"ok": True}
        if self.locked:
            return {"ok": False, "error": f"prop lock: {self.lock_reason}"}
        metrics = self.metrics(account)
        traded = self._has_activity(positions, account)
        if traded and metrics["ready"] and metrics["daily_pl_pct"] <= -abs(float(self.profile["max_daily_loss_pct"])):
            return {"ok": False, "error": "max daily loss reached"}
        if traded and metrics["ready"] and metrics["drawdown_pct"] >= abs(float(self.profile["max_drawdown_pct"])):
            return {"ok": False, "error": "max drawdown reached"}
        ok_h, why = self._in_hours()
        if not ok_h:
            return {"ok": False, "error": why}
        symbol = str(request.get("symbol") or "")
        blocked, news = self._news_blackout(symbol)
        if blocked:
            return {"ok": False, "error": news}
        volume = float(request.get("volume") or 0)
        if volume > float(self.profile["max_lot"]):
            return {"ok": False, "error": f"lot {volume} exceeds max {self.profile['max_lot']}"}
        desk = str(request.get("source") or "") == "desk"
        if (not desk) and len(positions) >= int(self.profile["max_open_trades"]) and action in {"market", "buy", "sell", "pending"}:
            return {"ok": False, "error": "max open trades reached"}
        same = [p for p in positions if p.get("symbol") == symbol]
        if (not desk) and len(same) >= int(self.profile.get("max_positions_per_symbol") or 1):
            return {"ok": False, "error": "max positions for symbol reached"}
        allowed = str(self.profile.get("allowed_symbols") or "").strip()
        if allowed and symbol:
            names = {s.strip().upper() for s in allowed.replace(";", ",").split(",") if s.strip()}
            if symbol.upper() not in names:
                return {"ok": False, "error": f"{symbol} is not in the allowed symbol list"}
        cap = int(self.profile.get("max_consecutive_losses") or 0)
        if cap > 0 and self.consecutive_losses >= cap:
            return {"ok": False, "error": f"{self.consecutive_losses} consecutive losses"}
        gap = float(self.profile.get("min_minutes_between_trades") or 0)
        if gap > 0 and self.last_entry_ts:
            import time as _t
            if (_t.time() - self.last_entry_ts) / 60.0 < gap:
                return {"ok": False, "error": f"wait {gap:.0f} minutes between entries"}
        target = float(self.profile.get("max_daily_profit_pct") or 0)
        if target > 0 and traded and metrics.get("ready") and metrics["daily_pl_pct"] >= target:
            return {"ok": False, "error": "daily profit target reached — new entries locked"}
        day_cap = int(self.profile.get("max_trades_per_day") or 0)
        if day_cap > 0 and self.entries_today >= day_cap:
            return {"ok": False, "error": f"max {day_cap} trades per day reached"}
        if not self.profile.get("hedging_allowed", True) and symbol:
            side = str(request.get("side") or action or "").lower()
            want = "buy" if side in {"buy", "market"} else "sell" if side == "sell" else ""
            if want:
                opposite = "sell" if want == "buy" else "buy"
                if any(p.get("symbol") == symbol and str(p.get("type") or "") == opposite for p in positions):
                    return {"ok": False, "error": "hedging is not allowed on this profile"}
        lot_sym = float(self.profile.get("max_lot_per_symbol") or 0)
        if lot_sym > 0 and symbol:
            already = sum(float(p.get("volume") or 0) for p in positions if p.get("symbol") == symbol)
            if already + volume > lot_sym + 1e-9:
                return {"ok": False, "error": f"lot on {symbol} would exceed {lot_sym}"}
        return {"ok": True, "metrics": metrics}

    def note_entry(self) -> None:
        import time as _t
        self.last_entry_ts = _t.time()
        self.entries_today += 1
        self._save_day_state()

    def note_closed_trade(self, profit: float) -> None:
        if profit < 0:
            self.consecutive_losses += 1
        elif profit > 0:
            self.consecutive_losses = 0
        self.closed_today += 1
        self._closed_since_balance += 1
        self._save_day_state()
