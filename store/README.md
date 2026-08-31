# store/ — فروشگاه و سرور صدور کلید

فروشگاه رسمی لایسنس AURION. یک اپلیکیشن **کاملاً مستقل** است: هیچ importی از
`engine/` یا `backend/` ندارد و روی هر VPS با Node 18+ جداگانه deploy می‌شود.

```
store/
├── keyserver/          فروشگاه + سرور کلید (Node/Express، پورت ۸۸۹۹)
│   ├── src/            API، احراز هویت، OTP، زرین‌پال، پنل ادمین مخفی
│   ├── public/         فرانت‌اند فروشگاه (کاتالوگ، سبد، پنل کاربری)
│   ├── test/           key-parity + api-support
│   └── .env.example    الگوی متغیرهای محیطی
└── shop-audit-fa.md    گزارش عیوب فروشگاه و وضعیت رفع آن‌ها
```

## راه‌اندازی

```bash
cd store/keyserver
cp .env.example .env     # ویندوز: copy .env.example .env
# .env را پر کنید: AURION_KEY_PRIVATE_HEX، JWT_SECRET، ADMIN_TOKEN،
#                  ADMIN_PANEL_HASH، ZARINPAL_MERCHANT_ID، قیمت پلن‌ها
npm install
npm start                # http://localhost:8899
```

تست (نیاز به سرور در حال اجرا):

```bash
npm test
```

## اتصال دسک

در `config/aurion.json`:

```json
{ "license": { "keyserver_url": "https://your-keyserver", "store_url": "https://your-keyserver" } }
```

یا متغیرهای محیطی `AURION_KEYSERVER_URL` و `AURION_STORE_URL`.

## تفاوت با admin/

- **اینجا** کلید را به مشتری می‌فروشد (پرداخت، سبد، کوپن، تیکت، بازیابی کلید).
- **`admin/`** ابزارهای لوکال مالک است: صدور دستی کلید و سرور آپدیت.

کلید خصوصی Ed25519 فقط در `.env` همین سرور و در ماشین مالک است.

## نکات امنیتی

- در پروداکشن `DEV_OTP_FALLBACK=0` و `ALLOW_DEV_PAID=0`.
- بدون `JWT_SECRET` در حالت production سرور بالا نمی‌آید.
- پنل ادمین هیچ لینکی در UI ندارد؛ فقط `/#/<ADMIN_PANEL_HASH>`.
- `store/keyserver/data/` و `store/keyserver/.env` در gitignore هستند.
