#!/usr/bin/env bash
#
# Build the AURION Android shell into a signed, installable APK — on the
# phone, in Termux, with no Gradle and no Android Studio.
#
# Gradle is avoided on purpose rather than for novelty. The Android Gradle
# Plugin fetches an aapt2 built for linux-x86_64, which cannot execute on an
# aarch64 phone; working around that is more fragile than driving the five
# tools underneath it directly. Those five are exactly what Android Studio
# runs for you:
#
#     res/      --aapt2 compile-->  res.zip
#     manifest  --aapt2 link----->  base.apk
#     *.java    --javac/ecj------>  *.class
#     *.class   --d8------------->  classes.dex
#     base.apk + classes.dex --pack.py--> aligned --apksigner--> APK
#
# Termux setup, once:
#
#     pkg update
#     pkg install aapt2 d8 ecj apksigner python findutils
#
# Three things that are easy to get wrong, all checked against the package
# tree rather than assumed:
#
#   - There is no openjdk-17 in Termux. The JDK is openjdk-21, and d8 and
#     apksigner already depend on it, so it arrives without being asked for.
#   - There is no zipalign at all; nothing in termux-packages provides it.
#     pack.py does the appending and the aligning in one controlled pass.
#   - android.jar is shipped by the ecj package, at
#     $PREFIX/share/java/android.jar. That is why ecj is installed even when
#     javac is the compiler actually used.

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$HERE/build"
PKG="com.axiasoft.aurion"
MIN_SDK=21
TARGET_SDK=34
KEYSTORE="${AURION_KEYSTORE:-$HERE/debug.keystore}"
KS_PASS="${AURION_KEYSTORE_PASS:-aurionaurion}"
KS_ALIAS="${AURION_KEY_ALIAS:-aurion}"

say()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[!]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[x]\033[0m %s\n' "$*" >&2; exit 1; }

# --- tools ------------------------------------------------------------------

need() {
  command -v "$1" >/dev/null 2>&1 \
    || die "$1 not found. In Termux: pkg install aapt2 d8 ecj apksigner python findutils"
}
need aapt2
need apksigner
need keytool          # from openjdk-21, pulled in by d8 and apksigner

PY_BIN=""
for c in python3 python; do
  if command -v "$c" >/dev/null 2>&1; then PY_BIN="$c"; break; fi
done
[ -n "$PY_BIN" ] || die "python not found. In Termux: pkg install python"
[ -f "$HERE/pack.py" ] || die "pack.py is missing from $HERE"

DEXER=""
if command -v d8 >/dev/null 2>&1; then DEXER=d8
elif command -v dx >/dev/null 2>&1; then DEXER=dx
else die "neither d8 nor dx found. In Termux: pkg install d8"; fi

# javac is preferred, but on some devices Termux's JDK fails to start over a
# libicu mismatch. AURION_JAVAC=ecj forces the other one without editing this
# file; ecj is installed anyway, since it is what ships android.jar.
JAVAC="${AURION_JAVAC:-}"
if [ -n "$JAVAC" ]; then
  command -v "$JAVAC" >/dev/null 2>&1 || die "AURION_JAVAC=$JAVAC is not installed"
elif command -v javac >/dev/null 2>&1; then JAVAC=javac
elif command -v ecj >/dev/null 2>&1; then JAVAC=ecj
else die "no Java compiler. In Termux: pkg install openjdk-21   (or: pkg install ecj)"; fi

# --- android.jar ------------------------------------------------------------

find_android_jar() {
  local c
  for c in "${ANDROID_JAR:-}" \
           "${PREFIX:-/usr}/share/java/android.jar" \
           "$HOME/android-sdk/android.jar" \
           "$HOME/.android/android.jar" \
           "$HERE/android.jar"; do
    if [ -n "$c" ] && [ -f "$c" ]; then echo "$c"; return 0; fi
  done
  if [ -n "${ANDROID_HOME:-}" ]; then
    c="$(ls "$ANDROID_HOME"/platforms/android-*/android.jar 2>/dev/null | sort -V | tail -1 || true)"
    if [ -n "$c" ]; then echo "$c"; return 0; fi
  fi
  return 1
}

ANDROID_JAR_PATH="$(find_android_jar || true)"
[ -n "$ANDROID_JAR_PATH" ] || die "android.jar not found.

The build needs the platform stub to compile and link against, not a full
SDK. The ecj package ships one:

    pkg install ecj

which puts it at \$PREFIX/share/java/android.jar. If you would rather use a
different API level, point the script at it:

    export ANDROID_JAR=/path/to/android.jar"

# --- build ------------------------------------------------------------------

say "cleaning"
rm -rf "$OUT"
mkdir -p "$OUT/classes"

say "compiling resources (aapt2)"
aapt2 compile --dir "$HERE/res" -o "$OUT/res.zip"

say "linking resources (aapt2)"
# Android 11+ wants resources.arsc stored, not deflated. Newer aapt2 does
# that by default; older ones need telling. Ask, and fall back if the flag
# is not understood rather than failing the whole build over it.
link_args=(
  -o "$OUT/base.apk"
  -I "$ANDROID_JAR_PATH"
  --manifest "$HERE/AndroidManifest.xml"
  --min-sdk-version "$MIN_SDK"
  --target-sdk-version "$TARGET_SDK"
  "$OUT/res.zip"
)
if ! aapt2 link -0 arsc "${link_args[@]}" 2>"$OUT/link.err"; then
  warn "aapt2 rejected -0 arsc; retrying without it"
  aapt2 link "${link_args[@]}" || { cat "$OUT/link.err" >&2; die "aapt2 link failed"; }
fi

say "compiling java ($JAVAC)"
mapfile -t SOURCES < <(find "$HERE/java" -name '*.java')
[ "${#SOURCES[@]}" -gt 0 ] || die "no java sources under $HERE/java"
if [ "$JAVAC" = "javac" ]; then
  javac --release 8 -nowarn -classpath "$ANDROID_JAR_PATH" \
        -d "$OUT/classes" "${SOURCES[@]}" \
    || die "javac failed. If it could not start at all, retry with:
       AURION_JAVAC=ecj $0"
else
  # Termux's ecj wrapper can hide newer framework symbols unless the stub is
  # handed over as the bootclasspath explicitly.
  ecj -source 8 -target 8 -nowarn -bootclasspath "$ANDROID_JAR_PATH" \
      -d "$OUT/classes" "${SOURCES[@]}"
fi

say "dexing ($DEXER)"
if [ "$DEXER" = "d8" ]; then
  mapfile -t CLASSES < <(find "$OUT/classes" -name '*.class')
  # --lib matters: without it d8 cannot see the framework and silently emits
  # a dex that can crash on launch.
  d8 --lib "$ANDROID_JAR_PATH" --min-api "$MIN_SDK" \
     --output "$OUT" "${CLASSES[@]}"
else
  dx --dex --output="$OUT/classes.dex" "$OUT/classes"
fi
[ -f "$OUT/classes.dex" ] || die "no classes.dex produced"

say "packaging and aligning"
# Termux has no zipalign, and `zip -u` would wreck the alignment aapt2 set
# up anyway. pack.py appends classes.dex and lays the whole archive out on
# 4-byte boundaries in one pass, then verifies its own output.
"$PY_BIN" "$HERE/pack.py" "$OUT/base.apk" "$OUT/classes.dex" "$OUT/aligned.apk"

if [ ! -f "$KEYSTORE" ]; then
  say "creating a signing key at $KEYSTORE"
  warn "this is a throwaway debug key. Keep it: Android will refuse to
       update an installed app signed with a different one."
  keytool -genkeypair -v -keystore "$KEYSTORE" -alias "$KS_ALIAS" \
          -keyalg RSA -keysize 2048 -validity 10000 \
          -storepass "$KS_PASS" -keypass "$KS_PASS" \
          -dname "CN=AURION, O=AxiaSoft, C=DE" >/dev/null
fi

say "signing"
APK="$OUT/AURION.apk"
apksigner sign --ks "$KEYSTORE" --ks-pass "pass:$KS_PASS" \
          --key-pass "pass:$KS_PASS" --ks-key-alias "$KS_ALIAS" \
          --out "$APK" "$OUT/aligned.apk"

say "verifying"
apksigner verify --print-certs "$APK" | head -4
aapt2 dump badging "$APK" | head -3

# Hand it to the file manager so it can actually be tapped.
for d in "$HOME/storage/downloads" "/sdcard/Download"; do
  if [ -d "$d" ]; then cp "$APK" "$d/AURION.apk" && say "copied to $d/AURION.apk"; break; fi
done

echo
say "done: $APK"
echo "    package $PKG, minSdk $MIN_SDK, targetSdk $TARGET_SDK"
echo "    install by opening it in a file manager (allow unknown sources once)."
