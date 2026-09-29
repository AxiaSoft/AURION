"""Every branding asset must be the format its name claims.

A .png renamed to .ico passes every existence check in the build script and
then fails a minute later inside the C# compiler as:

    CSC : error CS7065: Error building Win32 resources --
          Icon stream is not in the expected format.

which names neither the file nor the reason. It cost a whole build to find
once. This makes it impossible to commit again.

    python3 engine/tests/test_installer_assets.py
"""
from __future__ import annotations

import struct
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ASSETS = ROOT / "installer" / "assets" / "generated"
SCRIPT = ROOT / "installer" / "tools" / "build-msi.ps1"
BUILDER = ROOT / "installer" / "assets" / "build-assets.py"

ICONS = ["aurion.ico", "exclamation.ico", "info.ico", "new.ico", "up.ico"]
BITMAPS = ["banner.bmp", "dialog.bmp"]


def test_every_icon_is_a_real_icon() -> None:
    for name in ICONS:
        blob = (ASSETS / name).read_bytes()
        assert blob[:4] == b"\x00\x00\x01\x00", (
            f"{name} starts with {blob[:4]!r} - that is not an ICO container"
        )


def test_every_icon_holds_the_images_it_promises() -> None:
    for name in ICONS:
        blob = (ASSETS / name).read_bytes()
        count = struct.unpack("<H", blob[4:6])[0]
        assert count >= 1, f"{name} declares no images"
        for i in range(count):
            off = 6 + i * 16
            size, data = struct.unpack("<II", blob[off + 8:off + 16])
            assert data + size <= len(blob), f"{name}: image {i + 1} points past the end"


def test_the_product_icon_covers_the_sizes_windows_asks_for() -> None:
    """Explorer, the taskbar, alt-tab and the installer all want a different one."""
    blob = (ASSETS / "aurion.ico").read_bytes()
    count = struct.unpack("<H", blob[4:6])[0]
    sizes = {(blob[6 + i * 16] or 256) for i in range(count)}
    for need in (16, 32, 48, 256):
        assert need in sizes, f"aurion.ico has no {need}x{need} image (has {sorted(sizes)})"


def test_every_bitmap_is_a_real_bitmap() -> None:
    for name in BITMAPS:
        blob = (ASSETS / name).read_bytes()
        assert blob[:2] == b"BM", f"{name} is not a BMP - Windows Installer will not draw it"


def test_the_build_script_checks_this_before_compiling() -> None:
    ps1 = SCRIPT.read_text(encoding="utf-8")
    assert "asset formats verified" in ps1, "the build script must validate, not just Test-Path"
    assert "CS7065" in ps1, "and should say which failure it is preventing"


def test_a_dropped_png_can_be_repaired_without_extra_tools() -> None:
    """Somebody swapping in their own logo will copy a PNG over the .ico.

    The build repacks it rather than refusing, using nothing but PowerShell
    and System.Drawing - a build machine has no ImageMagick and may have no
    Python either.
    """
    maker = ROOT / "installer" / "tools" / "make-icon.ps1"
    assert maker.exists(), "installer/tools/make-icon.ps1 is missing"
    src = maker.read_text(encoding="utf-8")
    assert "System.Drawing" in src and "Add-Type" in src, "it must not need anything installed"
    # The container it writes: type 1, 32bpp, 256 stored as PNG, the rest DIB.
    assert "[uint16]1)                 # type 1 = icon" in src
    assert "[uint16]32)            # bits per pixel" in src
    assert "biHeight - colours + mask" in src, "an icon DIB doubles biHeight; that is the classic trap"

    ps1 = SCRIPT.read_text(encoding="utf-8")
    assert "make-icon.ps1" in ps1, "the build script has to know how to repair one"
    assert "repacking it" in ps1, "and say so rather than doing it silently"


def test_the_generator_can_verify_without_pillow() -> None:
    src = BUILDER.read_text(encoding="utf-8")
    assert "--verify" in src, "a build machine has to be able to check without installing Pillow"
    assert "Image = ImageDraw = ImageFilter = ImageFont = None" in src, \
        "the Pillow import must not abort the verify path"


TESTS = [
    test_a_dropped_png_can_be_repaired_without_extra_tools,
    test_every_icon_is_a_real_icon,
    test_every_icon_holds_the_images_it_promises,
    test_the_product_icon_covers_the_sizes_windows_asks_for,
    test_every_bitmap_is_a_real_bitmap,
    test_the_build_script_checks_this_before_compiling,
    test_the_generator_can_verify_without_pillow,
]

if __name__ == "__main__":
    bad = 0
    for fn in TESTS:
        try:
            fn()
            print("  ok  " + fn.__name__)
        except AssertionError as exc:
            print("FAIL  " + fn.__name__ + " → " + str(exc))
            bad += 1
        except Exception as exc:  # a corrupt file must report, not traceback
            print("FAIL  " + fn.__name__ + " → " + type(exc).__name__ + ": " + str(exc))
            bad += 1
    print("\n%d failing." % bad if bad else "\nThe installer's artwork is what it says it is.")
    raise SystemExit(1 if bad else 0)
