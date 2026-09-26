# بررسی کامل پروژه AURION

تاریخ بررسی: ۲۶ سپتامبر ۲۰۲۶ — برنچ `arena/01a0ded6-aurion` (کامیت پایه `42d1915`)

---

## ۱) نمای کلی

AURION یک «میز معاملاتی» (trading desk) برای MetaTrader 5 است با سه لایه:

| لایه | تکنولوژی | مسیر | حجم |
|---|---|---|---|
| موتور | Python 3.10–3.12 / FastAPI + uvicorn | `engine/` | ~۱۰٬۵۰۰ خط |
| بک‌اند میز | Node.js 18–30 / Express + ws | `backend/` | ~۳٬۴۰۰ خط |
| رابط کاربری | HTML/CSS/JS خالص (بدون بیلد) | `apps/web/` | ~۸٬۷۰۰ خط |
| فروشگاه کلید | Node.js مستقل | `store/keyserver/` | ~۲٬۳۰۰ خط |
| ابزار مالک | Node/Python | `admin/` | ~۸۰۰ خط |

جمعاً ۲۴۶ فایل، حدود ۳۴٬۵۰۰ خط کد مؤثر. پل MT5 هم به‌صورت MQL5 (`engine/ea/AurionBridge.mq5`) و هم از طریق پکیج رسمی پایتون پیاده شده است.

### وضعیت سلامت (آزمون عملی)

| آزمون | نتیجه |
|---|---|
| `node --check` روی همه‌ی فایل‌های JS | ✅ بدون خطا |
| `py_compile` روی همه‌ی فایل‌های پایتون | ✅ بدون خطا |
| بوت بک‌اند (`node backend/src/index.js`) | ✅ بالا می‌آید روی `0.0.0.0:8080` |
| `npm install` در `backend/` | ✅ ۸۸ پکیج، بدون خطا |
| اعمال `auth.middleware` روی APIها | ✅ همه‌ی مسیرهای حساس ۴۰۱ می‌دهند |
| همسانی فایل‌های ترجمه (en/fa/ar) | ✅ هر سه دقیقاً ۷۹۸ کلید، بدون کلید گمشده |
| `engine/tests/test_danger.py` | ✅ پاس |
| `engine/tests/test_fixes.py` و `test_gates.py` | ❌ اجرا نمی‌شوند (numpy نصب نیست) |
| `tests/desk-render.test.js` | ❌ اجرا نمی‌شود (`jsdom` در هیچ package.json نیست) |

---

## ۲) ایرادهای بحرانی (CRITICAL)

### C1 — API موتور اصلاً احراز هویت ندارد و به‌صورت پیش‌فرض روی `0.0.0.0` گوش می‌دهد

`engine/aurion/api/server.py` هیچ middleware احراز هویتی ندارد — فقط CORS. مسیرهای زیر برای هر کسی که به پورت ۱۸۷۶۵ برسد باز است:

```
POST /v1/order       → ثبت سفارش واقعی
POST /v1/kill        → بستن همه چیز
POST /v1/flatten
POST /v1/mt5/connect → با login/password/server
POST /v1/auto, /v1/danger, /v1/strategies/apply ...
```

و در `engine/main.py:65` و `config/aurion.json → engine.bind` مقدار پیش‌فرض `"0.0.0.0"` است. یعنی روی یک VPS، هر کسی در اینترنت/شبکه می‌تواند مستقیم روی حساب واقعی معامله باز کند و کل احراز هویت بک‌اند Node را دور بزند.

فقط دو مسیر (`/v1/license/issue` و یکی دیگر) با تابع `_local()` به localhost محدود شده‌اند؛ بقیه آزادند.

**راهکار:** `engine.bind` پیش‌فرض را `127.0.0.1` کنید و یک توکن مشترک (`AURION_ENGINE_TOKEN`) به‌صورت middleware روی همه‌ی `/v1/*` اجباری کنید (بک‌اند Node آن را در هدر بفرستد).

### C2 — `POST /api/auth/license-session` بدون هیچ رمزی توکن owner می‌دهد

در `backend/src/index.js:416` این مسیر عمومی است: با `{"mode":"freemium"}` کاربر `owner` را می‌سازد (اگر نباشد) و JWT با نقش owner برمی‌گرداند. تنها محدودیت یک throttle مبتنی بر IP (۴۰ در ساعت) است. چون `backend.host` هم `0.0.0.0` است، این یعنی تصاحب کامل میز از روی شبکه.

**راهکار:** این مسیر را به `127.0.0.1` محدود کنید یا به یک مرحله‌ی تأیید محلی (کد نمایش‌داده‌شده روی دسکتاپ) گره بزنید.

### C3 — فایل‌های راز و پایگاه‌داده داخل Git کامیت شده‌اند

فایل‌های زیر tracked هستند:

```
data/jwt.secret          ← راز امضای JWT (مقدار واقعی داخل مخزن)
data/license/secret.key  ← کلید HMAC ضدّدستکاری لایسنس
data/license/state.json, used.json
data/aurion.access.db    ← دیتابیس کاربران/لاگ دسترسی
data/aurion.engine.db (+ -shm/-wal)
data/logs/desk.log, engine.log
data/exports/*.xlsx      ← ۴ فایل خروجی تاریخچه‌ی واقعی
```

این‌ها دقیقاً همان چیزهایی هستند که `SECURITY-FIXES.md` ادعا می‌کند با مجوز `0600` محافظت می‌شوند — اما در مخزن عمومی/مشترک قرار دارند. هر کسی که کلون کند می‌تواند JWT جعل کند.

**راهکار:** `git rm --cached` روی همه‌ی این‌ها + `.gitignore` + چرخاندن (rotate) رازها.

---

## ۳) ایرادهای مهم (HIGH)

### H1 — پروژه اصلاً `.gitignore` ندارد

نتیجه‌ی مستقیمش این است که ۳۷ فایل `.pyc` داخل `__pycache__` کامیت شده‌اند و صرفاً با یک‌بار اجرای بک‌اند، فایل‌های tracked (`data/aurion.access.db`, `data/logs/desk.log`) تغییر کردند و در `git status` ظاهر شدند. یعنی هر بار اجرای برنامه، درخت گیت کثیف می‌شود.

پیشنهاد حداقلی:

```gitignore
__pycache__/
*.pyc
node_modules/
data/*.db
data/*.db-shm
data/*.db-wal
data/logs/
data/exports/
data/jwt.secret
data/license/
```

### H2 — تست‌ها قابل اجرا نیستند و CI وجود ندارد

- `tests/desk-render.test.js` به `jsdom` نیاز دارد که در هیچ `package.json` اعلام نشده؛ هیچ اسکریپت `test` در `package.json` ریشه نیست.
- ۱٬۶۴۷ خط تست در `engine/tests/test_fixes.py` نوشته شده ولی بدون `pip install -r engine/requirements.txt` اجرا نمی‌شود و هیچ `pytest.ini`/runner مشترکی وجود ندارد.
- پوشه‌ی `.github/workflows` وجود ندارد — هیچ اجرای خودکاری روی PRها نیست.

### H3 — README با کد و با خودش در تضاد است

انتهای README دو پاراگراف متناقض پشت سر هم دارد:

> «AURION runs in **freemium** mode until a product key is activated… key server… plans…»
>
> «This AURION build is a standard local desk. **There is no owner account, no registration, no plans and no license key.**»

در حالی که کد (`engine/aurion/license/guard.py` با ۸۳۰ خط، `backend/src/billing.js`، `store/keyserver/`) کاملاً سیستم لایسنس و پرداخت ZarinPal را پیاده کرده است. جمله‌ی دوم غلط است و باید حذف شود.

### H4 — CORS بک‌اند عملاً به هر مبدأیی اجازه می‌دهد که هدر `Origin` نداشته باشد

در `backend/src/index.js:89`: `if (!origin) return cb(null, true);`. برای curl مشکلی نیست، ولی چون سرور روی `0.0.0.0` است، هر کلاینت غیرمرورگری آزاد است. ترکیب این با C2 خطرناک است.

---

## ۴) ایرادهای متوسط (MEDIUM)

| # | مورد | جزئیات |
|---|---|---|
| M1 | فایل‌های تکراری | `AURION-GUIDE.html` و `docs/AURION-GUIDE.html` بایت‌به‌بایت یکسان‌اند (md5 برابر). همچنین `AURION-BACKTEST-GUIDE.html` در **سه** نسخه‌ی کاملاً یکسان (ریشه، `docs/`، `apps/web/`) موجود است. یکی نگه دارید و بقیه را symlink/حذف کنید. |
| M2 | حجم مخزن | `apps/web/assets/` تنها ۱۹ مگابایت است (دو ویدئوی `welcome/*.mp4`) از مجموع ~۲۱ مگابایت `.git`. برای دو ویدئوی خوش‌آمد، این ۹۰٪ حجم مخزن است. |
| M3 | فایل زائد | `engine/a.txt` بدون هیچ ارجاعی در مخزن رها شده. |
| M4 | `apps/web/js/app.js` با ۵٬۵۴۶ خط | یک فایل تک‌تکه بدون ماژول‌بندی؛ بزرگ‌ترین بدهی فنی سمت UI. همین‌طور `engine/aurion/runtime/trader.py` با ۲٬۲۵۳ خط و `engine/aurion/mt5/bridge.py` با ۱٬۶۶۹ خط. |
| M5 | پایان خط ناهمگون | `config/aurion.json` با CRLF ذخیره شده در حالی که بقیه‌ی درخت LF است و `.gitattributes` وجود ندارد → دیف‌های کاذب بین ویندوز و لینوکس. |
| M6 | مستندسازی ناقص | `docs/en/` فقط ۲ فایل دارد ولی `docs/ar/` پنج فایل؛ `docs/fa/` اصلاً وجود ندارد (خود README به این نقص اعتراف می‌کند). |
| M7 | نسخه‌ی قفل‌نشده در keyserver | `store/keyserver/package.json` از `^` استفاده می‌کند در حالی که `backend/package.json` نسخه‌ها را دقیق پین کرده — رفتار ناهمگون در دو اپ یک مخزن. |

---

## ۵) نقاط قوت پروژه

اینها واقعاً خوب انجام شده‌اند و باید حفظ شوند:

1. **معماری تمیز و لایه‌بندی‌شده** — مرز موتور/بک‌اند/UI شفاف است و `store/` و `admin/` به‌درستی اپ‌های مستقل‌اند.
2. **i18n بی‌نقص** — سه زبان با ۷۹۸ کلید کاملاً همسان، بدون یک کلید گمشده. RTL/LTR زنده. این سطح از انضباط نادر است.
3. **احراز هویت بک‌اند محکم شده** — bcrypt cost 12، JWT با `jti` و امکان revoke، TOTP، رد کردن توکن در query string، احراز هویت WebSocket با تایم‌اوت ۵ ثانیه‌ای. آزمون عملی تأیید کرد که همه‌ی مسیرهای حساس ۴۰۱ می‌دهند.
4. **رد کردن داده‌ی جعلی** — `allow_synthetic_data: false` و امتناع بک‌تستر از اجرا بدون تاریخچه‌ی واقعی، یک تصمیم طراحی درست و صادقانه است.
5. **جلوگیری از Prototype Pollution** و انتقال SQL از argv به stdin (`backend/src/db.js` ↔ `access_db.py`) اصلاحات دقیقی هستند.
6. **مستندسازی امنیتی** — `SECURITY-FIXES.md` با ذکر «قبل/بعد/فایل» برای هر مورد، الگوی خیلی خوبی است.

---

## ۶) اولویت‌بندی پیشنهادی اقدامات

**فوری (قبل از هر استقرار روی VPS):**
1. `engine.bind` → `127.0.0.1` و اضافه کردن توکن روی `/v1/*` موتور (C1)
2. محدود کردن `/api/auth/license-session` به لوکال (C2)
3. `git rm --cached` رازها و دیتابیس‌ها + چرخاندن `jwt.secret` و `secret.key` (C3)

**کوتاه‌مدت:**
4. افزودن `.gitignore` و `.gitattributes` (H1, M5)
5. اضافه کردن `jsdom` به devDependencies، اسکریپت `test` در ریشه، و یک workflow ساده‌ی GitHub Actions (H2)
6. اصلاح پاراگراف متناقض README (H3)

**میان‌مدت:**
7. حذف فایل‌های تکراری راهنما و `engine/a.txt` (M1, M3)
8. انتقال ویدئوهای welcome به Git LFS یا خارج از مخزن (M2)
9. شکستن `app.js` و `trader.py` به ماژول‌های کوچک‌تر (M4)

---

## جمع‌بندی

پروژه از نظر **کیفیت مهندسی و پوشش عملکردی در سطح بالایی** است: کد تمیز کامپایل می‌شود، بک‌اند بی‌خطا بوت می‌شود، احراز هویت لایه‌ی Node واقعاً محکم شده و بومی‌سازی سه‌زبانه بی‌نقص است.

اما **سطح حمله‌ی موتور پایتون نقطه‌ی شکست جدی است**: یک API بدون هیچ احراز هویتی که می‌تواند سفارش واقعی ثبت کند و به‌صورت پیش‌فرض روی همه‌ی رابط‌های شبکه گوش می‌دهد، تمام زحمتی را که در `SECURITY-FIXES.md` برای سخت‌سازی لایه‌ی Node کشیده شده خنثی می‌کند. همراه با رازهای کامیت‌شده در Git، این سه مورد باید قبل از هر استفاده‌ی واقعی روی حساب زنده برطرف شوند.
