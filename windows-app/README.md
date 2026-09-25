# windows-app/ — اپلیکیشن ویندوز و ساخت آن

همه فایل‌های مربوط به **اپلیکیشن ویندوز** و **بیلد/بسته‌بندی** آن.

```
windows-app/
├── desktop/                 اپلیکیشن Electron
│   ├── main.js              پروسه اصلی: پیش‌نیازها، راه‌اندازی engine + desk، پنجره‌ها
│   ├── runtime.js           سیاست مشترک: یافتن پایتون/نود، PATH، کشتن درخت پروسه
│   ├── prereq.js            دانلود و نصب پیش‌نیازها (بدون PowerShell)
│   ├── preload.js           پل امن ipcRenderer
│   ├── icon.ico
│   └── package.json         کانفیگ electron-builder (خروجی MSI)
├── installer/               نصب پیش‌نیازها روی سیستم خام
│   ├── install-aurion.cmd           اولین نصب (کنسول)
│   ├── install-aurion-secure.cmd    نصب گرافیکی، با fallback کنسول
│   ├── install-windows.ps1          نصب‌کننده اصلی (Python 3.12 + Node LTS + pip + npm)
│   └── install-windows-gui.ps1      نسخه Windows Forms
├── packaging/               ساخت MSI
│   ├── build-msi.ps1                ورودی ساده → build-msi-windows.ps1
│   ├── build-msi-windows.ps1        WiX Toolset روی ویندوز (-Electron: مسیر قدیمی)
│   ├── build-msi.py                 تولید wxs + ساخت با wixl (لینوکس/ویندوز)
│   ├── lint_wxs.py                  اعتبارسنج ساختاری wxs (بدون کامپایلر)
│   ├── make-wizart-assets.py        بازتولید بنر/آیکون ویزارد (ImageMagick)
│   ├── aurion.wxs                   آخرین نسخه‌ی تولیدشده (fallback بدون Python)
│   ├── wix/banner.bmp               بنر 493x58 ویزارد (برند AURION)
│   ├── wix/aurion-small.ico         آیکون کوچک ویزارد
│   ├── launch-aurion.vbs            لانچر مخفی برای شورتکات
│   └── aurion.ico
└── docs/
    ├── INSTALL-MSI.md
    └── WINDOWS-APP-GUIDE.md
```

## ساخت MSI

MSI اصلی، نسخه‌ی **برند AURION با ویزارد هوشمند** (WiX) است: اگر نصب قبلی پیدا
شود، ویزارد نسخه‌ی نصب‌شده را تشخیص می‌دهد — نسخه‌ی قدیمی‌تر →
**Update / Remove / Change location**؛ **همین نسخه** → فقط
**Repair / Remove / Change location** (Update برای نسخه‌ی تکراری نشان داده
نمی‌شود)؛ نسخه‌ی **جدیدتر** → پیام توضیحی و توقف. «Remove» نصبِ فعلی را لغو
می‌کند و نسخه‌ی شناسایی‌شده را بیرون از همین نشست حذف می‌کند — نتیجه: اپ
کامل پاک می‌شود، نه اینکه دوباره نصب شود. لایسنس + داده‌ها + تنظیمات در همه‌ی
حالت‌ها دست‌نخورده می‌مانند (جزئیات در `docs/INSTALL-MSI.md`).

```powershell
# روی ویندوز (نیاز: Node.js 22 + Python 3؛ WiX 3.14 را خود اسکریپت پیدا یا نصب می‌کند)
# 1) AURION.exe را با electron-builder --dir می‌سازد (dist\desktop\win-unpacked)
# 2) همان اپ را در MSI برنددار WiX بسته‌بندی می‌کند
powershell -ExecutionPolicy Bypass -File windows-app\packaging\build-msi.ps1
# خروجی: dist\AURION-Setup.msi
```

MSI یک **اپلیکیشن ویندوزی** نصب می‌کند: shortcut → `AURION.exe` (پنجره‌ی
بومی؛ بدون cmd و بدون مرورگر). engine و desk مخفی داخل خود اپ اجرا می‌شوند.
روی سیستم خامِ مشتری، اولین اجرا خودش Python 3.12 + Node 22 + پکیج‌ها را
بی‌صدا دانلود/نصب می‌کند و بعد desk را باز می‌کند. در پایان ویزارد نصب،
گزینه‌ی «Start AURION now» به‌طور پیش‌فرض فعال است.

**حذف/تعمیر**: در Control Panel (و Settings → Apps) فقط **یک** ورودی «AURION»
هست؛ کلیک روی **Uninstall** حذف **واقعی و کامل** را انجام می‌دهد: اول موتور
MSI (پنجره‌ی پیشرفت واقعی)، بعد پاک‌سازی اجباریِ بقیه‌ی چیزها — درخت برنامه،
`HKCU\Software\AURION`، ثبت‌های Apps & features و **همه‌ی شورتکات‌ها**
(دسکتاپ، استارت‌منو، پین‌شده‌ی تسک‌بار). این مسیر حتی وقتی ثبت/کشِ MSI خراب
است هم واقعاً حذف می‌کند (همان حالتی که پنجره می‌آمد ولی هیچ پاک نمی‌شد).
داده‌ها (`data/` + کانفیگ) برای استفاده‌ی بعدی نگه داشته می‌شوند. «Change»
ویزارد برند‌دار را باز می‌کند (Repair / Remove با تیک «Keep my license,
settings and data»). قبل از Repair/Remove در همه‌ی مسیرها، اپ و پروسه‌های
python/node وابسته به پوشه‌ی نصب خودکار بسته می‌شوند. لاگ:
`%TEMP%\aurion-arp-clean.log`.

در پایان هر نصب/حذف، یک پاک‌کننده‌ی جدا (wscript) اجرا می‌شود: ثبت‌های
قدیمی/یتیتم «AURION» را از Apps & features بردار می‌کند (اول `msiexec /x`
بی‌صدا، بعد حذف اجباری ثبت) و وقتی کاربر Remove را زده باشد، درخت برنامه،
`HKCU\Software\AURION` و شورتکات‌ها را هم پاک می‌کند. اگر چیزی زیر HKLM
بماند، یک‌بار با اجازه‌ی UAC دوباره تلاش می‌شود. لاگ:
`%TEMP%\aurion-arp-clean.log`. نسخه‌ی محصول همیشه سه‌رقمی است (مثل `1.0.0`
نه `1.0.0.0`).

حالت دیباگ (بدون Electron، لانچر اسکریپتی): `build-msi.ps1 -TreeOnly`.

```bash
# روی لینوکس (نیاز به wixl)
sudo apt install wixl
python3 windows-app/packaging/build-msi.py
# خروجی: dist/AURION-Setup.msi
```

مسیر قدیمی electron-builder (ویزارد استاندارد، بدون برندینگ):
`build-msi.ps1 -Electron`.

## چرا نصب per-user است

`msi.perMachine` روی `false` است، یعنی نصب در
`%LOCALAPPDATA%\Programs\AURION`. دلیلش فنی است، نه سلیقه‌ای:

- `backend/src/paths.js` همه‌چیز را نسبت به ریشه درخت پیدا می‌کند و در
  `<tree>/data` و `<tree>/config/aurion.json` می‌نویسد.
- `engine/aurion/config.py` هم `runtime-state.json` را در `<tree>/data` می‌نویسد.
- اپلیکیشن در اولین اجرا داخل `<tree>/backend` دستور `npm install` می‌زند.

زیر `C:\Program Files` یک کاربر عادی هیچ‌کدام از این کارها را نمی‌تواند انجام
دهد. اگر نصب per-machine می‌ماند، ساخت کاربر در اولین اجرا شکست می‌خورد.

## سیاست پایتون و نود

| جزء | نسخه |
|---|---|
| پایتون | فقط ۳.۱۰ / ۳.۱۱ / ۳.۱۲ — اولویت با ۳.۱۲ |
| نود | ۱۸ تا ۳۰ |

`engine/main.py` روی ویندوز با پایتون ۳.۱۳ به بالا با کد ۲ خارج می‌شود و
`numpy==1.26.4` (در `engine/requirements.txt`) ویل ۳.۱۳ ندارد. به همین دلیل
`windows-app/desktop/runtime.js` هرگز ۳.۱۳ را انتخاب نمی‌کند و همان
مفسری را که پیدا می‌کند هم برای `pip` و هم برای اجرای engine به کار می‌برد.

## اجرای توسعه‌ای

```bash
cd windows-app/desktop
npm install
npm start
```
