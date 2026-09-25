# نصب AURION - نسخه MSI ویندوز

## خروجی نصب‌کننده
- **نوع:** MSI (Windows Installer)، ساخته‌شده با WiX (wixl روی لینوکس / WiX Toolset روی ویندوز)
- **نام فایل:** `dist\AURION-Setup.msi`
- **معماری:** x64
- **نیاز به دسترسی ادمین:** خیر (نصب per-user)
- **ویزارد:** برند AURION (بنر و آیکون اختصاصی). اگر نصب قبلی AURION پیدا شود،
  صفحه‌ای باز می‌شود که کاربر انتخاب می‌کند:
  - **Update** (پیش‌فرض) - نصب نسخه جدید در همان مسیر
  - **Repair** - اعتبارسنجی و نصب مجدد همه فایل‌های برنامه
  - **Change location** - تغییر محل نصب (داده‌ها + پیکربندی به‌صورت خودکار منتقل می‌شوند)

## چرا لایسنس و تنظیمات در آپدیت پاک نمی‌شوند؟
- لایسنس در `<install>\data\license` ذخیره می‌شود و `data/` جزو کامپوننت‌های MSI نیست؛
  هیچ آپدیدی آن را لمس نمی‌کند.
- فایل `config\aurion.json` (تنظیمات کاربری: پسورد MT5، otp لایسنس و ...) **داخل MSI
  نیست**؛ فقط کپی کارخانه‌ای `config\aurion.factory.json` نصب می‌شود. در اولین اجرا،
  برنامه `aurion.json` را از کارخانه می‌سازد. بنابراین آپدیت هرگز تنظیمات زنده کاربر
  را با نسخه کارخانه روی‌نویسی نمی‌کند.
- اگر کاربر محل نصب را عوض کند، اکشن `AurionMigrateState` پوشه‌ی `data/` (شامل
  لایسنس) و `config\aurion.json` را به محل جدید می‌کوبد.
- شناسه‌ی ماشین لایسنس از `MachineGuid` ویندوز است و در آپدیت/نصب مجدد ثابت می‌ماند.

## مسیر نصب پیش‌فرض
```
%LOCALAPPDATA%\Programs\AURION\
```
- درخت کامل برنامه (backend/engine/apps/config/lang/scripts + `start-aurion.cmd`)
- لانسر: `launch-aurion.vbs` → اجرای مخفی `start-aurion.cmd` (engine + desk) و باز شدن
  دسک در مرورگر روی `http://127.0.0.1:8080`
- کاربر می‌تواند در مرحله‌ی Directory مسیر را تغییر دهد.

> چرا per-user؟ چون اپ در اولین اجرا داخل درخت خودش `npm install` می‌زند و در
> `<tree>\data` و `<tree>\config\aurion.json` می‌نویسد. زیر `C:\Program Files`
> یک کاربر عادی اجازه هیچ‌کدام را ندارد.

## شورتکات‌ها
- **دسکتاپ:** `%USERPROFILE%\Desktop\AURION.lnk` → `launch-aurion.vbs`
- **استارت منو:** `Start Menu\Programs\AURION\AURION.lnk`
- رجیستری (برای تشخیص نصب در آپدیت‌های بعدی): `HKCU\Software\AURION`
  (`installed=1`, `InstallPath`, `Version`, `ProductCode`)
- شناسایی نسخه‌های قدیمی (electron-builder): فایل `AURION.exe` در مسیرهای
  `%LOCALAPPDATA%\Programs\AURION` و `Program Files\AURION`.

## نحوه ساخت MSI

### روی ویندوز (مسیر اصلی)
```powershell
# ساخت (اسکریپت، WiX Toolset 3.x را در PATH یا "Program Files (x86)\WiX Toolset v3*"
# پیدا می‌کند؛ اگر نبود، پیشنهاد می‌دهد نسخه‌ی رسمی 3.14 را از
# github.com/wixtoolset/wix3 دانلود و بی‌صدا نصب کند):
cd AURION
powershell -ExecutionPolicy Bypass -File windows-app\packaging\build-msi.ps1
```
خروجی: `dist\AURION-Setup.msi`
(بدون Python، از `windows-app\packaging\aurion.wxs` متکامیل استفاده می‌شود.)

### روی لینوکس (با wixl)
```bash
sudo apt install wixl
python3 windows-app/packaging/build-msi.py
```
خروجی: `dist/AURION-Setup.msi`

### بدون کامپایلر (فقط تولید wxs + لint)
```bash
python3 windows-app/packaging/build-msi.py --wxs    # تولید dist/aurion.wxs + lint
python3 windows-app/packaging/build-msi.py --check  # فقط lint
```

### مسیری قدیمی (electron-builder - فقط برای ارجاع)
```powershell
powershell -ExecutionPolicy Bypass -File windows-app\packaging\build-msi.ps1 -Electron
```
این مسیر همان ویزارد استاندارد electron-builder را می‌دهد (بدون برندینگ و بدون
صفحه‌ی Update/Repair/Change). MSI جدید WiX نصب‌کننده‌ی اصلی است.

## ارتقا از نصب قدیمی (electron)
MSI جدید UpgradeCode متفاوتی دارد، بنابراین آپدیت خودکار روی نسخه‌ی electron
انجام نمی‌شود؛ اما ویزارد نصب قبلی را تشخیص می‌دهد (فایل `AURION.exe`). با انتخاب
Update، نسخه‌ی جدید در همان مسیر نصب می‌شود، شورتکات دسکتاپ جایگزین می‌شود و
`data/` قدیمی (لایسنس و داده‌ها) دست‌نخورده باقی می‌ماند. برای پاک‌سازی کامل،
نسخه‌ی قدیمی را جداگانه از Settings → Apps حذف کنید.

## رفتار اولین اجرا روی سیستم خام
1. کاربر MSI را اجرا می‌کند → نصب بدون نیاز به ادمین.
2. اجرای `AURION.lnk`، `start-aurion.cmd` را مخفی بالا می‌آورد:
   - پیش‌نیازها (Python 3.10–3.12، Node.js، پکیج‌های pip/npm) چک می‌شوند
   - اگر چیزی کم باشد، `install-windows.ps1` به‌صورت خودکار اجرا می‌شود
3. بعد از آماده‌شدن دسک (پورت 8080)، صفحه در مرورگر پیش‌فرض باز می‌شود.
4. اولین لانچ، کاربر ادمین را می‌سازد (پسورد کارخانه وجود ندارد).

## حذف نصب
- Settings → Apps → AURION → Uninstall
- پوشه‌ی `data\` (داخل پوشه‌ی نصب) برای حفظ تنظیمات باقی می‌ماند؛ برای پاک‌سازی
  کامل (شامل لایسنس)، دستی حذفش کنید.
