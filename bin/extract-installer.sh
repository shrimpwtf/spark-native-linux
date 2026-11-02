#!/usr/bin/env bash
# Extract Spark's NSIS installer into an app directory and verify the result.
#
# Usage: extract-installer.sh /path/to/Spark.exe /path/to/app
#
# libarchive can stop silently partway through an NSIS archive. The failure then
# surfaces later as 'Error loading V8 startup snapshot file' or 'Cannot find
# module @readdle/sparkcore-win'. This script compares the archive manifest with
# the extracted tree and recovers missing entries once with -T. Never patch a
# partially extracted tree.
set -euo pipefail

installer=${1:?usage: extract-installer.sh INSTALLER APP_DIR}
app=${2:?usage: extract-installer.sh INSTALLER APP_DIR}

[ -f "$installer" ] || { echo "error: no such file: $installer" >&2; exit 1; }

# A Windows installer starts with the MZ header. bsdtar rejects anything it
# cannot list, so a bad file fails here and not after a half-empty app directory.
if [ "$(head -c 2 "$installer")" != "MZ" ]; then
  echo "error: $installer is not a Windows executable." >&2
  exit 1
fi
if ! bsdtar -tf "$installer" >/dev/null 2>&1; then
  echo "error: bsdtar cannot read $installer as an NSIS archive." >&2
  exit 1
fi

mkdir -p "$app"
bsdtar -xf "$installer" -C "$app"

manifest=$(mktemp)
missing_list=$(mktemp)
trap 'rm -f "$manifest" "$missing_list"' EXIT

bsdtar -tf "$installer" > "$manifest"

find_missing() {
  : > "$missing_list"
  local entry norm
  while IFS= read -r entry; do
    # Normalize separators and leading ./ so both sides compare equal.
    norm=${entry//\\//}
    norm=${norm#./}
    norm=${norm%/}
    [ -z "$norm" ] && continue
    [ -e "$app/$norm" ] || printf '%s\n' "$entry" >> "$missing_list"
  done < "$manifest"
}

find_missing
if [ -s "$missing_list" ]; then
  count=$(wc -l < "$missing_list")
  echo "warning: extraction missed $count entries. Recovering them now." >&2
  bsdtar -xf "$installer" -C "$app" -T "$missing_list"
  find_missing
fi
if [ -s "$missing_list" ]; then
  echo "error: extraction is still incomplete after one recovery pass." >&2
  echo "The first missing entries:" >&2
  head -5 "$missing_list" >&2
  exit 1
fi

for required in \
  "Spark Desktop.exe" \
  "resources.pak" \
  "snapshot_blob.bin" \
  "v8_context_snapshot.bin" \
  "resources/app.asar.unpacked/node_modules/@readdle/sparkcore-win/package.json"
do
  [ -e "$app/$required" ] || { echo "error: missing required file: $app/$required" >&2; exit 1; }
done
