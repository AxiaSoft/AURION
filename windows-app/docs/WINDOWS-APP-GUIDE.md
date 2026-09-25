# راهنمای کامل تبدیل AURION به اپلیکیشن ویندوز (0-100)

این راهنما توضیح می‌دهد سیستم AURION دقیقاً چطور به یک اپلیکیشن ویندوزی
قابل‌نصب (MSI) تبدیل می‌شود، روی سیستم خام چه اتفاقی می‌افتد و برای اتصال
به MetaTrader چه باید کرد. همه مسیرها و نسخه‌های این سند با کد همین درخت
چک شده‌اند.

> فروشگاه فقط **کلید لایسنس** می‌فروشد، نه خود نرم‌افزار. فایل نصب فقط بعد
> از خرید کلید (لینک خصوصی / پنل کاربری) داده می‌شود، نه در صفحه عمومی.

---

## 1) معماری هدف

```
کاربر → اجرای AURION Setup MSI → نصب per-user (بدون ادمین)
→ اولین اجرا: چک پیش‌نیازها → پنجره گرافیکی نصب (در صورت نیاز)
→ دانلود/نصب خودکار Python + Node + پکیج‌ها → ری‌لانچ خودکار
→ Electron + Backend (8080) + Engine (18765) → Gate کلید → دسک اصلی
```

- **اپ ویندوز** شامل Backend (Node.js)، Engine (Python)، پل MT5 و فرانت است.
- **Bootstrapper** از قبل پیاده شده و داخل خود اپ است (§4): پنجره نصب
  Electron + دانلودر امن Node + فالبک PowerShell.
- **store/** (فروشگاه/کی‌سرور) و **admin/** (ابزار مالک) اپ‌های جداگانه‌اند و
  داخل MSI دسک نمی‌روند.

---

## 2) پیش‌نیازهای سیستم خام

ویندوز 10/11 نسخه 64 بیتی:

| پیش‌نیاز | نسخه قابل‌قبول | توضیح |
|---|---|---|
| Python | فقط 3.10 / 3.11 / 3.12 (اولویت 3.12) | **هرگز 3.13/3.14**: انجین با کد 2 خارج می‌شود و numpy پین‌شده ویل 3.13 ندارد |
| Node.js | 18 تا 30 (نصب خودکار: اول 22 LTS بعد 26) | اجرای backend + بیلد MSI |
| MetaTrader 5 | آخرین بیلد + EA نسخه 1.17 | اتصال به بازار (§6) |
| اینترنت | فقط برای نصب اول | دانلود Python/Node/pip/npm |

- **WebView2 لازم نیست**: Electron کرومیوم خودش را همراه دارد.
- **VC Redist جدا لازم نیست**: روی ویندوز 10/11 مدرن، ویل‌های numpy/pandas
  بدون نصب اضافه کار می‌کنند؛ نیازهای خودِ ترمینال MT5 را نصب‌کننده خودش
  پوشش می‌دهد.
- **ادمین لازم نیست**، مگر برای نصب MSI رسمی Node (آن MSI per-machine است).
  اگر کاربر ادمین نباشد، کافی است خودش یک Node 18+ نصب کند و دکمه نصب را
  دوباره بزند.

---

## 3) ساختار واقعی فایل‌های مرتبط

```
AURION/
├── windows-app/desktop/        # اپ Electron
│   ├── main.js                 # پروسه اصلی: چک پیش‌نیاز، اجرای engine+desk، پنجره‌ها
│   ├── runtime.js              # یافتن Python/Node، رفرش PATH، کشتن درخت پروسه
│   ├── prereq.js               # دانلودر/نصب‌کننده امن (بدون PowerShell)
│   ├── preload.js              # پل امن ipcRenderer
│   ├── icon.ico
│   └── package.json            # کانفیگ electron-builder ← خروجی MSI اینجاست
├── windows-app/installer/      # نصب پیش‌نیاز روی سیستم خام
│   ├── install-aurion.cmd          # نصب کنسولی + اجرای دسک بعدش
│   ├── install-aurion-secure.cmd   # نصب گرافیکی با فالبک کنسولی
│   ├── install-windows.ps1         # نصب‌کننده اصلی (فالبک اپ هم همین است)
│   └── install-windows-gui.ps1     # فرم گرافیکی که همان ps1 اصلی را صدا می‌زند
├── windows-app/packaging/      # ساخت MSI
│   ├── build-msi.ps1 / build-msi-windows.ps1   # مسیر اصلی (روی ویندوز)
│   ├── build-msi.py                            # مسیر دوم (wixl روی لینوکس)
│   └── launch-aurion.vbs                       # لانچر شورتکاتِ مسیر wixl
├── backend/                    # API دسک + WebSocket (پورت 8080)
├── engine/                     # انجین Python (پورت 18765) + EA نسخه 1.17 در engine/ea/
├── apps/web/                   # فرانت (توسط backend سرو می‌شود)
├── config/aurion.json          # کانفیگ زنده؛ license.keyserver_url و store_url اینجاست
├── data/                       # ساخته زمان اجرا؛ عمداً داخل هیچ MSI نمی‌رود
└── start-aurion.cmd / stop-aurion.cmd  # اجرای روزانه بدون MSI (درخت دستی)
```

پورت‌ها: دسک **8080** (روی همه اینترفیس‌ها، قابل دسترسی در LAN)، انجین
**18765** (loopback). پورت 18766 هیچ سرویسی ندارد (فقط در پاک‌سازی
پرونده‌های قدیمی لحاظ شده)؛ EA از **file inbox + HTTP روی 18765** حرف می‌زند.

---

## 4) Bootstrapper — همان که از قبل هست

Bootstrapper یک GUI جداگانه نیست؛ داخل `AURION.exe` است:

1. `main.js` در استارت‌آپ چک می‌کند: Python 3.10–3.12، Node 18–30،
   ایمپورت‌های `fastapi/numpy/pandas/sklearn`، `backend/node_modules` و
   وجود فایل‌های backend/engine.
2. اگر چیزی کم باشد، **پنجره نصب** (فارسی/راست‌به‌چپ) با بج وضعیت، دکمه
   «نصب خودکار پیش‌نیازها»، نوار پیشرفت و لاگ زنده باز می‌شود. پنجره اصلی
   تا پایان نصب پنهان می‌ماند.
3. با زدن دکمه، `run-installer` اجرا می‌شود:
   - **مسیر اول:** `prereq.js` — دانلود Python 3.12.10 و Node (اول 22.22.3
     LTS بعد 26.8.1/26.5.1) با اعتبارسنجی امضای باینری (MZ/PE برای EXE و
     OLE برای MSI)، نصب سایلنت، بعد `pip install -r engine/requirements.txt`
     + `MetaTrader5` و `psycopg` اختیاری، بعد `npm install --omit=dev` در
     backend، بعد ساخت پوشه‌های data و کپی `AurionBridge.mq5` در همه
     `MQL5\Experts\Aurion` های محلی.
   - **مسیر دوم (فالبک):** `windows-app/installer/install-windows.ps1` که
     همان کارها را با winget + دانلود مستقیم انجام می‌دهد. این فایل داخل
     MSI هم بسته‌بندی می‌شود تا فالبک در نسخه نصبی هم کار کند.
4. بعد از موفقیت، اپ خودکار بسته و **ری‌لانچ** می‌شود (بدون خروج کامل از
   اپلیکیشن)، engine و desk مخفی بالا می‌آیند و دسک لود می‌شود.
5. اگر کاربر پنجره نصب را قبل از اتمام ببندد، اپ کامل خارج می‌شود تا پروسه
   نیمه‌کاره و نامرئی باقی نماند.

نکته: نصب‌کننده کنسولی `install-aurion.cmd` (برای حالت درخت دستی روی
`D:\aurion`) همان `install-windows.ps1` را اجرا می‌کند؛ پس هر دو مسیر
نصب، یک منطق واحد دارند.

---

## 5) ساخت Installer MSI

### 5.1) مسیر اصلی: electron-builder روی ویندوز

```powershell
cd AURION
powershell -ExecutionPolicy Bypass -File windows-app\packaging\build-msi.ps1
# خروجی: dist\desktop\AURION Setup 1.0.0.msi
```

معادل دستی (پین‌شده و تست‌شده: electron 40.0.0 + electron-builder 26.0.12):

```powershell
cd windows-app\desktop
npm install
npm run dist:msi
```

- نصب **per-user** است: `%LOCALAPPDATA%\Programs\AURION`، بدون نیاز به ادمین
  (دلیل فنی: اپ در اولین اجرا `npm install` می‌زند و در `data/` و
  `config/aurion.json` می‌نویسد — زیر Program Files شدنی نیست).
- شورتکات دسکتاپ و استارت‌منو مستقیم به `AURION.exe` اشاره می‌کنند.
- داخل MSI می‌رود: `backend/src` + `backend/package.json`، کل `engine` (بدون
  pycache/venv)، کل `apps/web`، `config`، `lang` و اسکریپت فالبک نصب.
  `data/` نمی‌رود و در اولین اجرا ساخته می‌شود.

### 5.2) مسیر دوم: wixl روی لینوکس

```bash
sudo apt install wixl
python3 windows-app/packaging/build-msi.py
# خروجی: dist/AURION-Setup.msi  (+ dist/aurion.wxs برای WiX Toolset)
```

- این مسیر هم per-user است و در `%LOCALAPPDATA%\Programs\AURION` نصب می‌کند؛
  رجیستری در `HKCU\Software\AURION` نوشته می‌شود.
- شورتکات‌ها به `launch-aurion.vbs` اشاره می‌کنند که `start-aurion.cmd`
  کنار خودش را مخفی اجرا می‌کند.
- فایل‌های بالای 100MB با هشدار کنار گذاشته می‌شوند (در حال حاضر چنین
  فایلی در درخت نیست).

### 5.3) جایگزین‌های تست‌نشده

NSIS یا Inno Setup هم می‌توانند همین درخت را بسته‌بندی کنند، ولی در این
ریپو پیاده نشده‌اند و تست نشده‌اند. اگر روزی لازم شدند، همان قانون
per-user (درخت قابل‌نوشتن) باید رعایت شود.

---

## 6) اولین اجرا و اتصال MT5

1. MSI را اجرا کنید (بدون نیاز به ادمین) → نصب → اجرای خودکار.
2. اگر پیش‌نیازی کم بود، پنجره نصب گرافیکی → «نصب خودکار» → ری‌لانچ خودکار.
3. دسک باز می‌شود؛ اولین لانچ کاربر ادمین را می‌سازد (پسورد کارخانه نیست).
4. در MT5: فایل `engine\ea\AurionBridge.mq5` **نسخه 1.17** را با F7 کامپایل
   کنید و به هر چارت دلخواه بچسبانید (AutoTrading سبز؛ نه در Strategy Tester).
   نصب‌کننده همین فایل را در همه `MQL5\Experts\Aurion` های محلی کپی می‌کند.
5. لاگ زنده Experts باید این‌ها را نشان بدهد:
   `AURION: v1.17 FILE+HTTP` و `AURION: hello delivered v1.17`.
6. WebRequest اختیاری است؛ در صورت نیاز allow-list کنید: `127.0.0.1` و
   `http://127.0.0.1:18765` و `http://127.0.0.1:8080`.

حالت بدون MSI (توسعه/دستی): کل درخت را در `D:\aurion` بگذارید، بار اول
`windows-app\installer\install-aurion.cmd` و روزهای بعد `start-aurion.cmd`.

---

## 7) آپدیت سیستم (Source-Defined)

- آدرس آپدیت فقط در سورس تعریف می‌شود: `config/aurion.json ← update_server.url`
  (در فکتوری خالی است؛ مالک روی سرور خودش ست می‌کند، مثلاً سرور لوکال
  `admin/update-server` روی پورت **8898**). از داشبورد قابل تغییر نیست —
  بک‌اند این کلید را از هر patch ورودی حذف می‌کند.
- مسیر: `GET /api/system/update/state` ← `POST /api/system/update/check` ←
  `POST /api/system/update/apply`؛ بک‌آپ در `data/update_backups/<id>_<timestamp>`.
- بعد از آپدیت، دسک پیشنهاد ری‌استارت می‌دهد (`POST /api/host/restart`).
  در نسخه MSI بعد از آپدیت، خود `AURION.exe` را یک‌بار ببندید و باز کنید.
- جزئیات پنل: [admin/UPDATE-PANEL.md](../../admin/UPDATE-PANEL.md)

---

## 8) عدم عرضه از طریق فروشگاه — الزام امنیتی

- فروشگاه فقط کلید می‌فروشد. لینک دانلود MSI یا خصوصی است
  (مثلاً `https://cdn.axiasoft.com/...`) یا بعد از پرداخت در پنل کاربری
  نمایش داده می‌شود. **هرگز** در صفحه عمومی فروشگاه.
- در `config/aurion.json`:
  ```json
  { "license": {
      "store_url": "https://shop.axiasoft.com/aurion",
      "keyserver_url": "https://keys.axiasoft.com" } }
  ```
  `store_url` برای خرید کلید، `keyserver_url` برای فعال‌سازی.
- ساخت/باطل‌کردن کلید توسط مالک: [admin/ADMIN-KEY-GUIDE.md](../../admin/ADMIN-KEY-GUIDE.md)

---

## 9) چک‌لیست نهایی

- [ ] `powershell -ExecutionPolicy Bypass -File windows-app\packaging\build-msi.ps1` بدون خطا و خروجی `dist\desktop\AURION Setup 1.0.0.msi`؟
- [ ] نصب روی ویندوز 10/11 خام (ترجیحاً VM) بدون ادمین انجام شد؟
- [ ] پنجره نصب پیش‌نیازها آمد و بعد از اتمام، اپ خودکار ری‌لانچ شد؟
- [ ] `AURION.exe` بالا آمد و دسک را روی `http://127.0.0.1:8080` نشان داد؟
- [ ] Gate کلید پرمیوم را قبول کرد؟ (حالت رایگان هم با «کلید ندارم» ادامه می‌دهد)
- [ ] `AurionBridge.mq5` نسخه 1.17 کامپایل و به چارت وصل شد و تیک زنده آمد؟
- [ ] `update_server.url` روی مقدار سرور اصلی است و از داشبورد عوض نمی‌شود؟
- [ ] فایل MSI فقط بعد از خرید کلید قابل دانلود است؟

---

## 10) اسکریپت‌های کمکی موجود

- `scripts/restart-aurion.cmd` / `.sh`: ری‌استارت دسک.
- `scripts/hidden.vbs`: اجرای مخفی روی ویندوز.
- `scripts/fix-npm.ps1` / `scripts/fix-numpy.ps1`: تعمیر پکیج‌ها.
- [INSTALL-MSI.md](INSTALL-MSI.md): مرجع کوتاه نصب MSI.
- [admin/UPDATE-PANEL.md](../../admin/UPDATE-PANEL.md): پنل آپدیت.
- [admin/ADMIN-KEY-GUIDE.md](../../admin/ADMIN-KEY-GUIDE.md): کلید ادمین.
