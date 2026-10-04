#!/usr/bin/env bash
#
# Build the AURION installer from a phone.
#
#   curl -sSL https://raw.githubusercontent.com/AxiaSoft/AURION/arena/01a0ea7f-aurion/installer/tools/build-msi-termux.sh -o build.sh
#   bash build.sh
#
# Run it in Termux. It sets up what it needs, builds, and leaves the .msi in
# your Downloads folder.
#
# WHY IT IS NOT JUST "dotnet build"
#
# .NET needs glibc and Android uses bionic, so the SDK cannot run in Termux
# itself. The script installs a real Ubuntu inside Termux with proot-distro
# and does the work in there - that is the whole trick, and it is why the
# first run downloads several gigabytes.
#
# The MSI itself is produced on Linux. A Windows desktop app can be compiled
# anywhere as long as the targeting packs are allowed to come from NuGet
# (EnableWindowsTargeting), and WiX 5 is a .NET tool rather than a Windows
# one, so the whole chain is cross-platform. The output is a normal win-x64
# installer; nothing about it is different from one built on Windows.

set -euo pipefail

BRANCH="${AURION_BRANCH:-arena/01a0ea7f-aurion}"
REPO="${AURION_REPO:-https://github.com/AxiaSoft/AURION.git}"
VERSION="${AURION_VERSION:-1.0.0}"
DISTRO="ubuntu"

say()  { printf '\n\033[36m==\033[0m %s\n' "$*"; }
note() { printf '   %s\n' "$*"; }
die()  { printf '\n\033[31m!!\033[0m %s\n\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# Phase 1 - in Termux: get a glibc userland, then hand over to phase 2.
# ---------------------------------------------------------------------------
if [ -d /data/data/com.termux ] && [ ! -f /etc/os-release ]; then
    say "Termux detected"

    case "$(uname -m)" in
        aarch64|arm64) note "architecture $(uname -m) - supported" ;;
        *) die "This needs an arm64 phone. Yours reports $(uname -m), and .NET has no build for it." ;;
    esac

    # Storage permission, before anything else. Without it the build works
    # and the installer lands somewhere inside proot's filesystem that no
    # file manager can see - which looks exactly like a build that failed.
    if [ ! -d /sdcard ] || [ ! -w /sdcard ]; then
        say "Asking for storage access"
        note "Android will show a permission dialog - tap Allow."
        termux-setup-storage || true
        sleep 3
        [ -d /sdcard ] || die "Storage is still not reachable. Grant Termux the Files permission in Android settings and run this again."
    fi

    # Termux's df is toybox, which has no -m. -Pk is POSIX and understood
    # everywhere; the arithmetic is done here instead.
    free_kb=$(df -Pk "$HOME" 2>/dev/null | awk 'NR==2 {print $4}' || true)
    if [ -n "${free_kb:-}" ] && [ "$free_kb" -gt 0 ] 2>/dev/null; then
        free_mb=$((free_kb / 1024))
        note "free space: ${free_mb} MB"
        if [ "$free_mb" -lt 7000 ]; then
            die "About 7 GB of free space is needed; there is ${free_mb} MB."
        fi
    else
        note "free space: could not be measured - carrying on"
    fi

    say "Installing proot-distro and Ubuntu (first run only)"
    pkg update -y >/dev/null
    pkg install -y proot-distro >/dev/null

    # Three attempts have now been made to ask proot-distro whether Ubuntu
    # is installed - parsing its table, then trying a login - and both
    # depend on behaviour that differs between its versions. So stop asking.
    # Run the install, and read the one thing that is stable about it: it
    # says "already exists" when there is nothing to do. Any other failure
    # is a real one and is printed in full.
    note "this takes a few minutes the first time, and nothing after that"
    if install_log=$(proot-distro install "$DISTRO" 2>&1); then
        note "Ubuntu installed"
    else
        case "$install_log" in
            *"already exists"*) note "Ubuntu is already installed" ;;
            *)
                printf '%s\n' "$install_log"
                die "Could not install Ubuntu - the output above is proot-distro's."
                ;;
        esac
    fi

    say "Handing over to Ubuntu"
    # Fed in through stdin rather than copied into the container. The path of
    # a proot rootfs is an implementation detail that has moved between
    # proot-distro versions; this needs to know nothing about it.
    self="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
    if ! proot-distro login "$DISTRO" --bind /sdcard:/sdcard -- bash -s < "$self"; then
        die "Ubuntu is installed but would not run the build. Try: proot-distro reset $DISTRO"
    fi
    exit 0
fi

# ---------------------------------------------------------------------------
# Phase 2 - inside Ubuntu, where glibc lives.
# ---------------------------------------------------------------------------
say "Preparing the toolchain"
note "several hundred MB of packages - the output below is apt, not a hang"
export DEBIAN_FRONTEND=noninteractive

# Nothing here is quietened. On a phone these steps take tens of minutes,
# and a silent command that long is indistinguishable from a frozen one -
# which is how a half-finished container gets killed and started again.
# A timeout, too: without one a mirror that will not answer waits forever.
APT_OPTS="-o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 -o Acquire::Retries=2"
# shellcheck disable=SC2086
apt-get $APT_OPTS update || die "apt could not reach its mirrors. Check the phone's connection."
# Deliberately NOT the distro's nodejs/npm. Ubuntu's npm package is broken
# on this image - `npm` dies with "Cannot find module .../glob/dist/cjs" -
# and arguing with a distro's packaging from inside a build script is a
# losing game. The official tarball is one file, is the same Node the
# Windows prerequisite installs, and cannot be broken by the container.
# shellcheck disable=SC2086
apt-get $APT_OPTS install -y curl git ca-certificates libicu-dev xz-utils \
    || die "apt could not install the toolchain - its output is above."

NODE_VERSION="v20.17.0"
NODE_DIR="$HOME/node-$NODE_VERSION-linux-arm64"
if [ ! -x "$NODE_DIR/bin/npm" ]; then
    say "Installing Node $NODE_VERSION"
    curl -fL "https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-linux-arm64.tar.xz" \
        -o /tmp/node.tar.xz || die "Could not download Node from nodejs.org."
    tar -xJf /tmp/node.tar.xz -C "$HOME"
    rm -f /tmp/node.tar.xz
fi
export PATH="$NODE_DIR/bin:$PATH"
note "node $(node --version), npm $(npm --version)"

export DOTNET_ROOT="$HOME/.dotnet"
export PATH="$DOTNET_ROOT:$DOTNET_ROOT/tools:$PATH"
export DOTNET_CLI_TELEMETRY_OPTOUT=1
export DOTNET_NOLOGO=1

if ! command -v dotnet >/dev/null 2>&1; then
    # Ubuntu ships the SDK itself now, and apt is already working. That is
    # preferable to dotnet-install.sh, which fails on this image with
    #     line 1386: link_types[$link_index]: unbound variable
    # - a bug in its own array handling under set -u. The script is kept as
    # a fallback for distributions that do not package .NET.
    say "Installing the .NET 8 SDK (about 200 MB, once)"
    # shellcheck disable=SC2086
    if apt-get $APT_OPTS install -y dotnet-sdk-8.0; then
        export DOTNET_ROOT=/usr/lib/dotnet
        note "installed from Ubuntu's own packages"
    else
        note "not packaged here - falling back to Microsoft's installer"
        curl -fsSL https://dot.net/v1/dotnet-install.sh -o /tmp/dotnet-install.sh \
            || die "Could not reach Microsoft's download host."
        # --version instead of --channel: the channel path is what trips the
        # unbound-variable bug above.
        bash /tmp/dotnet-install.sh --version 8.0.404 --install-dir "$DOTNET_ROOT" --no-path \
            || die "The .NET installer failed - its output is above."
        export PATH="$DOTNET_ROOT:$PATH"
    fi
fi
command -v dotnet >/dev/null 2>&1 || die "dotnet is still not on PATH after installing it."
note "dotnet $(dotnet --version)"

say "Fetching the source"
note "this part is quick"
if [ -d "$HOME/AURION/.git" ]; then
    git -C "$HOME/AURION" fetch --quiet origin "$BRANCH"
    git -C "$HOME/AURION" checkout --quiet -B "$BRANCH" "origin/$BRANCH"
else
    git clone --quiet --branch "$BRANCH" --depth 1 "$REPO" "$HOME/AURION"
fi
cd "$HOME/AURION"
note "at $(git log --oneline -1)"

say "Building the desk window  (win-x64, self-contained)"
# EnableWindowsTargeting is what lets a net8.0-windows WinForms project
# compile on Linux; the targeting packs come from NuGet.
dotnet publish installer/window/AurionWindow.csproj \
    -c Release -r win-x64 --self-contained true \
    -p:AurionVersion="$VERSION" \
    -p:EnableWindowsTargeting=true \
    --nologo -v minimal

say "Installing the desk API's packages"
( cd backend && npm ci --omit=dev --no-audit --no-fund )

say "Building the MSI"
dotnet build installer/AURION.wixproj \
    -c Release \
    -p:AurionVersion="$VERSION" \
    -p:EnableWindowsTargeting=true \
    --nologo -v minimal

msi="$(find installer -name '*.msi' -newermt '-1 hour' | head -1)"
[ -n "$msi" ] || die "The build finished but produced no .msi - look above for the failing task."

say "Done"
note "built: $msi  ($(du -h "$msi" | cut -f1))"

copied=""
for out in /sdcard/Download /sdcard/Downloads /storage/emulated/0/Download; do
    if [ -d "$out" ] && cp "$msi" "$out/" 2>/dev/null; then
        copied="$out/$(basename "$msi")"
        note "copied to $copied"
        break
    fi
done

if [ -z "$copied" ]; then
    # Say exactly how to get it out rather than leaving it buried.
    printf '\n\033[33m!!\033[0m Could not reach your Downloads folder.\n'
    note "The installer is at:  $HOME/AURION/$msi"
    note "From a Termux shell (not this one), copy it out with:"
    note "  cp \$PREFIX/var/lib/proot-distro/installed-rootfs/ubuntu/root/AURION/$msi /sdcard/Download/"
fi

printf '\n\033[32m==\033[0m The installer is ready. Move it to a Windows machine to run it.\n\n'
