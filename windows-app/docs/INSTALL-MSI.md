# نصب AURION - نسخه MSI ویندوز

## خروجی نصب‌کننده
- **نوع:** MSI (Windows Installer)
- **نام فایل:** `AURION-Setup.msi` یا `AURION Setup 1.0.0.msi`
- **معماری:** x64
- **نیاز به دسترسی ادمین:** بله (برای نصب در Program Files)

## مسیر نصب پیش‌فرض
```
C:\Program Files\AURION\
```
- پوشه برنامه: `C:\Program Files\AURION\`
- فایل اجرایی: `C:\Program Files\AURION\AURION.exe` (Electron)
- اسکریپت‌ها: `C:\Program Files\AURION\start-aurion.cmd`
- داده‌ها: `C:\Program Files\AURION\data\` (با پرمیشن 0700)

کاربر می‌تواند در مرحله نصب مسیر را تغییر دهد (oneClick=false).

## شورتکات‌ها
- **دسکتاپ:** `C:\Users\Public\Desktop\AURION.lnk` یا `Desktop\AURION.lnk`
  - آیکون: `aurion.ico`
  - هدف: `launch-aurion.vbs` در پوشه نصب
  - توضیح: "AURION live desk - C:\Program Files\AURION"

- **استارت منو:** `Start Menu\Programs\AURION\AURION.lnk`

## نحوه ساخت MSI

### روی ویندوز (پیشنهادی)
```powershell
cd AURION
powershell -ExecutionPolicy Bypass -File windows-app\packaging\build-msi-windows.ps1
```
خروجی: `dist\desktop\AURION Setup 1.0.0.msi`

### روی لینوکس (با wixl)
```bash
python3 windows-app/packaging/build-msi.py
```
خروجی: `dist/AURION-Setup.msi`
- این نسخه کل سورس را در MSI می‌گذارد و به Program Files نصب می‌کند
- نیاز به `wixl` (sudo apt install wixl)

### با electron-builder مستقیم
```bash
cd windows-app/desktop
npm install
npm run dist:msi
```

## رفتار اولین اجرا روی سیستم خام

1. کاربر `AURION-Setup.msi` را اجرا می‌کند → نصب در `C:\Program Files\AURION`
2. شورتکات دسکتاپ ساخته می‌شود
3. کاربر شورتکات را می‌زند → `launch-aurion.vbs` → `start-aurion.cmd`
4. اگر پیش‌نیازها نباشد، پنجره گرافیکی نصب باز می‌شود:
   - بررسی Python 3.12, Node.js 18+, pip, npm
   - دکمه "نصب خودکار"
   - Progress bar + log زنده
   - دانلود امن با TLS 1.2+ از python.org و nodejs.org
5. بعد از نصب پیش‌نیازها، desk روی `http://127.0.0.1:8080` بالا می‌آید
6. مرورگر Electron باز می‌شود

## امنیت نصب‌کننده MSI
- InstallScope: perMachine (نیاز به admin)
- InstallPrivileges: elevated
- فایل‌ها با KeyPath و GUID پایدار
- Registry: `HKLM\Software\AURION\InstallPath = [INSTALLDIR]`
- Uninstall از Control Panel
- UpgradeCode ثابت: `A1B2C3D4-E5F6-7890-ABCD-AURION000001`

## حذف نصب
- Control Panel → Programs → AURION → Uninstall
- یا اجرای دوباره MSI → Remove
- پوشه `data\` باقی می‌ماند (برای حفظ تنظیمات) - کاربر می‌تواند دستی حذف کند
