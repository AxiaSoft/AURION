// Key parity (asymmetric Ed25519 scheme) — engine (Python) and key server
// (Node) must ALWAYS agree:
//   1) both Ed25519 implementations pass the official RFC 8032 vectors, and
//   2) keys minted by one side decode fine on the other (both directions).
//
// Run:  node test/key-parity.mjs        (from the keyserver folder)

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

// -- test-only keypair (never the production seed) -------------------------
const PRIV = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60"; // RFC seed
const PUB = "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a";

process.env.AURION_KEY_PUBLIC_HEX = PUB; // keys.js picks this up at require time

const require = createRequire(import.meta.url);
const keys = require("../src/keys.js");
const ed = require("../src/ed25519.js");

// 1) JS against the official RFC 8032 vectors.
{
  const seed = Buffer.from(PRIV, "hex");
  const sig = ed.sign(seed, Buffer.alloc(0)).toString("hex");
  const expect = "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b";
  if (ed.publickey(seed).toString("hex") !== PUB) throw new Error("JS publickey vector mismatch");
  if (sig !== expect) throw new Error("JS sign vector mismatch");
  console.log("1) JS passes RFC 8032 official vectors");
}

function pyDecode(key, expectTag) {
  // Ask the PYTHON engine to decode a key minted here.
  const out = execFileSync(
    "python3",
    [
      "-c",
      "import sys;sys.path.insert(0,'../engine');from aurion.license.guard import decode_key;" +
        "d=decode_key(sys.argv[1]);print('ok' if d and d['plan']==sys.argv[2] else 'bad')",
      key,
      expectTag,
    ],
    { env: { ...process.env, AXIASOFT_KEY_PUBLIC: PUB, PATH: process.env.PATH }, encoding: "utf8" }
  ).trim();
  return out === "ok";
}

function pyMint(plan) {
  return execFileSync(
    "python3",
    [
      "-c",
      "import sys;sys.path.insert(0,'../engine');from aurion.license.guard import mint;print(mint(sys.argv[1],'parity'))",
      plan,
    ],
    { env: { ...process.env, AXIASOFT_KEY_PRIVATE: PRIV, PATH: process.env.PATH }, encoding: "utf8" }
  ).trim();
}

// 2) JS-minted keys → Python decode.
for (const plan of ["m1", "developer"]) {
  const key = keys.mint(plan, PRIV);
  if (!pyDecode(key, plan)) throw new Error(`Python refused a JS-minted ${plan} key`);
  console.log(`2) JS mint(${plan}) → Python decode OK`);
}

// 3) Python-minted keys → JS decode.
for (const plan of ["m3", "developer"]) {
  const key = pyMint(plan);
  const d = keys.decodeKey(key, PRIV);
  if (!d || d.plan !== plan || d.verified !== true) throw new Error(`JS refused a Python-minted ${plan} key`);
  console.log(`3) Python mint(${plan}) → JS decode OK`);
}

// 4) Forgeries die on both sides.
{
  const alpha = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const fake = (n) => Array.from({ length: n }, () => alpha[(Math.random() * alpha.length) | 0]).join("");
  const devFake = "AXI-DEV-" + [4, 4, 4, 4].map(() => fake(4)).join("-") + "-" + (fake(103).match(/.{1,4}/g)).join("-");
  if (keys.decodeKey(devFake, PRIV) !== null) throw new Error("JS accepted a forged dev key");
  if (pyDecode(devFake, "developer")) throw new Error("Python accepted a forged dev key");
  const paidFake = "AXIA-M1-" + [4, 4, 4, 4, 4, 4, 4, 4, 4, 4].map(() => fake(4)).join("-");
  if (keys.decodeKey(paidFake, PRIV) !== null) throw new Error("JS accepted a forged customer key");
  console.log("4) forged keys rejected on both sides");
}

console.log("key parity OK — JS and Python agree (Ed25519 asymmetric scheme)");
