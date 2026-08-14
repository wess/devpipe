#!/usr/bin/env bash
# Build, sign and install the client on a real iPad.
#
# The simulator sibling of this is `build.sh`, and the split is deliberate:
# the two differ in SDK, triple, Rust target and — the whole reason this file
# exists — signing, which the simulator does not do at all. Folding both into
# one script means every line reading `if device`.
#
# Still no .xcodeproj. Everything Xcode would do for you is here in the open:
# find the profile, derive entitlements from it, codesign, install. That is
# perhaps thirty lines, and unlike a pbxproj you can read them in a diff.
#
# Usage: ios/device.sh [--launch]
#   DEVICE_UDID  a specific iPad, when more than one is plugged in
#   PROFILE      a specific .mobileprovision
#   IDENTITY     a specific signing identity
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IOS="$ROOT/ios"
BUILD="$ROOT/build"
APP="$BUILD/Devpipe.app"
BUNDLE_ID="io.wess.devpipe"
TARGET_TRIPLE="arm64-apple-ios17.0"
RUST_TARGET="aarch64-apple-ios"
CONFIG="${CONFIG:-release}"
PROFILES="$HOME/Library/Developer/Xcode/UserData/Provisioning Profiles"

say() { printf '==> %s\n' "$*"; }
die() { printf 'device.sh: %s\n' "$*" >&2; exit 1; }

# ---- the device -------------------------------------------------------------

say "device"
xcrun devicectl list devices --json-output "$BUILD/devices.json" >/dev/null 2>&1 ||
  die "devicectl could not list devices. Is Xcode installed?"
mkdir -p "$BUILD"

read -r UDID DEVNAME <<<"$(python3 - "$BUILD/devices.json" "${DEVICE_UDID:-}" <<'PY'
import json, sys
want = sys.argv[2]
devices = json.load(open(sys.argv[1]))["result"]["devices"]
for d in devices:
    hw, props = d.get("hardwareProperties", {}), d.get("deviceProperties", {})
    udid = hw.get("udid", "")
    if want and udid != want:
        continue
    # Developer Mode is the thing that is off by default and gives the least
    # helpful error later: "the operation failed" with no mention of a toggle.
    if props.get("developerModeStatus") != "enabled":
        print(f"!{udid} {props.get('name','?')}")
        break
    print(udid, props.get("name", "iPad"))
    break
else:
    print("", "")
PY
)"

[ -n "$UDID" ] || die "No device connected. Plug the iPad in and trust this Mac."
case "$UDID" in
  '!'*) die "Developer Mode is off on ${DEVNAME}. Settings → Privacy & Security → Developer Mode, then restart." ;;
esac
say "  $DEVNAME ($UDID)"

# ---- the profile ------------------------------------------------------------
#
# Chosen by what it actually covers rather than by name: a profile is only
# usable here if this device is in it and its app id matches this bundle, and
# discovering that after a failed install costs a full build.

say "provisioning profile"
PROFILE="${PROFILE:-$(python3 - "$PROFILES" "$UDID" "$BUNDLE_ID" <<'PY'
import glob, os, plistlib, subprocess, sys
folder, udid, bundle = sys.argv[1], sys.argv[2], sys.argv[3]
best = None
for path in glob.glob(os.path.join(folder, "*.mobileprovision")):
    raw = subprocess.run(["security", "cms", "-D", "-i", path],
                         capture_output=True).stdout
    try:
        p = plistlib.loads(raw)
    except Exception:
        continue
    if udid not in (p.get("ProvisionedDevices") or []):
        continue
    appid = p.get("Entitlements", {}).get("application-identifier", "")
    team, _, pattern = appid.partition(".")
    if pattern != "*" and pattern != bundle:
        continue
    # The one that expires last, so a stale duplicate does not win.
    when = p.get("ExpirationDate")
    if best is None or when > best[0]:
        best = (when, path)
print(best[1] if best else "")
PY
)}"
[ -n "$PROFILE" ] || die "No profile covers $BUNDLE_ID on this device. See docs/ios-device.md."

TEAM="$(security cms -D -i "$PROFILE" | plutil -extract Entitlements.com\\.apple\\.developer\\.team-identifier raw -o - -)"
say "  $(basename "$PROFILE") · team $TEAM"

# ---- the identity -----------------------------------------------------------

IDENTITY="${IDENTITY:-$(security find-identity -v -p codesigning |
  grep 'Apple Development' | head -1 | sed 's/.*"\(.*\)"/\1/')}"
[ -n "$IDENTITY" ] || die "No 'Apple Development' identity in the keychain."
say "signing as $IDENTITY"

# ---- build ------------------------------------------------------------------

say "rust core ($RUST_TARGET, $CONFIG)"
cd "$ROOT/core"
if [ "$CONFIG" = "release" ]; then
  cargo build --release --target "$RUST_TARGET"
else
  cargo build --target "$RUST_TARGET"
fi
LIBDIR="$ROOT/core/target/$RUST_TARGET/$CONFIG"
# The archive by path, never `-L … -ldevpipecore`.
#
# `core` is built as staticlib *and* cdylib, so that directory holds both a
# `.a` and a `.dylib`, and ld prefers the dylib — which bakes this machine's
# absolute path into the binary as a load command. On the simulator that path
# resolves, because the simulator shares the host filesystem, so the mistake is
# invisible there. On a device it is an immediate crash before `main`:
#   dyld: Library not loaded: /Users/…/libdevpipecore.dylib
[ -f "$LIBDIR/libdevpipecore.a" ] || die "no static core at $LIBDIR/libdevpipecore.a"

say "app bundle"
rm -rf "$APP"
mkdir -p "$APP"
cp "$IOS/Info.plist" "$APP/Info.plist"
# The simulator build leaves this alone because its plist is never checked.
# On a device an install is rejected outright without it, and the message does
# not say which key is missing.
plutil -replace CFBundleSupportedPlatforms -json '["iPhoneOS"]' "$APP/Info.plist"
plutil -replace MinimumOSVersion -string "17.0" "$APP/Info.plist"
cp "$IOS"/Resources/*.raw "$APP/" 2>/dev/null || true

SDK="$(xcrun --sdk iphoneos --show-sdk-path)"
xcrun -sdk iphoneos swiftc \
  -target "$TARGET_TRIPLE" \
  -sdk "$SDK" \
  -parse-as-library \
  -swift-version 5 \
  $([ "$CONFIG" = "release" ] && echo "-O" || echo "-Onone -g") \
  -import-objc-header "$IOS/include/bridge.h" \
  -I "$IOS/include" \
  "$LIBDIR/libdevpipecore.a" \
  -o "$APP/Devpipe" \
  "$IOS"/Sources/*.swift

# ---- sign -------------------------------------------------------------------
#
# Entitlements are derived from the profile rather than written by hand, with
# only the wildcard resolved. Hand-written entitlements that ask for more than
# the profile grants are rejected at install time with a message that names
# neither the entitlement nor the profile.

say "signing"
cp "$PROFILE" "$APP/embedded.mobileprovision"
security cms -D -i "$PROFILE" > "$BUILD/profile.plist"
python3 - "$BUILD/profile.plist" "$BUILD/entitlements.plist" "$TEAM" "$BUNDLE_ID" <<'PY'
import plistlib, sys
src, dest, team, bundle = sys.argv[1:5]
ents = plistlib.load(open(src, "rb"))["Entitlements"]
ents["application-identifier"] = f"{team}.{bundle}"
ents["keychain-access-groups"] = [f"{team}.{bundle}"]
plistlib.dump(ents, open(dest, "wb"))
PY

codesign --force --sign "$IDENTITY" \
  --entitlements "$BUILD/entitlements.plist" \
  --timestamp=none \
  "$APP"
codesign --verify --verbose=2 "$APP" 2>&1 | sed 's/^/    /'

# ---- install ----------------------------------------------------------------

say "installing on $DEVNAME"
xcrun devicectl device install app --device "$UDID" "$APP" 2>&1 | tail -3

if [ "${1:-}" = "--launch" ]; then
  say "launching"
  xcrun devicectl device process launch --device "$UDID" "$BUNDLE_ID" 2>&1 | tail -2
fi

say "done"
