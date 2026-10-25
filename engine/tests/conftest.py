"""Test isolation that no individual test should have to remember.

Two things leak between test files here, and both of them produced
failures that said nothing about the code under test:

  * the licence issuer. A test that needs to mint keys sets
    AXIASOFT_KEY_PRIVATE / AXIASOFT_KEY_PUBLIC in the process
    environment. The offline-licence tests mint with their own seed in
    AURION_KEY_PRIVATE_HEX - which the guard reads *second* - so once
    any earlier test had set the first pair, every offline key was
    signed by one issuer and verified against another and came back
    "invalid_key". Run alone the file passed; run after test_fixes it
    failed. The environment is therefore restored around every test.

  * the machine's own state directory. AURION_HOME and AURION_DATA_DIR
    decide where a licence, a database and a settings backup are read
    from, and a test that repoints them must not leave them repointed.

Nothing here changes what the tests assert. It only makes the answer
independent of the order they run in, which is the difference between a
suite that is believed and one that is ignored.
"""

from __future__ import annotations

import os

import pytest

# Everything that decides which issuer signs a key, and where the engine
# keeps its state. One list, so adding a new one is one line.
LEAKY = (
    "AXIASOFT_KEY_PRIVATE",
    "AXIASOFT_KEY_PUBLIC",
    "AURION_KEY_PRIVATE_HEX",
    "AURION_KEY_PRIVATE",
    "KEY_PRIVATE",
    "AURION_HOME",
    "AURION_DATA_DIR",
    "AURION_CONFIG_DIR",
)


@pytest.fixture(autouse=True)
def _no_environment_leaks():
    before = {name: os.environ.get(name) for name in LEAKY}
    try:
        yield
    finally:
        for name, value in before.items():
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value
