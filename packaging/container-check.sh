#!/usr/bin/env bash
# Runs inside a clean Arch container: build the package as a normal user,
# install it, and check the result. The build directory is mounted at /build.
set -euo pipefail

pacman -Syu --noconfirm --needed base-devel wine clang binutils libarchive icoutils \
  imagemagick bubblewrap python python-gobject libnotify desktop-file-utils xdg-utils \
  xorg-xprop xdg-desktop-portal hicolor-icon-theme xorg-server-xvfb namcap git

useradd -m builder
chown -R builder /build
su builder -c 'cd /build && makepkg -f --noconfirm'
pacman -U --noconfirm /build/*.pkg.tar.zst

fail=0
check() {
  local description=$1
  shift
  if "$@" >/dev/null 2>&1; then
    echo "PASS $description"
  else
    echo "FAIL $description"
    fail=1
  fi
}

root=/usr/share/spark-native-linux
foundation=$root/app/resources/app.asar.unpacked/node_modules/@readdle/sparkcore-win/bin/Release/SparkCore.bundle/Foundation.dll

check 'launcher wrapper installed' test -x /usr/bin/spark-native-linux
check 'auth wrapper installed' test -x /usr/bin/spark-native-linux-auth
check 'cli wrapper installed' test -x /usr/bin/spark-cli
check 'Spark executable installed' test -f "$root/app/Spark Desktop.exe"
check 'shims installed beside the executable' test -f "$root/app/sprkenv.dll" -a -f "$root/app/sprkiphl.dll"
check 'Foundation imports sprkenv.dll' bash -c "objdump -p '$foundation' | grep -q sprkenv.dll"
check 'Foundation imports sprkiphl.dll' bash -c "objdump -p '$foundation' | grep -q sprkiphl.dll"
check 'Foundation no longer imports USERENV.dll' bash -c "! objdump -p '$foundation' | grep -qi USERENV.dll"
check 'Wine helpers built' test -f "$root/.build/clipboard-image.exe.so" -a -f "$root/.build/window-rescue.exe.so"
check 'icons installed' test -f /usr/share/icons/hicolor/256x256/apps/spark-native-linux.png
check 'desktop entries are valid' desktop-file-validate /usr/share/applications/spark-native-linux.desktop /usr/share/applications/spark-native-linux-auth.desktop
check 'launcher entry runs the wrapper' grep -q '^Exec=/usr/bin/spark-native-linux$' /usr/share/applications/spark-native-linux.desktop
check 'code root is not writable by users' bash -c "! su builder -c 'touch $root/probe'"
check 'no proprietary installer left in the package' bash -c "! pacman -Ql spark-native-linux | grep -q '/Spark-[0-9][^/]*\\.exe\$'"

echo '--- namcap (informational)'
namcap /build/PKGBUILD || true
namcap /build/*.pkg.tar.zst || true

install -d -m 700 -o builder /tmp/runtime-builder

echo '--- CLI smoke test (no bubblewrap inside the container)'
cli_version=$(su builder -c 'XDG_RUNTIME_DIR=/tmp/runtime-builder SPARK_CONTAINER=0 timeout 120 spark-cli --version' 2>/dev/null | tail -1 | tr -d '\r' || true)
if [[ $cli_version =~ ^[0-9]+\.[0-9]+ ]]; then
  echo "PASS CLI reports a version ($cli_version)"
else
  echo 'FAIL CLI reports a version'
  fail=1
fi
check 'state directory created under XDG data' test -d /home/builder/.local/share/spark-native-linux/prefix

echo '--- desktop smoke test under Xvfb (software rendering)'
su builder -c 'cd ~ && XDG_RUNTIME_DIR=/tmp/runtime-builder SPARK_CONTAINER=0 SPARK_NOTIFY=0 SPARK_CLOSE_TRAY=0 SPARK_IMAGE_BRIDGE=0 timeout 180 xvfb-run -a spark-native-linux --disable-gpu > /tmp/desktop.log 2>&1' || true
check 'desktop reaches Application is ready' grep -q 'Application is ready' /tmp/desktop.log
check 'desktop log has no fatal crash' bash -c "! grep -q -E 'FATAL|SIGSEGV|Unhandled exception' /tmp/desktop.log"

exit "$fail"
