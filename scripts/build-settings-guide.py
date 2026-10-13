#!/usr/bin/env python3
"""Generate the settings reference inside the AURION guide.

Written as a generator rather than typed into the HTML for one reason:
every default in the guide is read out of config/aurion.factory.json at
build time. A hand-written reference starts correct and drifts the first
time somebody changes a default, and a guide that confidently states the
wrong default is worse than one that says nothing - the reader has no way
to know which half to trust.

Run it after changing a default:

    python3 scripts/build-settings-guide.py

It rewrites the marked block in apps/web/guide.html and the root copy,
and leaves everything else alone.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CONFIG = ROOT / "config" / "aurion.factory.json"
TARGETS = [ROOT / "apps" / "web" / "guide.html", ROOT / "AURION-GUIDE.html"]

START = "<!-- settings-reference:start -->"
END = "<!-- settings-reference:end -->"


def esc(text: str) -> str:
    return (str(text).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))


def load() -> dict:
    return json.loads(CONFIG.read_text(encoding="utf-8"))


def dig(cfg: dict, path: str):
    node = cfg
    for part in path.split("."):
        if not isinstance(node, dict) or part not in node:
            return None
        node = node[part]
    return node


def shown(value) -> str:
    """A default, as the reader will see it in the file."""
    if value is None:
        return "—"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (list, dict)):
        return esc(json.dumps(value, ensure_ascii=False))
    if value == "":
        return "<i>(empty)</i>"
    return esc(json.dumps(value, ensure_ascii=False))


# ---------------------------------------------------------------------------
# The reference itself.
#
# Each row: config path, then a line per language. The default column is
# never written here - it comes from the file.
# ---------------------------------------------------------------------------

GROUPS: list[dict] = [
    {
        "id": "trading",
        "title": {
            "fa": "الف. معامله — چه چیزی باز می‌شود و کِی",
            "en": "A. Trading — what opens, and when",
            "ar": "أ. التداول — ماذا يُفتح ومتى",
        },
        "lede": {
            "fa": "این گروه تعیین می‌کند ربات اجازهٔ معامله دارد یا نه، و با چه سخت‌گیری‌ای. اگر فقط یک بخش را می‌خوانید، همین است.",
            "en": "This group decides whether the robot may trade at all, and how strict it is. If you read one group, read this one.",
            "ar": "تحدد هذه المجموعة ما إذا كان الروبوت مسموحًا له بالتداول، وبأي صرامة.",
        },
        "rows": [
            ("runtime.auto_trade", {
                "fa": "کلید اصلی ربات. تا وقتی <code>false</code> است هیچ سفارشی از طرف استراتژی‌ها نمی‌رود — تحلیل و سیگنال ادامه دارد، فقط اجرا قطع است. <b>مثال:</b> برای یک هفته رصد بدون ریسک، این را خاموش بگذارید و لاگ ربات را بخوانید.",
                "en": "The master switch. While <code>false</code> no strategy order is ever sent — analysis and signals carry on, only execution stops. <b>Example:</b> to watch for a week with no risk, leave this off and read the robot log.",
                "ar": "المفتاح الرئيسي. عند <code>false</code> لا يُرسل أي أمر — التحليل مستمر والتنفيذ متوقف فقط.",
            }),
            ("runtime.trade_style", {
                "fa": "<code>normal</code> یا <code>scalping</code>. نرمال روی کندل بسته تصمیم می‌گیرد؛ اسکلپ تهاجمی‌تر و روی تایم‌فریم پایین‌تر است. <b>مثال:</b> روی حساب پراپ با محدودیت ضرر روزانه، <code>normal</code> بمانید — اسکلپ تعداد معامله و در نتیجه تعداد فرصت نقض قانون را بالا می‌برد.",
                "en": "<code>normal</code> or <code>scalping</code>. Normal decides on the closed candle; scalping is more aggressive and works lower. <b>Example:</b> on a prop account with a daily-loss rule, stay on <code>normal</code> — scalping multiplies the number of trades and therefore the number of chances to break a rule.",
                "ar": "<code>normal</code> أو <code>scalping</code>. العادي يقرر عند إغلاق الشمعة؛ السكالب أكثر عدوانية.",
            }),
            ("runtime.require_ai_agree", {
                "fa": "اگر روشن باشد، سیگنال استراتژی فقط وقتی اجرا می‌شود که هوش مصنوعی هم‌جهت باشد. این یک <b>فیلتر</b> است، نه یک تولیدکنندهٔ سیگنال. <b>مثال:</b> استراتژی خرید می‌دهد، هوش «نزولی» می‌گوید → سفارش نمی‌رود و در لاگ با دلیل ثبت می‌شود.",
                "en": "When on, a strategy signal only executes if the AI agrees with its direction. It is a <b>filter</b>, never a source of signals. <b>Example:</b> the strategy says buy, the AI says down → no order, and the log says why.",
                "ar": "عند التفعيل، تُنفَّذ إشارة الاستراتيجية فقط إذا وافق الذكاء الاصطناعي على اتجاهها.",
            }),
            ("runtime.min_ai_confidence", {
                "fa": "کف اطمینان هوش برای عبور از آن فیلتر، بین ۰ و ۱. <b>مثال:</b> <code>0.55</code> یعنی «۵۵٪ مطمئن یا بیشتر». بردنش به <code>0.75</code> تعداد معاملات را به‌شدت کم می‌کند؛ زیر <code>0.5</code> عملاً فیلتر را خاموش می‌کند.",
                "en": "The confidence floor for that filter, 0 to 1. <b>Example:</b> <code>0.55</code> means \"55% sure or better\". Raising it to <code>0.75</code> cuts the trade count sharply; below <code>0.5</code> the filter is off in all but name.",
                "ar": "الحد الأدنى للثقة، بين ٠ و١. رفعه إلى <code>0.75</code> يقلل عدد الصفقات بشدة.",
            }),
            ("runtime.min_signal_quality", {
                "fa": "کیفیت خود سیگنال استراتژی (جدا از هوش). سیگنال ضعیف‌تر از این حذف می‌شود. <b>مثال:</b> در بازار بدون روند، بالا بردن این عدد جلوی ورودهای بی‌کیفیت را می‌گیرد.",
                "en": "The quality of the strategy's own signal, separate from the AI. Anything weaker is dropped. <b>Example:</b> in a rangebound market, raising this is what stops low-grade entries.",
                "ar": "جودة إشارة الاستراتيجية نفسها، منفصلة عن الذكاء الاصطناعي.",
            }),
            ("runtime.smart_filters", {
                "fa": "فیلترهای داخلی (اسپرد غیرعادی، ساعات کم‌نقدینگی، شرایط نامناسب). خاموش کردنش فقط برای تست است.",
                "en": "The built-in filters: abnormal spread, thin hours, unsuitable conditions. Turning it off is for testing, not for trading.",
                "ar": "المرشحات المدمجة: السبريد غير الطبيعي والساعات الضعيفة.",
            }),
            ("runtime.min_open_trades", {
                "fa": "کمینهٔ پوزیشن باز که ربات تلاش می‌کند حفظ کند.",
                "en": "The floor on open positions the robot tries to maintain.",
                "ar": "الحد الأدنى للصفقات المفتوحة.",
            }),
            ("runtime.max_open_trades", {
                "fa": "سقف پوزیشن هم‌زمان. <b>مهم‌ترین عدد برای کنترل ریسک کل.</b> <b>مثال:</b> با حجم ۰٫۱ و سقف ۲، حداکثر ۰٫۲ لات در بازار دارید — نه بیشتر، فارغ از اینکه چند سیگنال بیاید.",
                "en": "The ceiling on simultaneous positions. <b>The single most important number for total risk.</b> <b>Example:</b> at 0.10 lots with a ceiling of 2 you can have 0.20 in the market and no more, however many signals arrive.",
                "ar": "سقف الصفقات المتزامنة. أهم رقم للتحكم في المخاطر الكلية.",
            }),
        ],
    },
    {
        "id": "protect",
        "title": {
            "fa": "ب. محافظت از معاملهٔ باز",
            "en": "B. Protecting an open trade",
            "ar": "ب. حماية الصفقة المفتوحة",
        },
        "lede": {
            "fa": "این‌ها بعد از باز شدن پوزیشن کار می‌کنند. هیچ‌کدام سفارش جدید باز نمی‌کنند.",
            "en": "These act after a position exists. None of them opens anything.",
            "ar": "تعمل هذه بعد فتح الصفقة. لا يفتح أي منها صفقة جديدة.",
        },
        "rows": [
            ("runtime.risk_free.enabled", {
                "fa": "«ریسک‌فری». وقتی معامله به اندازهٔ کافی در سود رفت، حد ضرر را به آن‌طرف نقطهٔ ورود می‌برد تا دیگر نتواند ضرر بدهد. روی <b>هر</b> پوزیشن اعمال می‌شود، چه ربات بازش کرده باشد چه شما دستی.",
                "en": "\"Risk free\". Once a trade is far enough ahead, the stop moves past the entry so the position can no longer lose. It applies to <b>every</b> position, whether the robot opened it or you did.",
                "ar": "«بدون مخاطرة». عند تحقيق ربح كافٍ، يُنقل وقف الخسارة خلف نقطة الدخول.",
            }),
            ("runtime.risk_free.trigger_pct", {
                "fa": "چقدر سود لازم است تا این حرکت مسلح شود — بر حسب <b>درصد قیمت ورود</b>، نه پوینت. یک عدد پوینتی به قیمت نماد وابسته است و با تغییر نماد بی‌معنی می‌شود؛ درصد روی همه یک معنی دارد. <b>مثال:</b> با <code>0.3</code>، ورود خرید در ۲۴۰۰ در ۲۴۰۷٫۲ مسلح می‌شود و ورود خرید در ۱٫۰۸۵۰ در ۱٫۰۸۸۳.",
                "en": "How much profit arms the move, as a <b>percentage of the entry price</b> rather than points. A figure in points depends on what the instrument costs and stops meaning anything the moment you trade something else; a percentage means the same everywhere. <b>Example:</b> at <code>0.3</code>, a long at 2400 arms at 2407.2 and a long at 1.0850 arms at 1.0883.",
                "ar": "مقدار الربح الذي يُفعّل النقل، كنسبة مئوية من سعر الدخول وليس بالنقاط، لأن النقاط تعتمد على سعر الأداة. <b>مثال:</b> عند <code>0.3</code> يُفعَّل شراء عند 2400 في 2407.2.",
            }),
            ("runtime.risk_free.lock_pct", {
                "fa": "حد ضرر چقدر آن‌طرفِ ورود بنشیند. <code>0</code> یعنی خودکار: <b>اسپرد زندهٔ همان لحظه + یک‌دهم تریگر</b>. این مقدار پیش‌فرض عمدی است — حد ضرری که <i>دقیقاً روی</i> قیمت ورود باشد باز هم با ضرر بسته می‌شود، چون برای خروج باید اسپرد رد شود و کمیسیون هم قبلاً گرفته شده.",
                "en": "How far past the entry the stop sits. <code>0</code> means derive it: <b>the live spread plus a tenth of the trigger</b>. That default is deliberate — a stop sitting <i>exactly on</i> the open price still closes at a loss, because the spread has to be crossed to get out and the commission was already charged.",
                "ar": "مسافة الوقف خلف نقطة الدخول. <code>0</code> يعني الاشتقاق من السبريد الحي.",
            }),
            ("runtime.danger_guard.enabled", {
                "fa": "خروج محافظتی خودکار در شرایط خطر. وقتی قوانین پراپ روشن باشد غیرفعال می‌ماند — دو سیستم که هم‌زمان پوزیشن ببندند، نتیجه‌اش غیرقابل‌پیش‌بینی است.",
                "en": "The automatic protective exit. It stays idle while prop rules are on: two systems closing positions at once is not a behaviour anyone can predict.",
                "ar": "الخروج الوقائي التلقائي. يبقى خاملاً عند تفعيل قواعد البروب.",
            }),
            ("runtime.danger_guard.sensitivity", {
                "fa": "۰ تا ۱۰۰. بالاتر = زودتر می‌بندد. <b>مثال:</b> ۸۰ روی یک بازار پرنوسان، پوزیشن‌ها را زود می‌بندد و سودهای بزرگ را از دست می‌دهد؛ ۲۰ تقریباً هیچ‌وقت دخالت نمی‌کند.",
                "en": "0 to 100. Higher closes sooner. <b>Example:</b> 80 on a volatile instrument exits early and gives up the large moves; 20 almost never intervenes.",
                "ar": "من ٠ إلى ١٠٠. الأعلى يغلق أسرع.",
            }),
        ],
    },
    {
        "id": "entry",
        "title": {
            "fa": "ج. ورود خودکار (Auto-entry)",
            "en": "C. Auto-entry",
            "ar": "ج. الدخول التلقائي",
        },
        "lede": {
            "fa": "به‌جای ورود در قیمت لحظه‌ای، سفارش معلق در ناحیهٔ بهتر می‌گذارد.",
            "en": "Instead of entering at market, it places a pending order in a better zone.",
            "ar": "بدلاً من الدخول بسعر السوق، يضع أمرًا معلقًا في منطقة أفضل.",
        },
        "rows": [
            ("runtime.auto_entry.enabled", {
                "fa": "روشن/خاموش.",
                "en": "On or off.",
                "ar": "تشغيل أو إيقاف.",
            }),
            ("runtime.auto_entry.zone_depth", {
                "fa": "چقدر داخل ناحیه منتظر بماند، ۰ تا ۱. <b>مثال:</b> <code>0.5</code> یعنی وسط ناحیه. نزدیک ۱ قیمت بهتری می‌گیرد ولی خیلی از سفارش‌ها اصلاً پر نمی‌شوند.",
                "en": "How deep into the zone to wait, 0 to 1. <b>Example:</b> <code>0.5</code> is the middle. Near 1 gets a better price and leaves many orders unfilled.",
                "ar": "عمق الانتظار داخل المنطقة، من ٠ إلى ١.",
            }),
            ("runtime.auto_entry.offset_atr", {
                "fa": "فاصلهٔ اضافه بر حسب ATR، برای جا دادن به نوسان. <b>مثال:</b> <code>0.35</code> یعنی ۳۵٪ یک ATR عقب‌تر.",
                "en": "Extra distance in ATR, to leave room for noise. <b>Example:</b> <code>0.35</code> is 35% of one ATR further back.",
                "ar": "مسافة إضافية بوحدات ATR.",
            }),
            ("runtime.auto_entry.expiry_minutes", {
                "fa": "بعد از این مدت، سفارش پرنشده لغو می‌شود. <b>مثال:</b> <code>120</code> دو ساعت. صفر یعنی بدون انقضا — که روی سفارش معلق خطرناک است، چون ممکن است فردا در شرایطی کاملاً متفاوت پر شود.",
                "en": "An unfilled order is cancelled after this. <b>Example:</b> <code>120</code> is two hours. Zero means never, which is dangerous on a pending order: it can fill tomorrow into conditions that no longer resemble the ones that justified it.",
                "ar": "يُلغى الأمر غير المنفَّذ بعد هذه المدة.",
            }),
        ],
    },
    {
        "id": "ai",
        "title": {
            "fa": "د. هوش مصنوعی",
            "en": "D. The AI",
            "ar": "د. الذكاء الاصطناعي",
        },
        "lede": {
            "fa": "هوش هرگز به‌تنهایی معامله باز نمی‌کند. فقط سیگنال استراتژی را تأیید یا رد می‌کند.",
            "en": "The AI never opens a trade on its own. It only agrees or disagrees with a strategy's signal.",
            "ar": "لا يفتح الذكاء الاصطناعي صفقة بمفرده أبدًا.",
        },
        "rows": [
            ("ai.enabled", {"fa": "روشن/خاموش کل لایهٔ هوش.", "en": "The whole AI layer, on or off.", "ar": "تشغيل طبقة الذكاء الاصطناعي."}),
            ("ai.min_bars_to_train", {
                "fa": "کمینهٔ کندل لازم برای اولین آموزش. قبل از رسیدن به این عدد، هوش نظری نمی‌دهد. <b>مثال:</b> روی M5 عدد <code>160</code> حدود ۱۳ ساعت دادهٔ بازار است.",
                "en": "The candles needed before the first training. Below it the AI has no opinion. <b>Example:</b> on M5, <code>160</code> is about 13 hours of market.",
                "ar": "الحد الأدنى من الشموع للتدريب الأول.",
            }),
            ("ai.retrain_every_bars", {
                "fa": "هر چند کندل یک‌بار دوباره آموزش ببیند. کمتر = تطبیق سریع‌تر و پرنوسان‌تر.",
                "en": "How often to retrain. Lower adapts faster and is noisier.",
                "ar": "عدد الشموع بين كل تدريب وآخر.",
            }),
            ("ai.online_learning", {"fa": "یادگیری پیوسته از نتیجهٔ معاملات.", "en": "Keep learning from outcomes as they arrive.", "ar": "التعلم المستمر من النتائج."}),
            ("ai.confidence_threshold", {
                "fa": "آستانهٔ داخلی خود مدل (با <code>runtime.min_ai_confidence</code> فرق دارد: آن یکی فیلتر اجراست، این یکی آستانهٔ اعلام نظر مدل).",
                "en": "The model's own threshold. Not the same as <code>runtime.min_ai_confidence</code>: that one filters execution, this one decides when the model speaks at all.",
                "ar": "عتبة النموذج نفسه، وتختلف عن مرشح التنفيذ.",
            }),
        ],
    },
    {
        "id": "exec",
        "title": {
            "fa": "ه. اجرا و ایمنی",
            "en": "E. Execution and safety",
            "ar": "هـ. التنفيذ والأمان",
        },
        "lede": {
            "fa": "این‌ها تعیین می‌کنند سفارش چطور به بروکر می‌رسد و در شرایط غیرعادی چه می‌شود.",
            "en": "How an order reaches the broker, and what happens when things go wrong.",
            "ar": "كيف يصل الأمر إلى الوسيط وماذا يحدث عند الخلل.",
        },
        "rows": [
            ("execution.max_slippage_points", {
                "fa": "بیشترین لغزش قابل‌قبول. اگر قیمت بیش از این حرکت کرده باشد، سفارش رد می‌شود به‌جای اینکه با قیمت بد پر شود.",
                "en": "The most slippage accepted. Beyond it the order is refused rather than filled at a price nobody agreed to.",
                "ar": "أقصى انزلاق مقبول.",
            }),
            ("execution.default_deviation", {"fa": "انحراف پیش‌فرض ارسالی به متاتریدر.", "en": "The deviation sent to MetaTrader.", "ar": "الانحراف المُرسل إلى ميتاتريدر."}),
            ("execution.magic", {
                "fa": "شمارهٔ شناسایی سفارش‌های AURION. <b>دست نزنید</b> مگر دو نسخه را هم‌زمان روی یک حساب اجرا کنید — این عدد است که مشخص می‌کند کدام پوزیشن مال ربات است و کدام مال شما.",
                "en": "The id stamped on AURION's orders. <b>Leave it alone</b> unless you run two copies on one account: this number is what tells the robot's positions from yours.",
                "ar": "رقم تعريف أوامر AURION. لا تغيّره.",
            }),
            ("execution.flatten_on_disconnect", {
                "fa": "قطع ارتباط با متاتریدر → بستن همه‌چیز. <b>مثال:</b> روی VPS با اینترنت ناپایدار این را روشن نگه دارید؛ پوزیشن باز بدون نظارت بدترین حالت است.",
                "en": "Lose MetaTrader, close everything. <b>Example:</b> on a VPS with a flaky line, keep this on — an open position nobody is watching is the worst state to be in.",
                "ar": "عند فقد الاتصال بميتاتريدر، أغلق كل شيء.",
            }),
            ("execution.flatten_on_ai_fault", {
                "fa": "خطای هوش → بستن همه‌چیز. پیش‌فرض خاموش است چون هوش فقط فیلتر است و نبودش به‌تنهایی دلیل بستن پوزیشن نیست.",
                "en": "An AI fault closes everything. Off by default, because the AI is only a filter and its absence is not by itself a reason to exit.",
                "ar": "خطأ الذكاء الاصطناعي يغلق كل شيء. معطّل افتراضيًا.",
            }),
            ("execution.kill_switch_default", {"fa": "وضعیت کلید اضطراری هنگام بالا آمدن.", "en": "The emergency switch's state at startup.", "ar": "حالة مفتاح الطوارئ عند التشغيل."}),
        ],
    },
    {
        "id": "prop",
        "title": {
            "fa": "و. قوانین پراپ",
            "en": "F. Prop rules",
            "ar": "و. قواعد البروب",
        },
        "lede": {
            "fa": "پراپ یک <b>فیلتر</b> روی همان سیگنال است، نه یک سبک معاملاتی جدا. سیگنال تولید می‌شود و پراپ اجازه می‌دهد یا نمی‌دهد.",
            "en": "Prop is a <b>filter</b> over the same signals, not a separate trading style. The signal is produced and prop lets it through or does not.",
            "ar": "البروب مرشّح على الإشارات نفسها وليس أسلوب تداول منفصل.",
        },
        "rows": [
            ("prop.enabled", {"fa": "اعمال قوانین پراپ.", "en": "Apply prop rules.", "ar": "تطبيق قواعد البروب."}),
            ("prop.active_profile", {
                "fa": "پروفایل فعال. <b>مثال:</b> <code>conservative</code> سخت‌گیرترین است و برای فاز ارزیابی مناسب.",
                "en": "The active profile. <b>Example:</b> <code>conservative</code> is the strictest and the right one for an evaluation phase.",
                "ar": "الملف النشط. <code>conservative</code> هو الأكثر صرامة.",
            }),
            ("prop.news_blackout_minutes_before", {
                "fa": "چند دقیقه <b>قبل</b> از خبر، معامله ممنوع شود. <b>مثال:</b> <code>15</code> با خبر ساعت ۱۶:۰۰ یعنی از ۱۵:۴۵ هیچ ورودی جدیدی نیست.",
                "en": "Minutes <b>before</b> an event with no trading. <b>Example:</b> <code>15</code> with a 16:00 release means nothing new opens after 15:45.",
                "ar": "الدقائق قبل الخبر التي يُمنع فيها التداول.",
            }),
            ("prop.news_blackout_minutes_after", {"fa": "همان، بعد از خبر.", "en": "The same, after the event.", "ar": "نفس الشيء بعد الخبر."}),
            ("prop.news_calendar_path", {"fa": "مسیر فایل تقویم خبری. خالی = بدون فیلتر خبر.", "en": "Path to the calendar file. Empty means no news filter.", "ar": "مسار ملف التقويم. فارغ يعني بلا مرشح."}),
        ],
    },
    {
        "id": "mt5",
        "title": {
            "fa": "ز. اتصال متاتریدر",
            "en": "G. MetaTrader connection",
            "ar": "ز. اتصال ميتاتريدر",
        },
        "lede": {
            "fa": "اگر این بخش غلط باشد میز خالی می‌ماند — و عمداً خالی می‌ماند. AURION هیچ‌وقت دادهٔ ساختگی نشان نمی‌دهد.",
            "en": "Get this wrong and the desk stays empty — deliberately. AURION never shows invented data.",
            "ar": "إذا كان هذا خاطئًا يبقى المكتب فارغًا عمدًا. لا يعرض AURION بيانات مُختلقة.",
        },
        "rows": [
            ("mt5.terminal_path", {"fa": "مسیر <code>terminal64.exe</code>. خالی = جستجوی خودکار.", "en": "Path to <code>terminal64.exe</code>. Empty means find it.", "ar": "مسار <code>terminal64.exe</code>."}),
            ("mt5.login", {"fa": "شمارهٔ حساب. <code>0</code> یعنی از نشست باز متاتریدر استفاده کن.", "en": "Account number. <code>0</code> uses whatever MetaTrader is already logged into.", "ar": "رقم الحساب. <code>0</code> يستخدم الجلسة المفتوحة."}),
            ("mt5.server", {"fa": "نام سرور بروکر، دقیقاً همان‌طور که متاتریدر نشان می‌دهد.", "en": "The broker's server name, exactly as MetaTrader spells it.", "ar": "اسم خادم الوسيط كما يكتبه ميتاتريدر."}),
            ("mt5.ea_listen_port", {
                "fa": "پورتی که EA روی آن حرف می‌زند. اگر عوضش کردید، باید در خود EA هم عوض شود وگرنه هیچ‌چیز نمی‌رسد.",
                "en": "The port the EA talks on. Change it here and you must change it in the EA too, or nothing arrives.",
                "ar": "المنفذ الذي يتحدث عليه EA.",
            }),
            ("mt5.timeframes", {"fa": "تایم‌فریم‌هایی که کندل‌شان گرفته می‌شود.", "en": "The timeframes whose candles are pulled.", "ar": "الأطر الزمنية المطلوبة."}),
            ("mt5.timeout_ms", {"fa": "مهلت پاسخ متاتریدر بر حسب میلی‌ثانیه.", "en": "How long to wait on MetaTrader, in milliseconds.", "ar": "مهلة الانتظار بالميلي ثانية."}),
        ],
    },
    {
        "id": "infra",
        "title": {
            "fa": "ح. موتور، میز و نگهداری",
            "en": "H. Engine, desk and retention",
            "ar": "ح. المحرك والمكتب والاحتفاظ",
        },
        "lede": {
            "fa": "این‌ها را معمولاً لازم نیست دست بزنید. فقط وقتی پورتی اشغال است یا VPS کم‌حافظه دارید.",
            "en": "Rarely worth touching. Change them when a port is taken or a VPS is short of memory.",
            "ar": "نادرًا ما تحتاج إلى تغييرها.",
        },
        "rows": [
            ("backend.port", {"fa": "پورت میز. اگر ۸۰۸۰ اشغال باشد اینجا عوض کنید.", "en": "The desk's port. Change it here if 8080 is taken.", "ar": "منفذ المكتب."}),
            ("backend.jwt_expires_hours", {"fa": "اعتبار نشست ورود. <b>مثال:</b> <code>72</code> یعنی سه روز بعد دوباره باید وارد شوید.", "en": "How long a sign-in lasts. <b>Example:</b> <code>72</code> means signing in again three days later.", "ar": "مدة صلاحية الجلسة."}),
            ("backend.history_retention_days", {
                "fa": "چند روز تاریخچه نگه داشته شود. <b>مثال:</b> روی VPS با دیسک کوچک، <code>30</code> را به <code>14</code> کم کنید.",
                "en": "Days of history kept. <b>Example:</b> on a small VPS disk, drop <code>30</code> to <code>14</code>.",
                "ar": "عدد أيام الاحتفاظ بالسجل.",
            }),
            ("engine.candle_lookback", {
                "fa": "چند کندل در حافظه بماند. کم کردنش مصرف رم را پایین می‌آورد ولی دقت آموزش هوش را کم می‌کند.",
                "en": "Candles held in memory. Lowering it saves RAM and costs the AI training depth.",
                "ar": "عدد الشموع المحفوظة في الذاكرة.",
            }),
            ("engine.tick_buffer", {"fa": "بافر تیک.", "en": "The tick buffer.", "ar": "مخزن التيكات."}),
            ("engine.heartbeat_seconds", {"fa": "فاصلهٔ ضربان سلامت موتور.", "en": "How often the engine reports it is alive.", "ar": "فترة نبض المحرك."}),
        ],
    },
    {
        "id": "notify",
        "title": {
            "fa": "ط. تلگرام",
            "en": "I. Telegram",
            "ar": "ط. تيليجرام",
        },
        "lede": {
            "fa": "اعلان یک‌طرفه. از تلگرام نمی‌شود معامله باز یا بسته کرد — عمداً.",
            "en": "One-way notifications. You cannot trade from Telegram, deliberately.",
            "ar": "إشعارات باتجاه واحد. لا يمكن التداول من تيليجرام عمدًا.",
        },
        "rows": [
            ("telegram.enabled", {"fa": "روشن/خاموش.", "en": "On or off.", "ar": "تشغيل أو إيقاف."}),
            ("telegram.bot_token", {"fa": "توکن ربات از BotFather.", "en": "The bot token from BotFather.", "ar": "رمز البوت من BotFather."}),
            ("telegram.notify_open", {"fa": "اعلان هنگام باز شدن پوزیشن.", "en": "Tell me when a position opens.", "ar": "إشعار عند فتح صفقة."}),
            ("telegram.notify_close", {"fa": "اعلان هنگام بسته شدن.", "en": "Tell me when one closes.", "ar": "إشعار عند الإغلاق."}),
            ("telegram.chats", {"fa": "فهرست چت‌هایی که اعلان می‌گیرند.", "en": "The chats that receive them.", "ar": "قائمة المحادثات."}),
        ],
    },
]

HEAD = {
    "fa": ("۱۶. مرجع کامل تنظیمات", """<p>هر کلیدی که AURION می‌خواند، با مقدار پیش‌فرض واقعی‌اش. این جدول‌ها از
      <code>config/aurion.factory.json</code> ساخته می‌شوند، پس هیچ‌وقت با خود محصول اختلاف پیدا نمی‌کنند.</p>
      <div class="card">تنظیمات زنده در <code>config/aurion.json</code> است. فایل <code>aurion.factory.json</code>
      فقط نسخهٔ کارخانه است و هنگام به‌روزرسانی بازنویسی می‌شود — ویرایش‌های خود را در اولی بگذارید.
      بیشتر این کلیدها از صفحهٔ <b>تنظیمات</b> میز هم قابل تغییرند؛ ویرایش مستقیم فایل برای چیزهایی است که آنجا نیستند.</div>"""),
    "en": ("16. Complete settings reference", """<p>Every key AURION reads, with its real default. These tables are generated from
      <code>config/aurion.factory.json</code>, so they cannot drift from the product.</p>
      <div class="card">Live settings are in <code>config/aurion.json</code>. <code>aurion.factory.json</code> is the
      factory copy and is overwritten on update — put your edits in the first one. Most of these are also on the desk's
      <b>Settings</b> screen; editing the file is for the ones that are not.</div>"""),
    "ar": ("١٦. مرجع الإعدادات الكامل", """<p>كل مفتاح يقرأه AURION مع قيمته الافتراضية الحقيقية. تُولَّد هذه الجداول من
      <code>config/aurion.factory.json</code> فلا يمكن أن تختلف عن المنتج.</p>
      <div class="card">الإعدادات الحية في <code>config/aurion.json</code>. ملف المصنع يُستبدل عند التحديث.</div>"""),
}

COLS = {
    "fa": ("کلید", "پیش‌فرض", "توضیح"),
    "en": ("Key", "Default", "What it does"),
    "ar": ("المفتاح", "الافتراضي", "الوظيفة"),
}


def build(lang: str, cfg: dict) -> str:
    title, lede = HEAD[lang]
    key_col, def_col, why_col = COLS[lang]

    out = [f'      <h2 id="{lang}-16">{title}</h2>', f"      {lede}"]

    for group in GROUPS:
        out.append(f'      <h3 id="{lang}-16-{group["id"]}">{group["title"][lang]}</h3>')
        out.append(f'      <p>{group["lede"][lang]}</p>')
        out.append("      <table>")
        out.append(f"        <tr><th>{key_col}</th><th>{def_col}</th><th>{why_col}</th></tr>")
        for path, text in group["rows"]:
            out.append(
                f"        <tr><td><code>{esc(path)}</code></td>"
                f"<td><code>{shown(dig(cfg, path))}</code></td>"
                f"<td>{text[lang]}</td></tr>"
            )
        out.append("      </table>")

    return "\n".join(out)


def main() -> int:
    cfg = load()
    block = "\n".join(
        [START]
        + [f'      <!-- {lang} -->\n{build(lang, cfg)}' for lang in ("fa", "en", "ar")]
        + [END]
    )

    # Each language's section goes at the end of its own article.
    sections = {lang: build(lang, cfg) for lang in ("fa", "en", "ar")}

    for target in TARGETS:
        if not target.exists():
            print(f"skip (missing): {target}")
            continue
        html = target.read_text(encoding="utf-8")

        # Remove any previously generated block, so this is idempotent.
        html = re.sub(
            re.escape(START) + r".*?" + re.escape(END) + r"\n?",
            "",
            html,
            flags=re.S,
        )

        for lang, body in sections.items():
            marker = f'<article id="doc-{lang}"'
            at = html.index(marker)
            close = html.index("</article>", at)
            html = (
                html[:close]
                + f"\n{START}\n{body}\n{END}\n\n    "
                + html[close:]
            )

        # And the contents list, which is hand-written in this file.
        for lang, label in (("fa", "۱۶ تنظیمات"), ("en", "16 Settings"), ("ar", "١٦ الإعدادات")):
            entry = f'["#{lang}-16","{label}"]'
            if entry in html:
                continue
            # Append to that language's array, after its last entry.
            pattern = re.compile(r'(' + lang + r':\s*\[)(.*?)(\n      \],)', re.S)
            match = pattern.search(html)
            if not match:
                print(f"warning: no contents array for {lang}")
                continue
            html = html[:match.end(2)] + f',\n        {entry}' + html[match.end(2):]

        target.write_text(html, encoding="utf-8")
        print(f"wrote {target.relative_to(ROOT)}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
