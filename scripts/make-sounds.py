#!/usr/bin/env python3
"""Render the desk's six notification sounds to apps/web/assets/sounds/.

The desk knows six sounds by name, and each name is one Ogg Vorbis file
in the source tree:

    chime.ogg     bell            (fa: زنگ)
    ding.ogg      ding            (fa: دینگ)
    rise.ogg      bullish / up    (fa: صعودی)
    fall.ogg      bearish / down  (fa: نزولی)
    alert.ogg     warning         (fa: هشدار)
    soft.ogg      gentle          (fa: ملایم)

The files are generated rather than recorded so that they are
reproducible, license-clean and tiny, and so that a change to one of
them is a change to a few lines here rather than an opaque binary
dropped into the tree. Run this script to regenerate them:

    python3 scripts/make-sounds.py

Requires `soundfile` (which bundles libsndfile) and `numpy`.

The frequencies deliberately match the synthesized fallback tones in
apps/web/js/app.js (the SOUNDS table), so a tree whose .ogg files are
missing still sounds like the same product -- just plainer.
"""

from __future__ import annotations

import pathlib
import sys

try:
    import numpy as np
    import soundfile as sf
except ImportError as exc:  # pragma: no cover - developer tooling
    sys.exit(f"missing dependency: {exc}. Try: pip install numpy soundfile")

SR = 44_100
OUT = pathlib.Path(__file__).resolve().parent.parent / "apps" / "web" / "assets" / "sounds"

# Vorbis quality. 0.4 is transparent for a one-second chime and keeps
# every file comfortably under 15 kB, which matters because they are
# fetched at boot.
QUALITY = 0.4


def _t(dur: float) -> np.ndarray:
    return np.arange(int(SR * dur), dtype=np.float64) / SR


def _env(n: int, attack: float, decay: float, curve: float = 4.0) -> np.ndarray:
    """Percussive envelope: a short raised-cosine attack, then an
    exponential decay. A hard edge on either side is what makes a
    synthesized tone sound like a click rather than a note."""
    a = max(1, int(SR * attack))
    a = min(a, n)
    env = np.empty(n, dtype=np.float64)
    env[:a] = 0.5 - 0.5 * np.cos(np.linspace(0.0, np.pi, a))
    rest = n - a
    if rest > 0:
        env[a:] = np.exp(-curve * np.linspace(0.0, 1.0, rest) * (1.0 / max(1e-6, decay)) * 0.5)
    return env


def tone(freq: float, dur: float, *, partials=((1.0, 1.0),), attack=0.004,
         decay=1.0, curve=4.0, detune=0.0) -> np.ndarray:
    """One struck note built from a fundamental plus partials."""
    t = _t(dur)
    out = np.zeros_like(t)
    for mult, amp in partials:
        f = freq * mult * (1.0 + detune)
        out += amp * np.sin(2.0 * np.pi * f * t)
    out /= max(1e-9, sum(abs(a) for _, a in partials))
    return out * _env(len(t), attack, decay, curve)


def square(freq: float, dur: float, *, attack=0.003, decay=1.0) -> np.ndarray:
    """A softened square: odd harmonics only, rolled off so it reads as
    urgent rather than as a buzzer in a cheap toy."""
    return tone(
        freq, dur,
        partials=((1.0, 1.0), (3.0, 1 / 3), (5.0, 1 / 5), (7.0, 1 / 7), (9.0, 1 / 9)),
        attack=attack, decay=decay, curve=3.0,
    )


def lay(total: float, parts) -> np.ndarray:
    """Place (offset_seconds, samples) onto one buffer."""
    buf = np.zeros(int(SR * total), dtype=np.float64)
    for at, sig in parts:
        i = int(SR * at)
        j = min(len(buf), i + len(sig))
        if j > i:
            buf[i:j] += sig[: j - i]
    return buf


def tail(sig: np.ndarray, amount: float = 0.18, delay: float = 0.055) -> np.ndarray:
    """A couple of cheap echoes. Gives the sound a small room to live in
    so it does not sound like it was pasted straight onto silence."""
    out = sig.copy()
    for k in (1, 2, 3):
        d = int(SR * delay * k)
        if d >= len(out):
            break
        out[d:] += sig[: len(out) - d] * (amount ** k)
    return out


def finish(sig: np.ndarray, peak: float = 0.72) -> np.ndarray:
    """Normalize, then fade the last few milliseconds to zero so the file
    cannot end on a step and click in the browser."""
    m = float(np.max(np.abs(sig))) or 1.0
    sig = sig * (peak / m)
    f = min(len(sig), int(SR * 0.012))
    if f:
        sig[-f:] *= np.linspace(1.0, 0.0, f)
    return np.clip(sig, -1.0, 1.0)


# Bell partials are deliberately inharmonic -- that stretched ratio set is
# most of what separates "bell" from "sine wave".
BELL = ((1.0, 1.0), (2.01, 0.46), (2.98, 0.26), (4.12, 0.14), (5.43, 0.07))
SOFTP = ((1.0, 1.0), (2.0, 0.22), (3.0, 0.06))


def build() -> dict[str, np.ndarray]:
    return {
        # زنگ - two bell strikes a fifth apart, the second ringing on.
        "chime": finish(tail(lay(1.45, [
            (0.00, tone(880, 1.30, partials=BELL, decay=0.75, curve=5.0)),
            (0.10, tone(1320, 1.30, partials=BELL, decay=0.60, curve=4.5) * 0.80),
        ]))),

        # دینگ - one bright strike, short and done.
        "ding": finish(tail(lay(0.80, [
            (0.00, tone(1568, 0.72, partials=BELL, decay=0.42, curve=6.0)),
            (0.00, tone(3136, 0.20, decay=0.25, curve=8.0) * 0.18),
        ]), amount=0.12, delay=0.040)),

        # صعودی - a rising major triad; the top note is held.
        "rise": finish(tail(lay(1.00, [
            (0.00, tone(523.25, 0.34, partials=SOFTP, decay=0.40, curve=5.0)),
            (0.08, tone(659.25, 0.34, partials=SOFTP, decay=0.40, curve=5.0)),
            (0.16, tone(783.99, 0.80, partials=SOFTP, decay=0.60, curve=4.0)),
        ]), amount=0.14)),

        # نزولی - the same shape inverted, landing low.
        "fall": finish(tail(lay(1.10, [
            (0.00, tone(659.25, 0.34, partials=SOFTP, decay=0.40, curve=5.0)),
            (0.10, tone(523.25, 0.34, partials=SOFTP, decay=0.40, curve=5.0)),
            (0.20, tone(392.00, 0.86, partials=SOFTP, decay=0.60, curve=4.0)),
        ]), amount=0.14)),

        # هشدار - two clipped pulses on one pitch. Repetition on a flat
        # pitch is what the ear hears as "something is wrong".
        "alert": finish(lay(0.52, [
            (0.00, square(440, 0.16, decay=0.30)),
            (0.16, square(440, 0.30, decay=0.35)),
        ])),

        # ملایم - one low note that fades in rather than striking, for
        # the ordinary toasts that must not startle anyone.
        "soft": finish(tail(lay(0.95, [
            (0.00, tone(330, 0.85, partials=SOFTP, attack=0.045, decay=0.70, curve=3.2)),
        ]), amount=0.10), peak=0.42),
    }


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    for name, sig in build().items():
        path = OUT / f"{name}.ogg"
        sf.write(path, sig.astype(np.float32), SR, format="OGG", subtype="VORBIS")
        print(f"{path.name:>12}  {path.stat().st_size:>6} bytes  {len(sig) / SR:.2f}s")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
