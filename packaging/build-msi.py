#!/usr/bin/env python3
"""Build AURION-Setup.msi with wixl (Linux).
Installs to C:\\Program Files\\AURION (perMachine) and creates desktop shortcut.
Installer output is MSI as requested.
"""
from __future__ import annotations

import os
import subprocess
import uuid
import xml.sax.saxutils as x
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "dist"
SKIP_DIRS = {
    ".git", ".arena", ".cache", ".mypy_cache", ".next", ".npm",
    "node_modules", "__pycache__", "build", "dist", "coverage",
    ".venv", "target", "android-sdk",
}
SKIP_FILES = {".DS_Store"}
MAX_FILE = 12 * 1024 * 1024

NS = "http://schemas.microsoft.com/wix/2006/wi"
UPGRADE = "A1B2C3D4-E5F6-7890-ABCD-AURION000001"

def guid_for(s: str) -> str:
    return str(uuid.uuid5(uuid.NAMESPACE_URL, "aurion:" + s)).upper()

def collect() -> list[Path]:
    files: list[Path] = []
    for p in ROOT.rglob("*"):
        if not p.is_file():
            continue
        rel = p.relative_to(ROOT)
        if any(part in SKIP_DIRS for part in rel.parts):
            continue
        if p.name in SKIP_FILES:
            continue
        if p.suffix.lower() in {".pyc", ".pyo", ".log", ".apk", ".msi", ".keystore"}:
            continue
        if p.stat().st_size > MAX_FILE:
            continue
        files.append(p)
    files.sort()
    return files

def xml_id(prefix: str, n: int) -> str:
    return f"{prefix}{n:04d}"

def main() -> None:
    files = collect()
    OUT.mkdir(parents=True, exist_ok=True)
    wxs = OUT / "aurion.wxs"

    dirs: dict[str, str] = {"": "INSTALLDIR"}
    dir_xml = []
    next_dir = 1

    def ensure_dir(rel: Path) -> str:
        nonlocal next_dir
        key = str(rel).replace("\\", "/")
        if key in dirs:
            return dirs[key]
        parent = ensure_dir(rel.parent) if rel.parent != Path(".") and str(rel.parent) != "" else "INSTALLDIR"
        if key == "." or key == "":
            return "INSTALLDIR"
        did = xml_id("D", next_dir)
        next_dir += 1
        dirs[key] = did
        name = x.escape(rel.name)
        dir_xml.append((parent, did, name))
        return did

    for f in files:
        rel = f.relative_to(ROOT)
        if rel.parent != Path("."):
            ensure_dir(rel.parent)

    children: dict[str, list[tuple[str, str]]] = {}
    for parent, did, name in dir_xml:
        children.setdefault(parent, []).append((did, name))

    files_by_dir: dict[str, list[Path]] = {}
    for f in files:
        rel = f.relative_to(ROOT)
        did = dirs.get(str(rel.parent).replace("\\", "/"), "INSTALLDIR")
        if str(rel.parent) in (".", ""):
            did = "INSTALLDIR"
        files_by_dir.setdefault(did, []).append(f)

    comps = []
    n = 1

    def emit_dir(did: str, indent: int) -> list[str]:
        nonlocal n
        pad = "  " * indent
        lines = []
        for f in files_by_dir.get(did, []):
            cid = xml_id("C", n)
            fid = xml_id("F", n)
            n += 1
            rel = f.relative_to(ROOT)
            src = x.escape(str(f))
            name = x.escape(f.name)
            gid = guid_for(str(rel))
            comps.append(cid)
            lines.append(f'{pad}  <Component Id="{cid}" Guid="{gid}">')
            lines.append(f'{pad}    <File Id="{fid}" Name="{name}" Source="{src}" KeyPath="yes" />')
            lines.append(f"{pad}  </Component>")
        for child_id, child_name in children.get(did, []):
            lines.append(f'{pad}  <Directory Id="{child_id}" Name="{x.escape(child_name)}">')
            lines.extend(emit_dir(child_id, indent + 1))
            lines.append(f"{pad}  </Directory>")
        return lines

    ico = ROOT / "packaging" / "aurion.ico"
    if not ico.exists():
        ico = ROOT / "apps" / "desktop" / "icon.ico"

    shortcut_comp = guid_for("shortcut-desktop")
    launch_src = ROOT / "packaging" / "launch-aurion.vbs"
    if not launch_src.exists():
        # create minimal launcher if missing
        launch_src.write_text('Set WshShell = CreateObject("WScript.Shell")\nWshShell.Run "cmd /c start-aurion.cmd", 0\n', encoding="utf-8")

    body = emit_dir("INSTALLDIR", 6)

    refs = "\n          ".join(f'<ComponentRef Id="{c}" />' for c in comps)
    refs += '\n          <ComponentRef Id="Shortcuts" />'
    refs += '\n          <ComponentRef Id="Launcher" />'

    wxs.write_text(
        f'''<?xml version="1.0" encoding="utf-8"?>
<Wix xmlns="{NS}">
  <Product Id="*" Name="AURION" Language="1033" Version="1.0.0.0"
           Manufacturer="AURION" UpgradeCode="{UPGRADE}">
    <Package InstallerVersion="300" Compressed="yes" InstallScope="perMachine"
             Description="AURION live MetaTrader 5 desk" InstallPrivileges="elevated" />
    <MajorUpgrade DowngradeErrorMessage="A newer AURION is already installed." />
    <Media Id="1" Cabinet="aurion.cab" EmbedCab="yes" />
    <Icon Id="AppIcon" SourceFile="{x.escape(str(ico))}" />
    <Property Id="ARPPRODUCTICON" Value="AppIcon" />
    <Property Id="WIXUI_INSTALLDIR" Value="INSTALLDIR" />
    <!-- Default to C:\\Program Files\\AURION -->
    <Directory Id="TARGETDIR" Name="SourceDir">
      <Directory Id="ProgramFilesFolder">
        <Directory Id="INSTALLDIR" Name="AURION">
{os.linesep.join(body)}
          <Component Id="Launcher" Guid="{guid_for("launcher")}">
            <File Id="LaunchVbs" Name="launch-aurion.vbs" Source="{x.escape(str(launch_src))}" KeyPath="yes" />
          </Component>
        </Directory>
      </Directory>
      <Directory Id="DesktopFolder" Name="Desktop" />
      <Directory Id="ProgramMenuFolder">
        <Directory Id="ProgramMenuDir" Name="AURION" />
      </Directory>
    </Directory>
    <DirectoryRef Id="DesktopFolder">
      <Component Id="Shortcuts" Guid="{shortcut_comp}">
        <Shortcut Id="DesktopShortcut" Name="AURION"
                  Description="AURION live desk - C:\\Program Files\\AURION"
                  Target="[#LaunchVbs]"
                  WorkingDirectory="INSTALLDIR"
                  Icon="AppIcon" />
        <Shortcut Id="StartMenuShortcut" Name="AURION"
                  Directory="ProgramMenuDir"
                  Description="AURION live desk"
                  Target="[#LaunchVbs]"
                  WorkingDirectory="INSTALLDIR"
                  Icon="AppIcon" />
        <RemoveFolder Id="RemoveMenu" Directory="ProgramMenuDir" On="uninstall" />
        <RegistryValue Root="HKLM" Key="Software\\AURION" Name="installed" Type="integer" Value="1" KeyPath="yes" />
        <RegistryValue Root="HKLM" Key="Software\\AURION" Name="InstallPath" Type="string" Value="[INSTALLDIR]" />
      </Component>
    </DirectoryRef>
    <Feature Id="MainFeature" Title="AURION" Level="1" Description="Installs to C:\\Program Files\\AURION with desktop shortcut">
          {refs}
    </Feature>
    <!-- UI for directory selection -->
    <UIRef Id="WixUI_InstallDir" />
    <UIRef Id="WixUI_ErrorProgressText" />
  </Product>
</Wix>
''',
        encoding="utf-8",
    )
    print(f"files {len(files)} wxs {wxs}")
    print(f"Default install dir: C:\\Program Files\\AURION")
    print(f"Desktop shortcut: AURION.lnk -> launch-aurion.vbs")
    msi = OUT / "AURION-Setup.msi"
    try:
        subprocess.check_call(["wixl", "-o", str(msi), str(wxs)])
        print(f"MSI built: {msi} ({msi.stat().st_size} bytes)")
        print("Installer type: MSI (perMachine, Program Files)")
    except FileNotFoundError:
        print("wixl not found - on Windows use electron-builder to build MSI:")
        print("  cd apps/desktop && npm run dist:msi")
        print("MSI wxs file generated for WiX toolset:")
        print(f"  {wxs}")

if __name__ == "__main__":
    main()
