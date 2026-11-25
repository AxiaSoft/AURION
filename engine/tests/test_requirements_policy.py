"""The dependency policy, which is about CPUs and not about Python.

AURION once refused to install on any Python newer than 3.12. The
reason given was NumPy, and the reason was half right: NumPy 2.1+
builds its *x86* wheels for the x86-64-v2 baseline, which an older x86
chip cannot execute, and the last wheel that runs anywhere - 1.26.4 -
publishes nothing for 3.13 or newer.

Both halves are true only on x86. The ARM wheels were never built
against a raised baseline, so on aarch64, Apple silicon, or a phone
running Debian under proot there was never anything to protect against
- and pinning there is what made the product uninstallable on every
current distribution, since the one that ships 3.13 is the one you get.

engine/requirements.txt now says that with environment markers. These
tests check the thing that actually matters: that every (interpreter,
architecture) pair a user might have resolves to exactly one usable
specifier, that the old-CPU case is still protected, and that nothing
has quietly reintroduced a ceiling.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from packaging.requirements import Requirement

ROOT = Path(__file__).resolve().parents[2]
REQUIREMENTS = ROOT / "engine" / "requirements.txt"

#: The compiled packages - the only ones the split applies to.
COMPILED = ("numpy", "pandas", "scikit-learn", "scipy")

#: Every combination worth being sure about. The names are the
#: situations, because that is what a failure here has to explain.
ENVIRONMENTS = {
    "an old x86 CPU on 3.12": {"python_version": "3.12", "platform_machine": "x86_64"},
    "64-bit Windows on 3.11": {"python_version": "3.11", "platform_machine": "AMD64"},
    "32-bit x86 on 3.10": {"python_version": "3.10", "platform_machine": "i686"},
    "x86 on 3.13": {"python_version": "3.13", "platform_machine": "x86_64"},
    "Windows on 3.14": {"python_version": "3.14", "platform_machine": "AMD64"},
    "a phone's Debian on 3.11": {"python_version": "3.11", "platform_machine": "aarch64"},
    "a phone's Debian on 3.13": {"python_version": "3.13", "platform_machine": "aarch64"},
    "a phone's Debian on 3.14": {"python_version": "3.14", "platform_machine": "aarch64"},
    "Apple silicon on 3.13": {"python_version": "3.13", "platform_machine": "arm64"},
    "a Raspberry Pi on 3.13": {"python_version": "3.13", "platform_machine": "armv7l"},
}


def _requirements() -> list[Requirement]:
    out = []
    for raw in REQUIREMENTS.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        out.append(Requirement(line))
    return out


def _chosen(reqs: list[Requirement], name: str, env: dict[str, str]) -> list[Requirement]:
    return [
        r for r in reqs
        if r.name == name and (r.marker is None or r.marker.evaluate(env))
    ]


@pytest.mark.parametrize("label", sorted(ENVIRONMENTS))
@pytest.mark.parametrize("package", COMPILED)
def test_every_machine_resolves_to_exactly_one_specifier(label: str, package: str) -> None:
    """Two matching lines would let pip pick; none would leave it unpinned.

    This is the failure that markers invite: widen one condition, forget
    to narrow the other, and the two lines overlap. pip then has to
    satisfy both at once, which on this file means an impossible
    `==1.26.4,>=2.1` - an install that fails for a reason nobody reading
    the error would connect to this file.
    """
    env = ENVIRONMENTS[label]
    chosen = _chosen(_requirements(), package, env)
    assert len(chosen) == 1, (
        f"{package} on {label} resolves to {len(chosen)} lines: "
        f"{[str(c) for c in chosen]}"
    )


@pytest.mark.parametrize(
    "label",
    ["an old x86 CPU on 3.12", "64-bit Windows on 3.11", "32-bit x86 on 3.10"],
)
def test_an_old_x86_cpu_still_gets_the_wheel_that_runs_on_it(label: str) -> None:
    """The protection that the pin existed for, which must not be lost.

    NumPy 2.1+ on a pre-x86-64-v2 chip does not degrade, it dies with an
    illegal instruction. Anyone still on such a machine is also still on
    3.12 or older, because 1.26.4 is the newest wheel they can have.
    """
    reqs = _requirements()
    env = ENVIRONMENTS[label]
    numpy = _chosen(reqs, "numpy", env)[0]
    assert str(numpy.specifier) == "==1.26.4", (
        f"an old x86 CPU on {label} would get numpy{numpy.specifier}, "
        "which may not run on it"
    )


@pytest.mark.parametrize(
    "label",
    [
        "a phone's Debian on 3.11",
        "a phone's Debian on 3.13",
        "a phone's Debian on 3.14",
        "Apple silicon on 3.13",
        "a Raspberry Pi on 3.13",
        "x86 on 3.13",
        "Windows on 3.14",
    ],
)
@pytest.mark.parametrize("package", COMPILED)
def test_everything_else_is_free_to_take_a_current_release(label: str, package: str) -> None:
    """No ceiling anywhere the x86 baseline does not apply.

    An `==` here is how the old bug comes back: it is what stops a
    machine whose Python has no such wheel from installing at all.
    """
    env = ENVIRONMENTS[label]
    chosen = _chosen(_requirements(), package, env)[0]
    spec = str(chosen.specifier)
    assert "==" not in spec, (
        f"{package} is pinned to {spec} on {label}, where the x86-64-v2 "
        "baseline does not apply - this is the ceiling that made AURION "
        "uninstallable on current Pythons"
    )
    assert spec.startswith(">="), f"{package} on {label} has no floor: {spec!r}"


def test_no_requirement_caps_the_python_version() -> None:
    """A `python_version < ...` upper bound on a package would re-cap everything."""
    for req in _requirements():
        if req.marker is None:
            continue
        text = str(req.marker)
        if 'python_version <' not in text:
            continue
        # The only legitimate use is selecting the old-x86 line, which
        # must always be paired with the x86 machine list.
        assert "platform_machine" in text, (
            f"{req.name} caps the Python version for every architecture: {text}"
        )


def test_the_engine_does_not_refuse_a_python_by_version() -> None:
    """engine/main.py used to exit(2) on 3.13. That check is gone for good.

    It is replaced by trying: a missing library and a NumPy built for a
    newer CPU baseline are both detected from the failure they actually
    cause, which is the only honest way to know either.
    """
    main = (ROOT / "engine" / "main.py").read_text(encoding="utf-8")
    code = "\n".join(
        line for line in main.splitlines()
        if not line.lstrip().startswith("#")
    )
    assert "version_info >= (3, 13)" not in code, \
        "engine/main.py refuses a Python by version again"
    assert "X86_V2" in code, \
        "the old-CPU NumPy message is the guard that should remain"
    assert "ModuleNotFoundError" in code, \
        "a missing dependency should be reported with what to run"
