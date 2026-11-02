#!/usr/bin/env bash
# Run Spark's UI in native Linux Electron with its backend in Wine.
# Experimental. Run native/setup-electron.sh once to get a matching Electron.
#   SPARK_NATIVE_STATE  this mode's own prefix, home, and data
#                       (default: SPARK_ROOT/native-state)
#   SPARK_ELECTRON      path to the Linux electron binary
#   SPARK_USER_DATA     Electron user data directory
set -euo pipefail
root=${SPARK_ROOT:-$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/.." && pwd)}
app=${SPARK_APP:-$root/app}
state=${SPARK_NATIVE_STATE:-$root/native-state}
electron=${SPARK_ELECTRON:-$root/runtime/electron/electron}
user_data=${SPARK_USER_DATA:-$state/userdata}
if [ ! -x "$electron" ]; then
  echo "error: no Linux Electron at $electron. Run native/setup-electron.sh." >&2
  exit 1
fi
mkdir -p "$user_data" "$state/logs"
# The backend opens the databases of this prefix, so never share the Wine mode's.
export SPARK_ROOT=$root SPARK_APP=$app SPARK_STATE=$state
export SPARK_PREFIX=${SPARK_PREFIX:-$state/prefix}
# Wine replaces these paths with the prefix's own profile once the prefix exists.
# Use that profile here too, so both sides see the same data on every run.
export SPARK_APPDATA=${SPARK_APPDATA:-$SPARK_PREFIX/drive_c/users/$(id -un)/AppData}
export SPARK_NATIVE_LOG_DIR=${SPARK_NATIVE_LOG_DIR:-$state/logs}
export SPARK_STUB_LOG=${SPARK_STUB_LOG:-$state/logs/addon-stub.log}
# onnxruntime.dll only finds its dxcore replacement in the prefix's system directory.
if [ -f "$app/sprkdx.dll" ]; then
  install -D -m 755 "$app/sprkdx.dll" "$SPARK_PREFIX/drive_c/windows/system32/sprkdx.dll"
fi
exec "$electron" "--user-data-dir=$user_data" \
  -r "$root/native/shim.js" "$app/resources/app.asar" "$@"
