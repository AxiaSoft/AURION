"""Telegram status + full desk-settings remote for the live AURION desk.

Modern inline keyboard: each button shows its own status with color emoji 🟢/🔴/🟡
When clicked, it toggles off->on and updates color.
All dashboard settings are available as buttons.
Version is shown and updates after each system update.

Commands: /start, /status, /positions, /ai, /desk, /settings, /about, /help.
Never sends market orders.
"""

from __future__ import annotations

import asyncio
import re
import secrets
import time
from typing import Any

from ..config import load, merge, ROOT
from . import secret
from ..util.log import get

log = get("telegram")

TG_API = "https://api.telegram.org"
PAIR_TTL = 15 * 60
POLL_TIMEOUT = 25

TXT: dict[str, dict[str, str]] = {
    "fa": {
        "help": (
            "🤖 AURION — ربات هوشمند کنترل دسک\n\n"
            "📌 دستورات:\n"
            "/status — وضعیت کامل موتور، MT5، پوزیشن‌ها\n"
            "/positions — پوزیشن‌های باز\n"
            "/ai — وضعیت هوش مصنوعی\n"
            "/settings — تمام تنظیمات سیستم با دکمه‌های رنگی\n"
            "/about — درباره سیستم و نسخه\n"
            "/help — راهنما\n\n"
            "💡 هر دکمه وضعیت خودش را با رنگ نشان می‌دهد:\n"
            "🟢 روشن / فعال\n"
            "🔴 خاموش / غیرفعال / مسلح\n"
            "🟡 حالت خاص\n"
            "با کلیک روی هر دکمه، وضعیت تغییر می‌کند.\n"
            "⚠️ از ربات نمی‌توان معامله مستقیم کرد."
        ),
        "denied": "🔒 این چت به AURION وصل نیست.\nاز داشبورد: تنظیمات → تلگرام → کد اتصال بگیرید و اینجا بفرستید:\n/start 123456",
        "paired": "✅ چت وصل شد!\nاز این به بعد وضعیت و باز/بسته شدن پوزیشن‌ها را اینجا می‌فرستم.",
        "engine_on": "🟢 موتور: آنلاین",
        "engine_off": "🔴 موتور: خاموش",
        "mt5_on": "🟢 متاتریدر: متصل",
        "mt5_off": "🔴 متاتریدر: قطع",
        "auto_on": "🟢 اتو ترید: روشن",
        "auto_off": "🔴 اتو ترید: خاموش",
        "kill_on": "🔴 کیل‌سوئیچ: مسلح",
        "kill_off": "🟢 کیل‌سوئیچ: خاموش",
        "prop_on": "🟢 پراپ: فعال",
        "prop_off": "🔴 پراپ: غیرفعال",
        "news_on": "🟢 اخبار: معامله فعال",
        "news_off": "🔴 اخبار: مسدود",
        "ai_gate_on": "🟢 AI Gate: فعال",
        "ai_gate_off": "🔴 AI Gate: غیرفعال",
        "no_pos": "📭 پوزیشن باز نیست.",
        "open_title": "🟢 پوزیشن باز شد",
        "close_title": "🔴 پوزیشن بسته شد",
        "ticket": "تیکت",
        "entry": "ورود",
        "pnl": "سود/ضرر",
        "profit": "سود",
        "loss": "ضرر",
        "flat": "سر به سر",
        "balance": "بالانس",
        "equity": "اکوئیتی",
        "float": "سود شناور",
        "open_n": "پوزیشن باز",
        "ea": "چارت EA",
        "readonly": "⚠️ سفارش بازار از ربات نمی‌رود. تنظیمات را با دکمه‌های رنگی عوض کنید.",
        "done": "✅ انجام شد.",
        "ai_title": "🧠 هوش مصنوعی",
        "desk_title": "⚙️ تنظیمات داشبورد",
        "settings_title": "🎛️ کنترل کامل سیستم",
        "btn_status": "📊 وضعیت",
        "btn_positions": "📈 پوزیشن‌ها",
        "btn_ai": "🧠 هوش",
        "btn_settings": "⚙️ تنظیمات",
        "btn_about": "ℹ️ درباره",
        "btn_auto": "🤖 اتو ترید",
        "btn_kill": "🛑 کیل سوئیچ",
        "btn_prop": "🛡️ پراپ",
        "btn_news": "📰 اخبار",
        "btn_ai_gate": "🧠 AI Gate",
        "btn_style": "🎨 استایل",
        "btn_vol": "📦 حجم",
        "btn_strats": "📊 استراتژی‌ها",
        "btn_normal": "نرمال",
        "btn_scalp": "اسکلپ",
        "tape_live": "🟢 نوار: زنده",
        "tape_tester": "🟡 نوار: بک‌تست",
        "tape_idle": "⚪ نوار: بدون EA",
        "who": "استراتژی",
        "sl": "حد ضرر",
        "tp": "حد سود",
        "vol": "حجم",
        "side_buy": "🟢 خرید",
        "side_sell": "🔴 فروش",
        "version": "نسخه",
        "about_text": "🏢 AURION Live Desk\nتوسعه: Axiasoft\nسیستم ترید زنده MT5 با AI",
    },
    "en": {
        "help": (
            "🤖 AURION — Smart Desk Control Bot\n\n"
            "📌 Commands:\n"
            "/status — full engine, MT5, positions\n"
            "/positions — open positions\n"
            "/ai — AI status\n"
            "/settings — all system settings with colored buttons\n"
            "/about — about system & version\n"
            "/help — help\n\n"
            "💡 Each button shows its status with color:\n"
            "🟢 On / Active\n"
            "🔴 Off / Armed\n"
            "🟡 Special\n"
            "Click to toggle.\n"
            "⚠️ No direct trading from bot."
        ),
        "denied": "🔒 Chat not linked.\nIn desk: Settings → Telegram, then send:\n/start 123456",
        "paired": "✅ Chat linked!\nYou will get status and alerts here.",
        "engine_on": "🟢 Engine: online",
        "engine_off": "🔴 Engine: down",
        "mt5_on": "🟢 MetaTrader: connected",
        "mt5_off": "🔴 MetaTrader: down",
        "auto_on": "🟢 Auto-trade: ON",
        "auto_off": "🔴 Auto-trade: OFF",
        "kill_on": "🔴 Kill: ARMED",
        "kill_off": "🟢 Kill: OFF",
        "prop_on": "🟢 Prop: ON",
        "prop_off": "🔴 Prop: OFF",
        "news_on": "🟢 News: Trading ON",
        "news_off": "🔴 News: Blocked",
        "ai_gate_on": "🟢 AI Gate: ON",
        "ai_gate_off": "🔴 AI Gate: OFF",
        "no_pos": "📭 No open positions.",
        "open_title": "🟢 Position opened",
        "close_title": "🔴 Position closed",
        "ticket": "Ticket",
        "entry": "Entry",
        "pnl": "P/L",
        "profit": "profit",
        "loss": "loss",
        "flat": "flat",
        "balance": "Balance",
        "equity": "Equity",
        "float": "Floating",
        "open_n": "Open",
        "ea": "EA charts",
        "readonly": "⚠️ No market orders from bot. Use colored buttons for settings.",
        "done": "✅ Done.",
        "ai_title": "🧠 Intelligence",
        "desk_title": "⚙️ Dashboard Settings",
        "settings_title": "🎛️ Full System Control",
        "btn_status": "📊 Status",
        "btn_positions": "📈 Positions",
        "btn_ai": "🧠 AI",
        "btn_settings": "⚙️ Settings",
        "btn_about": "ℹ️ About",
        "btn_auto": "🤖 Auto Trade",
        "btn_kill": "🛑 Kill",
        "btn_prop": "🛡️ Prop",
        "btn_news": "📰 News",
        "btn_ai_gate": "🧠 AI Gate",
        "btn_style": "🎨 Style",
        "btn_vol": "📦 Volume",
        "btn_strats": "📊 Strategies",
        "btn_normal": "Normal",
        "btn_scalp": "Scalp",
        "tape_live": "🟢 Tape: live",
        "tape_tester": "🟡 Tape: tester",
        "tape_idle": "⚪ Tape: no EA",
        "who": "Strategy",
        "sl": "SL",
        "tp": "TP",
        "vol": "Volume",
        "side_buy": "🟢 BUY",
        "side_sell": "🔴 SELL",
        "version": "Version",
        "about_text": "🏢 AURION Live Desk\nBy Axiasoft\nLive MT5 trading with AI",
    },
    "ar": {
        "help": "🤖 AURION — بوت التحكم\n/status — الحالة\n/settings — الإعدادات\n/about — حول النظام",
        "denied": "🔒 غير مربوط. Settings → Telegram\n/start 123456",
        "paired": "✅ تم الربط",
        "engine_on": "🟢 المحرك: متصل",
        "engine_off": "🔴 المحرك: متوقف",
        "mt5_on": "🟢 ميتاتريدر: متصل",
        "mt5_off": "🔴 ميتاتريدر: غير متصل",
        "auto_on": "🟢 آلي: تشغيل",
        "auto_off": "🔴 آلي: إيقاف",
        "kill_on": "🔴 قتل: مسلح",
        "kill_off": "🟢 قتل: إيقاف",
        "prop_on": "🟢 Prop: تشغيل",
        "prop_off": "🔴 Prop: إيقاف",
        "news_on": "🟢 أخبار: تشغيل",
        "news_off": "🔴 أخبار: محظور",
        "ai_gate_on": "🟢 AI Gate: تشغيل",
        "ai_gate_off": "🔴 AI Gate: إيقاف",
        "no_pos": "📭 لا صفقات",
        "open_title": "🟢 فتح صفقة",
        "close_title": "🔴 إغلاق صفقة",
        "ticket": "التذكرة",
        "entry": "الدخول",
        "pnl": "ربح/خسارة",
        "profit": "ربح",
        "loss": "خسارة",
        "flat": "متعادل",
        "balance": "الرصيد",
        "equity": "الحقوق",
        "float": "العائم",
        "open_n": "مفتوح",
        "ea": "EA",
        "readonly": "⚠️ لا أوامر من البوت",
        "done": "✅ تم",
        "ai_title": "🧠 ذكاء",
        "desk_title": "⚙️ إعدادات",
        "settings_title": "🎛️ تحكم كامل",
        "btn_status": "📊 حالة",
        "btn_positions": "📈 صفقات",
        "btn_ai": "🧠 ذكاء",
        "btn_settings": "⚙️ إعدادات",
        "btn_about": "ℹ️ حول",
        "btn_auto": "🤖 آلي",
        "btn_kill": "🛑 قتل",
        "btn_prop": "🛡️ Prop",
        "btn_news": "📰 أخبار",
        "btn_ai_gate": "🧠 AI",
        "btn_style": "🎨 نمط",
        "btn_vol": "📦 حجم",
        "btn_strats": "📊 استراتيجيات",
        "btn_normal": "عادي",
        "btn_scalp": "سكالب",
        "tape_live": "🟢 شريط: حي",
        "tape_tester": "🟡 شريط: اختبار",
        "tape_idle": "⚪ شريط: بلا",
        "who": "استراتيجية",
        "sl": "وقف",
        "tp": "جني",
        "vol": "حجم",
        "side_buy": "🟢 شراء",
        "side_sell": "🔴 بيع",
        "version": "إصدار",
        "about_text": "🏢 AURION\nAxiasoft",
    },
}


def t(lang: str, key: str) -> str:
    pack = TXT.get(lang) or TXT["en"]
    return pack.get(key) or TXT["en"].get(key) or key


def mask_token(token: str) -> str:
    raw = str(token or "").strip()
    if not raw:
        return ""
    if len(raw) < 12:
        return "•" * min(len(raw), 8)
    return raw[:6] + "…" + raw[-4:]


def is_masked_token(token: str) -> bool:
    raw = str(token or "")
    if not raw:
        return True
    return any(m in raw for m in ("…", "...", "•", "***"))


def _num(n: Any, digits: int = 2) -> str:
    try:
        v = float(n or 0)
    except (TypeError, ValueError):
        return "—"
    sign = "+" if v > 0 else ""
    return f"{sign}{v:.{digits}f}"


def _side_label(lang: str, side: str) -> str:
    s = str(side or "").lower()
    if s in {"buy", "long", "0"}:
        return t(lang, "side_buy")
    if s in {"sell", "short", "1"}:
        return t(lang, "side_sell")
    return str(side or "—")


def _pnl_word(lang: str, profit: float) -> str:
    if profit > 0:
        return t(lang, "profit")
    if profit < 0:
        return t(lang, "loss")
    return t(lang, "flat")


def get_version() -> str:
    try:
        cfg = load()
        return str(cfg.get("version") or "1.0.0")
    except Exception:
        return "1.0.0"


def format_status(snap: dict[str, Any] | None, lang: str = "fa") -> str:
    snap = snap or {}
    mt = snap.get("mt5") or {}
    acc = mt.get("account") if isinstance(mt.get("account"), dict) else {}
    if not acc and isinstance(snap.get("account"), dict):
        acc = snap["account"]
    positions = snap.get("positions") or []
    if not isinstance(positions, list):
        positions = []
    agents = snap.get("agents") or []
    if not isinstance(agents, list):
        agents = []
    currency = str(acc.get("currency") or "")
    mt_live = bool(mt.get("connected") or agents)
    st = snap.get("strategy") if isinstance(snap.get("strategy"), dict) else {}
    auto = bool(st.get("auto_trade") or snap.get("auto_trade"))
    version = snap.get("version") or get_version()
    lines = [
        f"🚀 AURION v{version}",
        "━━━━━━━━━━━━━━━",
        t(lang, "engine_on") if snap.get("engine") == "online" or snap else t(lang, "engine_off"),
        t(lang, "mt5_on") if mt_live else t(lang, "mt5_off"),
    ]
    login = acc.get("login") or ""
    server = acc.get("server") or ""
    if login or server:
        lines.append(f"🔑 {login} · {server}".strip(" ·"))
    if acc:
        lines.append(f"💰 {t(lang, 'balance')}: {_num(acc.get('balance'))} {currency}".strip())
        lines.append(f"📈 {t(lang, 'equity')}: {_num(acc.get('equity'))} {currency}".strip())
        lines.append(f"💹 {t(lang, 'float')}: {_num(acc.get('profit'))} {currency}".strip())
    lines.append(f"📊 {t(lang, 'open_n')}: {len(positions)} | {t(lang, 'ea')}: {len(agents)}")
    lines.append(t(lang, "auto_on") if auto else t(lang, "auto_off"))
    lines.append(t(lang, "kill_on") if snap.get("kill_switch") else t(lang, "kill_off"))
    # extra settings
    prop_enabled = st.get("prop_enabled")
    if prop_enabled is None:
        prop_enabled = snap.get("prop", {}).get("enabled", True) if isinstance(snap.get("prop"), dict) else True
    lines.append(t(lang, "prop_on") if prop_enabled else t(lang, "prop_off"))
    news_on = st.get("news_trade")
    if news_on is None:
        news_on = False
    # news trading is locked when prop enabled, show accordingly
    if st.get("news_trade_locked"):
        lines.append(f"📰 اخبار: قفل پراپ 🔒")
    else:
        lines.append(t(lang, "news_on") if news_on else t(lang, "news_off"))
    lines.append(t(lang, "ai_gate_on") if st.get("require_ai_agree", True) else t(lang, "ai_gate_off"))
    tape = str(snap.get("tape") or (mt.get("tape") if isinstance(mt, dict) else "") or "idle")
    lines.append(t(lang, "tape_tester" if tape == "tester" else ("tape_live" if tape == "live" else "tape_idle")))
    ai = snap.get("ai") if isinstance(snap.get("ai"), dict) else {}
    outlook = ai.get("outlook") if isinstance(ai.get("outlook"), dict) else {}
    if outlook.get("text") or ai.get("display_direction") or ai.get("direction"):
        lines.append(f"🧠 {t(lang, 'ai_title')}: {outlook.get('text') or ai.get('display_direction') or ai.get('direction')}")
    bt = snap.get("backtest") if isinstance(snap.get("backtest"), dict) else {}
    if bt.get("running"):
        lines.append(f"⏳ BACKTEST {bt.get('symbol') or ''} {bt.get('timeframe') or ''}…")
    elif bt.get("mode") == "backtest" and bt.get("ok"):
        metrics = bt.get("metrics") or {}
        lines.append(f"✅ BACKTEST {bt.get('symbol') or ''} net={_num(metrics.get('net'))}")
    lines.append(f"🔖 {t(lang, 'version')}: v{version}")
    if positions:
        lines.append("")
        lines.extend(_pos_lines(positions, lang, currency))
    else:
        lines.append(t(lang, "no_pos"))
    return "\n".join(lines)


def _pos_lines(positions: list[dict[str, Any]], lang: str, currency: str) -> list[str]:
    out: list[str] = []
    for p in positions:
        if not isinstance(p, dict):
            continue
        side = _side_label(lang, str(p.get("type") or p.get("side") or ""))
        who = str(p.get("strategy") or "").lstrip("@")
        line = (
            f"#{p.get('ticket') or '—'} {p.get('symbol') or '—'} {side} "
            f"{_num(p.get('volume'))}  {_num(p.get('profit'))} {currency}".strip()
        )
        if who:
            line += f"  ({who})"
        out.append(line)
    return out


def format_open(pos: dict[str, Any] | None, lang: str = "fa", currency: str = "") -> str:
    p = dict(pos or {})
    side = _side_label(lang, str(p.get("type") or p.get("side") or ""))
    who = str(p.get("strategy") or "").lstrip("@")
    lines = [
        t(lang, "open_title"),
        f"{p.get('symbol') or '—'}  {side}  {_num(p.get('volume'))}",
        f"{t(lang, 'ticket')} {p.get('ticket') or '—'}",
        f"{t(lang, 'entry')} {_num(p.get('price_open') or p.get('price'), 5)}",
    ]
    sl = p.get("sl")
    tp = p.get("tp")
    try:
        sl_n = float(sl or 0)
    except (TypeError, ValueError):
        sl_n = 0.0
    try:
        tp_n = float(tp or 0)
    except (TypeError, ValueError):
        tp_n = 0.0
    if sl_n:
        lines.append(f"{t(lang, 'sl')} {_num(sl_n, 5)}")
    if tp_n:
        lines.append(f"{t(lang, 'tp')} {_num(tp_n, 5)}")
    if who:
        lines.append(f"{t(lang, 'who')}: {who}")
    lines.append(f"🔖 v{get_version()}")
    return "\n".join(lines)


def format_close(pos: dict[str, Any] | None, lang: str = "fa", currency: str = "") -> str:
    p = dict(pos or {})
    side = _side_label(lang, str(p.get("type") or p.get("side") or ""))
    try:
        profit = float(p.get("profit") or 0)
    except (TypeError, ValueError):
        profit = 0.0
    who = str(p.get("strategy") or "").lstrip("@")
    mark = "✅" if profit > 0 else ("❌" if profit < 0 else "•")
    lines = [
        t(lang, "close_title"),
        f"{p.get('symbol') or '—'}  {side}  {_num(p.get('volume'))}",
        f"{t(lang, 'ticket')} {p.get('ticket') or '—'}",
        f"{t(lang, 'pnl')}: {_num(profit)} {currency}  {mark}  {_pnl_word(lang, profit)}".strip(),
    ]
    if who:
        lines.append(f"{t(lang, 'who')}: {who}")
    lines.append(f"🔖 v{get_version()}")
    return "\n".join(lines)


def _norm_chats(raw: Any) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    seen: set[int] = set()
    rows = raw if isinstance(raw, list) else []
    for item in rows:
        chat_id = 0
        name = ""
        username = ""
        if isinstance(item, dict):
            try:
                chat_id = int(item.get("id") or item.get("chat_id") or 0)
            except (TypeError, ValueError):
                chat_id = 0
            name = str(item.get("name") or item.get("title") or "")
            username = str(item.get("username") or "")
        else:
            try:
                chat_id = int(item)
            except (TypeError, ValueError):
                chat_id = 0
        if not chat_id or chat_id in seen:
            continue
        seen.add(chat_id)
        out.append({"id": chat_id, "name": name, "username": username})
    return out


class TelegramBot:
    def __init__(self, trader: Any | None = None) -> None:
        self.trader = trader
        self._task: asyncio.Task | None = None
        self._client: Any = None
        self._offset = 0
        self._stop = asyncio.Event()
        self._pair_code = ""
        self._pair_until = 0.0
        self._last_error = ""
        self._me: dict[str, Any] = {}
        self._lock = asyncio.Lock()
        self._started_at = 0.0

    def _cfg(self) -> dict[str, Any]:
        cfg = load()
        blob = cfg.get("telegram") if isinstance(cfg.get("telegram"), dict) else {}
        return dict(blob)

    def lang(self) -> str:
        lang = str(self._cfg().get("language") or load().get("default_language") or "fa").lower()
        return lang if lang in TXT else "fa"

    def token(self) -> str:
        """Active token. The source (env / config file) always wins over the desk."""
        tok, _ = secret.resolve(self._cfg().get("bot_token"))
        return tok

    def token_origin(self) -> str:
        _, origin = secret.resolve(self._cfg().get("bot_token"))
        return origin

    def source_token_set(self) -> bool:
        return bool(secret.source_token())

    def enabled(self) -> bool:
        c = self._cfg()
        return bool(c.get("enabled") and self.token())

    def uptime(self) -> float:
        """Seconds the poll loop has been running (0 when it is not)."""
        task = self._task
        if not task or task.done() or not self.enabled():
            return 0.0
        return round(max(0.0, time.time() - float(self._started_at or 0.0)), 1)

    def chats(self) -> list[dict[str, Any]]:
        return _norm_chats(self._cfg().get("chats") or self._cfg().get("chat_ids"))

    def chat_ids(self) -> set[int]:
        return {int(c["id"]) for c in self.chats()}

    def public(self) -> dict[str, Any]:
        c = self._cfg()
        token = self.token()
        from_source = self.source_token_set()
        return {
            "enabled": bool(c.get("enabled")),
            "has_token": bool(token),
            # The dashboard is a client: it may see the origin, never the token.
            "token_origin": self.token_origin(),
            "token_from_source": from_source,
            "token_editable": not from_source,
            "token_hint": mask_token(token) if token else "",
            "language": self.lang(),
            "notify_open": c.get("notify_open", True) is not False,
            "notify_close": c.get("notify_close", True) is not False,
            "chats": self.chats(),
            "username": str(self._me.get("username") or c.get("username") or ""),
            # "running" means actually polling: the task is alive AND the bot is
            # enabled. A disabled bot keeps an idle task, which is not "on".
            "running": bool(self._task and not self._task.done()) and self.enabled(),
            "last_error": self._last_error,
            "pair_active": bool(self._pair_code and time.time() < self._pair_until),
            "version": get_version(),
        }

    def make_pair_code(self) -> dict[str, Any]:
        self._pair_code = f"{secrets.randbelow(1_000_000):06d}"
        self._pair_until = time.time() + PAIR_TTL
        return {"ok": True, "code": self._pair_code, "ttl": PAIR_TTL}

    def _save(self, patch: dict[str, Any]) -> dict[str, Any]:
        current = self._cfg()
        current.update(patch)
        merge({"telegram": current})
        return current

    def apply(self, body: dict[str, Any] | None = None) -> dict[str, Any]:
        body = dict(body or {})
        current = self._cfg()
        token_in = str(body.get("bot_token") if "bot_token" in body else current.get("bot_token") or "").strip()
        if is_masked_token(token_in):
            token_in = str(current.get("bot_token") or "").strip()
        # Source-provisioned tokens are read-only: the desk cannot swap the bot.
        if secret.source_token():
            token_in = str(current.get("bot_token") or "").strip()
        lang = str(body.get("language") if "language" in body else current.get("language") or "fa").lower()
        if lang not in TXT:
            lang = "fa"
        chats = current.get("chats") or current.get("chat_ids") or []
        if "chats" in body:
            chats = body.get("chats")
        enabled = bool(body.get("enabled") if "enabled" in body else current.get("enabled"))
        patch = {
            "enabled": enabled,
            "bot_token": token_in,
            "language": lang,
            "notify_open": bool(body.get("notify_open") if "notify_open" in body else current.get("notify_open", True)),
            "notify_close": bool(body.get("notify_close") if "notify_close" in body else current.get("notify_close", True)),
            "chats": _norm_chats(chats),
        }
        self._save(patch)
        self._last_error = ""
        try:
            loop = asyncio.get_running_loop()
            loop.create_task(self.restart())
        except RuntimeError:
            pass
        return {"ok": True, "telegram": self.public()}

    def set_enabled(self, value: bool) -> dict[str, Any]:
        """Persist the on/off flag WITHOUT scheduling a restart.

        ``apply()`` fires its own restart task; the admin panel drives the
        lifecycle explicitly, so it needs a save that does not race with it.
        """
        self._save({"enabled": bool(value)})
        return self._cfg()

    def unlink(self, chat_id: int) -> dict[str, Any]:
        try:
            cid = int(chat_id)
        except (TypeError, ValueError):
            return {"ok": False, "error": "chat"}
        chats = [c for c in self.chats() if int(c["id"]) != cid]
        self._save({"chats": chats})
        return {"ok": True, "telegram": self.public()}

    async def start(self, auto_enable: bool = False) -> None:
        self._stop = asyncio.Event()
        # "Always on" is a boot-time rule only: a source-provisioned token means
        # the bot re-arms itself whenever the engine starts.  An admin who
        # stopped it on purpose must stay stopped, so restart() never re-enables.
        if auto_enable and self.source_token_set() and not self._cfg().get("enabled"):
            self._save({"enabled": True})
        if self._task and not self._task.done():
            return
        self._started_at = time.time()
        self._task = asyncio.create_task(self._run(), name="aurion-telegram")

    async def stop(self) -> None:
        self._stop.set()
        self._started_at = 0.0
        task = self._task
        self._task = None
        if task:
            task.cancel()
            try:
                await task
            except (asyncio.CancelledError, Exception):
                pass
        client = self._client
        self._client = None
        if client is not None:
            try:
                await client.aclose()
            except Exception:
                pass

    async def restart(self) -> None:
        await self.stop()
        self._stop = asyncio.Event()
        await self.start()

    async def _client_of(self) -> Any:
        if self._client is None:
            import httpx

            self._client = httpx.AsyncClient(timeout=httpx.Timeout(40.0, connect=10.0), trust_env=True)
        return self._client

    async def _call(self, method: str, payload: dict[str, Any] | None = None, token: str | None = None) -> dict[str, Any]:
        tok = token if token is not None else self.token()
        if not tok or is_masked_token(tok):
            return {"ok": False, "error": "no_token"}
        client = await self._client_of()
        url = f"{TG_API}/bot{tok}/{method}"
        try:
            res = await client.post(url, json=payload or {})
            data = res.json()
            if not isinstance(data, dict):
                return {"ok": False, "error": "bad_response"}
            return data
        except Exception as exc:
            self._last_error = str(exc)
            log.warning("telegram %s failed: %s", method, exc)
            return {"ok": False, "error": str(exc)}

    async def _run(self) -> None:
        while not self._stop.is_set():
            if not self.enabled():
                try:
                    await asyncio.wait_for(self._stop.wait(), timeout=3.0)
                except asyncio.TimeoutError:
                    continue
                continue
            try:
                await self._call("deleteWebhook", {"drop_pending_updates": False})
                me = await self._call("getMe")
                if me.get("ok") and isinstance(me.get("result"), dict):
                    self._me = me["result"]
                    self._last_error = ""
                    username = str(self._me.get("username") or "")
                    if username and self._cfg().get("username") != username:
                        self._save({"username": username})
                else:
                    self._last_error = str(me.get("description") or me.get("error") or "telegram")
                    await asyncio.sleep(8)
                    continue
                data = await self._call(
                    "getUpdates",
                    {"offset": self._offset, "timeout": POLL_TIMEOUT, "allowed_updates": ["message", "callback_query"]},
                )
                if not data.get("ok"):
                    self._last_error = str(data.get("description") or data.get("error") or "getUpdates")
                    await asyncio.sleep(4)
                    continue
                for upd in data.get("result") or []:
                    if not isinstance(upd, dict):
                        continue
                    uid = int(upd.get("update_id") or 0)
                    if uid:
                        self._offset = uid + 1
                    try:
                        await self._on_update(upd)
                    except Exception:
                        log.exception("telegram update failed")
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                self._last_error = str(exc)
                log.warning("telegram loop: %s", exc)
                await asyncio.sleep(5)

    def _authorized(self, chat_id: int) -> bool:
        return int(chat_id) in self.chat_ids()

    def _try_pair(self, chat_id: int, text: str, from_user: dict[str, Any] | None) -> bool:
        if not self._pair_code or time.time() > self._pair_until:
            return False
        blob = str(text or "")
        if self._pair_code not in blob:
            return False
        name = ""
        username = ""
        if isinstance(from_user, dict):
            name = str(from_user.get("first_name") or from_user.get("last_name") or "")
            username = str(from_user.get("username") or "")
        chats = self.chats()
        if not any(int(c["id"]) == int(chat_id) for c in chats):
            chats.append({"id": int(chat_id), "name": name, "username": username})
            self._save({"chats": chats})
        self._pair_code = ""
        self._pair_until = 0.0
        return True

    def _desk_keyboard(self) -> dict[str, Any]:
        """Modern keyboard with status colors 🟢/🔴 for each setting."""
        lang = self.lang()
        snap = self._snap()
        st = snap.get("strategy") if isinstance(snap.get("strategy"), dict) else {}
        version = snap.get("version") or get_version()

        auto = bool(st.get("auto_trade") or snap.get("auto_trade"))
        kill = bool(snap.get("kill_switch"))
        prop_enabled = st.get("prop_enabled")
        if prop_enabled is None:
            prop_enabled = snap.get("prop", {}).get("enabled", True) if isinstance(snap.get("prop"), dict) else True
        news_locked = bool(st.get("news_trade_locked"))
        news_on = bool(st.get("news_trade")) if not news_locked else False
        ai_gate = bool(st.get("require_ai_agree", True))
        trade_style = str(st.get("trade_style") or snap.get("trade_style") or "normal")
        vol_mode = str(st.get("volume_mode") or "auto")

        # Build buttons with status + color
        auto_btn = f"{'🟢' if auto else '🔴'} {t(lang, 'btn_auto')}: {'ON' if auto else 'OFF'}"
        kill_btn = f"{'🔴' if kill else '🟢'} {t(lang, 'btn_kill')}: {'ARMED' if kill else 'OFF'}"
        prop_btn = f"{'🟢' if prop_enabled else '🔴'} {t(lang, 'btn_prop')}: {'ON' if prop_enabled else 'OFF'}"
        if news_locked:
            news_btn = f"🔒 {t(lang, 'btn_news')}: LOCKED"
        else:
            news_btn = f"{'🟢' if news_on else '🔴'} {t(lang, 'btn_news')}: {'ON' if news_on else 'OFF'}"
        ai_btn = f"{'🟢' if ai_gate else '🔴'} {t(lang, 'btn_ai_gate')}: {'ON' if ai_gate else 'OFF'}"
        style_btn = f"{'🟡' if trade_style=='scalping' else '🟢'} {t(lang, 'btn_style')}: {trade_style.upper()}"
        vol_btn = f"📦 {t(lang, 'btn_vol')}: {vol_mode.upper()}"

        # Strategies with status
        items = st.get("items") or []
        strat_buttons = []
        for it in items[:8]:  # max 8
            if not isinstance(it, dict):
                continue
            name = str(it.get("name") or "")
            if not name:
                continue
            enabled = bool(it.get("enabled"))
            emoji = "🟢" if enabled else "⚪"
            short_name = name[:14]
            strat_buttons.append({"text": f"{emoji} {short_name}: {'ON' if enabled else 'OFF'}", "callback_data": f"strat:{name}:toggle"})

        # Group strat buttons into rows of 2
        strat_rows = []
        for i in range(0, len(strat_buttons), 2):
            strat_rows.append(strat_buttons[i:i+2])

        keyboard = [
            [{"text": auto_btn, "callback_data": "auto:toggle"}, {"text": kill_btn, "callback_data": "kill:toggle"}],
            [{"text": prop_btn, "callback_data": "prop:toggle"}, {"text": news_btn, "callback_data": "news:toggle"}],
            [{"text": ai_btn, "callback_data": "ai_gate:toggle"}, {"text": style_btn, "callback_data": "style:toggle"}],
            [{"text": vol_btn, "callback_data": "vol:toggle"}],
        ]
        keyboard.extend(strat_rows)
        keyboard.extend([
            [{"text": t(lang, "btn_status"), "callback_data": "status"}, {"text": t(lang, "btn_positions"), "callback_data": "positions"}],
            [{"text": t(lang, "btn_ai"), "callback_data": "ai"}, {"text": t(lang, "btn_settings"), "callback_data": "settings"}],
            [{"text": f"{t(lang, 'btn_about')} v{version}", "callback_data": "about"}],
        ])

        return {"inline_keyboard": keyboard}

    def _apply_desk(self, action: str, arg: str = "") -> str:
        trader = self.trader
        if trader is None:
            return t(self.lang(), "readonly")
        act = str(action or "").lower()
        val = str(arg or "").lower()
        snap = self._snap()
        st = snap.get("strategy") if isinstance(snap.get("strategy"), dict) else {}
        try:
            if act == "auto":
                if val == "toggle":
                    current = bool(st.get("auto_trade") or snap.get("auto_trade"))
                    on = not current
                else:
                    on = val in {"on", "1", "true", "yes"}
                trader.set_auto({"enabled": on})
                return t(self.lang(), "auto_on" if on else "auto_off")
            if act == "kill":
                if val == "toggle":
                    current = bool(snap.get("kill_switch"))
                    on = not current
                else:
                    on = val in {"on", "1", "true", "yes", "arm"}
                trader.set_kill(on)
                return t(self.lang(), "kill_on" if on else "kill_off")
            if act == "prop":
                if val == "toggle":
                    current = st.get("prop_enabled")
                    if current is None:
                        current = snap.get("prop", {}).get("enabled", True) if isinstance(snap.get("prop"), dict) else True
                    on = not bool(current)
                else:
                    on = val in {"on", "1", "true", "yes"}
                trader.set_auto({"prop_enabled": on})
                return t(self.lang(), "prop_on" if on else "prop_off")
            if act == "news":
                if val == "toggle":
                    current = bool(st.get("news_trade"))
                    on = not current
                else:
                    on = val in {"on", "1", "true", "yes"}
                if st.get("news_trade_locked"):
                    return "🔒 Prop locks news trading"
                trader.set_auto({"news_trade": on})
                return t(self.lang(), "news_on" if on else "news_off")
            if act == "ai_gate":
                if val == "toggle":
                    current = bool(st.get("require_ai_agree", True))
                    on = not current
                else:
                    on = val in {"on", "1", "true", "yes"}
                trader.set_auto({"require_ai_agree": on})
                return t(self.lang(), "ai_gate_on" if on else "ai_gate_off")
            if act == "style":
                if val == "toggle":
                    current = str(st.get("trade_style") or snap.get("trade_style") or "normal")
                    style = "normal" if current == "scalping" else "scalping"
                else:
                    style = "scalping" if "scalp" in val else "normal"
                trader.set_auto({"trade_style": style})
                return f"🎨 Style: {style}"
            if act == "vol":
                if val == "toggle":
                    current = str(st.get("volume_mode") or "auto")
                    mode = "manual" if current == "auto" else "auto"
                else:
                    mode = "manual" if "manual" in val else "auto"
                trader.set_auto({"volume_mode": mode})
                return f"📦 Volume: {mode}"
            if act == "strat" and val:
                # format: name:toggle or name:on/off
                parts = val.split(":")
                name = parts[0]
                if len(parts) > 1 and parts[1] == "toggle":
                    # find current
                    items = st.get("items") or []
                    current = False
                    for it in items:
                        if isinstance(it, dict) and str(it.get("name")) == name:
                            current = bool(it.get("enabled"))
                            break
                    on = not current
                else:
                    on = True if len(parts) < 2 else parts[1] in {"on", "1", "true", "yes"}
                try:
                    loop = asyncio.get_running_loop()
                    loop.create_task(trader.toggle_strategy(name, on))
                except RuntimeError:
                    pass
                return f"{'🟢' if on else '⚪'} {name}: {'ON' if on else 'OFF'}"
            if act == "strategy" and val:
                parts = val.split()
                name = parts[0]
                on = True if len(parts) < 2 else parts[1] in {"on", "1", "true", "yes"}
                try:
                    loop = asyncio.get_running_loop()
                    loop.create_task(trader.toggle_strategy(name, on))
                except RuntimeError:
                    pass
                return f"{name} {'on' if on else 'off'}"
        except Exception as exc:
            return f"❌ {exc}"
        return t(self.lang(), "done")

    def _ai_text(self) -> str:
        snap = self._snap()
        ai = snap.get("ai") if isinstance(snap.get("ai"), dict) else {}
        outlook = ai.get("outlook") if isinstance(ai.get("outlook"), dict) else {}
        lang = self.lang()
        version = snap.get("version") or get_version()
        lines = [f"🧠 {t(lang, 'ai_title')} v{version}", "━━━━━━━━━━━━━━━"]
        if outlook.get("text"):
            lines.append(str(outlook["text"]))
        else:
            lines.append(str(ai.get("display_direction") or ai.get("direction") or "neutral"))
        if ai.get("reason"):
            lines.append(str(ai.get("reason")))
        conf = ai.get("confidence")
        if conf is not None:
            try:
                lines.append(f"Confidence: {float(conf)*100:.1f}%")
            except Exception:
                pass
        st = snap.get("strategy") if isinstance(snap.get("strategy"), dict) else {}
        lines.append(f"AI Gate: {'🟢 ON' if st.get('require_ai_agree', True) else '🔴 OFF'}")
        lines.append(f"Min Conf: {st.get('min_ai_confidence', 0.55)}")
        tape = str(snap.get("tape") or "idle")
        lines.append(t(lang, "tape_tester" if tape == "tester" else ("tape_live" if tape == "live" else "tape_idle")))
        return "\n".join(lines)

    def _desk_text(self) -> str:
        snap = self._snap()
        lang = self.lang()
        st = snap.get("strategy") if isinstance(snap.get("strategy"), dict) else {}
        version = snap.get("version") or get_version()
        lines = [
            f"🎛️ {t(lang, 'settings_title')} v{version}",
            "━━━━━━━━━━━━━━━",
            t(lang, "auto_on") if st.get("auto_trade") or snap.get("auto_trade") else t(lang, "auto_off"),
            t(lang, "kill_on") if snap.get("kill_switch") else t(lang, "kill_off"),
            f"🛡️ Prop: {'🟢 ON' if st.get('prop_enabled', True) else '🔴 OFF'}",
            f"📰 News: {'🔒 LOCKED' if st.get('news_trade_locked') else ('🟢 ON' if st.get('news_trade') else '🔴 OFF')}",
            f"🧠 AI Gate: {'🟢 ON' if st.get('require_ai_agree', True) else '🔴 OFF'}",
            f"🎨 Style: {st.get('trade_style') or snap.get('trade_style') or 'normal'}",
            f"📦 Volume: {st.get('volume_mode') or 'auto'} {st.get('manual_volume') or ''}",
            t(lang, "tape_tester" if snap.get("tape") == "tester" else ("tape_live" if snap.get("tape") == "live" else "tape_idle")),
        ]
        enabled = [it.get("name") for it in (st.get("items") or []) if isinstance(it, dict) and it.get("enabled")]
        if enabled:
            lines.append(f"✅ Active: {', '.join(str(x) for x in enabled)}")
        all_strats = [it for it in (st.get("items") or []) if isinstance(it, dict)]
        if all_strats:
            lines.append("")
            lines.append("📊 Strategies:")
            for it in all_strats:
                name = it.get("name") or ""
                en = bool(it.get("enabled"))
                lines.append(f"{'🟢' if en else '⚪'} {name}: {'ON' if en else 'OFF'}")
        lines.append("")
        lines.append(f"🔖 {t(lang, 'version')}: v{version}")
        return "\n".join(lines)

    def _about_text(self) -> str:
        snap = self._snap()
        lang = self.lang()
        version = snap.get("version") or get_version()
        cfg = load()
        build_date = ""
        try:
            build_date = str((ROOT / "config" / "aurion.json").stat().st_mtime)
        except Exception:
            pass
        lines = [
            f"🚀 AURION v{version}",
            "━━━━━━━━━━━━━━━",
            t(lang, "about_text"),
            "",
            f"🔖 {t(lang, 'version')}: v{version}",
            f"🏢 By Axiasoft",
            f"📅 Build: {build_date[:10] if build_date else '—'}",
            f"⚙️ Engine: {'🟢 Online' if snap.get('engine') else '🔴 Offline'}",
            f"🔗 MT5: {'🟢 Connected' if snap.get('mt5', {}).get('connected') or snap.get('agents') else '🔴 Disconnected'}",
            f"📊 EA Charts: {len(snap.get('agents') or [])}",
            f"🤖 Auto: {'🟢 ON' if (snap.get('strategy') or {}).get('auto_trade') else '🔴 OFF'}",
            "",
            "💡 Features:",
            "• Live MT5 Trading",
            "• AI Intelligence",
            "• Prop Guard",
            "• Custom Strategies",
            "• Telegram Control",
            "• Auto Update",
        ]
        return "\n".join(lines)

    async def _on_callback(self, cb: dict[str, Any]) -> None:
        chat = ((cb.get("message") or {}).get("chat") or {})
        try:
            chat_id = int(chat.get("id") or (cb.get("from") or {}).get("id") or 0)
        except (TypeError, ValueError):
            return
        if not chat_id or not self._authorized(chat_id):
            return
        data = str(cb.get("data") or "")
        cid = str(cb.get("id") or "")
        if cid:
            await self._call("answerCallbackQuery", {"callback_query_id": cid, "text": "⏳"})
        if data in {"status"}:
            await self.send(chat_id, self._status_text(), self._desk_keyboard())
            return
        if data in {"positions"}:
            await self.send(chat_id, self._positions_text(), self._desk_keyboard())
            return
        if data in {"ai"}:
            await self.send(chat_id, self._ai_text(), self._desk_keyboard())
            return
        if data in {"settings", "desk"}:
            await self.send(chat_id, self._desk_text(), self._desk_keyboard())
            return
        if data in {"about"}:
            await self.send(chat_id, self._about_text(), self._desk_keyboard())
            return
        if ":" in data:
            parts = data.split(":", 1)
            act = parts[0]
            arg = parts[1] if len(parts) > 1 else ""
            note = self._apply_desk(act, arg)
            # Small delay to let trader update
            await asyncio.sleep(0.5)
            # Send updated settings with new keyboard showing new colors
            await self.send(chat_id, f"{note}\n\n{self._desk_text()}", self._desk_keyboard())
            return
        await self.send(chat_id, self._desk_text(), self._desk_keyboard())

    async def _on_update(self, upd: dict[str, Any]) -> None:
        if isinstance(upd.get("callback_query"), dict):
            await self._on_callback(upd["callback_query"])
            return
        msg = upd.get("message") or upd.get("edited_message") or {}
        if not isinstance(msg, dict):
            return
        chat = msg.get("chat") or {}
        try:
            chat_id = int((chat or {}).get("id") or 0)
        except (TypeError, ValueError):
            return
        if not chat_id:
            return
        text = str(msg.get("text") or "").strip()
        if not text:
            return
        from_user = msg.get("from") if isinstance(msg.get("from"), dict) else {}
        if self._try_pair(chat_id, text, from_user):
            await self.send(chat_id, t(self.lang(), "paired") + "\n\n" + t(self.lang(), "help"), self._desk_keyboard())
            return
        if not self._authorized(chat_id):
            await self.send(chat_id, t(self.lang(), "denied"))
            return
        parts = text.split()
        cmd = parts[0].lower().split("@", 1)[0]
        arg = " ".join(parts[1:]).strip()
        if cmd in {"/start", "/help"}:
            await self.send(chat_id, t(self.lang(), "help") + "\n\n" + self._status_text(), self._desk_keyboard())
            return
        if cmd in {"/status", "/vaziat", "وضعیت", "/state"}:
            await self.send(chat_id, self._status_text(), self._desk_keyboard())
            return
        if cmd in {"/positions", "/pos", "/open", "پوزیشن"}:
            await self.send(chat_id, self._positions_text(), self._desk_keyboard())
            return
        if cmd in {"/ai", "/outlook", "هوش"}:
            await self.send(chat_id, self._ai_text(), self._desk_keyboard())
            return
        if cmd in {"/settings", "/desk", "تنظیمات"}:
            await self.send(chat_id, self._desk_text(), self._desk_keyboard())
            return
        if cmd in {"/about", "/version", "درباره", "نسخه"}:
            await self.send(chat_id, self._about_text(), self._desk_keyboard())
            return
        if cmd in {"/auto"}:
            note = self._apply_desk("auto", arg or "toggle")
            await asyncio.sleep(0.3)
            await self.send(chat_id, note + "\n\n" + self._desk_text(), self._desk_keyboard())
            return
        if cmd in {"/kill"}:
            note = self._apply_desk("kill", arg or "toggle")
            await asyncio.sleep(0.3)
            await self.send(chat_id, note + "\n\n" + self._desk_text(), self._desk_keyboard())
            return
        if cmd in {"/style"}:
            note = self._apply_desk("style", arg or "toggle")
            await asyncio.sleep(0.3)
            await self.send(chat_id, note + "\n\n" + self._desk_text(), self._desk_keyboard())
            return
        if cmd in {"/strategy", "/strat"}:
            note = self._apply_desk("strategy", arg)
            await asyncio.sleep(0.3)
            await self.send(chat_id, note + "\n\n" + self._desk_text(), self._desk_keyboard())
            return
        await self.send(chat_id, t(self.lang(), "readonly"), self._desk_keyboard())

    def _snap(self) -> dict[str, Any]:
        if self.trader and hasattr(self.trader, "snapshot"):
            try:
                snap = self.trader.snapshot() or {}
                # inject version
                snap["version"] = snap.get("version") or get_version()
                return snap
            except Exception:
                return {"version": get_version()}
        return {"version": get_version()}

    def _currency(self, snap: dict[str, Any] | None = None) -> str:
        snap = snap if snap is not None else self._snap()
        mt = snap.get("mt5") or {}
        acc = mt.get("account") if isinstance(mt.get("account"), dict) else {}
        return str(acc.get("currency") or "")

    def _status_text(self) -> str:
        return format_status(self._snap(), self.lang())

    def _positions_text(self) -> str:
        snap = self._snap()
        lang = self.lang()
        positions = snap.get("positions") or []
        if not positions:
            return t(lang, "no_pos") + f"\n\n🔖 v{snap.get('version') or get_version()}"
        currency = self._currency(snap)
        lines = [f"📊 {t(lang, 'open_n')}: {len(positions)} v{snap.get('version') or get_version()}", ""]
        lines.extend(_pos_lines(positions, lang, currency))
        return "\n".join(lines)

    async def send(self, chat_id: int, text: str, keyboard: dict[str, Any] | None = None) -> dict[str, Any]:
        if not text:
            return {"ok": False, "error": "empty"}
        payload: dict[str, Any] = {"chat_id": int(chat_id), "text": text[:3900], "disable_web_page_preview": True}
        if keyboard:
            payload["reply_markup"] = keyboard
        return await self._call("sendMessage", payload)

    async def broadcast(self, text: str) -> None:
        if not self.enabled() or not text:
            return
        for chat in self.chats():
            try:
                await self.send(int(chat["id"]), text)
            except Exception:
                log.exception("telegram broadcast failed")

    async def notify_open(self, pos: dict[str, Any] | None) -> None:
        c = self._cfg()
        if not self.enabled() or c.get("notify_open", True) is False:
            return
        await self.broadcast(format_open(pos, self.lang(), self._currency()))

    async def notify_close(self, pos: dict[str, Any] | None) -> None:
        c = self._cfg()
        if not self.enabled() or c.get("notify_close", True) is False:
            return
        await self.broadcast(format_close(pos, self.lang(), self._currency()))

    async def send_test(self) -> dict[str, Any]:
        if not self.enabled():
            return {"ok": False, "error": "disabled"}
        if not self.chats():
            return {"ok": False, "error": "no_chat"}
        await self.broadcast(self._status_text())
        return {"ok": True, "telegram": self.public()}
