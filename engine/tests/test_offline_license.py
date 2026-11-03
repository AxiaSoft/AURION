"""Premium, activated on a desk with no internet.

Why this exists at all: a customer key (AXIA-) carries the first fifteen
bytes of an Ed25519 signature. Fifteen bytes of a signature cannot be
verified - not with the public key, not with anything - so the only way to
know such a key is genuine is to ask the server that minted it. On a desk
that will never see the internet, that made Premium unreachable.

AXIO- keys carry the whole signature. Every copy of AURION already ships
the public key, so the desk can decide for itself, and the term comes from
the plan exactly as it does online.

The trade is real and is tested for here too: an offline key cannot be
revoked and cannot be capped to a number of machines, because nothing it
depends on lives anywhere else.
"""

from __future__ import annotations

import os
import secrets
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def _fresh_guard():
    """A guard with its own home and a key pair this test controls."""
    seed = secrets.token_hex(32)
    os.environ["AURION_KEY_PRIVATE_HEX"] = seed
    os.environ["AURION_HOME"] = tempfile.mkdtemp()

    for name in [m for m in list(sys.modules) if m.startswith("aurion")]:
        del sys.modules[name]

    from aurion.license import ed25519 as ed
    from aurion.license import guard as g

    # The bundled public key belongs to the real signing machine; this test
    # has to verify against its own.
    g._pub = lambda: ed.publickey(bytes.fromhex(seed))
    return g


def test_offline_key_verifies_without_any_network():
    g = _fresh_guard()

    for plan in ("m1", "m3", "m6", "y1"):
        key = g.mint(plan, "test", offline=True)
        assert key.startswith("AXIO-")

        parsed = g.decode_key(key)
        assert parsed is not None, f"{plan} key did not parse"
        assert parsed["verified"] is True
        assert parsed["offline"] is True
        assert parsed["plan"] == plan


def test_a_tampered_offline_key_is_refused():
    g = _fresh_guard()
    key = g.mint("y1", "test", offline=True)

    # One character of the signature.
    flipped = "A" if key[-1] != "A" else "B"
    assert g.decode_key(key[:-1] + flipped) is None

    # And the plan, which is inside the signed body - so upgrading a one
    # month key to a year by editing the text cannot work.
    assert g.decode_key(key.replace("AXIO-Y1-", "AXIO-M1-", 1)) is None


def test_activation_sets_the_term_from_the_plan():
    g = _fresh_guard()
    guard = g.Guard()

    before = datetime.now(timezone.utc)
    out = guard.activate(g.mint("m3", "test", offline=True), "trader@example.com")

    assert out["ok"] is True, out
    lic = out["license"]
    assert lic["premium"] is True
    assert lic["plan"] == "m3"

    # 90 days, counted from now, reported as days_left - the same field the
    # desk has always shown. No new clock, just one that gets wound up
    # without a server.
    assert lic["days_left"] in (89, 90), lic["days_left"]

    expires = g.parse_iso(lic["expires"])
    assert expires is not None
    assert before + timedelta(days=89) < expires < before + timedelta(days=91)


def test_the_term_runs_down_and_expires():
    g = _fresh_guard()
    guard = g.Guard()
    guard.activate(g.mint("m1", "test", offline=True), "trader@example.com")

    # Wind the stored expiry back past its end, the way thirty-one days of
    # elapsed time would.
    guard.state["expires"] = g._iso(datetime.now(timezone.utc) - timedelta(days=1))
    guard._write(guard.state)

    assert guard.expired() is True
    assert guard.premium_active() is False
    assert guard.public()["days_left"] == 0


def test_an_offline_key_is_single_use_on_one_machine():
    g = _fresh_guard()
    guard = g.Guard()
    key = g.mint("m1", "test", offline=True)

    assert guard.activate(key, "trader@example.com")["ok"] is True

    again = guard.activate(key, "trader@example.com")
    assert again["ok"] is False
    assert again["error"] == "key_used"


def test_offline_keys_are_only_for_paid_plans():
    g = _fresh_guard()
    for plan in ("freemium", "developer", "trial"):
        try:
            g.mint(plan, "test", offline=True)
        except ValueError:
            continue
        raise AssertionError(f"{plan} should not be mintable as an offline key")


def test_ordinary_customer_keys_are_unchanged():
    """The online path must keep its server check.

    An AXIA- key is fifteen bytes of signature and nothing can verify it
    locally. If this ever starts parsing as verified, offline activation
    has been handed to keys that cannot prove anything.
    """
    g = _fresh_guard()
    parsed = g.decode_key(g.mint("y1", "test"))
    assert parsed is not None
    assert parsed.get("verified") is False
    assert parsed.get("offline") is not True


if __name__ == "__main__":
    passed = 0
    for name, fn in sorted(globals().items()):
        if not name.startswith("test_") or not callable(fn):
            continue
        fn()
        passed += 1
        print(f"ok   {name}")
    print(f"\n{passed}/{passed} offline licence checks passed")
