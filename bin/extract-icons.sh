#!/usr/bin/env bash
# Extract Spark's launcher icon from Spark Desktop.exe into an icon theme.
#
# Usage: extract-icons.sh "/path/to/Spark Desktop.exe" /path/to/icons/hicolor [name]
#
# Needs icoutils. With ImageMagick, the icon is shrunk to about 85% with rounder
# corners so it matches the padding of other desktop icons.
# Exits nonzero when no icon was written.
set -euo pipefail

exe=${1:?usage: extract-icons.sh EXE ICON_BASE [NAME]}
icon_base=${2:?usage: extract-icons.sh EXE ICON_BASE [NAME]}
name=${3:-spark-mail-linux}

[ -f "$exe" ] || { echo "error: no such file: $exe" >&2; exit 1; }
for tool in wrestool icotool; do
  command -v "$tool" >/dev/null || { echo "error: $tool is required (icoutils)" >&2; exit 1; }
done

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

wrestool -x --type=14 -o "$work" "$exe" 2>/dev/null || exit 1
ico=$(ls "$work"/*.ico 2>/dev/null | head -n1 || true)
[ -n "$ico" ] || exit 1

master=
if command -v magick >/dev/null \
    && icotool -x -w 256 -o "$work/src.png" "$ico" 2>/dev/null \
    && magick -size 218x218 xc:none -fill white -draw 'roundrectangle 0,0 217,217 56,56' "$work/mask.png" \
    && magick "$work/src.png" -filter Lanczos -resize 218x218 \( "$work/mask.png" -alpha extract \) -alpha off \
         -compose CopyOpacity -composite "$work/tile.png" 2>/dev/null \
    && magick "$work/tile.png" -background none -gravity center -extent 256x256 "$work/master.png" 2>/dev/null; then
  master=$work/master.png
fi

written=0
for size in 16 24 32 48 64 96 128 256; do
  mkdir -p "$icon_base/${size}x${size}/apps"
  out=$icon_base/${size}x${size}/apps/$name.png
  if [ -n "$master" ]; then
    magick "$master" -filter Lanczos -resize "${size}x${size}" "$out" 2>/dev/null && written=1
  else
    icotool -x -w "$size" -o "$out" "$ico" 2>/dev/null && written=1
  fi
done
[ "$written" = 1 ] || exit 1
command -v gtk-update-icon-cache >/dev/null && gtk-update-icon-cache -q -t "$icon_base" 2>/dev/null || true
