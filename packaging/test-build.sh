#!/usr/bin/env bash
# Build the package in a clean Arch container from the current working tree.
#
# Usage: packaging/test-build.sh [/path/to/Spark.exe]
#
# The release tarball is made from tracked and new files, so uncommitted work is
# tested. A local installer avoids a 200 MB download; makepkg still verifies its
# checksum against the PKGBUILD.
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
engine=$(command -v podman || command -v docker || true)
[ -n "$engine" ] || { echo 'error: podman or docker is required.' >&2; exit 1; }

pkgver=$(sed -n 's/^pkgver=//p' "$root/packaging/PKGBUILD")
pkgrel=$(sed -n 's/^pkgrel=//p' "$root/packaging/PKGBUILD")
name=spark-native-linux-$pkgver-$pkgrel

mkdir -p "$root/archive"
context=$(mktemp -d "$root/archive/pkgtest.XXXXXX")

(cd "$root" && git ls-files -co --exclude-standard -z |
  tar --null -T - --transform "s,^,$name/," -czf "$context/$name.tar.gz")
sum=$(sha256sum "$context/$name.tar.gz" | cut -d' ' -f1)

sed "s/^sha256sums=('SKIP'/sha256sums=('$sum'/" "$root/packaging/PKGBUILD" > "$context/PKGBUILD"
cp "$root/packaging/spark-native-linux.install" "$context/"
[ -z "${1:-}" ] || cp "$1" "$context/Spark-$pkgver.exe"

echo "Build context: $context"
"$engine" run --rm -v "$context:/build:Z" -v "$root/packaging/container-check.sh:/check.sh:ro,Z" \
  docker.io/library/archlinux:latest bash /check.sh
