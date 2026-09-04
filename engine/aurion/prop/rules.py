from __future__ import annotations

import csv
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from ..config import abspath, load
from ..util.clock import utc_iso
from ..util.log import get
from .profiles import LOCKED_IDS, get_profile

log = get("prop")


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
        self.enabled = bool(saved.get("enabled", True))
        self.reload_news()

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
        stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        if stamp != self.day_stamp:
            self.day_stamp = stamp
            self.day_start_equity = equity
            self.entries_today = 0
        if self.high_water is None or equity > self.high_water:
            self.high_water = equity

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
            }
        self._roll_day(equity)
        daily = 0.0
        if self.day_start_equity:
            daily = (equity - self.day_start_equity) / self.day_start_equity * 100.0
        dd = 0.0
        if self.high_water:
            dd = (self.high_water - equity) / self.high_water * 100.0
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

    def unlock(self) -> None:
        self.locked = False
        self.lock_reason = ""

    def evaluate_account(self, account: dict[str, Any], positions: list[dict[str, Any]]) -> dict[str, Any]:
        metrics = self.metrics(account)
        if self.locked:
            return {"ok": False, "action": "none", "code": self.lock_reason, "metrics": metrics}
        if not metrics["ready"]:
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
        if metrics["ready"] and metrics["daily_pl_pct"] <= -abs(float(self.profile["max_daily_loss_pct"])):
            return {"ok": False, "error": "max daily loss reached"}
        if metrics["ready"] and metrics["drawdown_pct"] >= abs(float(self.profile["max_drawdown_pct"])):
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
        if target > 0 and metrics.get("ready") and metrics["daily_pl_pct"] >= target:
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

    def note_closed_trade(self, profit: float) -> None:
        if profit < 0:
            self.consecutive_losses += 1
        elif profit > 0:
            self.consecutive_losses = 0
