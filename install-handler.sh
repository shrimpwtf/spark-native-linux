#!/usr/bin/env bash
# Register Spark's launcher, URL schemes, and mailto handler with the desktop.
#
# Browser sign-in and Spark links use custom schemes. Without this handler the
# callback or deep-link URL has nowhere to go.
set -euo pipefail

root=${SPARK_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}
auth_template=$root/share/spark-mail-linux-auth.desktop.in
launcher_template=$root/share/spark-mail-linux.desktop.in
dest_dir=${XDG_DATA_HOME:-$HOME/.local/share}/applications
auth_dest=$dest_dir/spark-mail-linux-auth.desktop
launcher_dest=$dest_dir/spark-mail-linux.desktop

[ -f "$auth_template" ] || { echo "error: missing $auth_template" >&2; exit 1; }
[ -f "$launcher_template" ] || { echo "error: missing $launcher_template" >&2; exit 1; }

mkdir -p "$dest_dir"
escaped_root=${root//\\/\\\\}
escaped_root=${escaped_root//&/\\&}
escaped_root=${escaped_root//|/\\|}
sed "s|@SPARK_ROOT@|$escaped_root|g" "$auth_template" > "$auth_dest"
sed "s|@SPARK_ROOT@|$escaped_root|g" "$launcher_template" > "$launcher_dest"

# Extract Spark's own icon from the installed exe into the user icon theme.
# Needs icoutils; without it the launcher falls back to a generic mail icon.
exe="$root/app/Spark Desktop.exe"
icon_base=${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor
icon_ok=0
if [ -f "$exe" ] && command -v wrestool >/dev/null && command -v icotool >/dev/null; then
  icon_tmp=$(mktemp -d)
  if wrestool -x --type=14 -o "$icon_tmp" "$exe" 2>/dev/null; then
    ico=$(ls "$icon_tmp"/*.ico 2>/dev/null | head -n1 || true)
    if [ -n "$ico" ]; then
      # Spark's tile fills its canvas. With ImageMagick, shrink it to ~85% with
      # rounder corners so it matches the padding of other desktop icons.
      master=
      if command -v magick >/dev/null \
          && icotool -x -w 256 -o "$icon_tmp/src.png" "$ico" 2>/dev/null \
          && magick -size 218x218 xc:none -fill white -draw 'roundrectangle 0,0 217,217 56,56' "$icon_tmp/mask.png" \
          && magick "$icon_tmp/src.png" -filter Lanczos -resize 218x218 \( "$icon_tmp/mask.png" -alpha extract \) -alpha off \
               -compose CopyOpacity -composite "$icon_tmp/tile.png" 2>/dev/null \
          && magick "$icon_tmp/tile.png" -background none -gravity center -extent 256x256 "$icon_tmp/master.png" 2>/dev/null; then
        master=$icon_tmp/master.png
      fi
      for size in 16 24 32 48 64 96 128 256; do
        mkdir -p "$icon_base/${size}x${size}/apps"
        out=$icon_base/${size}x${size}/apps/spark-mail-linux.png
        if [ -n "$master" ]; then
          magick "$master" -filter Lanczos -resize "${size}x${size}" "$out" 2>/dev/null && icon_ok=1
        else
          icotool -x -w "$size" -o "$out" "$ico" 2>/dev/null && icon_ok=1
        fi
      done
    fi
  fi
  rm -rf "$icon_tmp"
fi
if [ "$icon_ok" = 1 ]; then
  command -v gtk-update-icon-cache >/dev/null && gtk-update-icon-cache -q -t "$icon_base" 2>/dev/null || true
else
  sed -i 's|^Icon=.*|Icon=mail-unread|' "$launcher_dest"
  echo "warning: could not extract Spark icon (needs icoutils); using generic icon" >&2
fi
command -v update-desktop-database >/dev/null && update-desktop-database "$dest_dir" || true

echo "Installed $launcher_dest"
echo "Installed $auth_dest"
echo "Registered schemes:"
while IFS= read -r mime; do
  [ -n "$mime" ] || continue
  xdg-mime default "$(basename "$auth_dest")" "$mime"
  echo "  ${mime#x-scheme-handler/}"
done < <(sed -n 's/^MimeType=//p' "$auth_dest" | tr ';' '\n')
