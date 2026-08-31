# =============================================================================
# AURION strategy template
# EN: Define entry / exit / filters / sizing. The engine hot-reloads this file.
# FA: منطق ورود، خروج، فیلتر و حجم را اینجا بنویسید. موتور فایل را زنده بارگذاری می‌کند.
# AR: عرّف الدخول والخروج والمرشحات والحجم. يعيد المحرك تحميل هذا الملف فوراً.
# =============================================================================
# Allowed imports: math, statistics, datetime, collections, typing, json
# Plus AURION helpers already imported below.
# Forbidden: os, sys, subprocess, socket, network, eval, exec, file deletion.
# =============================================================================

from aurion.strategy.base import BaseStrategy, StrategyContext, StrategySignal


class MyStrategy(BaseStrategy):
    # EN: Unique name shown in the desk.
    # FA: نام یکتایی که در میز دیده می‌شود.
    # AR: الاسم الفريد الذي يظهر في المكتب.
    name = "my_strategy"
    version = "1.0.0"
    language = "en"  # en | fa | ar

    params = {
        "volume": 0.10,  # EN lot size / FA حجم لات / AR حجم اللوت
        "sl_points": 0.0,
        "tp_points": 0.0,
    }

    def on_start(self, ctx: StrategyContext) -> None:
        return None

    def on_stop(self, ctx: StrategyContext) -> None:
        return None

    def on_tick(self, ctx: StrategyContext) -> StrategySignal | None:
        # EN: Called on every live tick. Return None to stand aside.
        # FA: با هر تیک زنده صدا زده می‌شود. برای بی‌عملی None برگردانید.
        # AR: يُستدعى مع كل تيك حي. أرجع None للوقوف جانباً.
        return None

    def on_candle(self, ctx: StrategyContext) -> StrategySignal | None:
        # EN: Called when a real MT5 candle closes.
        # FA: هنگام بسته شدن کندل واقعی متاتریدر فراخوانی می‌شود.
        # AR: يُستدعى عند إغلاق شمعة ميتاتريدر حقيقية.
        if not ctx.candles:
            return None
        last = ctx.candles[-1]
        pos = ctx.position()
        ai = ctx.ai or {}

        # Example skeleton — replace with your logic. It only fires if YOU uncomment.
        # مثال — منطق خود را جایگزین کنید.
        # مثال — استبدل بمنطقك.
        _ = last, pos, ai
        return None

        # return StrategySignal(
        #     action="buy",          # buy | sell | close | close_all | modify | hold
        #     symbol=ctx.symbol,
        #     volume=float(self.params["volume"]),
        #     sl=0.0,
        #     tp=0.0,
        #     reason="describe why this live bar qualifies",
        #     comment="AURION my_strategy",
        # )
