# AURION Key Server — FULL E-COMMERCE STORE (نسخه کامل)

فروشگاه رسمی و کامل لایسنس AURION — **فروشگاهی واقعی** با سبد خرید، علاقه‌مندی، کوپن، پنل کاربری تب‌بندی شده، پنل ادمین محرمانه جدا، تیکت پشتیبانی که همیشه کار می‌کند، بازیابی رایگان، فاکتور یکتا، و امنیت سخت‌گیرانه.

> این پوشه standalone است — روی هر VPS با Node 18+ مستقل deploy می‌شود. هیچ importای از `engine/` یا `backend/` ندارد.

## ویژگی‌های نسخه کامل (درخواست کاربر)

### فروشگاه (Store)
- **کاتالوگ کامل محصولات**: ۴ پلن با عنوان، توضیح کوتاه/بلند، ویژگی‌ها، badge (محبوب/به‌صرفه/VIP)، امتیاز و نظرات، SKU یکتا
- **جستجو و فیلتر**: جستجوی زنده روی عنوان/توضیح/ویژگی، فیلتر محبوب/ارزان/گران
- **صفحه محصول**: `/product/:id` با جزئیات، ویژگی‌ها، مقایسه، دکمه افزودن به سبد و خرید مستقیم
- **سبد خرید**: localStorage (`aurion_cart`) — افزودن، حذف، تغییر تعداد (۱ تا ۱۰)، جمع جزء، تخفیف، قابل پرداخت
- **کوپن**: اعتبارسنجی سرورساید (`/api/coupons/validate`)، درصد یا مبلغ ثابت، سقف استفاده، حداقل مبلغ، انقضا، پلن‌های مجاز
- **علاقه‌مندی (Wishlist)**: local + سرور (اگر لاگین) — `♡/♥` در کارت‌ها، صفحه جدا `/wishlist`
- **چک‌اوت گروهی**: `/api/cart/checkout` — چند محصول در یک پرداخت زرین‌پال، صدور چند کلید همزمان
- **Trust & UX**: Hero با آمار زنده، Trust badges (پرداخت امن، تحویل آنی، تیکت، اصالت)، مقایسه پلن‌ها، FAQ آکاردئونی، نظرات مشتریان، اعلان بالای سایت، منوی موبایل همبرگری، نوار جستجوی کشویی
- **پرداخت**: زرین‌پال v4، callback امن، شماره سفارش `AX-O-…`، شماره فاکتور `AX-I-…`، گروه سفارش `AX-G-…`، رفرنس درگاه
- **صفحه موفقیت**: نمایش همه کلیدهای صادر شده (چندتایی)، کپی امن با fallback

### پنل کاربری (Account) — تب‌بندی شده
- **داشبورد**: سلام، آمار سفارش‌های پرداخت‌شده، کلیدها، مجموع پرداختی، تیکت‌ها، دسترسی سریع
- **سفارش‌ها**: کارت هر سفارش با شماره سفارش/فاکتور/گروه، آیتم‌ها، مبلغ اصلی/تخفیف/کوپن، وضعیت، کلیدها، دکمه پشتیبانی برای سفارش
- **کلیدها**: جدول همه کلیدها با پلن، سفارش، وضعیت، انقضا، کپی
- **فاکتورها**: جدول فاکتورهای رسمی
- **تیکت‌ها**: لیست + باز کردن ترد، پاسخ
- **علاقه‌مندی**: محصولات ♡ شده
- **پروفایل**: ویرایش نام نمایشی (`/api/me/profile`)
- **امنیت**: تغییر رمز (`/api/me/password`)

### پشتیبانی — باگ رفع شد
- **قبلا**: کلیک روی پشتیبانی گاهی هیچ اتفاقی نمی‌افتاد (async render بدون loading، contactCard خالی اگر env خالی، عدم fallback)
- **الان**: `contactCard()` همیشه fallback دارد (شماره/ایمیل/تلگرام پیش‌فرض)، loading state، FAQ، اگر لاگین نباشد دکمه ورود کار می‌کند، اگر لاگین باشد فرم تیکت با دسته/اولویت/سفارش مرتبط + لیست تیکت‌ها. تست e2e با `api-support` پاس می‌شود.

### بازیابی کلید
- با کلید قبلی یا شماره سفارش، کپچا، صدور جایگزین رایگان، ابطال قبلی، نمایش مانده رایگان

### احراز هویت کامل
- ثبت‌نام با جیمیل/موبایل ایران + رمز + نام نمایشی + کپچا + honeypot
- OTP تأیید (SMTP یا Kavenegar یا dev fallback)، ورود با کپچا، فراموشی رمز (`/api/auth/forgot` + `/api/auth/reset`)

### پنل ادمین محرمانه — صفحه جدا
- **آدرس مخفی**: هیچ دکمه‌ای در UI نیست؛ فقط `/#/<ADMIN_PANEL_HASH>` (مثلا `/#/owner-axia-x7k2`) — مقدار از `.env` می‌آید و در `app.js` inject می‌شود
- **لاگین امن**: توکن ادمین + کپچا، rate-limit IP، قفل ۱۵ دقیقه بعد از `ADMIN_FAIL_LIMIT` تلاش ناموفق، مقایسه timing-safe
- **داشبورد**: کاربران، فروش تومان، سفارش‌ها، کلیدها (unused/active/revoked/replaced)، تیکت باز، نقض‌ها، کوپن‌ها، محصولات، نمودار ۷ روز اخیر (orders/revenue)
- **سفارش‌ها**: صفحه‌بندی سرورساید (`page/limit`), جستجو (سفارش/فاکتور/هویت)، نمایش آیتم‌های چندتایی، تخفیف، کوپن، گروه
- **کاربران**: جستجو، پرونده کامل (سفارش‌ها+کلیدها+تیکت‌ها+wishlist)، غیرفعال/فعال‌سازی
- **کلیدها**: جستجو، فیلتر وضعیت، صدور دستی، ابطال، آزادسازی سیستم
- **محصولات**: CRUD کامل (`/api/admin/products`) — ID، عنوان، توضیح، قیمت ریال، روز/ماه، badge، ویژگی‌ها، محبوب، فعال
- **کوپن‌ها**: CRUD (`/api/admin/coupons`) — کد، نوع (درصد/ثابت)، مقدار، سقف، حداقل، پلن‌های مجاز، انقضا، یادداشت
- **تیکت‌ها**: اینباکس با فیلتر وضعیت (باز/پاسخ‌داده/بسته) + جستجو، ترد کامل، پاسخ، بستن/بازکردن، رفتن به پرونده مشتری
- **نقض‌ها**: heartbeat mismatch — کلید کپی/لو رفته
- **کلید مالک**: لیست `AXI-DEV-…` با تعداد ماشین، ابطال/بازگردانی، آزادسازی
- **لاگ ممیزی**: هر تغییر ادمین با IP و زمان، جستجو
- **تنظیمات**: پشتیبانی (تلفن/ایمیل/تلگرام/ساعات/آدرس)، سایت (نام/تگ‌لاین/اعلان)، FAQ (افزودن/حذف)
- **خروجی**: CSV سفارش‌ها

## نصب

```bash
cd keyserver
cp .env.example .env   # پر کنید
npm install
npm start              # http://localhost:8899
# یا
npm run dev
```

## متغیرهای .env

| Var | توضیح |
| --- | --- |
| `AURION_KEY_PRIVATE_HEX` | ۳۲ بایت seed امضای Ed25519 — تاج — فقط اینجا و CLI مالک |
| `JWT_SECRET`, `ADMIN_TOKEN` | رشته‌های تصادفی بلند |
| `ADMIN_PANEL_HASH` | آدرس مخفی ادمین — فقط حروف/عدد/خط تیره |
| `ZARINPAL_MERCHANT_ID`, `ZARINPAL_GATEWAY` | درگاه |
| `PUBLIC_BASE_URL` | برای callback زرین‌پال |
| `PLAN_*_PRICE` | قیمت به ریال |
| `SMTP_*`, `KAVENEGAR_API_KEY` | OTP |
| `SUPPORT_*` | تماس مستقیم |
| `SITE_NOTICE` | اعلان بالای سایت |
| `ALLOW_DEV_PAID` | فقط تست — در پروداکشن ۰ |

## API خلاصه

```
GET  /api/captcha
POST /api/auth/register|login|verify|forgot|reset
GET  /api/me (Bearer) — orders, wishlist
POST /api/me/profile|password
GET  /api/products, /api/products/:id, /api/site/info, /api/support/info
POST /api/coupons/validate, /api/wishlist/toggle
POST /api/orders (single), /api/cart/checkout (bulk) → pay_url
GET  /api/pay/callback (ZarinPal)
POST /api/keys/recover
POST /api/support/tickets, GET /api/support/tickets|ticket, POST /api/support/reply
POST /api/desk/activate|heartbeat|status
GET  /api/admin/overview|orders|users|keys|products|coupons|tickets|ticket|violations|owner-keys|audit|settings|export/orders
POST /api/admin/mint|revoke|grant|reset-machines|user-disable|owner-revoke|owner-reset-machines|tickets/reply|status|products|coupons|settings
DELETE /api/admin/products/:id, /api/admin/coupons/:code
```

## امنیت

- bcrypt برای رمز، OTP هش شده، TTL ۱۰ دقیقه، ۵ تلاش
- کپچا جمع ساده + honeypot + rate-limit حافظه‌ای
- JWT ۷ روزه
- ادمین: timing-safe compare + قفل IP + audit log
- کلیدها Ed25519 امضا شده — کلاینت نمی‌تواند mint کند
- Heartbeat ضد اشتراک + ثبت violation + downgrade
- Helmet-like headers (nosniff, DENY, etc.)

## اتصال دسک

در `config/aurion.json`:

```json
{ "license": { "keyserver_url": "https://your-keyserver", "store_url": "https://your-keyserver" } }
```

یا env `AURION_KEYSERVER_URL`, `AURION_STORE_URL`.

صفحه ارتقا در دسک لینک فروشگاه را باز می‌کند.

## تست

```bash
npm test   # key-parity + api-support (نیاز به سرور در حال اجرا)
```

## یادداشت

- سبد خرید سمت کلاینت است اما چک‌اوت و کوپن سرورساید اعتبارسنجی می‌شود
- برای پروداکشن `DEV_OTP_FALLBACK=0` بگذارید تا کد در پاسخ API نیاید
- دیتابیس JSON ساده است — برای ترافیک بالا به Postgres مهاجرت کنید (Store را عوض کنید)
