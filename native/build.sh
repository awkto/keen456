#!/usr/bin/env bash
# Build the native Linux AppImage: native/dist/Keen456-x86_64.AppImage
#
#   ./native/build.sh
#
# Stages (all cached under native/vendor/):
#   1. dosbox-x compiled from source in a Debian 12 container (build-dosbox-x.sh)
#   2. Go launcher (static, becomes the AppImage's AppRun)
#   2b. keen456-gui (Fyne settings window, built in a container)
#   3. Keen 4 shareware extracted from games/keen4.jsdos
#   4. AppDir assembly + appimagetool
set -euo pipefail

DOSBOX_X_VERSION="${DOSBOX_X_VERSION:-2026.08.02}"
APPIMAGETOOL_URL="https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-x86_64.AppImage"

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(dirname "$HERE")"
VENDOR="$HERE/vendor"
APPDIR="$VENDOR/AppDir"
DIST="$HERE/dist"

# --- 1. dosbox-x ------------------------------------------------------------
DOSBOX_X_VERSION="$DOSBOX_X_VERSION" "$HERE/build-dosbox-x.sh"
DBX="$VENDOR/dosbox-x-$DOSBOX_X_VERSION"

# --- 2. launcher ------------------------------------------------------------
echo "Building launcher..."
(cd "$HERE/launcher" && CGO_ENABLED=0 go build -trimpath \
  -ldflags="-s -w -X keen456/core.Version=${KEEN456_VERSION:-dev}" \
  -o "$VENDOR/keen456-launcher" .)

# --- 2b. settings UI --------------------------------------------------------
"$HERE/build-gui.sh" "${KEEN456_VERSION:-dev}" ""

# --- 3. game files ----------------------------------------------------------
"$HERE/extract-game.sh"
GAME="$VENDOR/game"
JSDOS_META="$VENDOR/jsdos-meta"

# --- 4. AppDir + AppImage ---------------------------------------------------
echo "Assembling AppDir..."
rm -rf "$APPDIR"
mkdir -p "$APPDIR/usr/bin" "$APPDIR/usr/lib" "$APPDIR/usr/share/keen456"

cp "$VENDOR/keen456-launcher"         "$APPDIR/AppRun"
cp "$DBX/dosbox-x"                    "$APPDIR/usr/bin/dosbox-x"
cp "$VENDOR/keen456-gui"              "$APPDIR/usr/bin/keen456-gui"
cp -a "$DBX/lib/." "$APPDIR/usr/lib/" 2>/dev/null || true
cp -a "$GAME"                         "$APPDIR/usr/share/keen456/game"
cp -a "$JSDOS_META"                   "$APPDIR/usr/share/keen456/jsdos-meta"
cp "$HERE/appdir/dosbox-x.conf.tmpl"  "$APPDIR/usr/share/keen456/"
cp "$HERE/appdir/mapper-keen456.map"  "$APPDIR/usr/share/keen456/"
cp -a "$HERE/appdir/shaders"          "$APPDIR/usr/share/keen456/shaders"
cp "$HERE/appdir/keen456.desktop"     "$APPDIR/"
cp "$REPO/icons/icon-192.png"         "$APPDIR/keen456.png"
chmod +x "$APPDIR/AppRun" "$APPDIR/usr/bin/dosbox-x" "$APPDIR/usr/bin/keen456-gui"

AIT="$VENDOR/appimagetool"
if [[ ! -x "$AIT" ]]; then
  echo "Fetching appimagetool..."
  curl -fsSL -o "$AIT" "$APPIMAGETOOL_URL"
  chmod +x "$AIT"
fi

mkdir -p "$DIST"
echo "Building AppImage..."
APPIMAGE_EXTRACT_AND_RUN=1 ARCH=x86_64 "$AIT" --no-appstream "$APPDIR" "$DIST/Keen456-x86_64.AppImage" >/dev/null
echo "Done: $DIST/Keen456-x86_64.AppImage ($(du -h "$DIST/Keen456-x86_64.AppImage" | cut -f1))"
