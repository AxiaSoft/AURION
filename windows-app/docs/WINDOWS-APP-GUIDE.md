# راهنمای کامل تبدیل AURION به اپلیکیشن ویندوز (0-100)

این راهنما توضیح می‌دهد چگونه سیستم AURION (به‌جز سایت فروشگاهی) به یک اپلیکیشن ویندوز تبدیل شود که بعد از نصب روی سیستم خام، پیش‌نیازها را در محیط گرافیکی دانلود و نصب کند و سپس اپلیکیشن اصلی بالا بیاید. همچنین تاکید شده که سیستم نباید از طریق سایت فروشگاهی به کسی عرضه شود — فقط اپلیکیشن ویندوز توزیع شود.

---

## 1) معماری هدف

```
کاربر → دانلود Installer (MSI/EXE) → نصب → اولین اجرا (Bootstrapper GUI)
→ چک پیش‌نیازها → دانلود/نصب خودکار → اجرای AURION Desktop (Electron) + Backend + Engine
→ Gate (کلید لایسنس) → دسک اصلی
```

- **فروشگاه (Shop Site) فقط برای فروش کلید** است، نه برای عرضه خود نرم‌افزار.
- **اپ ویندوز** شامل Backend (Node.js), Engine (Python), MT5 Bridge, و Frontend است.
- **Bootstrapper** یک GUI کوچک است که قبل از اجرای اصلی، پیش‌نیازها را نصب می‌کند.

---

## 2) پیش‌نیازهای سیستم خام

برای اجرای AURION روی ویندوز خام (Windows 10/11 64-bit):

| پیش‌نیاز | نسخه پیشنهادی | دلیل |
|---------|---------------|------|
| Node.js | 26 Current (یا 22+ / 18+ سازگار) — بیلد با Electron 40 + builder 26.0.12 | اجرای backend + ساخت MSI |
| Python | 3.12 (یا 3.11/3.13 64-bit) | اجرای engine + AI |
| Visual C++ Redistributable | 2015-2022 x64 | نیاز Python/MT5 |
| WebView2 Runtime | آخرین نسخه | نیاز Electron (اگر سیستم قدیمی) |
| MetaTrader 5 | آخرین بیلد | اتصال به بازار |
| Git (اختیاری) | - | برای آپدیت از سورس |

> نکته: Bootstrapper باید این‌ها را چک کند و در صورت نبود، دانلود و نصب کند.

---

## 3) ساختار پروژه فعلی مرتبط

```
AURION/
├── windows-app/desktop/          # Electron app (Windows app اصلی)
│   ├── package.json
│   ├── src/main.js        # Main process
│   └── ...
├── backend/               # Node.js backend (desk)
├── engine/                # Python engine
│   ├── aurion/
│   └── requirements.txt
├── config/aurion.json     # شامل update_server.url و license.keyserver_url
├── scripts/
│   ├── restart-aurion.cmd / .sh
│   ├── hidden.vbs
│   └── installer/         # اسکریپت‌های ساخت MSI
└── docs/INSTALL-MSI.md    # راهنمای نصب موجود
```

---

## 4) Bootstrapper GUI — طراحی 0-100

### 4.1) چی باید باشد؟

یک برنامه کوچک (می‌تواند با Electron, Python Tkinter, یا C# WPF) که:

1. **UI گرافیکی** دارد: Progress bar + لاگ + دکمه‌ها.
2. **چک سیستم**: Node, Python, VC Redist, WebView2, MT5 نصب است؟
3. **دانلود خودکار**: اگر نبود، از لینک رسمی دانلود کند.
4. **نصب Silent**: با پرچم `/SILENT` یا `/quiet`.
5. **نصب وابستگی‌های پروژه**:
   - `npm ci` در `backend/` و `windows-app/desktop/`
   - `pip install -r engine/requirements.txt`
6. **اجرای AURION**: بعد از اتمام، `windows-app/desktop` را اجرا کند.

### 4.2) نمونه ساده Bootstrapper با Electron (پیشنهادی)

`windows-app/desktop/src/bootstrapper.js` (pseudo):

```js
const { execSync } = require('child_process');
const https = require('https');
const fs = require('fs');

async function checkAndInstall() {
  updateUI("Checking Node.js...");
  if (!isInstalled("node --version")) {
    await downloadAndInstall("https://nodejs.org/dist/v26.8.1/node-v26.8.1-x64.msi", "/quiet");
  }
  updateUI("Checking Python...");
  if (!isInstalled("python --version")) {
    await downloadAndInstall("https://www.python.org/ftp/python/3.12.10/python-3.12.10-amd64.exe", "/quiet InstallAllUsers=1 PrependPath=1");
  }
  updateUI("Checking VC Redist...");
  if (!isVCRedistInstalled()) {
    await downloadAndInstall("https://aka.ms/vs/17/release/vc_redist.x64.exe", "/quiet");
  }
  updateUI("Installing dependencies...");
  execSync("npm ci", { cwd: "../backend" });
  execSync("pip install -r requirements.txt", { cwd: "../engine" });
  execSync("npm ci", { cwd: "." });
  updateUI("Launching AURION...");
  execSync("npm start", { cwd: "." });
}
```

### 4.3) نسخه PowerShell GUI (سریع)

`scripts/bootstrapper.ps1`:

```powershell
Add-Type -AssemblyName System.Windows.Forms
$form = New-Object System.Windows.Forms.Form
$form.Text = "AURION Setup"
$form.Size = New-Object System.Drawing.Size(500,400)

$label = New-Object System.Windows.Forms.Label
$label.Text = "Checking prerequisites..."
$label.Location = New-Object System.Drawing.Point(20,20)
$form.Controls.Add($label)

$progress = New-Object System.Windows.Forms.ProgressBar
$progress.Location = New-Object System.Drawing.Point(20,50)
$progress.Size = New-Object System.Drawing.Size(440,30)
$form.Controls.Add($progress)

function Check-Command($cmd) {
  try { Invoke-Expression "$cmd --version" | Out-Null; return $true } catch { return $false }
}

function Install-Node {
  $label.Text = "Downloading Node.js 26..."
  Invoke-WebRequest -Uri "https://nodejs.org/dist/v26.8.1/node-v26.8.1-x64.msi" -OutFile "$env:TEMP\node.msi"
  Start-Process msiexec.exe -ArgumentList "/i $env:TEMP\node.msi /quiet" -Wait
}

# ... similar for Python, VC Redist

$form.ShowDialog()
```

---

## 5) ساخت Installer MSI/EXE

### 5.1) ابزار پیشنهادی

- **Electron Builder**: برای ساخت `AURION Setup.exe` (NSIS)
- **WiX Toolset** یا **Inno Setup**: برای MSI حرفه‌ای

### 5.2) با Electron Builder

در `windows-app/desktop/package.json`:

```json
{
  "build": {
    "appId": "com.axiasoft.aurion",
    "productName": "AURION",
    "win": {
      "target": ["nsis"],
      "icon": "icons/icon.ico"
    },
    "nsis": {
      "oneClick": false,
      "allowToChangeInstallationDirectory": true,
      "createDesktopShortcut": true,
      "include": "scripts/installer.nsh"
    },
    "extraResources": [
      {"from": "../../backend", "to": "backend"},
      {"from": "../../engine", "to": "engine"},
      {"from": "../../config", "to": "config"}
    ]
  }
}
```

`scripts/installer.nsh` برای چک پیش‌نیازها در زمان نصب:

```nsh
!macro customInstall
  DetailPrint "Checking prerequisites..."
  ; Check Node.js
  nsExec::ExecToStack 'node --version'
  Pop $0
  ${If} $0 != 0
    DetailPrint "Installing Node.js..."
    File /oname=$TEMP\node.msi "prereqs\node.msi"
    ExecWait 'msiexec /i $TEMP\node.msi /quiet'
  ${EndIf}
!macroend
```

ساخت (با Node.js 26):

```bash
# Node 26 نصب شده باشد: node -v باید v26.x باشد
# Electron 40.0.0 + electron-builder 26.0.12 از Node 26 پشتیبانی می‌کند (Electron داخلی Node 24 دارد، اما host می‌تواند Node 26 باشد)
cd windows-app/desktop
npm install
npm run dist:win
# یا
npm run dist:msi
# خروجی: ../../dist/desktop/AURION-Setup-1.0.0.msi

# اگر خطای native module داشتید:
npm install --force
```

> نکته Node 26: اگر روی ماشین بیلد Node 26 دارید، `electron-builder@26.0.12` بدون مشکل کار می‌کند. Electron 40 داخلش Node 24.11.1 دارد (جدیدترین پایدار تا Jan 2026) که با کد ما سازگار است. اگر حتماً می‌خواهید Electron با Node 26 باشد، باید منتظر Electron 41+/42 باشید، اما بیلد فعلی با Node 26 host کاملاً تست شده و MSI تولید می‌کند.

### 5.3) با Inno Setup (ساده‌تر)

`scripts/aurion.iss`:

```iss
[Setup]
AppName=AURION
AppVersion=1.0.0
DefaultDirName={pf}\AURION
OutputBaseFilename=AURION-Setup
Compression=lzma2

[Files]
Source: "..\windows-app\desktop\dist\*"; DestDir: "{app}"; Flags: recursesubdirs
Source: "..\backend\*"; DestDir: "{app}\backend"; Flags: recursesubdirs
Source: "..\engine\*"; DestDir: "{app}\engine"; Flags: recursesubdirs
Source: "prereqs\node.msi"; DestDir: "{tmp}"; Flags: deleteafterinstall
Source: "prereqs\python.exe"; DestDir: "{tmp}"; Flags: deleteafterinstall

[Run]
Filename: "msiexec.exe"; Parameters: "/i {tmp}\node.msi /quiet"; Check: not IsNodeInstalled
Filename: "{tmp}\python.exe"; Parameters: "/quiet InstallAllUsers=1 PrependPath=1"; Check: not IsPythonInstalled
Filename: "{app}\AURION.exe"; Description: "Launch AURION"; Flags: nowait postinstall

[Code]
function IsNodeInstalled(): Boolean;
begin
  Result := FileExists(ExpandConstant('{pf}\nodejs\node.exe'));
end;
```

---

## 6) اولین اجرا — تجربه کاربر خام

1. کاربر `AURION-Setup.exe` را دانلود می‌کند (از لینک مستقیم، نه از فروشگاه).
2. اجرا → UAC → نصب در `C:\Program Files\AURION`.
3. در پایان نصب، تیک **Launch AURION** فعال است.
4. Bootstrapper GUI باز می‌شود:
   ```
   [AURION Setup]
   Checking prerequisites...
   [=====>     ] 45%
   - Node.js: Found v20.11.0
   - Python: Not found → Downloading...
   - VC Redist: Installing...
   ```
5. بعد از اتمام، دسک اصلی باز می‌شود → صفحه Gate → وارد کردن کلید لایسنس → دسک.
6. MT5 را نصب نکرده؟ Bootstrapper لینک دانلود MT5 را نشان می‌دهد و بعد از نصب، مسیر ترمینال را در `Settings → MT5` ست می‌کند.

---

## 7) آپدیت سیستم (Source-Defined)

- لینک آپدیت در `config/aurion.json` → `update_server.url` تعریف شده (مثلاً `http://127.0.0.1:8898` یا سرور اصلی).
- این لینک **از داشبورد قابل تغییر نیست** — فقط سازنده می‌تواند در سورس عوض کند.
- دسک از همین لینک چک می‌کند: `GET /api/system/update/state` → `POST /api/system/update/check` → `POST /api/system/update/apply`.
- بعد از آپدیت، دسک پیشنهاد ری‌استارت می‌دهد (`POST /api/host/restart`).

برای ویندوز اپ:
- آپدیت‌ها فایل‌های `backend/src`, `engine/aurion`, `apps/web/js` را جایگزین می‌کنند.
- بک‌آپ در `data/update_backups/<id>_<timestamp>` ذخیره می‌شود.
- بعد از آپدیت، Electron app را ری‌استارت کنید.

---

## 8) عدم عرضه از طریق فروشگاه — الزام امنیتی

- **فروشگاه فقط کلید می‌فروشد**، نه خود نرم‌افزار.
- لینک دانلود اپ ویندوز باید:
  - یا لینک مستقیم خصوصی (مثلاً `https://cdn.axiasoft.com/AURION-Setup.exe`) باشد که فقط بعد از خرید کلید نمایش داده می‌شود.
  - یا از طریق پنل کاربری بعد از تایید پرداخت.
- **هرگز** فایل نصب را در صفحه عمومی فروشگاه قرار ندهید.
- در `config/aurion.json`:
  ```json
  {
    "license": {
      "store_url": "https://shop.axiasoft.com/aurion",
      "keyserver_url": "https://keys.axiasoft.com"
    },
    "update_server": {
      "url": "https://updates.axiasoft.com"
    }
  }
  ```
  `store_url` برای خرید کلید، `update_server.url` برای آپدیت اپ.

---

## 9) چک‌لیست نهایی ساخت اپ ویندوز

- [ ] `windows-app/desktop` → `npm run dist:win` بدون خطا؟
- [ ] Installer روی ویندوز 10 خام تست شد؟ (VM)
- [ ] Bootstrapper پیش‌نیازها را درست تشخیص می‌دهد؟
- [ ] بعد از نصب، `AURION.exe` بالا می‌آید و به `http://127.0.0.1:8080` وصل می‌شود؟
- [ ] Gate کلید پرمیوم را قبول می‌کند؟
- [ ] MT5 Bridge 1.17 کامپایل و به چارت متصل شد؟
- [ ] `config/aurion.json` → `update_server.url` درست ست شده و از داشبورد قابل تغییر نیست؟
- [ ] فایل نصب فقط بعد از خرید کلید قابل دانلود است، نه عمومی؟

---

## 10) اسکریپت‌های کمکی موجود

- `scripts/restart-aurion.cmd` و `restart-aurion.sh`: ری‌استارت دسک.
- `scripts/hidden.vbs`: اجرای مخفی روی ویندوز.
- `docs/INSTALL-MSI.md`: راهنمای قبلی نصب MSI.
- `docs/UPDATE-PANEL.md`: راهنمای پنل آپدیت.

---

**پایان راهنمای ویندوز اپ — برای راهنمای کلید ادمین به `ADMIN-KEY-GUIDE.md` مراجعه کنید.**
