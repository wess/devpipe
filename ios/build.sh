#!/usr/bin/env bash
# Build and run the client on a booted simulator, without an .xcodeproj.
#
# swiftc against the simulator SDK plus a hand-assembled bundle is enough to
# run a SwiftUI app, and it keeps the whole build reviewable as a script
# instead of a pbxproj nobody can diff.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IOS="$ROOT/ios"
BUILD="$ROOT/build"
APP="$BUILD/Devpipe.app"
BUNDLE_ID="io.wess.devpipe"

DEVICE="${DEVICE:-iPad Pro 11-inch (M4)}"
TARGET_TRIPLE="arm64-apple-ios17.0-simulator"
RUST_TARGET="aarch64-apple-ios-sim"
CONFIG="${CONFIG:-release}"

echo "==> rust core ($RUST_TARGET, $CONFIG)"
cd "$ROOT/core"
if [ "$CONFIG" = "release" ]; then
  cargo build --release --target "$RUST_TARGET"
else
  cargo build --target "$RUST_TARGET"
fi
LIBDIR="$ROOT/core/target/$RUST_TARGET/$CONFIG"

echo "==> app bundle"
rm -rf "$APP"
mkdir -p "$APP"
cp "$IOS/Info.plist" "$APP/Info.plist"
cp "$IOS"/Resources/*.raw "$APP/" 2>/dev/null || true

SDK="$(xcrun --sdk iphonesimulator --show-sdk-path)"
# -parse-as-library: no main.swift here, the entry point is @main in App.swift.
xcrun -sdk iphonesimulator swiftc \
  -target "$TARGET_TRIPLE" \
  -sdk "$SDK" \
  -parse-as-library \
  -swift-version 5 \
  $([ "$CONFIG" = "release" ] && echo "-O" || echo "-Onone -g") \
  -import-objc-header "$IOS/include/bridge.h" \
  -I "$IOS/include" \
  -L "$LIBDIR" -ldevpipecore \
  -o "$APP/Devpipe" \
  "$IOS"/Sources/*.swift

echo "==> boot $DEVICE"
UDID="$(xcrun simctl list devices available | grep -F "$DEVICE (" | head -1 |
  sed -E 's/.*\(([0-9A-F-]{36})\).*/\1/')"
if [ -z "$UDID" ]; then echo "no simulator named '$DEVICE'"; exit 1; fi
xcrun simctl bootstatus "$UDID" -b >/dev/null 2>&1 || xcrun simctl boot "$UDID" || true

echo "==> install + launch ($UDID)"
xcrun simctl uninstall "$UDID" "$BUNDLE_ID" >/dev/null 2>&1 || true
xcrun simctl install "$UDID" "$APP"
# Args after the bundle id reach the app: --stress, --top, or nothing for vim.
# Deliberately not --console-pty; it attaches and never returns, which makes
# this unusable from a script.
xcrun simctl launch "$UDID" "$BUNDLE_ID" "$@"
echo "$UDID" > "$BUILD/.udid"
