#!/usr/bin/env bash
# Download the Linux Electron that matches the version Spark bundles, verify it
# against the release checksums, and install it under runtime/electron. Then build
# and apply the shim that lets Spark's AI Assistant find the GPU under Wine.
set -euo pipefail
root=$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/.." && pwd)
exe=${SPARK_APP:-$root/app}/Spark\ Desktop.exe
[ -f "$exe" ] || { echo "error: no Spark installation at $exe" >&2; exit 1; }

version=$(grep -aoE -m1 'Electron/[0-9]+\.[0-9]+\.[0-9]+' "$exe" | head -n1 | cut -d/ -f2)
[ -n "$version" ] || { echo 'error: cannot read the bundled Electron version' >&2; exit 1; }

file=electron-v$version-linux-x64.zip
base=https://github.com/electron/electron/releases/download/v$version
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
curl -fL --retry 3 -o "$work/$file" "$base/$file"
curl -fL --retry 3 -o "$work/SHASUMS256.txt" "$base/SHASUMS256.txt"
(cd "$work" && grep -E " \*?$file\$" SHASUMS256.txt | sha256sum -c -)

mkdir "$work/electron"
bsdtar -xf "$work/$file" -C "$work/electron"
mkdir -p "$root/runtime"
rm -rf "$root/runtime/electron"
mv "$work/electron" "$root/runtime/electron"
ELECTRON_RUN_AS_NODE=1 "$root/runtime/electron/electron" "$root/native/check-compat.js" "${SPARK_APP:-$root/app}"
OUT_DIR=${SPARK_APP:-$root/app} "$root/shims/build.sh"
SPARK_ROOT=$root python3 "$root/shims/patch-onnxruntime.py"
