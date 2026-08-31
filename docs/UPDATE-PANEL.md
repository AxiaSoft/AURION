# پنل مخفی آپدیت AURION - جدا از سایت خرید

## معماری

```
[داشبورد AURION]  --API-->  [Update Server - پنل مخفی]
   |                                |
   |-- چک آپدیت                    |-- ذخیره فایل‌ها (Draft)
   |-- دانلود فایل‌های تغییر       |-- انتشار (Publish)
   |-- بک‌آپ + جایگزینی            |-- لغو انتشار (Unpublish - بدون اطلاع داشبورد)
```

## 1. Update Server - سرور مخفی آپدیت

**مسیر:** `update-server/`
**پورت پیش‌فرض:** `8898`
**دیتابیس:** فایل‌های JSON امن با `0o600/0o700` و محدودیت سایز

### راه‌اندازی:
```bash
cd update-server
cp .env.example .env
# ویرایش .env:
# ADMIN_TOKEN=یک-توکن-طولانی-تصادفی
# ADMIN_PANEL_HASH=aurion-update-admin-x9k3-CHANGE-THIS
# DATA_DIR=./data
npm install
node src/index.js
```
خروجی:
```
AURION Update Server listening on 8898
Admin panel: http://127.0.0.1:8898/admin/aurion-update-admin-x9k3-change-this
Public API: /api/updates/latest , /api/updates/check
```

### پنل ادمین مخفی:
- **URL مخفی:** `http://SERVER:8898/admin/<ADMIN_PANEL_HASH>`
- فقط با لینک مستقیم قابل دسترسی - هیچ لینکی از سایت اصلی به آن نیست
- احراز هویت با `X-Admin-Token` header
- **امکانات:**
  - ایجاد آپدیت جدید (Draft) با نسخه و changelog
  - آپلود فایل‌ها با مسیر هدف (مثلا `engine/aurion/config.py`)
  - انتشار (Publish) - بعد از انتشار داشبورد آپدیت را می‌بیند
  - لغو انتشار (Unpublish) - داشبورد متوجه لغو نمی‌شود، فقط آپدیت قبلی را می‌بیند یا هیچ
  - حذف Draft
  - لیست تمام آپدیت‌ها با وضعیت draft/published

### API عمومی (برای داشبورد):
- `GET /api/updates/latest` - آخرین آپدیت منتشر شده
- `POST /api/updates/check` - داشبورد فایل‌های محلی و نسخه را می‌فرستد، سرور diff را برمی‌گرداند
  ```json
  {
    "current_version": "1.0.0",
    "files": [{ "path": "backend/src/index.js", "hash": "abc..." }]
  }
  ```
- `GET /api/updates/file/:updateId/:fileId` - دانلود فایل (فقط اگر published)

### امنیت Update Server:
- فایل‌ها با `0o600`, دایرکتوری `0o700`
- محدودیت سایز: 50MB هر فایل، 100MB کل write
- sanitize file path جلوگیری از path traversal
- hash SHA256 برای هر فایل و بررسی قبل از ارسال
- CORS whitelist فقط `127.0.0.1:8080, localhost, app://aurion`
- Security headers: nosniff, DENY, CSP
- Admin token با `timingSafeEqual`
- Draft تا publish نشود دیده نمی‌شود

## 2. داشبورد - کلاینت آپدیت

**ماژول:** `backend/src/updater.js`

### تنظیمات:
فایل: `data/update-settings.json` (0o600)
```json
{
  "update_server_url": "http://127.0.0.1:8898",
  "auto_check_enabled": true,
  "auto_check_interval_hours": 6,
  "last_check": "2024-..."
}
```

### API داشبورد (برای فرانت):
- `GET /api/system/update/settings` - خواندن تنظیمات (owner/admin)
- `POST /api/system/update/settings` - ذخیره تنظیمات
  ```json
  {
    "update_server_url": "https://update.example.com",
    "auto_check_enabled": true,
    "auto_check_interval_hours": 6
  }
  ```
- `GET /api/system/update/state` - وضعیت آخرین چک
- `POST /api/system/update/check` - چک دستی آپدیت (فایل‌های محلی را جمع و به update server می‌فرستد)
- `POST /api/system/update/apply` - اعمال آپدیت (دانلود + بک‌آپ + جایگزینی)
- `GET /api/system/update/manifest` - لیست فایل‌های محلی با hash

### منطق چک:
1. جمع‌آوری فایل‌های مهم از `backend/src`, `engine/aurion`, `apps/web/js`, `apps/desktop` (max 500 فایل)
2. محاسبه SHA256 هر فایل
3. ارسال به `POST /api/updates/check` با `current_version` و `files`
4. سرور diff را حساب می‌کند: فایل‌هایی که hash متفاوت دارند
5. اگر نسخه متفاوت یا فایل تغییر کرده باشد `update_available=true`

### اعمال آپدیت:
1. دانلود هر فایل با `GET /api/updates/file/:id/:fileId` و بررسی hash
2. جلوگیری از path traversal: `path.resolve` باید زیر `ROOT` باشد
3. بک‌آپ فایل قدیمی در `data/update_backups/<updateId>_<timestamp>/`
4. نوشتن atomic با `0o600`
5. آپدیت نسخه در `config/aurion.json`
6. ذخیره لاگ در `data/last-update.json`

### چک خودکار:
- `startAutoChecker()` - هر `interval_hours` (پیش‌فرض 6 ساعت) چک می‌کند
- 30 ثانیه بعد از start یک چک اولیه
- قابل فعال/غیرفعال از تنظیمات

## 3. فرانت‌اند - تنظیمات

**مسیر:** `apps/web/js/app.js` - تب `set-update` در تنظیمات

**امکانات:**
- فیلد URL سرور آپدیت
- سوییچ چک خودکار
- فیلد فاصله چک (ساعت)
- دکمه ذخیره
- نمایش آخرین چک
- دکمه چک دستی - نمایش diff فایل‌ها
- دکمه نصب آپدیت با confirm و نمایش بک‌آپ
- دکمه نمایش فایل‌های محلی
- دکمه ری‌استارت سیستم بعد از آپدیت

## 4. جریان انتشار (مهم)

### تا انتشار اجازه ندهی فایل‌ها جایگزین نشود:
1. ادمین وارد پنل مخفی می‌شود: `http://update-server:8898/admin/<HASH>`
2. `ایجاد Draft` با نسخه مثلا `1.0.1`
3. آپلود فایل‌ها (مثلا `backend/src/index.js` با مسیر هدف)
4. **در این حالت داشبورد چیزی نمی‌بیند** - چون `published=false`
5. بررسی فایل‌ها در پنل
6. اگر OK بود: دکمه `✅ انتشار` - حالا `published=true` و داشبورد آپدیت را می‌بیند
7. اگر اشتباه بود: دکمه `❌ لغو انتشار` - `published=false` می‌شود، داشبورد متوجه لغو نمی‌شود (فقط دیگر آپدیت را نمی‌بیند یا نسخه قبلی را می‌بیند)

### لغو بدون اطلاع:
- `unpublish` فقط `published=false` می‌کند و `published_at=null`
- داشبورد در چک بعدی فقط لیست `published=true` را می‌بیند، پس آپدیت لغو شده را نمی‌بیند
- هیچ نوتیفیکیشنی به داشبورد فرستاده نمی‌شود

## 5. امنیت کلی

- Update Server جدا از shop site - هیچ وابستگی ندارد
- فایل‌های Draft هرگز به داشبورد نمی‌رسد
- Hash verification قبل از جایگزینی
- Path traversal block
- بک‌آپ خودکار قبل از جایگزینی
- فقط owner می‌تواند apply کند (admin فقط check)
- تنظیمات با 0o600
- TLS 1.2+ برای ارتباط با update server (اگر https باشد)

## 6. تست

```bash
# 1. راه‌اندازی update server
cd update-server
npm install
ADMIN_TOKEN=test123 ADMIN_PANEL_HASH=test-panel node src/index.js

# 2. در داشبورد تنظیمات آپدیت:
# URL: http://127.0.0.1:8898
# auto check: on, interval 1 hour

# 3. در پنل مخفی:
# http://127.0.0.1:8898/admin/test-panel
# Token: test123
# Create draft 1.0.1, upload file, publish

# 4. در داشبورد: چک آپدیت -> باید 1.0.1 را ببیند
# Apply -> فایل جایگزین + بک‌آپ

# 5. در پنل مخفی: Unpublish -> داشبورد دیگر آپدیت را نمی‌بیند و چیزی اعلام نمی‌شود
```
