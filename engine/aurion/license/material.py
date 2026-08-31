# Axiasoft license material — PUBLIC HALF ONLY.
#
# The engine verifies license keys with this Ed25519 public key. Verification
# is all the client ever needs to do, so this value is SAFE to publish (public
# repo, customer machines) — nobody can mint keys from it.
#
# The matching private seed NEVER ships: it lives only in the keyserver env
# (AURION_KEY_PRIVATE_HEX) and the owner mint CLI (AXIASOFT_KEY_PRIVATE).
# To rotate: generate a fresh pair (python -m aurion.license.ed25519.keygen or
# keyserver `npm run mint -- --keygen`), swap the value below + both private
# copies. Rotation invalidates every previously issued key.
ED25519_PUBLIC_HEX = "c914c8f0b049760bf07fb71e61829dae157c31edeea7182aadacdf1fca75096d"
ISSUER = "Axiasoft"
PRODUCT = "AURION"
