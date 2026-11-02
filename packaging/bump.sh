#!/usr/bin/env bash
# Point the PKGBUILD at a Spark release and pin its installer checksum.
#
# Usage: packaging/bump.sh VERSION [INSTALLER [PKGREL]]
#
# Without INSTALLER the installer is downloaded from Readdle. PKGREL defaults to 1.
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
pkgbuild=$root/packaging/PKGBUILD

version=${1:?usage: bump.sh VERSION [INSTALLER [PKGREL]]}
installer=${2:-}
pkgrel=${3:-1}

[[ $version =~ ^[0-9]+(\.[0-9]+){3}$ ]] || { echo "error: unexpected version: $version" >&2; exit 2; }
[[ $pkgrel =~ ^[0-9]+$ ]] || { echo "error: unexpected pkgrel: $pkgrel" >&2; exit 2; }

if [ -z "$installer" ]; then
  installer=$(mktemp)
  trap 'rm -f "$installer"' EXIT
  curl -fL --retry 3 -o "$installer" "https://downloads.sparkmailapp.com/Spark3/win/dist/$version/Spark.exe"
fi
[ "$(head -c 2 "$installer")" = MZ ] || { echo "error: $installer is not a Windows executable." >&2; exit 1; }

sum=$(sha256sum "$installer" | cut -d' ' -f1)
sed -i -E \
  -e "s/^pkgver=.*/pkgver=$version/" \
  -e "s/^pkgrel=.*/pkgrel=$pkgrel/" \
  -e "s/^(sha256sums=\('[^']*' ')[0-9a-f]{64}('\))\$/\1$sum\2/" \
  "$pkgbuild"

grep -q "^pkgver=$version\$" "$pkgbuild" && grep -q "^pkgrel=$pkgrel\$" "$pkgbuild" &&
  grep -q "'$sum')\$" "$pkgbuild" || { echo 'error: PKGBUILD was not updated as expected.' >&2; exit 1; }
echo "PKGBUILD now packages Spark $version-$pkgrel (installer sha256 $sum)"
