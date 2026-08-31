#!/usr/bin/env python3
"""
Local-only key minting tool (owner machine only).
- Not exposed via public API
- Supports both AXIASOFT_KEY_PRIVATE and AURION_KEY_PRIVATE_HEX
- Fixes ModuleNotFoundError by adding engine/ to sys.path

Usage (Windows):
  set AURION_KEY_PRIVATE_HEX=9090ebd8...
  python scripts/mint_local.py developer "admin-owner"

  set AURION_KEY_PRIVATE_HEX=9090ebd8...
  python scripts/mint_local.py m1 "client@example.com"

  set AURION_KEY_PRIVATE_HEX=9090ebd8...
  python scripts/mint_local.py y1 "client@example.com"

Usage (PowerShell):
  $env:AURION_KEY_PRIVATE_HEX="9090ebd8..."
  python scripts/mint_local.py developer "admin-owner"

  $env:AXIASOFT_KEY_PRIVATE="9090ebd8..."
  python scripts/mint_local.py m1 "client@example.com"

Plans: m1 (1 month), m3 (3 months), m6 (6 months), y1 (12 months), developer (admin, unlimited)
"""
import os
import sys
from pathlib import Path

# Ensure engine/ is on PYTHONPATH regardless of where you run from
ROOT = Path(__file__).resolve().parents[1]
ENGINE = ROOT / "engine"
if str(ENGINE) not in sys.path:
    sys.path.insert(0, str(ENGINE))

# Also allow running from D:\AURION BETA with space in path
# Python 3.12+ recommended, but 3.11/3.13/3.14 also works for minting (no MT5 dep)

try:
    from aurion.license.guard import mint, _priv_source, PLANS
except ModuleNotFoundError as e:
    print(f"ModuleNotFoundError: {e}", file=sys.stderr)
    print(f"ROOT={ROOT}", file=sys.stderr)
    print(f"ENGINE={ENGINE} exists={ENGINE.exists()}", file=sys.stderr)
    print("Fix: run from AURION root, e.g.: python scripts/mint_local.py developer", file=sys.stderr)
    print("Or set PYTHONPATH: set PYTHONPATH=D:\\AURION BETA\\engine", file=sys.stderr)
    sys.exit(4)

def main():
    if len(sys.argv) < 2:
        print("Usage: python scripts/mint_local.py <plan> [note]", file=sys.stderr)
        print(f"Plans: {', '.join(k for k in PLANS if k not in ('freemium','trial'))}", file=sys.stderr)
        print("Example: python scripts/mint_local.py developer \"admin-owner\"", file=sys.stderr)
        print("Example: python scripts/mint_local.py m1 \"client@example.com\"", file=sys.stderr)
        sys.exit(2)

    plan = sys.argv[1].lower()
    note = sys.argv[2] if len(sys.argv) > 2 else "local"

    # Check private key present (supports both names)
    has_key = any(os.environ.get(n, "").strip() for n in ("AXIASOFT_KEY_PRIVATE", "AURION_KEY_PRIVATE_HEX", "AURION_KEY_PRIVATE", "KEY_PRIVATE"))
    if not has_key:
        print("ERROR: Private key not set in env.", file=sys.stderr)
        print("Set one of:", file=sys.stderr)
        print("  Windows CMD: set AURION_KEY_PRIVATE_HEX=9090ebd82348b326eb891e496f2f5c1746a53243625237411835a810686826dc", file=sys.stderr)
        print("  PowerShell: $env:AURION_KEY_PRIVATE_HEX=\"9090ebd82348b326eb891e496f2f5c1746a53243625237411835a810686826dc\"", file=sys.stderr)
        print("  Linux: export AURION_KEY_PRIVATE_HEX=9090ebd8...", file=sys.stderr)
        sys.exit(3)

    try:
        key = mint(plan, note)
        src = _priv_source()
        # Print key to stdout (easy to copy), info to stderr
        print(key)
        print(f"# OK plan={plan} note={note} via {src}", file=sys.stderr)
        if plan == "developer":
            print(f"# Admin key (AXI-DEV-) — unlimited, offline verifiable, premium all features", file=sys.stderr)
        else:
            print(f"# Normal key (AXIA-{plan.upper()}-) — requires keyserver online activation", file=sys.stderr)
            print(f"# To activate: desk -> Upgrade -> paste key", file=sys.stderr)
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    main()
