#!/usr/bin/env python3
"""Make the Ed25519 signing seed AURION licences are minted with.

Run once, on the machine you intend to sign from, and never again: the
seed IS the product. Anyone holding it can mint a licence for any plan,
and rotating it invalidates every key already sold, because the public
half is compiled into every copy of AURION that has shipped.

    python3 admin/new-seed.py            # print it
    python3 admin/new-seed.py --save     # print it and keep it for the panel

With --save the seed is also written to admin/panel/seed.key (owner-only,
never committed), which is where the admin panel looks for it. That
spares you setting AURION_KEY_PRIVATE_HEX in every console you open -
a step that silently leaves the Licences tab unable to mint when it is
forgotten.

It prints two things. The private seed goes in the key server's .env and
nowhere else - not in git, not in a chat, not in a screenshot. The public
half goes into the engine so the desk can verify offline keys without
asking anyone.
"""

from __future__ import annotations

import secrets
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "engine"))


def main() -> int:
    try:
        from aurion.license import ed25519 as ed
    except Exception as exc:                       # pragma: no cover
        print(f"could not import the engine's ed25519: {exc}", file=sys.stderr)
        print("run this from the repository root.", file=sys.stderr)
        return 2

    seed = secrets.token_bytes(32)
    public = ed.publickey(seed)

    saved = ""
    if "--save" in sys.argv:
        target = ROOT / "admin" / "panel" / "seed.key"
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(seed.hex() + "\n", encoding="utf-8")
        try:
            target.chmod(0o600)
        except OSError:                            # Windows ACLs; best effort
            pass
        saved = str(target)

    print()
    print("  A new AURION signing key")
    print("  " + "-" * 50)
    print()
    print("  PRIVATE SEED  (key server .env, nowhere else)")
    print(f"    AURION_KEY_PRIVATE_HEX={seed.hex()}")
    print()
    print("  PUBLIC KEY    (ships inside AURION, safe to commit)")
    print(f"    {public.hex()}")
    print()
    if saved:
        print(f"  SAVED FOR THE PANEL   {saved}")
        print("    The admin panel reads this file; nothing to set by hand.")
        print()
    else:
        print("  Not saved anywhere. Run again with --save to let the admin")
        print("  panel use it without you setting an environment variable.")
        print()
    print("  Next:")
    print("    1. Put the private line in store/keyserver/.env")
    print("    2. Put the public key in engine/aurion/license/material.py")
    print("    3. Rebuild the MSI so desks carry the new public key")
    print()
    print("  Keep the seed. Losing it means no new licences can be minted;")
    print("  leaking it means anyone can mint them. Replacing it breaks")
    print("  every licence already sold.")
    print()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
