# AURION Installer

A real Windows Installer package (`.msi`) for the AURION desk — branded wizard,
smart upgrades, repair, modify and a branded uninstall flow that Windows itself
invokes from **Settings → Apps**.

```
installer/
├── AURION.wixproj              MSI project (WiX 5 MSBuild SDK)
├── Version.props               ← the ONLY place you bump the version
├── assets/
│   ├── build-assets.py         regenerates the branding from the app's own artwork
│   └── generated/              banner.bmp, dialog.bmp, aurion.ico, wizard glyphs
├── launcher/                   installer-owned .vbs helpers (start / stop)
├── src/
│   ├── Variables.wxi           shared constants — no hard-coded paths anywhere else
│   ├── Package.wxs             product, upgrade policy, features, Windows integration
│   ├── Files.wxs               payload harvesting
│   ├── Registry.wxs            the single HKCU key the product owns
│   ├── Shortcuts.wxs           Start Menu / Desktop / uninstall shortcuts
│   ├── Prerequisites.wxs       Python / Node.js / MT5 / previous-version detection
│   ├── Actions.wxs             close-before-touch, opt-in data removal, launch
│   └── ui/
│       ├── AurionUI.wxs        the complete branded wizard (16 dialogs)
│       └── en-us.wxl           every visible string
└── build/
    ├── build-msi.ps1           one-command build
    ├── stage.ps1               assembles + verifies the payload
    └── check-authoring.py      static lint, runs on any OS
```

---

## Build it

**Requirements:** Windows 10/11, **.NET SDK 6.0+**, **Node.js 18+** (to restore the
desk's production dependencies). Nothing else — NuGet pulls the WiX 5 toolset in
automatically on the first build.

```powershell
powershell -ExecutionPolicy Bypass -File installer\tools\build-msi.ps1
```

No .NET SDK on the machine? The script offers to install it for you — per-user,
into `%LocalAppData%\Microsoft\dotnet`, with no administrator rights and no
machine-wide change. Just answer **Y**. To skip the question (CI, unattended):

```powershell
powershell -ExecutionPolicy Bypass -File installer\tools\build-msi.ps1 -InstallDotnet
```

The script prints its own revision on the first line. If it does not print one,
you are running a stale copy — refresh the `installer\` folder before anything
else.

> The .NET **Runtime** is not enough: WiX is an MSBuild SDK, and only the **SDK**
> ships MSBuild. The script checks for a real SDK (`dotnet --list-sdks`) and also
> looks in `%ProgramFiles%\dotnet` and `%LocalAppData%\Microsoft\dotnet`, so an
> SDK that is installed but missing from `PATH` is still found.
>
> The first build needs internet access to restore the WiX toolset from
> nuget.org. Later builds work offline from the NuGet cache.

Output:

```
installer\output\AURION-1.0.0-x64.msi
installer\output\AURION-1.0.0-x64.msi.sha256
```

Useful switches:

| Switch | What it does |
|---|---|
| `-Version 1.1.0` | build a version without editing `Version.props` (CI) |
| `-CertThumbprint <hash>` | Authenticode-sign the finished MSI |
| `-SkipNpm` | reuse the staged `node_modules` (local iteration only) |

Before a build — or from Linux/macOS/CI where WiX cannot run — lint the authoring:

```bash
python installer/tools/check-authoring.py
```

---

## What ends up inside

**Installed:** the Python engine, the Node.js desk API and its production
`node_modules`, the web desk, translations, helper scripts, the MetaTrader 5
bridge sources, factory configuration, and (optionally) the offline docs.

**Never installed:** `store/` (key server), `admin/` (update server + Telegram
panel), `data/` (databases, logs, exports, `jwt.secret`, licence state) and
`config/aurion.json`. The staging script *fails the build* if any of them, or any
file matching a secret pattern, reaches the payload — see the verification block
at the end of `tools/stage.ps1`.

The key server, the admin key-minting tool and the update panel are hosted
separately, exactly as intended; this MSI is the trader-machine half only.

---

## Design decisions (and why)

**Per-user install, no elevation.** AURION writes into its own tree at runtime —
`data\`, `config\aurion.json`, `engine\models\`. Under `Program Files` that needs
either a loosened ACL or elevation on every launch. So the package installs
per-user into `%LocalAppData%\Programs\AURION` (the user can redirect it, e.g. to
`D:\aurion`), registers under `HKCU`, and asks for no administrator rights at all.

**The application was not modified.** The MSI packages the app as it is. The only
added files are two installer-owned launchers (`AURION-Launch.vbs`,
`AURION-Stop.vbs`) that wrap the app's existing `start-aurion.cmd` /
`stop-aurion.cmd` so shortcuts get a proper icon, a correct working directory and
no console flash.

**Runtimes are detected, never bundled or downloaded.** Python 3.10–3.12 and
Node.js 18+ are found through registry `AppSearch`. Missing ones produce a clear
status page, not a blocked install — and Python 3.13+ is called out explicitly,
because `engine/main.py` refuses to run on it.

**Config survives upgrades by construction.** Only `config/aurion.factory.json`
ships. The engine creates `config/aurion.json` from it on first run
(`ensure_config()` in `engine/aurion/config.py`), so no installer transaction ever
owns — or can overwrite — the trader's live settings.

**Stable identity.** `UpgradeCode` is frozen in `Version.props` for the life of
the product. `ProductCode` is regenerated per build, which is what Windows
Installer *requires* for major upgrades; the UpgradeCode is what keeps a single
Apps & Features entry across versions.

---

## Wizard flows

```
Install    Welcome → Environment → Location → Options → Ready → Progress → Finish
Upgrade    Welcome → Environment → Options → Ready → Progress → Finish
           (location is reused; the old version is named on screen)
Repair     Maintenance → Ready → Progress → Finish
Modify     Maintenance → Components → Ready → Progress → Finish
Uninstall  Maintenance → Remove confirmation → Ready → Progress → Finish
```

`Settings → Apps → AURION → Uninstall` runs `msiexec /x {ProductCode}` at full UI
level, so it enters the same branded set at the Maintenance page — no generic
Windows uninstall box. The Start Menu "Uninstall AURION" shortcut calls exactly
the same command.

**Running app.** Before any file is touched (upgrade, repair, uninstall) a
deferred action runs the product's own `stop-aurion.cmd` and waits for it.
Anything still holding a file falls through to the branded **Files in use** /
Restart Manager pages rather than a sharing-violation error.

**User data on uninstall.** Kept by default. The removal page has one clearly
worded checkbox that deletes `data\`, `config\aurion.json` and `engine\models\`
— and only those paths, enumerated explicitly. There is deliberately no recursive
delete of the install folder.

---

## Upgrades and downgrades

| Situation | Behaviour |
|---|---|
| Newer version over older | Major upgrade: old product removed, new installed, one ARP entry, data kept, obsolete files gone |
| Same version again | Repairs in place (`AllowSameVersionUpgrades`) |
| Older over newer | Refused with a plain-language message; the newer install is untouched |
| Different folder chosen on upgrade | The previous folder is pre-filled and reused — the desk never silently moves |

---

## Silent / managed installs

Every wizard choice is a public property, so the MSI is fully scriptable:

```powershell
# silent install, desktop shortcut on, custom folder
msiexec /i AURION-1.0.0-x64.msi /qn INSTALLFOLDER="D:\aurion" AURION_WANT_DESKTOP=yes

# silent uninstall, keep the trader's data (default)
msiexec /x AURION-1.0.0-x64.msi /qn

# silent uninstall, remove data too
msiexec /x AURION-1.0.0-x64.msi /qn AURION_REMOVE_DATA=yes

# administrative install (extract the payload to a share)
msiexec /a AURION-1.0.0-x64.msi TARGETDIR=\\server\software\aurion
```

| Property | Values | Default |
|---|---|---|
| `INSTALLFOLDER` | any path | `%LocalAppData%\Programs\AURION` |
| `AURION_WANT_STARTMENU` | `yes` / omit | `yes` |
| `AURION_WANT_DESKTOP` | `yes` / omit | off |
| `AURION_LAUNCH_AFTER` | `yes` / omit | `yes` (finish page only; silent installs never launch) |
| `AURION_REMOVE_DATA` | `yes` / omit | off — data is kept |

> Conditions treat *any* non-empty string as true, which is why these are `yes`
> or absent — never `0`.

---

## Logging and troubleshooting

`MsiLogging` is baked into the package, so **every** install writes
`%TEMP%\MSI*.LOG` even when the user just double-clicks. For a targeted log:

```powershell
msiexec /i AURION-1.0.0-x64.msi /l*v "%TEMP%\aurion-install.log"
msiexec /x AURION-1.0.0-x64.msi /l*v "%TEMP%\aurion-uninstall.log"
```

Read the log from the bottom: search for `Return value 3` — the action just above
it is the one that failed.

| Symptom | Where to look |
|---|---|
| Build fails | `installer\output\build.binlog`, open with <https://msbuildlog.com> |
| "Payload rejected" | `stage.ps1` found a secret or a hosted-service folder in the payload |
| Install rolls back | `Return value 3` in the MSI log |
| Desk will not start after install | `data\logs\engine.log` and `data\logs\desk.log` in the install folder |
| Wizard says a runtime is missing | Install Python 3.12 / Node.js 18+, then `pip install -r engine\requirements.txt` |

Exit codes are the standard Windows Installer ones: `0` success, `1602` user
cancelled, `1603` fatal error, `1618` another install in progress, `1638` a
different version is already installed.

---

## Shipping a new version

1. Bump `AurionVersion` in `installer/Version.props` (three numeric fields —
   Windows Installer ignores a fourth). **Never touch `AurionUpgradeCode`.**
2. `powershell -File installer\tools\build-msi.ps1 -CertThumbprint <hash>`
3. Test the three paths on a machine that already has the previous version:
   upgrade, then repair, then uninstall.
4. Publish the MSI and its `.sha256`.

Adding files to the app needs no installer change — `stage.ps1` copies the tree
and WiX harvests it. Only a *new top-level folder* needs a line in `stage.ps1`.

**Re-branding:** drop new files into `assets/generated/` (banner `493×58`,
dialog `493×312`, both 24-bit BMP) or edit `assets/build-assets.py` and re-run it.
No `.wxs` file references an image by path.

**Another language:** copy `src/ui/en-us.wxl` to e.g. `fa-ir.wxl`, translate the
values, add the culture to `<Cultures>` in `AURION.wixproj`. Right-to-left
cultures also need `RightToLeft="yes"` on the `<Dialog>` elements — the desk
itself is already fully trilingual, so this only affects setup.
