"""Each install must only listen for the people paired with it.

A single bot token is shared by every desk, and Telegram hands a long-poll
update to exactly ONE caller.  An install with nobody paired therefore has
no business on the wire: anything it receives belongs to somebody else, and
taking it means the desk that should have had it never will.

    python3 engine/tests/test_telegram_isolation.py
"""
from __future__ import annotations

import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from aurion.telegram.bot import TelegramBot  # noqa: E402


def _bot(chats):
    bot = TelegramBot.__new__(TelegramBot)
    bot._pair_code = ""
    bot._pair_until = 0.0
    bot.chat_ids = lambda: {int(c) for c in chats}
    return bot


def test_idle_install_does_not_poll() -> None:
    bot = _bot([])
    assert bot._should_poll() is False, "an install with no chats must stay off the wire"


def test_paired_install_polls() -> None:
    bot = _bot([12345])
    assert bot._should_poll() is True


def test_pairing_window_opens_the_wire() -> None:
    bot = _bot([])
    bot._pair_code = "123456"
    bot._pair_until = time.time() + 60
    assert bot._should_poll() is True, "a live pairing code has to be able to arrive"


def test_expired_pairing_window_closes_it_again() -> None:
    bot = _bot([])
    bot._pair_code = "123456"
    bot._pair_until = time.time() - 1
    assert bot._should_poll() is False


def test_only_paired_chats_are_authorised() -> None:
    bot = _bot([111])
    assert bot._authorized(111) is True
    assert bot._authorized(222) is False, "another customer's chat is not this desk's"


TESTS = [
    test_idle_install_does_not_poll,
    test_paired_install_polls,
    test_pairing_window_opens_the_wire,
    test_expired_pairing_window_closes_it_again,
    test_only_paired_chats_are_authorised,
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
    print("\n%d failing." % bad if bad else "\nEach desk listens only for its own.")
    raise SystemExit(1 if bad else 0)
