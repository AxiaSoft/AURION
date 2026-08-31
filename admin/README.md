# admin/ — ابزارهای مالک و ادمین

هر چیزی که فقط روی **ماشین سازنده / ادمین** اجرا می‌شود اینجا است.
هیچ‌کدام از این فایل‌ها بخشی از دسک کاربر نهایی نیستند و هیچ‌کدام در MSI
اپلیکیشن ویندوز بسته‌بندی نمی‌شوند.

| فایل | کار |
|---|---|
| `mint_local.py` | صدور کلید لایسنس به‌صورت لوکال (بدون API عمومی) |
| `mint-key.cmd` | همان، از CMD ویندوز |
| `mint-key.ps1` | همان، از PowerShell |
| `issue-license.py` | صدور کلید + ثبت در دفتر کل `data/license/issued.json` |
| `ADMIN-KEY-GUIDE.md` | راهنمای کامل ۰ تا ۱۰۰ کلید ادمین |
| `UPDATE-PANEL.md` | راهنمای سرور آپدیت و پنل مخفی آن |
| `start-update-server.cmd` / `.sh` | راه‌اندازی سرور آپدیت |
| `update-server/` | خودِ سرور آپدیت (Node، پورت ۸۸۹۸، پنل ادمین مخفی) |

## صدور کلید (خلاصه)

کلید خصوصی Ed25519 فقط در متغیر محیطی است، هرگز در فایل:

```cmd
:: CMD
set AURION_KEY_PRIVATE_HEX=your-64-hex-ed25519-seed
admin\mint-key.cmd developer "admin-owner"
admin\mint-key.cmd m1 "client@example.com"
```

```powershell
# PowerShell
$env:AURION_KEY_PRIVATE_HEX="your-64-hex-ed25519-seed"
.\admin\mint-key.ps1 developer "admin-owner"
```

```bash
# Linux / macOS / WSL
AURION_KEY_PRIVATE_HEX=your-64-hex-seed python3 admin/mint_local.py developer "admin-owner"
```

پلن‌ها: `m1` `m3` `m6` `y1` `developer` (کلید ادمین، بدون انقضا).

هر دو نام متغیر محیطی پذیرفته می‌شود: `AURION_KEY_PRIVATE_HEX` و
`AXIASOFT_KEY_PRIVATE`.

> اسکریپت‌های mint ترجیحاً `py -3.12` را صدا می‌زنند و اگر نبود به `python`
> برمی‌گردند. `engine/main.py` روی ویندوز پایتون ۳.۱۳ به بالا را رد می‌کند.

## سرور آپدیت

```cmd
admin\start-update-server.cmd
```

برای اولین اجرا `admin/update-server/.env` از روی `.env.example` ساخته می‌شود؛
`ADMIN_TOKEN` و `ADMIN_PANEL_HASH` را پر کنید. بدون `ADMIN_TOKEN` تمام
درخواست‌های `/admin` با ۴۰۱ رد می‌شوند.

پنل: `http://127.0.0.1:8898/admin/<ADMIN_PANEL_HASH>`

## امنیت

- کلید خصوصی هرگز در سورس، لاگ یا بیلد ویندوز قرار نمی‌گیرد.
- endpoint صدور کلید در engine فقط از `127.0.0.1` قابل دسترسی است.
- endpoint `/api/admin/mint-key` در دسک فقط برای owner است.
- دفتر کل صادرشده‌ها در `data/license/issued.json` نوشته می‌شود (gitignore).
