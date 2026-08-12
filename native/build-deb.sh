#!/usr/bin/env bash
# Build the Debian/Ubuntu package: native/dist/keen456_<version>_amd64.deb
#
#   ./native/build-deb.sh 1.0.0
#
# Same payload as the AppImage, laid out per the FHS instead of in an AppDir,
# so `apt install keen456` and `apt upgrade` work like any other package:
#
#   /usr/bin/keen456                 the Go launcher (installPrefix=/usr)
#   /usr/lib/keen456/dosbox-x        patched DOSBox-X (see patches/)
#   /usr/lib/keen456/lib/            its private shared libraries
#   /usr/share/keen456/              Keen 4 shareware, shaders, conf, mapper
#   /usr/share/applications/         desktop entry (with per-episode actions)
#
# Stages 1-3 are shared with build.sh and cached under native/vendor/.
set -euo pipefail

VERSION="${1:-${KEEN456_VERSION:-0.0.0}}"
DOSBOX_X_VERSION="${DOSBOX_X_VERSION:-2026.08.02}"
ARCH="${ARCH:-amd64}"

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(dirname "$HERE")"
VENDOR="$HERE/vendor"
DIST="$HERE/dist"
DBX="$VENDOR/dosbox-x-$DOSBOX_X_VERSION"

if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "usage: $0 <version>   (semver, e.g. 1.0.0)" >&2
  exit 1
fi

# --- 1. dosbox-x ------------------------------------------------------------
DOSBOX_X_VERSION="$DOSBOX_X_VERSION" "$HERE/build-dosbox-x.sh"

# --- 2. launcher ------------------------------------------------------------
# installPrefix switches the launcher from the AppImage layout to the FHS one.
echo "Building launcher (prefix=/usr, version=$VERSION)..."
(cd "$HERE/launcher" && CGO_ENABLED=0 go build -trimpath \
  -ldflags="-s -w -X keen456/core.InstallPrefix=/usr -X keen456/core.Version=$VERSION" \
  -o "$VENDOR/keen456-launcher-deb" .)

# --- 2b. settings UI --------------------------------------------------------
"$HERE/build-gui.sh" "$VERSION" /usr

# --- 3. game files ----------------------------------------------------------
"$HERE/extract-game.sh"

# --- 4. staging tree --------------------------------------------------------
PKGROOT="$VENDOR/deb/keen456_${VERSION}_${ARCH}"
rm -rf "$PKGROOT"
install -d "$PKGROOT/DEBIAN" \
           "$PKGROOT/usr/bin" \
           "$PKGROOT/usr/lib/keen456/lib" \
           "$PKGROOT/usr/share/keen456" \
           "$PKGROOT/usr/share/applications" \
           "$PKGROOT/usr/share/pixmaps" \
           "$PKGROOT/usr/share/doc/keen456"

install -m755 "$VENDOR/keen456-launcher-deb" "$PKGROOT/usr/bin/keen456"
install -m755 "$VENDOR/keen456-gui-deb"      "$PKGROOT/usr/bin/keen456-gui"
install -m755 "$DBX/dosbox-x"                "$PKGROOT/usr/lib/keen456/dosbox-x"
cp -a "$DBX/lib/." "$PKGROOT/usr/lib/keen456/lib/" 2>/dev/null || true
find "$PKGROOT/usr/lib/keen456/lib" -type f -exec chmod 644 {} +

cp -a "$VENDOR/game"                 "$PKGROOT/usr/share/keen456/game"
cp -a "$VENDOR/jsdos-meta"           "$PKGROOT/usr/share/keen456/jsdos-meta"
cp -a "$HERE/appdir/shaders"         "$PKGROOT/usr/share/keen456/shaders"
install -m644 "$HERE/appdir/dosbox-x.conf.tmpl" "$PKGROOT/usr/share/keen456/"
install -m644 "$HERE/appdir/mapper-keen456.map" "$PKGROOT/usr/share/keen456/"
install -m644 "$REPO/icons/icon-192.png" "$PKGROOT/usr/share/pixmaps/keen456.png"
find "$PKGROOT/usr/share/keen456" -type f -exec chmod 644 {} +
find "$PKGROOT/usr/share/keen456" -type d -exec chmod 755 {} +

# Desktop entry opens the settings/launcher panel; the per-episode actions
# (right-click the launcher icon) start one episode directly.
sed -e 's|^Exec=AppRun$|Exec=keen456-gui|' -e 's|^Exec=AppRun \([456]\)$|Exec=keen456 \1|' \
  "$HERE/appdir/keen456.desktop" > "$PKGROOT/usr/share/applications/keen456.desktop"
chmod 644 "$PKGROOT/usr/share/applications/keen456.desktop"

install -m644 "$REPO/LICENSE" "$PKGROOT/usr/share/doc/keen456/copyright"

# --- 5. control -------------------------------------------------------------
# Depends covers only what is NOT bundled in usr/lib/keen456/lib — the
# host-coupled libraries deliberately excluded by build-dosbox-x.sh (shipping
# our own Mesa/X11 bits broke hardware GL on newer distros).
#
# The `t64 | pre-t64` alternatives matter: Ubuntu >=24.04 renamed several
# packages for the 64-bit time_t transition, so `libasound2` does not exist on
# Ubuntu 26.04 and `libasound2t64` does not exist on Debian 12. Naming both
# keeps one package installable on either.
cat > "$PKGROOT/DEBIAN/control" <<EOF
Package: keen456
Version: $VERSION
Section: games
Priority: optional
Architecture: $ARCH
Maintainer: awkto <me@awkto.dev>
Depends: libc6 (>= 2.36), libstdc++6, libgcc-s1, libgl1, libx11-6, zlib1g,
 libexpat1, libgpg-error0, libasound2t64 | libasound2, libgbm1, libdrm2,
 libwayland-client0, libwayland-cursor0, libwayland-egl1, libxrandr2,
 libxcursor1, libxinerama1, libxi6, libxxf86vm1, libxkbcommon0
Homepage: https://github.com/awkto/keen456
Description: Commander Keen 4/5/6 — native DOSBox-X build
 Commander Keen "Goodbye, Galaxy!" and "Aliens Ate My Babysitter!", packaged
 with a patched DOSBox-X and a launcher that adds desktop conveniences: the
 Alt-key pogo super-bounce, hold-Tab turbo, CRT/scanline/soft-pixel GL filters
 cycled in-game with V, save states, and optional save sync that cross-plays
 with the browser build.
 .
 Episode 4 is the freely redistributable shareware release and is included.
 Episodes 5 and 6 are commercial: point the app at your own copy with
 keen456 5 --game-files DIR, or let save sync bring them down.
 .
 Game data, saves and settings live under ~/.local/share/keen456 and
 ~/.config/keen456; the package itself is read-only.
EOF

# Installed-Size (KiB) — apt shows it and dpkg warns if it is absent.
SIZE=$(du -sk --exclude=DEBIAN "$PKGROOT" | cut -f1)
sed -i "s|^Section: games|Installed-Size: $SIZE\nSection: games|" "$PKGROOT/DEBIAN/control"

# --- 6. build ---------------------------------------------------------------
mkdir -p "$DIST"
DEB="$DIST/keen456_${VERSION}_${ARCH}.deb"
rm -f "$DEB"
# Ownership must be root:root regardless of who runs the build.
dpkg-deb --root-owner-group --build "$PKGROOT" "$DEB" >/dev/null
echo "Done: $DEB ($(du -h "$DEB" | cut -f1))"
dpkg-deb --info "$DEB" | sed -n '1,20p'
