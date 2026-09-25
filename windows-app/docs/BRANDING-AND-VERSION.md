# نسخه، لوگو و بنرها — از کجا عوض کنیم؟

## ۱) شماره نسخه (Version)

| کجا | فایل | توضیح |
|---|---|---|
| **منبع اصلی نسخهٔ MSI** | `engine/aurion/__init__.py` → `__version__ = "1.0.0"` | `build-msi.py` این مقدار را می‌خواند و در `Product/@Version`، ARP، و «Update to version …» ویزارد می‌گذارد. |
| نسخهٔ اپ ویندوز (AURION.exe) | `windows-app/desktop/package.json` → `"version"` | با `brand-exe.js` روی Properties فایل `AURION.exe` (FileVersion/ProductVersion) نوشته می‌شود. |
| بک‌اند (اختیاری) | `backend/package.json` → `"version"` و `config/aurion.factory.json` → `version` | نسخه‌ای که آپدیتر/داشبورد نشان می‌دهد. |
| Cache-bust فایل‌های وب | `apps/web/index.html` → `?v=desk65` (css و js) | بعد از هر تغییر در `app.css`/`app.js` عدد را یکی زیاد کنید تا مرورگر/Electron نسخهٔ قدیمی را نشان ندهد. |

> عدد را در هر ۳ جای اول یکی نگه دارید (مثلاً `1.1.0`). برای آپگرید MSI حتماً نسخهٔ جدید **بزرگ‌تر** از قبلی باشد (MajorUpgrade فقط سه بخش اول را می‌بیند).
> **فرمت نسخه همیشه سه‌بخشی است** (`1.0.0` نه `1.0.0.0`) — `build-msi.py` هر ورودی را به `X.Y.Z` نرمال می‌کند و `lint_wxs.py` بیلدِ چهاربخشی را رد می‌کند.
> بیلد یک‌باره با نسخهٔ دلخواه: `python windows-app\packaging\build-msi.py --wxs --version 1.1.0 ...` (اسکریپت PS خودش `__version__` را می‌خواند).

## ۲) آیکون‌ها (لوگو)

| فایل | مصرف |
|---|---|
| `windows-app/desktop/icon.ico` | آیکون **AURION.exe**، پنجره‌های Electron، تسک‌بار، و (از این نسخه) آیکون داخل Apps & features. |
| `windows-app/packaging/aurion.ico` | آیکون MSI / ARP (`ARPPRODUCTICON`) و شورت‌کات‌های دسکتاپ/استارت. بهتر است کپیِ همان `icon.ico` باشد. |
| `windows-app/packaging/wix/aurion-small.ico` | آیکون کوچک گوشهٔ دیالوگ‌های ویزارد WiX (Info/Exclamation/New/Up). |
| `apps/web/icons/mark.png` | لوگوی داخل اپ وب (favicon، صفحهٔ ورود) و منبع ساخت بنرها. |
| `apps/web/assets/axiasoft-logo.png` | لوگوی Axiasoft در صفحهٔ ورود. |
| `windows-app/desktop/main.js` → `AURION_MARK` (SVG) | لوگوی برداری صفحه‌های نصب پیش‌نیاز / اسپلش / صفحهٔ خطا در Electron. |

فرمت `.ico` باید چندسایزه باشد (16/32/48/64/128/256). ساخت از PNG:
```powershell
# ImageMagick
magick logo-1024.png -define icon:auto-resize=256,128,64,48,40,32,24,20,16 windows-app\desktop\icon.ico
copy windows-app\desktop\icon.ico windows-app\packaging\aurion.ico
```

## ۳) بنر و تصویر ویزارد MSI

| فایل | اندازه | کجا دیده می‌شود |
|---|---|---|
| `windows-app/packaging/wix/banner.bmp` | **493×58** | نوار بالای همهٔ صفحه‌های میانی ویزارد (WixUIBannerBmp). |
| `windows-app/packaging/wix/dialog.bmp` | **493×312** | تصویر سمت چپ صفحهٔ Welcome و Finish (WixUIDialogBmp). |

- فرمت باید BMP 24-bit بدون فشرده‌سازی باشد. اندازه‌ها را دقیق رعایت کنید وگرنه WiX آن را کش/برش می‌کند.
- ناحیهٔ سمت چپ بنر (تقریباً ۳۳۰px اول) روشن نگه داشته شود چون WiX عنوان صفحه را با متن تیره روی آن می‌نویسد.
- تولید خودکار از `mark.png`: 
  ```bash
  python3 windows-app/packaging/make-wizart-assets.py --font <DejaVuSans-Bold.ttf> --font-tagline <DejaVuSans.ttf>
  ```
  (خروجی: banner.bmp، aurion-small.ico، banner-preview.png). یا هر ابزار گرافیکی و ذخیره با همین نام‌ها/اندازه‌ها.
- بعد از تعویض هیچ تغییری در کد لازم نیست؛ فقط MSI را دوباره بیلد کنید.

## ۴) متن‌ها/نام‌ها در ویزارد

`windows-app/packaging/build-msi.py`: `Name="AURION"`, `Manufacturer="Axiasoft"`, متن دیالوگ‌های `AurionModeDlg` / `AurionRemoveDlg`، متن دکمهٔ «Start AURION now» (`WIXUI_EXITDIALOGOPTIONALCHECKBOXTEXT`).
**`UPGRADE` (UpgradeCode) را هرگز عوض نکنید** — وگرنه نصب‌های قبلی به‌عنوان محصول جداگانه شناخته می‌شوند.

## ۵) بعد از هر تغییر

```powershell
git pull
powershell -ExecutionPolicy Bypass -File windows-app\packaging\build-msi.ps1
```
