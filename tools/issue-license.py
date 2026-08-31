#!/usr/bin/env python3
"""Issue a one-time Axiasoft product key. Run only on the issuer machine.

  py -3.12 tools/issue-license.py --plan m1 --note customer@gmail.com
  py -3.12 tools/issue-license.py --plan m3 --note 09121234567
  py -3.12 tools/issue-license.py --plan m6
  py -3.12 tools/issue-license.py --plan y1
  py -3.12 tools/issue-license.py --plan developer
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "engine"))

from aurion.license.guard import PLANS, mint  # noqa: E402

LEDGER = ROOT / "data" / "license" / "issued.json"


def main() -> int:
    p = argparse.ArgumentParser(description="Issue Axiasoft AURION product keys")
    p.add_argument("--plan", required=True, choices=["m1", "m3", "m6", "y1", "developer"])
    p.add_argument("--note", default="", help="buyer gmail or Iranian mobile (for your ledger only)")
    args = p.parse_args()
    key = mint(args.plan, args.note)
    LEDGER.parent.mkdir(parents=True, exist_ok=True)
    rows = []
    if LEDGER.exists():
        try:
            rows = json.loads(LEDGER.read_text(encoding="utf-8"))
        except Exception:
            rows = []
    rows.append(
        {
            "ts": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
            "plan": args.plan,
            "note": args.note,
            "key_prefix": key[:12] + "…",
            "days": PLANS[args.plan]["days"],
        }
    )
    LEDGER.write_text(json.dumps(rows, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(key)
    print(f"# plan={args.plan} days={PLANS[args.plan]['days']} note={args.note or '-'}", file=sys.stderr)
    print("# Give the key to the buyer once. It cannot be reused after activation.", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
