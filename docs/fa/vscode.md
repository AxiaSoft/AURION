# کار با AURION در VS Code — ساخت MSI و به‌روزرسانی از گیت‌هاب

همهٔ این‌ها از منوی **Run Task** هم در دسترس‌اند (`Ctrl+Shift+P` ← `Tasks: Run Task`)،
و تعریفشان در [`.vscode/tasks.json`](../../.vscode/tasks.json) است. این صفحه
همان دستورها را خام می‌دهد، برای وقتی که ترمینال سریع‌تر است.

ترمینال پیش‌فرض VS Code روی ویندوز **PowerShell** است. اگر ترمینالتان
`cmd.exe` است، دستورهای PowerShell را با `powershell -Command "..."` اجرا کنید.

---

## ۱) به‌روزرسانی از گیت‌هاب

**Run Task ← `AURION: Update from GitHub`**

یا دستی، به همین ترتیب:

```powershell
# ۱. اول برنامه را ببندید
.\stop-aurion.cmd

# ۲. سورس را بکشید
git pull --ff-only --autostash origin $(git rev-parse --abbrev-ref HEAD)

# ۳. وابستگی‌ها را تازه کنید
npm install --no-audit --no-fund
npm install --no-audit --no-fund --prefix backend
python -m pip install -r engine\requirements.txt
```

سه نکته که هر کدامشان یک بار شما را گیر می‌اندازند:

**چرا اول `stop-aurion.cmd`؟** فقط برای جلوگیری از تداخل نیست. این اسکریپت
تنظیمات داشبورد را در `config\aurion.json` و `data\` می‌نویسد — یعنی فایل‌هایی
که در گیت ردیابی می‌شوند. اجرای آن *قبل* از pull باعث می‌شود درخت کاری آرام
بگیرد، نه اینکه وسط merge یک نوشتن جدید برسد.

**چرا `--autostash`؟** این مخزن فایل‌هایی را ردیابی می‌کند که خودِ برنامه
بازنویسی می‌کند: `data\runtime-state.json`، `data\settings-backup.json`، وضعیت
لایسنس. بدون این سوییچ، اولین pull بعد از اولین اجرای AURION با پیام
`local changes would be overwritten` متوقف می‌شود. با آن، این تغییرها کنار
گذاشته و دوباره برگردانده می‌شوند و **وضعیت لایسنس شما از بین نمی‌رود**.

**چرا اسم برنچ صریح نوشته شده؟** یک clone فقط برای همان برنچی که checkout
کرده upstream می‌گیرد. روی هر برنچ دیگری، `git pull` خالی بی‌سروصدا سراغ برنچ
پیش‌فرض می‌رود و با `Not possible to fast-forward` می‌ایستد — که شبیه خرابیِ
مخزن به نظر می‌رسد، در حالی که فقط upstream تنظیم نشده.

> `--ff-only` عمداً آنجاست. اگر کامیت محلی دارید، pull **متوقف می‌شود** به‌جای
> اینکه یک merge commit از خودش بسازد. اگر این اتفاق افتاد یعنی واقعاً چیزی
> هست که باید نگاهش کنید.

---

## ۲) خروجی گرفتن MSI

**`Ctrl+Shift+B`** (تسک build پیش‌فرض)، یا:

```powershell
powershell -ExecutionPolicy Bypass -File installer\tools\build-msi.ps1
```

خروجی:

```
installer\output\AURION-1.0.0-x64.msi
installer\output\AURION-1.0.0-x64.msi.sha256
```

### پیش‌نیازها

ویندوز ۱۰/۱۱، **.NET SDK 6.0+**، و **Node.js 18+**. چیز دیگری لازم نیست —
NuGet خودش در اولین build ابزار WiX 5 را می‌آورد (و برای همین اولین build به
اینترنت نیاز دارد؛ build های بعدی آفلاین کار می‌کنند).

.NET SDK ندارید؟ اسکریپت پیشنهاد می‌کند خودش نصبش کند — per-user، داخل
`%LocalAppData%\Microsoft\dotnet`، بدون دسترسی ادمین و بدون تغییر در سطح سیستم.
کافی است **Y** بزنید. برای رد کردن این سؤال (CI یا نصب بی‌نظارت):

```powershell
powershell -ExecutionPolicy Bypass -File installer\tools\build-msi.ps1 -InstallDotnet
```

> **Runtime کافی نیست، SDK لازم است.** WiX یک MSBuild SDK است و MSBuild فقط
> با SDK می‌آید.

### سوییچ‌های مفید

| سوییچ | کار |
|---|---|
| `-Version 1.1.0` | ساخت با نسخهٔ دلخواه، بدون دست‌زدن به `Version.props` |
| `-CertThumbprint <hash>` | امضای Authenticode روی MSI نهایی |
| `-SkipNpm` | استفادهٔ دوباره از `node_modules` مرحله‌بندی‌شده — **فقط برای تکرار سریع محلی، هرگز برای ریلیز** |

### قبل از build (یا از لینوکس/مک، جایی که WiX اجرا نمی‌شود)

```bash
python installer/tools/check-authoring.py
```

این lint روی هر سیستمی اجرا می‌شود و خطاهایی را می‌گیرد که وگرنه وسط یک build
ویندوزی خودشان را نشان می‌دهند.

---

## ۳) چیزهایی که در MSI نیستند — و عمدی است

اسکریپت staging **بیلد را رد می‌کند** اگر هرکدام از این‌ها وارد payload شوند:

- `store/` (کی‌سرور) و `admin/` (سرور آپدیت و پنل) — این‌ها جداگانه هاست
  می‌شوند و نباید روی ماشین یک تریدر نصب شوند
- `data/` (دیتابیس‌ها، لاگ‌ها، `jwt.secret`، وضعیت لایسنس) و
  `config/aurion.json` — موتور خودش آن را در اولین اجرا از روی نسخهٔ factory
  می‌سازد، و همین است که باعث می‌شود یک آپدیت نتواند تنظیمات تریدر را پاک کند
- `apps/web/demo/` و `apps/web/js/demo.js` — دموی گیت‌هاب. نسخهٔ نصب‌شده هم
  دسک واقعی دارد هم موتور واقعی؛ یک تِیپ ساختگی نباید کنار تِیپ زنده بنشیند

اگر پیام `PAYLOAD REJECTED` دیدید، یکی از همین‌ها وارد شده.

---

## ۴) تست‌ها

**Run Task ← `AURION: Test`**، یا:

```powershell
npm test                              # دسک، وب، دمو، قرارداد نصب‌کننده
python -m pytest engine\tests -q      # موتور
node scripts\check-lang.mjs           # هم‌خوانی کلیدهای en / fa / ar
```

---

## نسخهٔ پایتون

**۳.۱۰، ۳.۱۱ یا ۳.۱۲** (۳.۱۲ بهتر). **هرگز ۳.۱۳ یا ۳.۱۴** — `engine/main.py`
روی آن‌ها بالا نمی‌آید چون `numpy==1.26.4` برایشان wheel ندارد.
