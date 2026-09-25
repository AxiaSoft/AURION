"use strict";
// Pure-JS Ed25519 (RFC 8032) with BigInt — byte-exact port of
// engine/aurion/license/ed25519.py. Verified in test/key-parity.mjs against
// the official RFC test vectors, so Node and Python always agree.
//
// Only THIS server (and the owner CLI) may hold a private seed.

const crypto = require("crypto");

const q = 2n ** 255n - 19n;
const l = 2n ** 252n + 27742317777372353535851937790883648493n;

const H = (m) => crypto.createHash("sha512").update(m).digest();
const mod = (v) => ((v % q) + q) % q;

function modPow(b, e, m) {
  let r = 1n;
  b = ((b % m) + m) % m;
  while (e > 0n) {
    if (e & 1n) r = (r * b) % m;
    b = (b * b) % m;
    e >>= 1n;
  }
  return r;
}

const inv = (x) => modPow(x, q - 2n, q);
const d = mod(-121665n * inv(121666n));
const I = modPow(2n, (q - 1n) / 4n, q);

function xrecover(y) {
  const xx = mod((y * y - 1n) * inv(mod(d * y * y + 1n)));
  let x = modPow(xx, (q + 3n) / 8n, q);
  if (mod(x * x - xx) !== 0n) x = mod(x * I);
  if (x % 2n !== 0n) x = q - x;
  return x;
}

const By = mod(4n * inv(5n));
const Bx = xrecover(By);
const B = [Bx, By];

function edwards(P, Q) {
  const [x1, y1] = P;
  const [x2, y2] = Q;
  const t = mod(d * x1 * x2 * y1 * y2);
  const x3 = mod((x1 * y2 + x2 * y1) * inv(mod(1n + t)));
  const y3 = mod((y1 * y2 + x1 * x2) * inv(mod(1n - t)));
  return [x3, y3];
}

function scalarmult(P, e) {
  if (e === 0n) return [0n, 1n];
  let Q = scalarmult(P, e >> 1n);
  Q = edwards(Q, Q);
  if (e & 1n) Q = edwards(Q, P);
  return Q;
}

function encodeint(y) {
  const out = Buffer.alloc(32);
  let v = BigInt(y);
  for (let i = 0; i < 32; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

function encodepoint(P) {
  const [x, y] = P;
  const out = encodeint(y);
  out[31] |= Number(x & 1n) << 7;
  return out;
}

const decodeint = (s) => {
  let v = 0n;
  for (let i = s.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(s[i]);
  return v;
};

const bitAt = (h, i) => Number((h[i >> 3] >> (i % 8)) & 1);

function prune(h) {
  let a = 2n ** 254n;
  for (let i = 3; i < 254; i++) a += 2n ** BigInt(i) * BigInt(bitAt(h, i));
  return a;
}

function isoncurve(P) {
  const [x, y] = P;
  return mod(-x * x + y * y - 1n - d * x * x * y * y) === 0n;
}

function decodepoint(s) {
  if (s.length !== 32) throw new Error("point must be 32 bytes");
  const y = decodeint(s) & ((1n << 255n) - 1n);
  let x = xrecover(y);
  if ((x & 1n) !== BigInt(s[31] >> 7)) x = q - x;
  if (!isoncurve([x, y])) throw new Error("point is not on the curve");
  return [x, y];
}

const Hint = (m) => decodeint(H(m));

function publickey(seed) {
  if (seed.length !== 32) throw new Error("seed must be 32 bytes");
  const h = H(seed);
  const a = prune(h);
  return encodepoint(scalarmult(B, a));
}

function sign(seed, msg) {
  if (seed.length !== 32) throw new Error("seed must be 32 bytes");
  const h = H(seed);
  const a = prune(h);
  const A = encodepoint(scalarmult(B, a));
  const r = Hint(Buffer.concat([h.subarray(32, 64), msg])) % l;
  const R = scalarmult(B, r);
  const S = (r + Hint(Buffer.concat([encodepoint(R), A, msg])) * a) % l;
  return Buffer.concat([encodepoint(R), encodeint(S)]);
}

function verify(sig, msg, pub) {
  try {
    if (sig.length !== 64 || pub.length !== 32) return false;
    const R = decodepoint(sig.subarray(0, 32));
    const A = decodepoint(pub);
    const S = decodeint(sig.subarray(32));
    if (S >= l) return false;
    const h = Hint(Buffer.concat([sig.subarray(0, 32), pub, msg])) % l;
    const left = scalarmult(B, S);
    const right = edwards(R, scalarmult(A, h));
    return left[0] === right[0] && left[1] === right[1];
  } catch {
    return false;
  }
}

module.exports = { publickey, sign, verify };
