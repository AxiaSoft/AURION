# الإعداد المتقدم لـ AURION (العربية)

---

## ١. تطوير استراتيجية مخصّصة

الملف: `engine/strategies/template.py` (يُقدَّم أيضاً من المكتب).

```python
from aurion.strategy.base import BaseStrategy, StrategyContext, StrategySignal

class MyStrategy(BaseStrategy):
    name = "my_strategy"
    params = {"volume": 0.10}

    def on_candle(self, ctx: StrategyContext) -> StrategySignal | None:
        if not ctx.candles:
            return None
        return None
```

يعطي `StrategyContext`: الشموع الحقيقية، آخر تيك، الحساب، المراكز، الأوامر، قاموس الذكاء، المعاملات.

أرجع `StrategySignal(action="buy"|"sell"|"close"|"close_all"|"modify"|"hold", ...)`.

### صندوق الرمل

ممنوع: `os` و`sys` و`subprocess` و`socket` و`shutil` و`ctypes` و`pathlib` و`pickle` و`requests` و`httpx` و`urllib` و`eval` و`exec` وحذف الملفات والتحكم بالعمليات.

مسموح: `math` و`statistics` و`datetime` و`collections` و`typing` و`json` ومساعدات AURION.

### التبديل الساخن

`POST /api/strategies/upload` يكتب الملف ويمكنه التفعيل. تستقبل الاستراتيجية السابقة `on_stop`.

---

## ٢. إعادة تدريب الذكاء

- تلقائي: كل `ai.retrain_every_bars` شمعة مغلقة، ومرة عند بلوغ `min_bars_to_train`.
- حي: `partial_fit` على كل شمعة بعد أول ملاءمة إن كان `online_learning` مفعّلاً.
- يدوي: الذكاء → تدريب أو `POST /api/ai/train`.
- الآثار: `engine/models/live.joblib` و`live.metrics.json`.

السمات في `features.py`: العوائد، EMA 8/21/55، RSI14، ATR٪، عرض بولينجر، نسب الذيول، z للحجم.

تصنيف التدريب إشارة عائد ٣ شموع أمامية مقابل `0.35 * ATR%`. لا تُشحن مجموعة بيانات خارجية.

للبدء من صفر احذف الملفين.

---

## ٣. تخصيص الخلفية

- سر JWT: `data/jwt.secret` أو `AURION_JWT_SECRET`.
- الربط: `AURION_HOST` و`AURION_PORT`.
- اكتشاف المحرك: `AURION_ENGINE_HOST` و`AURION_ENGINE_PORT`.
- ضع TLS أمامه بـ Caddy/nginx وحدّث `/ws`.
- المستخدمون: `data/users.json` (bcrypt). لا تسجيل ذاتي بعد التشغيل الأول.
- تنسيق إكسل: `backend/src/excel.js`.

دفتر التداول ملك المحرك (`data/aurion.engine.db`). ليس للمكتب دفتر ثانٍ.

---

## ٤. تخصيص تعدد اللغات

1. حرّر ملفات `/lang/*.json` الثلاثة بنفس المفاتيح.
2. `meta.dir` هي `ltr` أو `rtl`. `meta.locale` يقود إكسل.
3. قد يحمل سجل المحرك `lang_key` ويترجمه المكتب بالحزمة النشطة.
4. تبديل لغة المكتب لا يحتاج إعادة تشغيل.

لغة رابعة: انسخ حزمة وأضف الرمز إلى `SUPPORTED` في بايثون و`i18n.js` وأضف كبسولة.

---

## ٥. تخصيص السمة

الرموز في `apps/web/css/app.css` تحت `:root`:

```css
--bg: #06070b;
--cyan: #3ee0c4;
--violet: #7c6cff;
--gold: #e8c07a;
--rose: #ff6b8a;
```

الألواح تستخدم `backdrop-filter`. الخطوط محلية (`apps/web/fonts`) فلا يعتمد المكتب على شبكة توصيل.

يرث مكتب ويندوز وقشرة Electron الاختيارية نفس CSS. لا يوجد عميل أندرويد / فلاتر.

---

## ٦. بروتوكول المستشار والمحرك

JSON مفصول بأسطر على TCP `18766`.

المستشار → المحرك: `hello` و`tick` و`candle` و`candles` و`account` و`positions` و`orders` و`deals` و`log` و`signal` و`pong` و`result`.

المحرك → المستشار: `hello` و`order`/`market` و`close` و`modify` و`flatten` و`ping` و`request_history`.

---

## ٧. أقفال السلامة

| القفل | الافتراضي |
|---|---|
| بلا ميتاتريدر → بلا أمر | صارم |
| مفتاح الإيقاف | مطفأ |
| قفل البروب | مطفأ حتى المخالفة |
| استثناء الاستراتيجية → وضع آمن | مشغّل |
| إغلاق الكل عند إيقاف المحرك | مشغّل |
| إغلاق الكل عند عطل الذكاء | مطفأ |
| بيانات مختلقة | محظور |
