#!/usr/bin/env bash
# Run Spark's UI in native Linux Electron with its backend in Wine.
# Experimental. Needs a Linux Electron matching the app's Electron version.
#   SPARK_ELECTRON   path to the Linux electron binary
#   SPARK_USER_DATA  Electron user data directory (default: tmp/native-userdata)
set -euo pipefail
root=${SPARK_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}
app=${SPARK_APP:-$root/app}
electron=${SPARK_ELECTRON:-$root/runtime/electron/electron}
user_data=${SPARK_USER_DATA:-$root/tmp/native-userdata}
mkdir -p "$user_data" "$root/tmp"
export SPARK_ROOT=$root SPARK_APP=$app
exec "$electron" --no-sandbox "--user-data-dir=$user_data" \
  -r "$root/native/shim.js" "$app/resources/app.asar" "$@"
