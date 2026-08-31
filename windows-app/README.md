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
│   ├── build-msi-windows.ps1        electron-builder روی ویندوز
│   ├── build-msi.py                 WiX/wixl روی لینوکس (کل سورس)
│   ├── launch-aurion.vbs            لانچر مخفی برای شورتکات
│   └── aurion.ico
└── docs/
    ├── INSTALL-MSI.md
    └── WINDOWS-APP-GUIDE.md
```

## ساخت MSI

```powershell
powershell -ExecutionPolicy Bypass -File windows-app\packaging\build-msi.ps1
# یا مستقیم
cd windows-app\desktop
npm install
npm run dist:win
```

خروجی: `dist\desktop\AURION Setup 1.0.0.msi`

روی لینوکس (نیاز به `wixl`):

```bash
python3 windows-app/packaging/build-msi.py
```

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
