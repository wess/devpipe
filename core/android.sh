#!/usr/bin/env bash
# Build the terminal core as an Android shared library, one per ABI.
#
# Output lands where Gradle expects it, so an app module only has to point
# `jniLibs.srcDirs` at `core/build/android` and call
# `System.loadLibrary("devpipecore")`.
#
# There is no Android app yet. This exists so the claim that the emulator is
# portable is something the build system checks rather than something a
# document asserts — and so the day somebody starts the Kotlin client, the
# hard part is already done.
#
# Needs:
#   brew install --cask android-ndk
#   rustup target add aarch64-linux-android armv7-linux-androideabi x86_64-linux-android
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$ROOT/build/android"
NDK="${ANDROID_NDK_HOME:-/opt/homebrew/share/android-ndk}"
[ -d "$NDK" ] || { echo "no NDK at $NDK; set ANDROID_NDK_HOME" >&2; exit 1; }

# Rust's target triples and Android's ABI directory names disagree, and the
# mapping is not derivable — jniLibs wants the second name.
cd "$ROOT"

build() {
  local target="$1" abi="$2"
  echo "==> $target -> $abi"
  cargo build --release --target "$target"
  mkdir -p "$OUT/$abi"
  cp "$ROOT/target/$target/release/libdevpipecore.so" "$OUT/$abi/"
}

build aarch64-linux-android arm64-v8a
build armv7-linux-androideabi armeabi-v7a
build x86_64-linux-android x86_64

echo "==> done"
find "$OUT" -name '*.so' -exec ls -la {} \;
