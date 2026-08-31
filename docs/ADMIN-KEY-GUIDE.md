# راهنمای کامل دریافت کلید ادمین / Admin Key Retrieval Guide (0-100)

این راهنما تمام مراحل دریافت و استفاده از کلید ادمین (کلید لایسنس پرمیوم) را از صفر تا صد توضیح می‌دهد.  
License model = Ed25519 asymmetric — ساختار موجود حفظ شده، فقط مستند شده.  
**Fix 2026-05-17:** هر دو env `AXIASOFT_KEY_PRIVATE` و `AURION_KEY_PRIVATE_HEX` پذیرفته می‌شود، ابزار لوکال `scripts/mint_local.py` خطای `ModuleNotFoundError: No module named 'aurion'` را در ویندوز حل می‌کند.

> **خلاصه دستورات (Quick Commands) — Windows Fix:**
> ```powershell
> # Admin Key (نامحدود) — PowerShell
> $env:AURION_KEY_PRIVATE_HEX="9090ebd8..."   # یا AXIASOFT_KEY_PRIVATE
> python scripts/mint_local.py developer "admin-owner"
> # Normal Key (1 ماهه) — PowerShell
> $env:AURION_KEY_PRIVATE_HEX="9090ebd8..."; python scripts/mint_local.py m1 "client@example.com"
> # Normal Key (12 ماهه)
> $env:AURION_KEY_PRIVATE_HEX="9090ebd8..."; python scripts/mint_local.py y1 "client@example.com"
> ```
> ```cmd
> :: Windows CMD
> set AURION_KEY_PRIVATE_HEX=9090ebd8...
> python scripts/mint_local.py developer "admin-owner"
> mint-key.cmd developer "admin-owner"
> mint-key.cmd m1 "client@example.com"
> ```
> جزئیات کامل در بخش 2B و 2B-1 (Windows Fix).

---

## 1) مدل لایسنس AURION چیست؟

- **Freemium**: بدون کلید، دسک بالا می‌آید اما قابلیت‌های پرمیوم قفل است: `prop`, `scalping`, `strategy_upload`, `telegram`, `news`, `chart_signals`, `volume_mode`. همچنین اتو-ترید ربات محدود به 3 ترید در هر 5 ساعت است.
- **Premium**: کلید با پیشوند `AXIA-` (مثلاً `AXIA-M1-XXXX-...`) یا کلید توسعه‌دهنده `AXI-DEV-...`.
  - کلید مشتری `AXIA-` فقط با اتصال به **Keyserver** قابل فعال‌سازی است (اینترنت لازم است). سرور اصالت کلید را با کلید خصوصی Ed25519 چک می‌کند.
  - کلید توسعه‌دهنده `AXI-DEV-` امضای کامل Ed25519 دارد و آفلاین با کلید عمومی داخل سورس قابل تایید است، اما در صورت وجود Keyserver، آنجا هم ثبت می‌شود تا قابلیت revoke داشته باشد.
- **Machine Binding**: کلید به `machine_id` (MachineGuid ویندوز + MAC + نام هاست + ...) بایند می‌شود. جابجایی به سیستم دیگر = نیاز به کلید جدید یا revoke از سمت سرور.
- **Heartbeat**: هر 12 ساعت یک بار دسک به Keyserver گزارش می‌دهد `key_hash + machine_id`. اگر سرور revoke کند، دسک به Freemium دانگرید می‌شود.

---

## 2) از کجا کلید بگیریم؟ (صفر تا صد)

### روش A — خرید از فروشگاه (Store URL)

1. دسک را باز کنید. اگر پرمیوم نیستید، صفحه Gate (ورودی) بالا می‌آید.
2. دکمه **Buy / خرید** را بزنید. این دکمه شما را به `store_url` که در `config/aurion.json` بخش `license.store_url` یا `license.keyserver_url` تعریف شده می‌برد.
3. در فروشگاه پلن را انتخاب کنید: `m1` (1 ماه)، `m3` (3 ماه)، `m6` (6 ماه)، `y1` (12 ماه).
4. پرداخت را انجام دهید (Zarinpal یا درگاه تعریف شده).
5. پس از پرداخت، کلید در پنل کاربری فروشگاه + ایمیل شما نمایش داده می‌شود. فرمت: `AXIA-M1-A1B2-C3D4-E5F6-G7H8-XXXX-...`
6. کلید را کپی کنید.

### روش B — صدور دستی توسط ادمین (Owner Machine) — دستور دقیق

فقط روی ماشین سازنده که `AXIASOFT_KEY_PRIVATE` یا `AURION_KEY_PRIVATE_HEX` (کلید خصوصی 64 هگز Ed25519 seed) در env ست شده. این کلید در فایل سورس نیست — فقط روی سیستم سازنده نگهداری می‌شود. هر دو نام env پشتیبانی می‌شود (برای سازگاری با keyserver).

#### ⚠️ رفع خطای Windows: ModuleNotFoundError: No module named 'aurion' (2B-1)

اگر در ویندوز از `D:\AURION BETA` یا هر پوشه‌ای با فاصله اجرا می‌کنید و `python -m aurion.license.guard` خطای `ModuleNotFoundError` می‌دهد:

**علت:** Python مسیر `engine/` را نمی‌شناسد (pip install نشده) + نام env اشتباه.

**راه‌حل قطعی (لوکال، امن، بدون انتشار عمومی):**

1. از ابزار لوکال استفاده کنید که خودش `engine/` را به `PYTHONPATH` اضافه می‌کند:
```cmd
:: CMD - از ریشه پروژه اجرا کنید D:\AURION BETA
set AURION_KEY_PRIVATE_HEX=9090ebd82348b326eb891e496f2f5c1746a53243625237411835a810686826dc
python scripts/mint_local.py developer "admin-owner"
python scripts/mint_local.py m1 "client@example.com"
python scripts/mint_local.py y1 "client@example.com"
:: یا با wrapper:
mint-key.cmd developer "admin-owner"
mint-key.cmd m1 "client@example.com"
```

```powershell
# PowerShell
$env:AURION_KEY_PRIVATE_HEX="9090ebd82348b326eb891e496f2f5c1746a53243625237411835a810686826dc"
python scripts/mint_local.py developer "admin-owner"
python scripts/mint_local.py m1 "client@example.com"
# یا
.\mint-key.ps1 developer "admin-owner"
.\mint-key.ps1 m1 "client@example.com"
```

2. اگر می‌خواهید `python -m aurion.license.guard` هم کار کند:
```cmd
set PYTHONPATH=D:\AURION BETA\engine
set AURION_KEY_PRIVATE_HEX=...
python -m aurion.license.guard developer "admin-owner"
```

3. هر دو env کار می‌کند:
- `AXIASOFT_KEY_PRIVATE` (engine)
- `AURION_KEY_PRIVATE_HEX` (keyserver)
- `AURION_KEY_PRIVATE` / `KEY_PRIVATE` (fallback)

**امنیت:** این ابزار فقط لوکال است — endpoint `/v1/license/issue` فقط از `127.0.0.1` قابل دسترسی است، backend endpoint `/api/admin/mint-key` فقط owner، و هیچ API عمومی برای mint وجود ندارد. کلید خصوصی هرگز در بیلد ویندوز قرار نمی‌گیرد.

---

#### دریافت کلید ادمین (Admin Key) — نامحدود، آفلاین قابل تایید

کلید ادمین = کلید توسعه‌دهنده با پیشوند `AXI-DEV-` (تمام قابلیت‌ها، بدون انقضا، قابل revoke از Keyserver).

**Windows PowerShell (دقیق) — توصیه شده:**
```powershell
$env:AURION_KEY_PRIVATE_HEX="YOUR_64_HEX_PRIVATE_SEED"  # یا AXIASOFT_KEY_PRIVATE
cd C:\path\to\AURION   # یا D:\AURION BETA
python scripts/mint_local.py developer "admin-owner"
# خروجی نمونه: AXI-DEV-ABCD-EFGH-... (30 گروه 4 حرفی)
# این کلید را کپی کنید و در دسک → Upgrade → Activate وارد کنید
```

**Windows CMD (توصیه شده):**
```cmd
set AURION_KEY_PRIVATE_HEX=YOUR_64_HEX_PRIVATE_SEED
cd /d D:\AURION BETA
python scripts/mint_local.py developer "admin-owner"
:: یا
mint-key.cmd developer "admin-owner"
```

**Legacy (اگر PYTHONPATH ست باشد):**
```powershell
$env:AXIASOFT_KEY_PRIVATE="YOUR_64_HEX_PRIVATE_SEED"
python -m aurion.license.guard developer "admin-owner"
```

**Linux / macOS / WSL (دقیق):**
```bash
cd /path/to/AURION
AURION_KEY_PRIVATE_HEX=YOUR_64_HEX_PRIVATE_SEED python scripts/mint_local.py developer "admin-owner"
# یا
export AXIASOFT_KEY_PRIVATE=YOUR_64_HEX_PRIVATE_SEED
python -m aurion.license.guard developer "admin-owner"
```

#### دریافت کلید عادی (Normal Keys) — مشتریان (لوکال، غیر عمومی)

کلید عادی = پیشوند `AXIA-` + پلن + 24 کاراکتر تگ. فقط با Keyserver آنلاین فعال می‌شود (امنیت اشتراک‌گذاری).  
**امنیت:** این کلیدها فقط لوکال ساخته می‌شوند — هیچ endpoint عمومی برای mint وجود ندارد. فقط owner روی ماشین خودش می‌تواند بسازد.

**پلن‌ها:** `m1` = 1 ماه، `m3` = 3 ماه، `m6` = 6 ماه، `y1` = 12 ماه (1 سال)

**Windows PowerShell (توصیه شده):**
```powershell
$env:AURION_KEY_PRIVATE_HEX="YOUR_64_HEX_PRIVATE_SEED"
python scripts/mint_local.py m1 "client@example.com"
python scripts/mint_local.py m3 "client@example.com"
python scripts/mint_local.py m6 "client@example.com"
python scripts/mint_local.py y1 "client@example.com"
# خروجی نمونه: AXIA-M1-A1B2-C3D4-E5F6-G7H8-XXXX-YYYY-ZZZZ-...
# یا wrapper:
.\mint-key.ps1 m1 "client@example.com"
```

**Windows CMD:**
```cmd
set AURION_KEY_PRIVATE_HEX=YOUR_64_HEX_PRIVATE_SEED
python scripts/mint_local.py m1 "client@example.com"
mint-key.cmd m1 "client@example.com"
mint-key.cmd y1 "client@example.com"
```

**Linux / macOS:**
```bash
AURION_KEY_PRIVATE_HEX=YOUR_64_HEX_PRIVATE_SEED python scripts/mint_local.py m1 "client@example.com"
AURION_KEY_PRIVATE_HEX=YOUR_64_HEX_PRIVATE_SEED python scripts/mint_local.py y1 "client@example.com"
```

**از طریق Desk (owner only) — وقتی Engine در حال اجراست:**
```bash
# در Desk لاگین به عنوان owner، سپس:
curl -X POST http://127.0.0.1:8080/api/admin/mint-key \
  -H "Authorization: Bearer YOUR_OWNER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"plan":"m1","note":"client@example.com"}'
# پاسخ: {"ok":true,"key":"AXIA-M1-...","plan":"m1"}
```

**فقط لوکال از طریق Engine API (بدون نیاز به دانستن private در خط فرمان، اگر Engine روی همان ماشین سازنده در حال اجراست و env ست است):**
```bash
curl -X POST http://127.0.0.1:18765/v1/license/issue \
  -H "Content-Type: application/json" \
  -d '{"plan":"m1","note":"client@example.com"}'
# پاسخ: {"ok":true,"key":"AXIA-M1-...","plan":"m1"}

curl -X POST http://127.0.0.1:18765/v1/license/issue \
  -H "Content-Type: application/json" \
  -d '{"plan":"developer","note":"admin-owner"}'
# پاسخ: {"ok":true,"key":"AXI-DEV-...","plan":"developer"}
```
> این endpoint فقط از `127.0.0.1` قابل دسترسی است (local_only).

> ⚠️ کلید خصوصی را هرگز در گیت، لاگ، یا فایل کانفیگ عمومی قرار ندهید. فقط env روی ماشین امن سازنده. بعد از صدور، `set AXIASOFT_KEY_PRIVATE=` یا `Remove-Item Env:AXIASOFT_KEY_PRIVATE` را بزنید تا از حافظه پاک شود.

### روش C — API صدور از Keyserver

اگر Keyserver شخصی دارید (`AURION_KEYSERVER_URL`):

```bash
curl -X POST https://your-keyserver.com/api/keys/mint \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"plan":"m1","note":"client@example.com"}'
```

پاسخ: `{ "ok": true, "key": "AXIA-M1-..." }`

---

## 3) فعال‌سازی کلید در دسک

### مرحله 1: اینترنت را چک کنید
- کلید مشتری `AXIA-` بدون اینترنت فعال نمی‌شود (`internet_required`).
- کلید `AXI-DEV-` هم برای ثبت اولیه بهتر است آنلاین باشد.

### مرحله 2: وارد کردن کلید
- **در Gate (اولین صفحه)**: فیلد کلید را پر کنید → **Activate**.
- **در داخل دسک**: `Upgrade / ارتقاء` → فیلد کلید → **Activate**.

### مرحله 3: نتیجه
- موفق: `license.activated` + پلن + تاریخ انقضا نمایش داده می‌شود. `S.snap.license.premium = true`.
- خطاها:
  - `invalid_key`: فرمت اشتباه یا دستکاری شده.
  - `key_used`: کلید قبلاً روی ماشین دیگر مصرف شده (یک‌بار مصرف).
  - `machine_mismatch`: کلید به ماشین دیگر بایند شده.
  - `key_revoked` / `key_replaced`: ادمین کلید را از سرور باطل کرده.
  - `internet_required`: Keyserver در دسترس نیست یا `license.keyserver_url` خالی است.

### مرحله 4: تایید پرمیوم
- در نوار کناری پایین: `PRO` + پلن (مثلاً `Premium · 1 month`).
- در `Settings → System` یا `About` نسخه + وضعیت آپدیت را ببینید.
- در `Command` → `Trade Gate` باید `ready` باشد.

---

## 4) مدیریت کلید (ادمین)

### بررسی وضعیت لایسنس (داخل دسک)
```js
GET /api/license → { data: { plan, premium, expires, features, locked } }
```

### Revoke / Replace از سمت Keyserver
- در پنل Keyserver، کلید را revoke کنید. در heartbeat بعدی (حداکثر 12 ساعت) دسک به Freemium برمی‌گردد و `remote_revoked` ست می‌شود.
- برای انتقال: revoke قبلی + صدور کلید جدید برای ماشین جدید.

### بایند هویت (Identity Binding)
- هنگام لاگین، دسک خودکار `identity` (Gmail یا موبایل) را به `POST /v1/license/bind` می‌فرستد. این برای جلوگیری از اشتراک‌گذاری کلید است.
- فایل‌های ذخیره:
  - `data/license/state.json` (0o600, امضا شده با secret محلی)
  - `data/license/used.json`
  - `data/license/secret.key` (32 بایت تصادفی)

---

## 5) عیب‌یابی

| مشکل | علت | راه‌حل |
|------|-----|--------|
| `internet_required` | Keyserver URL خالی یا آفلاین | `config/aurion.json` → `license.keyserver_url` را چک کنید، فایروال را باز کنید |
| `key_used` | کلید قبلاً مصرف شده | کلید جدید بگیرید، یا از Keyserver revoke و دوباره mint کنید |
| `machine_mismatch` | سیستم عوض شده | کلید جدید برای ماشین جدید صادر کنید |
| Premium بعد از مدتی Freemium شد | Heartbeat revoke یا clock rollback | ساعت سیستم را درست کنید، به اینترنت وصل شوید، دوباره heartbeat شود |
| `tampered` | `state.json` دستکاری شده | فایل را پاک کنید، دوباره کلید را فعال کنید |

---

## 6) امنیت (بدون نظر شخصی، کاملاً سختگیرانه)

- کلید خصوصی فقط در env ماشین سازنده.
- `state.json` با HMAC + secret محلی 32 بایتی امضا می‌شود، نه با کلید عمومی.
- `machine_id` از چند منبع سخت‌افزاری + MachineGuid ساخته می‌شود.
- TLS verification در heartbeat و activate اجباری است (`ssl.create_default_context()`).
- Rate limit در Gate: 12 تلاش در 10 دقیقه برای activate.
- کلیدهای استفاده شده در `used.json` ذخیره می‌شوند تا reuse نشود (به‌جز developer).
- Clock rollback >12h = بلاک پرمیوم تا heartbeat موفق.

---

## 7) چک‌لیست سریع

- [ ] `config/aurion.json` → `license.keyserver_url` و `license.store_url` ست شده؟
- [ ] کلید با فرمت درست `AXIA-...` یا `AXI-DEV-...`؟
- [ ] اینترنت وصل است؟
- [ ] کلید قبلاً استفاده نشده؟
- [ ] بعد از فعال‌سازی، `nav-acc` → `PRO` شد؟
- [ ] `GET /api/license` → `premium:true`؟

---

**پایان راهنمای کلید ادمین — برای راهنمای نصب ویندوز به `WINDOWS-APP-GUIDE.md` مراجعه کنید.**
