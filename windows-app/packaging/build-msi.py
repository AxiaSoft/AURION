#!/usr/bin/env python3
r"""Build AURION-Setup.msi (branded, upgrade-aware, license-preserving).

Per-USER install to %LOCALAPPDATA%\\Programs\\AURION (no admin needed).
perMachine is deliberately NOT used: the app writes <tree>/data,
<tree>/config/aurion.json and runs "npm install" into <tree>/backend on first
run, which a standard user cannot do under C:\\Program Files.

Installer behaviour
-------------------
* Smart wizard. Opening the MSI when an AURION is already installed shows a
  mode dialog that adapts to the detected install (AurionVerCmp classifies
  the detected version after AppSearch):
      same version installed -> Repair / Remove / Change location (no Update)
      older version installed -> Update / Remove / Change location
      newer version installed -> message only (downgrades are blocked)
  "Remove" cancels this setup and uninstalls the DETECTED products from
  outside the session (detached cleaner, aurion-arp-uninstall.js) - the old
  Remove-event approach silently fell through to a fresh install.
* Control Panel / Settings: "Uninstall" runs the INSTALLED
  uninstall-aurion.js (UninstallString = wscript.exe "<...>\\uninstall-aurion.js",
  WindowsInstaller=0 so Windows honours it): engine uninstall first (real
  progress bar), then forced cleanup - program tree (data/config kept),
  HKCU\Software\AURION, ARP registrations, ALL shortcuts (desktop, start
  menu, pinned). This removes for real even when the MSI registration or
  cache is broken - the case where the engine-only uninstall "runs" but
  changes nothing. "Change" (ModifyPath) opens the branded wizard; before
  every repair/remove in any path the app AND every process running from
  the install dir (python/node children) are killed (AurionKillApp +
  AurionKillApp2 + handle-release wait), so "cannot write file" cannot
  happen. Logs: %TEMP%\\aurion-arp-clean.log.
* A detached cleaner runs after every install/uninstall transaction:
  stale AURION registrations are uninstalled/force-removed, and when the
  user chose Remove the program tree, HKCU\Software\AURION, the ARP entry
  and shortcuts are wiped too (data/config kept unless the user unticked
  the keep-box). HKLM leftovers trigger one UAC-elevated retry.
* Detects an existing AURION install (previous MSI run via
  HKCU\\Software\\AURION, or the legacy electron-builder install via
  AURION.exe in its folder)
* User state NEVER resets on update:
    - the license lives in <install>/data/license (not an MSI component)
    - config/aurion.json is NOT shipped (the MSI carries only the factory
      copy); first run bootstraps it from aurion.factory.json, so an
      upgrade can never overwrite the user's live config
    - on a location change, data/ + config are copied to the new folder
      by the AurionMigrateState custom action
* Wizard is branded with AURION assets (wix/banner.bmp + wix/aurion-small.ico).

Payload
-------
Default: the Electron app built by ``electron-builder --dir``
(dist/desktop/win-unpacked). AURION.exe is a real Windows application: native
window, engine + desk run hidden inside it, no console, no browser; on a fresh
machine it downloads/installs Python 3.12 + Node 22 + packages silently on
first start, then opens the desk. ``--tree`` ships the raw repo tree with the
VBS/console launcher instead (dev/debug only).

Build
-----
Linux:   python3 windows-app/packaging/build-msi.py        (needs wixl)
Windows: powershell -File windows-app\\packaging\\build-msi-windows.ps1
         (needs the WiX toolset 3.x - the script finds it in
         "Program Files (x86)\\WiX Toolset v3*\\bin" or offers to download
         the official wix314.exe from github.com/wixtoolset/wix3)
Flags:
  --version X.Y.Z  override the product version (default: engine __version__)
  --wxs            generate aurion.wxs + assets only (no wixl compile)
  --check          lint the generated .wxs and stop (no compile)
"""
from __future__ import annotations

import argparse
import os
import re
import shutil
import subprocess
import sys
import uuid
import xml.sax.saxutils as x
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "dist"
HERE = Path(__file__).resolve().parent
WIX_ASSETS = HERE / "wix"

SKIP_DIRS = {
    ".git", ".arena", ".cache", ".mypy_cache", ".next", ".npm",
    "node_modules", "__pycache__", "build", "dist", "coverage",
    ".venv", "target", "android-sdk", ".pytest_cache",
    # Runtime state must never ship inside an installer:
    # data/ holds users.json, jwt.secret, the SQLite DBs, logs and -
    # decisively - the LICENSE (data/license).
    "data",
}
# Runtime/user files that must not ship either: a factory copy of aurion.json
# would be overwritten on every installer upgrade (wiping mt5 credentials,
# license otp, settings). The MSI ships aurion.factory.json instead; the app
# bootstraps aurion.json from it on first run (backend config.js ensureConfig,
# engine config.py ensure_config).
SKIP_FILES = {
    ".DS_Store",
    "aurion.json",
    "news_calendar.csv",
    "news_calendar.fetched",
    "owner.gmail",
    "telegram.token",
}
# MSI/CAB streams handle files up to 2 GB; the Electron AURION.exe alone is ~200 MB.
MAX_FILE = 1900 * 1024 * 1024
SKIPPED_LARGE: list[str] = []

# Payload root. Default = the electron-builder unpacked app
# (dist/desktop/win-unpacked: AURION.exe + resources/{backend,engine,apps,...})
# so the MSI installs a real Windows application: native window, engine/desk
# run hidden, prerequisites installed silently by the app itself on first run.
# Falls back to the raw repo tree (script launcher) only when --tree is given.
APP_DIR_DEFAULT = OUT / "desktop" / "win-unpacked"
PAYLOAD_ROOT: Path = ROOT
APP_MODE = False

NS = "http://schemas.microsoft.com/wix/2006/wi"
# Stable UpgradeCode (must be a valid hex GUID). NOTE: an earlier revision
# shipped "A1B2C3D4-E5F6-7890-ABCD-AURION000001" which is NOT a valid GUID
# (non-hex characters) - wixl/candle reject it, so there is nothing to migrate.
UPGRADE = "A1B2C3D4-5E6F-4A90-8B1D-7A0E15C90F01"
# uuid5(ai.aurion.desk, electron-builder MSI namespace) = UpgradeCode of the old electron-builder MSI
LEGACY_UPGRADE = "134B0455-22E8-5870-A900-62999683CF0B"


def guid_for(s: str) -> str:
    return str(uuid.uuid5(uuid.NAMESPACE_URL, "aurion:" + s)).upper()


def product_version(override: str | None = None) -> str:
    if override:
        v = override
    else:
        v = "1.0.0"
        init = ROOT / "engine" / "aurion" / "__init__.py"
        try:
            for line in init.read_text(encoding="utf-8").splitlines():
                m = re.match(r'__version__\s*=\s*["\']([^"\']+)["\']', line)
                if m:
                    v = m.group(1)
                    break
        except Exception:
            pass
    parts = [p for p in v.split(".") if p.isdigit()]
    # MSI ProductVersion / ARP "DisplayVersion" are shown with THREE parts
    # (1.0.0). A 4th field would surface as "1.0.0.0" in Apps & features.
    while len(parts) < 3:
        parts.append("0")
    return ".".join(parts[:3])


def collect() -> list[Path]:
    files: list[Path] = []
    for p in PAYLOAD_ROOT.rglob("*"):
        if not p.is_file():
            continue
        rel = p.relative_to(PAYLOAD_ROOT)
        if any(part in SKIP_DIRS for part in rel.parts):
            continue
        if p.name in SKIP_FILES:
            continue
        if p.suffix.lower() in {".pyc", ".pyo", ".log", ".apk", ".msi", ".keystore"}:
            continue
        if p.stat().st_size > MAX_FILE:
            SKIPPED_LARGE.append(str(rel))
            continue
        files.append(p)
    files.sort()
    return files


def xml_id(prefix: str, n: int) -> str:
    return f"{prefix}{n:04d}"


WIPE_JS = r"""try {
  var dest = Session.Property("INSTALLDIR") || "";
  var DATA_SUB = "__DATA_SUB__";
  if (dest) {
    var fso = new ActiveXObject("Scripting.FileSystemObject");
    var base = dest.replace(/[\\\/]+$/, "") + (DATA_SUB ? "\\" + DATA_SUB : "");
    var victims = [base + "\\data", base + "\\config\\aurion.json", base + "\\backend\\node_modules"];
    for (var i = 0; i < victims.length; i++) {
      try {
        if (fso.FolderExists(victims[i])) fso.DeleteFolder(victims[i], true);
        else if (fso.FileExists(victims[i])) fso.DeleteFile(victims[i], true);
      } catch (e) {}
    }
  }
} catch (e) {}"""

# Runs inside msiexec (JScript CA). Writes the real cleaner to %TEMP% and starts
# it detached so it can call msiexec itself after this installation is over.
# The cleaner source of truth is wix/arp-clean-inner.js (a plain, testable
# wscript script - see the file header). build_wxs() wraps it mechanically
# into the two JScript custom actions below; no escape-layer duplication.
ARP_INNER = HERE / "wix" / "arp-clean-inner.js"

# JS prelude (computed from session properties inside the CA, before the
# wrapped template body). Backslash/quote values are escaped for JS source.
_JS_ESC_DIR = r'var dir = (Session.Property("INSTALLDIR") || "").replace(/\\/g, "\\\\").replace(/"/g, "\\\"");'
_JS_ESC_PREV = r'var dir = (Session.Property("AURION_PREV_PATH") || "").replace(/\\/g, "\\\\").replace(/"/g, "\\\"");'
ARP_PRE_CLEAN = "\n".join([
    'var own = (Session.Property("ProductCode") || "").toUpperCase();',
    'var mode = (Session.Property("AURION_REMOVING") == "1") ? "remove" : "clean";',
    'var keep = (Session.Property("AURION_KEEPDATA") == "1") ? 1 : 0;',
    'var unl = (Session.Property("REMOVE") == "ALL") ? 1 : 0;',
    _JS_ESC_DIR,
])
ARP_PRE_REMOVE = "\n".join([
    'var own = (Session.Property("ProductCode") || "").toUpperCase();',
    'var keep = (Session.Property("AURION_KEEPDATA") == "1") ? 1 : 0;',
    _JS_ESC_PREV,
    'var codes = ((Session.Property("OLDPRODUCTFOUND") || "") + ";" + '
    '(Session.Property("AURION_LEGACY_MSI") || "")).replace(/^;+|;+$/g, "")'
    '.replace(/;;+/g, ";").replace(/"/g, "");',
])

# Direct (non-detached) JScript-free version compare: VBScript custom action
# that classifies the DETECTED previous version against this package.
VER_CMP_VBS = '''On Error Resume Next
Dim prev, cur
prev = Trim(Session.Property("AURION_PREV_VERSION"))
cur = Trim(Session.Property("ProductVersion"))
Dim res : res = "same"
If prev = "" Then
  res = "older"
Else
  Dim pv, cv, i, a, b
  pv = Split(prev & ".0.0.0", ".")
  cv = Split(cur & ".0.0.0", ".")
  For i = 0 To 2
    a = 0 : b = 0
    If IsNumeric(pv(i)) Then a = CInt(pv(i))
    If IsNumeric(cv(i)) Then b = CInt(cv(i))
    If a > b Then res = "newer" : Exit For
    If a < b Then res = "older" : Exit For
  Next
End If
If res = "older" Then Session.Property("AURION_PREV_OLDER") = "1"
If res = "same" Then Session.Property("AURION_PREV_SAME") = "1"
If res = "newer" Then Session.Property("AURION_PREV_NEWER") = "1"
'''

def _jsq(s: str) -> str:
    return "'" + s.replace("\\", "\\\\").replace("'", "\\'") + "',"


def _wrap_detached_ca(file_name: str, pre: str, var_lines: list[str]) -> str:
    r"""Wrap wix/arp-clean-inner.js into a JScript custom action that writes
    the real cleaner to %TEMP%\<file_name> and starts it detached (it must
    outlive this msiexec session to run msiexec itself)."""
    tpl = ARP_INNER.read_text(encoding="utf-8").replace("\r\n", "\n").rstrip("\n")
    # the CA binary is read as ANSI by the msiexec script host - keep ASCII
    tpl = tpl.replace("—", "-")
    body = "\n".join("    " + v for v in var_lines)
    body += "\n" + "\n".join("    " + _jsq(l) for l in tpl.split("\n"))
    prolog = (
        "try {\n"
        '  var sh = new ActiveXObject("WScript.Shell");\n'
        '  var fso = new ActiveXObject("Scripting.FileSystemObject");\n'
        '  var tmp = sh.ExpandEnvironmentStrings("%TEMP%");\n'
        '  var file = tmp + "\\\\' + file_name + '";\n'
        + "".join("  " + l + "\n" for l in pre.split("\n")) +
        "  var body = [\n"
    )
    footer = (
        '  ].join("\\r\\n");\n'
        '  var f = fso.CreateTextFile(file, true); f.Write(body); f.Close();\n'
        # JS source we must emit:  sh.Run("wscript.exe //B //Nologo \"" + file + "\"", 0, false);
        '  sh.Run("wscript.exe //B //Nologo ' + chr(92) + '"" + file + "' + chr(92) + '"", 0, false);\n'
        "} catch (e) {}"
    )
    return prolog + "\n" + body + "\n" + footer


def _jesc(s: str) -> str:
    return s.replace("\\", "\\\\").replace('"', '\\"')



MIGRATE_JS = r"""try {
  var prev = Session.Property("AURION_PREV_PATH") || "";
  var legacy = Session.Property("AURION_LEGACY") || "";
  var dest = Session.Property("INSTALLDIR") || "";
  var DATA_SUB = "__DATA_SUB__"; // "resources" for the electron layout, "" for the script tree
  function log(msg) {
    try { var r = Session.Installer.CreateRecord(1); r.StringData(1) = "[AurionMigrateState] " + msg; Session.Message(0x04000000, r); } catch (e) {}
  }
  function stripSlash(s) { return (s || "").replace(/[\\\/]+$/, "").toLowerCase(); }
  if (dest) {
    var fsoObj = new ActiveXObject("Scripting.FileSystemObject");
    var sh = new ActiveXObject("WScript.Shell");
    function expand(s) { try { return sh.ExpandEnvironmentStrings(s); } catch (e) { return ""; } }
    var roots = [];
    if (prev) roots.push(prev);
    if (legacy) {
      var local = expand("%LOCALAPPDATA%\\Programs\\AURION");
      if (local && fsoObj.FileExists(local + "\\AURION.exe")) roots.push(local);
      var pf = expand("%ProgramFiles%\\AURION");
      if (pf && fsoObj.FileExists(pf + "\\AURION.exe")) roots.push(pf);
      var pf86 = expand("%ProgramFiles(x86)%\\AURION");
      if (pf86 && fsoObj.FileExists(pf86 + "\\AURION.exe")) roots.push(pf86);
    }
    for (var i = 0; i < roots.length; i++) {
      var root = roots[i];
      if (stripSlash(root) === stripSlash(dest)) continue;
      // data/ (holds the license in data/license) - carry it to the new home
      var dataCands = [root + "\\data", root + "\\resources\\data"];
      for (var j = 0; j < dataCands.length; j++) {
        if (fsoObj.FolderExists(dataCands[j])) {
          var destData = dest + (DATA_SUB ? "\\" + DATA_SUB : "") + "\\data";
          if (DATA_SUB && !fsoObj.FolderExists(dest + "\\" + DATA_SUB)) { try { fsoObj.CreateFolder(dest + "\\" + DATA_SUB); } catch (e) {} }
          if (!fsoObj.FolderExists(destData)) {
            try { fsoObj.CopyFolder(dataCands[j], destData); log("migrated data: " + dataCands[j]); }
            catch (e) { log("data copy failed: " + e.message); }
          }
          break;
        }
      }
      // user config (mt5 credentials, license otp) - copy only if not present
      var cfgCands = [root + "\\config", root + "\\resources\\config"];
      for (var k = 0; k < cfgCands.length; k++) {
        if (!fsoObj.FolderExists(cfgCands[k])) continue;
        var destCfg = dest + (DATA_SUB ? "\\" + DATA_SUB : "") + "\\config";
        if (!fsoObj.FolderExists(destCfg)) { try { fsoObj.CreateFolder(destCfg); } catch (e) {} }
        var cfgFiles = ["aurion.json", "news_calendar.csv", "news_calendar.fetched"];
        for (var m = 0; m < cfgFiles.length; m++) {
          var sf = cfgCands[k] + "\\" + cfgFiles[m];
          var df = destCfg + "\\" + cfgFiles[m];
          if (fsoObj.FileExists(sf) && !fsoObj.FileExists(df)) {
            try { fsoObj.CopyFile(sf, df, false); log("migrated config: " + cfgFiles[m]); }
            catch (e) { log("config copy failed: " + e.message); }
          }
        }
        break;
      }
    }
  }
} catch (e) {}"""


def build_wxs(version: str, out_wxs: Path) -> None:
    files = collect()

    dirs: dict[str, str] = {"": "INSTALLDIR"}
    dir_xml: list[tuple[str, str, str]] = []
    next_dir = 1

    def ensure_dir(rel: Path) -> str:
        nonlocal next_dir
        key = str(rel).replace("\\", "/")
        if key in dirs:
            return dirs[key]
        if rel.parent != Path(".") and str(rel.parent) != "":
            parent = ensure_dir(rel.parent)
        else:
            parent = "INSTALLDIR"
        if key == "." or key == "":
            return "INSTALLDIR"
        did = xml_id("D", next_dir)
        next_dir += 1
        dirs[key] = did
        dir_xml.append((parent, did, rel.name))
        return did

    for f in files:
        rel = f.relative_to(PAYLOAD_ROOT)
        if rel.parent != Path("."):
            ensure_dir(rel.parent)

    children: dict[str, list[tuple[str, str]]] = {}
    for parent, did, name in dir_xml:
        children.setdefault(parent, []).append((did, name))

    files_by_dir: dict[str, list[Path]] = {}
    for f in files:
        rel = f.relative_to(PAYLOAD_ROOT)
        did = "INSTALLDIR" if str(rel.parent) in (".", "") else dirs[str(rel.parent).replace("\\", "/")]
        files_by_dir.setdefault(did, []).append(f)

    comps: list[str] = []
    n = 1

    def emit_dir(did: str, indent: int) -> list[str]:
        nonlocal n
        pad = "  " * indent
        lines: list[str] = []
        for f in files_by_dir.get(did, []):
            cid = xml_id("C", n)
            fid = xml_id("F", n)
            n += 1
            comps.append(cid)
            rel = f.relative_to(PAYLOAD_ROOT)
            if APP_MODE and str(rel) == "AURION.exe":
                fid = "AurionExe"
            lines.append(f'{pad}  <Component Id="{cid}" Guid="{guid_for(str(rel))}">')
            lines.append(f'{pad}    <File Id="{fid}" Name="{x.escape(f.name)}" Source="{x.escape(str(f))}" KeyPath="yes" />')
            lines.append(f"{pad}  </Component>")
        for child_id, child_name in children.get(did, []):
            lines.append(f'{pad}  <Directory Id="{child_id}" Name="{x.escape(child_name)}">')
            lines.extend(emit_dir(child_id, indent + 1))
            lines.append(f"{pad}  </Directory>")
        return lines

    ico = ROOT / "windows-app" / "packaging" / "aurion.ico"
    if not ico.exists():
        ico = ROOT / "windows-app" / "desktop" / "icon.ico"

    launch_src = ROOT / "windows-app" / "packaging" / "launch-aurion.vbs"
    if not launch_src.exists():
        launch_src.write_text(
            'Set WshShell = CreateObject("WScript.Shell")\n'
            'WshShell.Run "cmd /c start-aurion.cmd", 0\n',
            encoding="utf-8",
        )

    banner = WIX_ASSETS / "banner.bmp"
    dialog_bmp = WIX_ASSETS / "dialog.bmp"
    small_ico = WIX_ASSETS / "aurion-small.ico"
    branding = ""
    if banner.exists() and small_ico.exists():
        # WiX 3 (WixUIExtension) override variable names - NOT the WiX 4
        # "WixUI_Banner" names, which light silently ignores.
        branding = (
            '    <WixVariable Id="WixUIBannerBmp" Value="wix\\banner.bmp" />\n'
            '    <WixVariable Id="WixUIExclamationIco" Value="wix\\aurion-small.ico" />\n'
            '    <WixVariable Id="WixUIInfoIco" Value="wix\\aurion-small.ico" />\n'
            '    <WixVariable Id="WixUINewIco" Value="wix\\aurion-small.ico" />\n'
            '    <WixVariable Id="WixUIUpIco" Value="wix\\aurion-small.ico" />\n'
        )
        if dialog_bmp.exists():
            branding += '    <WixVariable Id="WixUIDialogBmp" Value="wix\\dialog.bmp" />\n'

    body = emit_dir("INSTALLDIR", 6)
    refs = "\n          ".join(f'<ComponentRef Id="{c}" />' for c in comps)
    refs += '\n          <ComponentRef Id="Shortcuts" />'
    if APP_MODE:
        launcher_component = ""
        shortcut_target = "[#AurionExe]"
        starter_name = "AURION.exe"
        data_sub = "resources"
    else:
        refs += '\n          <ComponentRef Id="Launcher" />'
        launcher_component = (
            f'          <Component Id="Launcher" Guid="{guid_for("launcher")}">\n'
            f'            <File Id="LaunchVbs" Name="launch-aurion.vbs" Source="{x.escape(str(launch_src))}" KeyPath="yes" />\n'
            f'          </Component>\n'
        )
        shortcut_target = "[#LaunchVbs]"
        starter_name = "start-aurion.cmd"
        data_sub = ""
    # the installed uninstaller script lives next to the app
    # (Electron layout: <install>\resources\uninstall-aurion.js; script-tree
    # layout: <install>\uninstall-aurion.js). uninstall_js is written later,
    # but the Source path is static - safe to reference here.
    uninstall_dir = dirs.get(data_sub, "INSTALLDIR") if data_sub else "INSTALLDIR"
    uninstall_js = HERE / "wix" / "uninstall-aurion.js"
    uninstall_arp_path = f"{data_sub}\\uninstall-aurion.js" if data_sub else "uninstall-aurion.js"
    refs += '\n          <ComponentRef Id="AurionUninstallJs" />'
    uninstall_component = (
        f'      <DirectoryRef Id="{uninstall_dir}">\n'
        f'        <Component Id="AurionUninstallJs" Guid="{guid_for("uninstall-js")}">\n'
        f'          <File Id="AurionUninstallJsFile" Name="uninstall-aurion.js" Source="{x.escape(str(uninstall_js))}" KeyPath="yes" />\n'
        f'        </Component>\n'
        f'      </DirectoryRef>\n'
    )
    wipe_js = HERE / "wix" / "wipe-state.js"
    wipe_js.write_text(WIPE_JS.replace("__DATA_SUB__", data_sub), encoding="utf-8")
    migrate_js = HERE / "wix" / "migrate-state.js"
    migrate_js.write_text(MIGRATE_JS.replace("__DATA_SUB__", data_sub), encoding="utf-8")
    # Detached cleaner #1: runs after EVERY transaction (stale sweep; full
    # removal when the user chose Remove in the maintenance wizard).
    arpclean_js = HERE / "wix" / "arp-clean.js"
    arpclean_js.write_text(_wrap_detached_ca(
        "aurion-arp-clean.js",
        ARP_PRE_CLEAN,
        [
            "'var OWN = \"' + own + '\";',",
            "'var MODE = \"' + mode + '\";',",
            "'var MYDIR = \"' + dir + '\";',",
            "'var KEEP = ' + keep + ';',",
            "'var CODES = \"\";',",
            "'var UNINSTALL = ' + unl + ';',",
            "'var ENGINE = 0;',",
            "'var POPUP = 0;',",
        ]), encoding="utf-8")
    # Detached cleaner #2: the mode dialog's Remove. The setup is cancelled
    # (EndDialog Exit) and the DETECTED previous products are uninstalled
    # from OUTSIDE this msiexec session.
    arpremove_js = HERE / "wix" / "arp-remove-old.js"
    arpremove_js.write_text(_wrap_detached_ca(
        "aurion-arp-uninstall.js",
        ARP_PRE_REMOVE,
        [
            "'var OWN = \"' + own + '\";',",
            "'var MODE = \"uninstall-old\";',",
            "'var MYDIR = \"' + dir + '\";',",
            "'var KEEP = ' + keep + ';',",
            "'var CODES = \"' + codes + '\";',",
            "'var UNINSTALL = 0;',",
            "'var ENGINE = 0;',",
            "'var POPUP = 0;',",
        ]), encoding="utf-8")
    # The INSTALLED uninstaller: Control Panel "Uninstall" runs this plain
    # script (UninstallString = wscript.exe "<...>\uninstall-aurion.js").
    # It is the arp-clean template in "remove" mode with SELF discovery: it
    # finds its own product code from the ARP entry that points to it, gives
    # the MSI engine the first shot (msiexec /x, real progress bar), then
    # force-cleans every leftover (tree with data/config kept, HKCU keys,
    # shortcuts). This works even when the MSI registration/cache is broken
    # - the case where the engine's own uninstall did nothing.
    uninstall_js = HERE / "wix" / "uninstall-aurion.js"
    uninstall_js.write_text(
        'var OWN = "SELF";\n'
        'var MODE = "remove";\n'
        'var MYDIR = "";\n'
        'var KEEP = 1;\n'
        'var CODES = "";\n'
        'var UNINSTALL = 0;\n'
        'var ENGINE = 1;\n'
        'var POPUP = 1;\n'
        + ARP_INNER.read_text(encoding="utf-8").replace("\r\n", "\n").replace("—", "-"),
        encoding="utf-8")
    vercmp_vbs = HERE / "wix" / "ver-cmp.vbs"
    vercmp_vbs.write_text(VER_CMP_VBS, encoding="utf-8")
        # Launch AURION when the wizard closes (checkbox on the Finish page, on by default).
    launch_after = f'''
    <Property Id="WIXUI_EXITDIALOGOPTIONALCHECKBOXTEXT" Value="Start AURION now" />
    <Property Id="WIXUI_EXITDIALOGOPTIONALCHECKBOX" Value="1" />
    <Property Id="WixShellExecTarget" Value="{shortcut_target}" />
    <CustomAction Id="AurionLaunchApp" BinaryKey="WixCA" DllEntry="WixShellExec" Impersonate="yes" />
'''

    detected = '(AURION_PREV OR AURION_LEGACY OR OLDPRODUCTFOUND)'
    mode_cond = f'NOT Installed AND {detected}'
    no_mode_cond = f'NOT Installed AND NOT {detected}'
    migrate_cond = 'NOT Installed AND ((AURION_PREV_PATH AND AURION_PREV_PATH&lt;&gt;INSTALLDIR) OR AURION_LEGACY)'
    # Smart mode dialog: AurionVerCmp (VBScript CA, runs after AppSearch)
    # classifies the DETECTED previous version against this package into
    # AURION_PREV_OLDER / _SAME / _NEWER. Update only for older installs;
    # Repair only when the same version is installed; Remove in every
    # detected case (except newer, where this package must not install).
    upd_show = f'NOT Installed AND AURION_PREV_OLDER AND {detected}'
    rep_show = 'NOT Installed AND AURION_PREV_SAME'
    rem_show = f'NOT Installed AND {detected} AND NOT AURION_PREV_NEWER'
    chg_show = 'NOT Installed AND NOT AURION_PREV_NEWER'

    out_wxs.write_text(
        f'''<?xml version="1.0" encoding="utf-8"?>
<Wix xmlns="{NS}">
  <Product Id="*" Name="AURION" Language="1033" Version="{version}"
           Manufacturer="Axiasoft" UpgradeCode="{UPGRADE}">
    <Package InstallerVersion="300" Compressed="yes" InstallScope="perUser"
             Description="AURION live MetaTrader 5 desk" InstallPrivileges="limited" />
    <!-- Major upgrade: every installed AURION MSI sharing this UpgradeCode
         and older than OR EQUAL to this package is removed before the new
         files are written. AllowSameVersionUpgrades makes reinstalling the
         exact same version a clean replace (repair) instead of piling up a
         second entry; a NEWER installed version aborts with the message. -->
    <MajorUpgrade AllowSameVersionUpgrades="yes" DowngradeErrorMessage="A newer AURION is already installed. Uninstall it first (Control Panel - Programs and Features), then run this setup again." />
    <!-- The legacy electron-builder MSI (appId ai.aurion.desk) has its own
         UpgradeCode; remove it too so only one AURION is ever installed. -->
    <Upgrade Id="{LEGACY_UPGRADE}">
      <UpgradeVersion Minimum="0.0.0" IncludeMinimum="yes" Maximum="99.0.0" IncludeMaximum="yes" OnlyDetect="no" Property="AURION_LEGACY_MSI" />
    </Upgrade>
    <Media Id="1" Cabinet="aurion.cab" EmbedCab="yes" />
    <Icon Id="AppIcon" SourceFile="{x.escape(str(ico))}" />
    <Property Id="ARPPRODUCTICON" Value="AppIcon" />
    <!-- ARPNOMODIFY is already set by WixUI_InstallDir.
         Control Panel / Settings policy: "Uninstall" runs the INSTALLED
         uninstall-aurion.js (self-contained: engine uninstall first for the
         real progress bar, then forced cleanup of the tree, registry and
         ALL shortcuts - works even when the MSI registration/cache is
         broken, which is exactly when the engine-only uninstall silently
         does nothing). WindowsInstaller=0 makes Windows run that
         UninstallString. "Change" (ModifyPath = MsiExec.exe /I + code)
         opens the branded wizard (Repair / Remove with real events).
         Repair is also available by running the setup MSI again. -->
    <SetProperty Id="AurionArpFix" Value="&quot;[SystemFolder]reg.exe&quot; add &quot;HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\[ProductCode]&quot; /v UninstallString /t REG_SZ /d &quot;wscript.exe \\&quot;[INSTALLDIR]{uninstall_arp_path}\\&quot;&quot; /f" Before="AurionArpFix" Sequence="execute" />
    <CustomAction Id="AurionArpFix" BinaryKey="WixCA" DllEntry="WixQuietExec" Execute="deferred" Impersonate="yes" Return="ignore" />
    <SetProperty Id="AurionArpFix2" Value="&quot;[SystemFolder]reg.exe&quot; add &quot;HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\[ProductCode]&quot; /v ModifyPath /t REG_SZ /d &quot;MsiExec.exe /I[ProductCode]&quot; /f" Before="AurionArpFix2" Sequence="execute" />
    <CustomAction Id="AurionArpFix2" BinaryKey="WixCA" DllEntry="WixQuietExec" Execute="deferred" Impersonate="yes" Return="ignore" />
    <SetProperty Id="AurionArpFix3" Value="&quot;[SystemFolder]reg.exe&quot; add &quot;HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\[ProductCode]&quot; /v WindowsInstaller /t REG_DWORD /d 0 /f" Before="AurionArpFix3" Sequence="execute" />
    <CustomAction Id="AurionArpFix3" BinaryKey="WixCA" DllEntry="WixQuietExec" Execute="deferred" Impersonate="yes" Return="ignore" />
    <!-- Stale / duplicate "AURION" entries in Apps &amp; features (older
         electron-builder MSI with a broken cache, the hand-made HKCU\\...\\AURION
         key of earlier builds, ...). msiexec cannot run nested, so this CA
         launches a detached cleaner (wscript) that runs once this install has
         finished: it uninstalls every other AURION MSI product silently and
         force-deletes registrations whose package is gone. Never touches
         [ProductCode]. Log: %TEMP%\\aurion-arp-clean.log -->
    <Binary Id="AurionArpCleanJs" SourceFile="{x.escape(str(arpclean_js))}" />
    <CustomAction Id="AurionArpClean" BinaryKey="AurionArpCleanJs" JScriptCall="" Execute="immediate" Impersonate="yes" Return="ignore" />
    <Binary Id="AurionArpRemoveOldJs" SourceFile="{x.escape(str(arpremove_js))}" />
    <CustomAction Id="AurionArpRemoveOld" BinaryKey="AurionArpRemoveOldJs" JScriptCall="" Execute="immediate" Impersonate="yes" Return="ignore" />
    <Binary Id="AurionVerCmpVbs" SourceFile="{x.escape(str(vercmp_vbs))}" />
    <CustomAction Id="AurionVerCmp" BinaryKey="AurionVerCmpVbs" VBScriptCall="" Execute="immediate" Return="ignore" />
    <Property Id="AURION_KEEPDATA" Value="1" Secure="yes" />
    <Property Id="AURION_REMOVING" Secure="yes" />
    <Property Id="AURION_MODEPICK" Secure="yes" />
    <!-- Kill a running AURION before files are replaced/removed; otherwise
         msiexec shows the "files in use" page or leaves a half-updated tree. -->
    <SetProperty Id="AurionKillApp" Value="&quot;[SystemFolder]taskkill.exe&quot; /F /T /IM AURION.exe" Before="AurionKillApp" Sequence="execute" />
    <CustomAction Id="AurionKillApp" BinaryKey="WixCA" DllEntry="WixQuietExec" Execute="immediate" Return="ignore" />
    <!-- Repair/Remove can fail with "cannot write &lt;file&gt;" while the app
         or its python/node children (started from the install dir) still
         hold handles. taskkill only knows image names, so also kill every
         process whose executable lives under [INSTALLDIR], then wait a
         moment for Windows to release the handles. -->
    <SetProperty Id="AurionKillApp2" Value="&quot;[SystemFolder]WindowsPowerShell\\v1.0\\powershell.exe&quot; -NoProfile -ExecutionPolicy Bypass -Command &quot;Get-Process | Where-Object {{ $_.Path -like '[INSTALLDIR]*' }} | Stop-Process -Force&quot;" Before="AurionKillApp2" Sequence="execute" />
    <CustomAction Id="AurionKillApp2" BinaryKey="WixCA" DllEntry="WixQuietExec" Execute="immediate" Return="ignore" />
    <SetProperty Id="AurionKillWait" Value="&quot;[SystemFolder]cmd.exe&quot; /c ping -n 3 127.0.0.1 &gt; nul" Before="AurionKillWait" Sequence="execute" />
    <CustomAction Id="AurionKillWait" BinaryKey="WixCA" DllEntry="WixQuietExec" Execute="immediate" Return="ignore" />
    <Property Id="WIXUI_INSTALLDIR" Value="INSTALLDIR" />
{launch_after}{branding}
    <!-- ============================ detection ============================ -->
    <!-- Previous install of this MSI (registry key written by Shortcuts). -->
    <!-- AURION_PREV = full path of start-aurion.cmd inside the registered
         InstallPath; empty when the key is stale (folder gone / manually deleted). -->
    <Property Id="AURION_PREV" Secure="yes">
      <RegistrySearch Id="AurionInstalledSearch" Root="HKCU" Key="Software\\AURION" Name="InstallPath" Type="directory">
        <FileSearch Id="AurionPrevStarter" Name="{starter_name}" />
      </RegistrySearch>
    </Property>
    <Property Id="AURION_PREV_PATH" Secure="yes">
      <RegistrySearch Id="AurionPrevPathSearch" Root="HKCU" Key="Software\\AURION" Name="InstallPath" Type="raw" />
    </Property>
    <Property Id="AURION_PREV_VERSION" Secure="yes">
      <RegistrySearch Id="AurionPrevVersionSearch" Root="HKCU" Key="Software\\AURION" Name="Version" Type="raw" />
    </Property>
    <!-- Legacy electron-builder install (AURION.exe in its folder). -->
    <Property Id="AURION_LEGACY" Secure="yes">
      <DirectorySearch Id="AurionLegacyLocalDir" Path="[LocalAppDataFolder]Programs\\AURION" Depth="0">
        <FileSearch Id="AurionLegacyLocal" Name="AURION.exe" />
      </DirectorySearch>
      <DirectorySearch Id="AurionLegacyPFDir" Path="[ProgramFilesFolder]AURION" Depth="0">
        <FileSearch Id="AurionLegacyPF" Name="AURION.exe" />
      </DirectorySearch>
    </Property>

    <!-- ========================== custom actions ========================= -->
    <!-- Carry user state (data/ incl. the license, user config) to the new
         install location when the location changes or the legacy install is
         replaced. Runs in the execute sequence once INSTALLDIR is final. -->
    <Binary Id="AurionMigrateJs" SourceFile="{x.escape(str(migrate_js))}" />
    <CustomAction Id="AurionMigrateState" BinaryKey="AurionMigrateJs" JScriptCall="" Execute="immediate" Return="ignore" />
    <Binary Id="AurionWipeJs" SourceFile="{x.escape(str(wipe_js))}" />
    <CustomAction Id="AurionWipeState" BinaryKey="AurionWipeJs" JScriptCall="" Execute="immediate" Return="ignore" />
    <InstallExecuteSequence>
      <Custom Action="AurionKillApp" Before="InstallValidate">Installed OR REMOVE</Custom>
      <Custom Action="AurionKillApp2" After="AurionKillApp">Installed OR REMOVE</Custom>
      <Custom Action="AurionKillWait" After="AurionKillApp2">Installed OR REMOVE</Custom>
      <Custom Action="AurionMigrateState" After="CostFinalize">{migrate_cond}</Custom>
      <Custom Action="AurionWipeState" After="InstallValidate">REMOVE="ALL" AND NOT UPGRADINGPRODUCTCODE AND AURION_KEEPDATA&lt;&gt;"1"</Custom>
      <Custom Action="AurionArpFix" After="RegisterProduct">NOT REMOVE</Custom>
      <Custom Action="AurionArpFix2" After="AurionArpFix">NOT REMOVE</Custom>
      <Custom Action="AurionArpFix3" After="AurionArpFix2">NOT REMOVE</Custom>
      <Custom Action="AurionArpClean" After="InstallFinalize">1</Custom>
    </InstallExecuteSequence>

    <!-- Default to %LOCALAPPDATA%\\Programs\\AURION (per user, writable tree) -->
    <Directory Id="TARGETDIR" Name="SourceDir">
      <Directory Id="LocalAppDataFolder">
        <Directory Id="ProgramsDir" Name="Programs">
          <Directory Id="INSTALLDIR" Name="AURION">
{os.linesep.join(body)}
{launcher_component}          </Directory>
        </Directory>
      </Directory>
      <Directory Id="DesktopFolder" Name="Desktop" />
      <Directory Id="ProgramMenuFolder">
        <Directory Id="ProgramMenuDir" Name="AURION" />
      </Directory>
    </Directory>
    <DirectoryRef Id="DesktopFolder">
      <Component Id="Shortcuts" Guid="{guid_for('shortcut-desktop')}">
        <Shortcut Id="DesktopShortcut" Name="AURION"
                  Description="AURION live desk"
                  Target="{shortcut_target}"
                  WorkingDirectory="INSTALLDIR"
                  Icon="AppIcon" />
        <Shortcut Id="StartMenuShortcut" Name="AURION"
                  Directory="ProgramMenuDir"
                  Description="AURION live desk"
                  Target="{shortcut_target}"
                  WorkingDirectory="INSTALLDIR"
                  Icon="AppIcon" />
        <RemoveFolder Id="RemoveMenu" Directory="ProgramMenuDir" On="uninstall" />
        <RegistryValue Root="HKCU" Key="Software\\AURION" Name="installed" Type="integer" Value="1" KeyPath="yes" />
        <RegistryValue Root="HKCU" Key="Software\\AURION" Name="InstallPath" Type="string" Value="[INSTALLDIR]" />
        <RegistryValue Root="HKCU" Key="Software\\AURION" Name="Version" Type="string" Value="[ProductVersion]" />
        <RegistryValue Root="HKCU" Key="Software\\AURION" Name="ProductCode" Type="string" Value="[ProductCode]" />
      </Component>
      <!-- The installed uninstaller (uninstall-aurion.js): the ARP entry's
           UninstallString is rewritten (deferred CA) to run it, so Control
           Panel / Settings uninstall REALLY removes - engine first, then
           forced cleanup + all shortcuts. (Its own DirectoryRef follows
           AFTER this one closes - DirectoryRef must not nest.) -->
    </DirectoryRef>
{uninstall_component}
    <Feature Id="MainFeature" Title="AURION" Level="1" Description="Installs to %LOCALAPPDATA%\\Programs\\AURION with desktop shortcut">
          {refs}
    </Feature>

    <!-- ============================= wizard ============================= -->
    <!-- WixUI_InstallMode drives the stock VerifyReadyDlg (which button/title
         it shows). Our dialogs set it explicitly; the stock Maintenance pages
         are bypassed. -->
    <UI>
      <!-- first install / upgrade when an existing AURION is detected.
           Smart: the same version offers Repair / Remove only; Update shows
           up exclusively when this package is actually newer. -->
      <Dialog Id="AurionModeDlg" Width="370" Height="270" Title="AURION Setup" NoMinimize="yes">
        <Control Id="BannerBitmap" Type="Bitmap" X="0" Y="0" Width="370" Height="44" TabSkip="no" Text="!(loc.InstallDirDlgBannerBitmap)" />
        <Control Id="BannerLine" Type="Line" X="0" Y="44" Width="370" Height="0" />
        <Control Id="Title" Type="Text" X="15" Y="6" Width="300" Height="15" Transparent="yes" NoPrefix="yes"
                 Text="{{\\WixUI_Font_Title}}AURION is already installed" />
        <Control Id="Description" Type="Text" X="25" Y="23" Width="320" Height="15" Transparent="yes" NoPrefix="yes"
                 Text="Choose what Setup should do." />
        <Control Id="PathLine" Type="Text" X="20" Y="58" Width="330" Height="12" NoPrefix="yes" Hidden="yes"
                 Text="Current: [AURION_PREV_PATH]  (version [AURION_PREV_VERSION])">
          <Condition Action="show">AURION_PREV</Condition>
        </Control>
        <Control Id="LegacyLine" Type="Text" X="20" Y="58" Width="330" Height="12" NoPrefix="yes" Hidden="yes"
                 Text="Older AURION found: [AURION_LEGACY] - it will be replaced.">
          <Condition Action="show">NOT AURION_PREV AND AURION_LEGACY</Condition>
        </Control>
        <Control Id="HintUpdate" Type="Text" X="20" Y="74" Width="330" Height="12" NoPrefix="yes" Hidden="yes"
                 Text="Your license, data and settings are kept - you will not re-enter them.">
          <Condition Action="show">NOT Installed AND AURION_PREV_OLDER</Condition>
        </Control>
        <Control Id="HintSame" Type="Text" X="20" Y="74" Width="330" Height="12" NoPrefix="yes" Hidden="yes"
                 Text="This version is already installed - you can repair the files or remove AURION.">
          <Condition Action="show">NOT Installed AND AURION_PREV_SAME</Condition>
        </Control>
        <Control Id="HintNewer" Type="Text" X="20" Y="74" Width="330" Height="24" NoPrefix="yes" Hidden="yes"
                 Text="A newer AURION is already installed. This setup cannot continue - uninstall the newer version first.">
          <Condition Action="show">NOT Installed AND AURION_PREV_NEWER</Condition>
        </Control>
        <Control Id="OptUpdate" Type="PushButton" X="20" Y="96" Width="330" Height="30" TabSkip="no" Hidden="yes"
                 Text="&amp;Update AURION to version [ProductVersion] (keeps your data)">
          <Condition Action="show">{upd_show}</Condition>
        </Control>
        <Control Id="OptRepair" Type="PushButton" X="20" Y="96" Width="330" Height="30" TabSkip="no" Hidden="yes"
                 Text="&amp;Repair AURION [ProductVersion] (re-write the program files)">
          <Condition Action="show">{rep_show}</Condition>
        </Control>
        <Control Id="OptRemove" Type="PushButton" X="20" Y="132" Width="330" Height="30" TabSkip="no" Hidden="yes"
                 Text="&amp;Remove AURION from this computer">
          <Condition Action="show">{rem_show}</Condition>
        </Control>
        <Control Id="OptChange" Type="PushButton" X="20" Y="168" Width="330" Height="30" TabSkip="no" Hidden="yes"
                 Text="&amp;Change the install location">
          <Condition Action="show">{chg_show}</Condition>
        </Control>
        <Control Id="BottomLine" Type="Line" X="0" Y="234" Width="370" Height="0" />
        <Control Id="Back" Type="PushButton" X="180" Y="243" Width="56" Height="17" Disabled="yes" Text="!(loc.WixUIBack)" />
        <Control Id="Next" Type="PushButton" X="236" Y="243" Width="56" Height="17" Default="yes" Text="!(loc.WixUINext)" />
        <Control Id="Cancel" Type="PushButton" X="304" Y="243" Width="56" Height="17" Cancel="yes" Text="!(loc.WixUICancel)" />
      </Dialog>
      <!-- Update / Repair: keep the previous folder, go to the summary (new
           ProductCode = a normal install from MSI's point of view; the
           MajorUpgrade removes the old one first). Repair on the SAME
           version is a clean replace: AllowSameVersionUpgrades lets the
           equal version through and the old files are fully rewritten. -->
      <Publish Dialog="AurionModeDlg" Control="OptUpdate" Property="AURION_MODEPICK" Value="1" Order="0">1</Publish>
      <Publish Dialog="AurionModeDlg" Control="OptUpdate" Property="INSTALLDIR" Value="[AURION_PREV_PATH]" Order="1">AURION_PREV_PATH</Publish>
      <Publish Dialog="AurionModeDlg" Control="OptUpdate" Event="SetTargetPath" Value="INSTALLDIR" Order="2">1</Publish>
      <Publish Dialog="AurionModeDlg" Control="OptUpdate" Event="NewDialog" Value="VerifyReadyDlg" Order="3">1</Publish>
      <Publish Dialog="AurionModeDlg" Control="OptRepair" Property="AURION_MODEPICK" Value="1" Order="0">1</Publish>
      <Publish Dialog="AurionModeDlg" Control="OptRepair" Property="INSTALLDIR" Value="[AURION_PREV_PATH]" Order="1">AURION_PREV_PATH</Publish>
      <Publish Dialog="AurionModeDlg" Control="OptRepair" Event="SetTargetPath" Value="INSTALLDIR" Order="2">1</Publish>
      <Publish Dialog="AurionModeDlg" Control="OptRepair" Event="NewDialog" Value="VerifyReadyDlg" Order="3">1</Publish>
      <!-- Remove from the mode dialog. This session is a FIRST install (the
           detected product is a DIFFERENT package), so the stock "Remove"
           event can never fire here (its condition "Installed" is false) -
           publishing it made the wizard fall through and INSTALL AURION.
           Instead: cancel this setup entirely (EndDialog Exit) after arming
           the detached uninstaller, which removes the detected products
           (OLDPRODUCTFOUND + AURION_LEGACY_MSI codes), the program tree,
           HKCU\Software\AURION and shortcuts from outside this session. -->
      <Publish Dialog="AurionModeDlg" Control="OptRemove" Event="DoAction" Value="AurionArpRemoveOld" Order="0">1</Publish>
      <Publish Dialog="AurionModeDlg" Control="OptRemove" Event="EndDialog" Value="Exit" Order="1">1</Publish>
      <Publish Dialog="AurionModeDlg" Control="OptChange" Event="NewDialog" Value="InstallDirDlg">1</Publish>
      <Publish Dialog="AurionModeDlg" Control="Next" Event="NewDialog" Value="InstallDirDlg">1</Publish>
      <Publish Dialog="AurionModeDlg" Control="Cancel" Event="SpawnDialog" Value="CancelDlg">1</Publish>

      <!-- maintenance (Apps and features / Control Panel) -->
      <Dialog Id="AurionRemoveDlg" Width="370" Height="270" Title="AURION Setup" NoMinimize="yes">
        <Control Id="BannerBitmap" Type="Bitmap" X="0" Y="0" Width="370" Height="44" TabSkip="no" Text="!(loc.InstallDirDlgBannerBitmap)" />
        <Control Id="BannerLine" Type="Line" X="0" Y="44" Width="370" Height="0" />
        <Control Id="Title" Type="Text" X="15" Y="6" Width="300" Height="15" Transparent="yes" NoPrefix="yes"
                 Text="{{\\WixUI_Font_Title}}Repair or remove AURION" />
        <Control Id="Description" Type="Text" X="25" Y="23" Width="320" Height="15" Transparent="yes" NoPrefix="yes"
                 Text="AURION [ProductVersion] is installed in [INSTALLDIR]" />
        <Control Id="Hint" Type="Text" X="20" Y="58" Width="330" Height="24" NoPrefix="yes"
                 Text="Choose what Setup should do." />
        <Control Id="OptRepair" Type="PushButton" X="20" Y="92" Width="330" Height="30" TabSkip="no"
                 Text="&amp;Repair AURION (re-write all program files, keep everything else)" />
        <Control Id="OptRemove" Type="PushButton" X="20" Y="128" Width="330" Height="30" TabSkip="no"
                 Text="&amp;Remove AURION from this computer" />
        <Control Id="KeepData" Type="CheckBox" X="24" Y="170" Width="326" Height="17" Property="AURION_KEEPDATA" CheckBoxValue="1"
                 Text="Keep my license, settings and data (a later install picks them up)" />
        <Control Id="BottomLine" Type="Line" X="0" Y="234" Width="370" Height="0" />
        <Control Id="Back" Type="PushButton" X="180" Y="243" Width="56" Height="17" Disabled="yes" Text="!(loc.WixUIBack)" />
        <Control Id="Next" Type="PushButton" X="236" Y="243" Width="56" Height="17" Disabled="yes" Text="!(loc.WixUINext)" />
        <Control Id="Cancel" Type="PushButton" X="304" Y="243" Width="56" Height="17" Cancel="yes" Default="yes" Text="!(loc.WixUICancel)" />
      </Dialog>
      <!-- Repair / Remove run straight from this dialog (ReinstallMode +
           Reinstall / Remove + EndDialog Return) - the stock VerifyReadyDlg
           is never shown in maintenance, so its "blank page" cannot happen. -->
      <Publish Dialog="AurionRemoveDlg" Control="OptRepair" Property="WixUI_InstallMode" Value="Repair" Order="1">1</Publish>
      <Publish Dialog="AurionRemoveDlg" Control="OptRepair" Event="ReinstallMode" Value="amus" Order="2">1</Publish>
      <Publish Dialog="AurionRemoveDlg" Control="OptRepair" Event="Reinstall" Value="All" Order="3">1</Publish>
      <Publish Dialog="AurionRemoveDlg" Control="OptRepair" Event="EndDialog" Value="Return" Order="4">1</Publish>
      <Publish Dialog="AurionRemoveDlg" Control="OptRemove" Property="AURION_REMOVING" Value="1" Order="1">1</Publish>
      <Publish Dialog="AurionRemoveDlg" Control="OptRemove" Event="Remove" Value="All" Order="2">1</Publish>
      <Publish Dialog="AurionRemoveDlg" Control="OptRemove" Event="EndDialog" Value="Return" Order="3">1</Publish>
      <Publish Dialog="AurionRemoveDlg" Control="Cancel" Event="SpawnDialog" Value="CancelDlg">1</Publish>

      <!-- stock flow wiring -->
      <!-- EULA page skipped: later Order on the same control wins. -->
      <Publish Dialog="WelcomeDlg" Control="Next" Event="NewDialog" Value="InstallDirDlg" Order="2">1</Publish>
      <Publish Dialog="InstallDirDlg" Control="Back" Event="NewDialog" Value="WelcomeDlg" Order="2">{no_mode_cond}</Publish>
      <Publish Dialog="InstallDirDlg" Control="Back" Event="NewDialog" Value="AurionModeDlg" Order="3">{mode_cond}</Publish>
      <!-- Ready page Back: to our dialogs (never to the stock Maintenance pages) -->
      <Publish Dialog="VerifyReadyDlg" Control="Back" Event="NewDialog" Value="InstallDirDlg" Order="10">NOT Installed AND NOT AURION_MODEPICK</Publish>
      <Publish Dialog="VerifyReadyDlg" Control="Back" Event="NewDialog" Value="AurionModeDlg" Order="11">NOT Installed AND AURION_MODEPICK</Publish>
      <Publish Dialog="VerifyReadyDlg" Control="Back" Event="NewDialog" Value="AurionRemoveDlg" Order="12">Installed AND NOT PATCH</Publish>
      <!-- Launch the app from the Finish page (first install / upgrade only) -->
      <Publish Dialog="ExitDialog" Control="Finish" Event="DoAction" Value="AurionLaunchApp" Order="1">WIXUI_EXITDIALOGOPTIONALCHECKBOX = 1 AND NOT Installed</Publish>
      <!-- stock maintenance welcome -> our branded Repair/Remove page -->
      <Publish Dialog="MaintenanceWelcomeDlg" Control="Next" Event="NewDialog" Value="AurionRemoveDlg" Order="2">1</Publish>
      <Publish Dialog="MaintenanceTypeDlg" Control="Next" Event="NewDialog" Value="VerifyReadyDlg" Order="2">1</Publish>

      <InstallUISequence>
        <!-- First install: mode dialog when an old AURION is present,
             otherwise the stock Welcome. Maintenance (Control Panel
             "Change"/ModifyPath): the stock MaintenanceWelcomeDlg appears
             and its Next is re-pointed to our branded AurionRemoveDlg. -->
        <Custom Action="AurionVerCmp" After="AppSearch">NOT Installed</Custom>
        <Show Dialog="AurionModeDlg" After="MigrateFeatureStates">{mode_cond}</Show>
        <Show Dialog="WelcomeDlg" Before="ProgressDlg">{no_mode_cond}</Show>
        <!-- Maintenance (Control Panel "Change" / ModifyPath): the stock
             MaintenanceWelcomeDlg shows first; its Next is re-pointed to our
             branded AurionRemoveDlg (later Order on the same control wins -
             the same pattern as our WelcomeDlg.Next override). Its
             Repair/Remove buttons perform the real operation. -->
      </InstallUISequence>
    </UI>
    <UIRef Id="WixUI_InstallDir" />
    <UIRef Id="WixUI_ErrorProgressText" />
  </Product>
</Wix>
''',
        encoding="utf-8",
    )
    return files


def stage_assets() -> None:
    """Copy wizard assets next to the generated wxs (wixl resolves paths
    relative to the .wxs file) and keep a committed fallback copy of the wxs
    for Windows builds without Python."""
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "wix").mkdir(exist_ok=True)
    for name in ("banner.bmp", "aurion-small.ico"):
        src = WIX_ASSETS / name
        if src.exists():
            shutil.copy2(src, OUT / "wix" / name)
    shutil.copy2(OUT / "aurion.wxs", HERE / "aurion.wxs")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--version", default=None, help="product version X.Y.Z(.W)")
    ap.add_argument("--wxs", action="store_true", help="generate .wxs + assets only")
    ap.add_argument("--check", action="store_true", help="lint the generated .wxs and stop")
    ap.add_argument("--app-dir", type=Path, default=None,
                    help=f"electron-builder win-unpacked dir to package (default: {APP_DIR_DEFAULT} when it exists)")
    ap.add_argument("--tree", action="store_true",
                    help="package the raw repo tree with the script launcher instead of the Electron app")
    args = ap.parse_args()

    global PAYLOAD_ROOT, APP_MODE
    app_dir = args.app_dir or APP_DIR_DEFAULT
    if not args.tree and (app_dir / "AURION.exe").exists():
        PAYLOAD_ROOT = app_dir.resolve()
        APP_MODE = True
    elif args.app_dir and not args.tree:
        raise SystemExit(f"--app-dir has no AURION.exe: {app_dir}")

    version = product_version(args.version)
    OUT.mkdir(parents=True, exist_ok=True)
    wxs = OUT / "aurion.wxs"

    files = build_wxs(version, wxs)
    stage_assets()
    if APP_MODE and not any(f.name == "AURION.exe" and f.parent == PAYLOAD_ROOT for f in files):
        raise SystemExit("FATAL: AURION.exe was not included in the payload")
    # version sync guard: the exe's FileVersion (desktop/package.json) must
    # match the product version (engine __init__.py) - a drift shows up as
    # wrong "Version" in Apps & features details.
    try:
        import json as _json
        pkg = _json.loads((ROOT / "windows-app" / "desktop" / "package.json").read_text(encoding="utf-8"))
        pkg_v = str(pkg.get("version", "")).strip()
        if pkg_v and pkg_v != version:
            print(f"WARNING: desktop/package.json version {pkg_v} != product version {version} "
                  f"- AURION.exe FileVersion will differ; keep them in sync.")
    except Exception:
        pass
    print(f"payload: {'Electron app ' + str(PAYLOAD_ROOT) if APP_MODE else 'raw tree (script launcher) ' + str(PAYLOAD_ROOT)}")
    print(f"files {len(files)} version {version} wxs {wxs}")
    for s in SKIPPED_LARGE:
        print(f"WARNING: skipped >1.9GB file (not shipped): {s}")
    print("Default install dir: %LOCALAPPDATA%\\Programs\\AURION (per user, no admin)")
    print("Upgrade UX: mode dialog (Update / Repair / Change location) when an")
    print("            AURION install is detected; user state + license are kept")

    if args.check or args.wxs:
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        from lint_wxs import check_wxs
        errors = check_wxs(wxs)
        if errors:
            print(f"LINT FAIL: {len(errors)} problem(s)")
            for e in errors:
                print("  -", e)
            raise SystemExit(1)
        print(f"LINT OK: {wxs}")
        if args.wxs:
            print("--wxs: stopping before compile (Windows: build-msi-windows.ps1)")
        return

    msi = OUT / "AURION-Setup.msi"
    try:
        subprocess.check_call(["wixl", "-o", str(msi), str(wxs)])
        print(f"MSI built: {msi} ({msi.stat().st_size} bytes)")
        print("Installer type: MSI (perUser, LocalAppData, branded wizard)")
    except FileNotFoundError:
        print("wixl not found. On Windows build the same .wxs with the WiX toolset:")
        print("  powershell -ExecutionPolicy Bypass -File windows-app\\packaging\\build-msi-windows.ps1")
        print("   (or: candle.exe aurion.wxs -arch x64 && light.exe AURION.wixobj -loc aurion.wxl -out AURION-Setup.msi)")


if __name__ == "__main__":
    main()
