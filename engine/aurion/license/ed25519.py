"""Pure-Python Ed25519 (RFC 8032) — no third-party dependency.

Used for license-key signatures: the engine ships ONLY the public key, so a
public repository (or a curious customer) can verify keys but can never mint
them. Signing needs the 32-byte private seed, held exclusively by the owner
(keyserver env var / owner CLI).

API:
    publickey(seed32) -> 32 bytes
    sign(seed32, msg) -> 64 bytes
    verify(sig64, msg, pub32) -> bool
"""

from __future__ import annotations

import hashlib

_b = 256
_q = 2**255 - 19
_l = 2**252 + 27742317777372353535851937790883648493


def _H(m: bytes) -> bytes:
    return hashlib.sha512(m).digest()


def _inv(x: int) -> int:
    return pow(x, _q - 2, _q)


_d = (-121665 * _inv(121666)) % _q
_I = pow(2, (_q - 1) // 4, _q)


def _xrecover(y: int) -> int:
    xx = (y * y - 1) * _inv(_d * y * y + 1) % _q
    x = pow(xx, (_q + 3) // 8, _q)
    if (x * x - xx) % _q != 0:
        x = (x * _I) % _q
    if x % 2 != 0:
        x = _q - x
    return x


_By = (4 * _inv(5)) % _q
_Bx = _xrecover(_By)
_B = (_Bx, _By)


def _edwards(P: tuple[int, int], Q: tuple[int, int]) -> tuple[int, int]:
    (x1, y1) = P
    (x2, y2) = Q
    t = (_d * x1 * x2 * y1 * y2) % _q
    x3 = (x1 * y2 + x2 * y1) * _inv(1 + t) % _q
    y3 = (y1 * y2 + x1 * x2) * _inv(1 - t) % _q
    return (x3, y3)


def _scalarmult(P: tuple[int, int], e: int) -> tuple[int, int]:
    if e == 0:
        return (0, 1)
    Q = _scalarmult(P, e >> 1)
    Q = _edwards(Q, Q)
    if e & 1:
        Q = _edwards(Q, P)
    return Q


def _encodeint(y: int) -> bytes:
    return int(y).to_bytes(32, "little")


def _encodepoint(P: tuple[int, int]) -> bytes:
    (x, y) = P
    out = bytearray(_encodeint(y))
    out[31] |= (x & 1) << 7
    return bytes(out)


def _decodeint(s: bytes) -> int:
    return int.from_bytes(s, "little")


def _bit(h: bytes, i: int) -> int:
    return (h[i // 8] >> (i % 8)) & 1


def _prune(h: bytes) -> int:
    a = 2 ** (_b - 2)
    for i in range(3, _b - 2):
        a += 2**i * _bit(h, i)
    return a


def _isoncurve(P: tuple[int, int]) -> bool:
    (x, y) = P
    return (-x * x + y * y - 1 - _d * x * x * y * y) % _q == 0


def _decodepoint(s: bytes) -> tuple[int, int]:
    if len(s) != 32:
        raise ValueError("point must be 32 bytes")
    y = _decodeint(s) & ((1 << 255) - 1)
    x = _xrecover(y)
    if (x & 1) != (s[31] >> 7):
        x = _q - x
    if not _isoncurve((x, y)):
        raise ValueError("point is not on the curve")
    return (x, y)


def _Hint(m: bytes) -> int:
    return int.from_bytes(_H(m), "little")


def publickey(seed: bytes) -> bytes:
    if len(seed) != 32:
        raise ValueError("seed must be 32 bytes")
    h = _H(seed)
    a = _prune(h)
    return _encodepoint(_scalarmult(_B, a))


def sign(seed: bytes, msg: bytes) -> bytes:
    if len(seed) != 32:
        raise ValueError("seed must be 32 bytes")
    h = _H(seed)
    a = _prune(h)
    A = _encodepoint(_scalarmult(_B, a))
    r = _Hint(h[32:64] + msg) % _l
    R = _scalarmult(_B, r)
    S = (r + _Hint(_encodepoint(R) + A + msg) * a) % _l
    return _encodepoint(R) + _encodeint(S)


def verify(sig: bytes, msg: bytes, pub: bytes) -> bool:
    try:
        if len(sig) != 64 or len(pub) != 32:
            return False
        R = _decodepoint(sig[:32])
        A = _decodepoint(pub)
        S = _decodeint(sig[32:])
        if S >= _l:
            return False
        h = _Hint(sig[:32] + pub + msg) % _l
        return _scalarmult(_B, S) == _edwards(R, _scalarmult(A, h))
    except (ValueError, IndexError):
        return False


if __name__ == "__main__":  # keygen:  python -m aurion.license.ed25519
    import os as _os

    _seed = _os.urandom(32)
    print("private seed (KEEP SECRET — keyserver .env AURION_KEY_PRIVATE_HEX):", _seed.hex())
    print("public key   (ships in material.py ED25519_PUBLIC_HEX):           ", publickey(_seed).hex())
