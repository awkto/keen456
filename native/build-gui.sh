#!/usr/bin/env bash
# Stage 2b of the native build: compile keen456-gui (Fyne) inside a Debian 12
# container, for the same reason DOSBox-X is built there — glibc 2.36, so the
# result runs on Debian 12+ and Ubuntu 23.10+.
#
# Fyne needs cgo and the X11/GL development headers, which is exactly why it is
# a separate binary in a separate module: the launcher stays CGO_ENABLED=0 with
# no external dependencies and builds anywhere.
#
# Output is cached at native/vendor/keen456-gui — delete it to force a rebuild.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
VENDOR="$HERE/vendor"
VERSION="${1:-${KEEN456_VERSION:-dev}}"
# Same switch as the launcher: /usr for the package, empty for the AppImage
# (where assets are found relative to $APPDIR instead). The two builds differ,
# so they are cached under different names.
PREFIX="${2-/usr}"
OUT="$VENDOR/keen456-gui${PREFIX:+-deb}"
GO_IMAGE="${GO_IMAGE:-golang:1.24-bookworm}"

# Cache key: everything that changes the binary. The GUI imports the launcher
# module's core package, so its sources count too.
STAMP="$(cat "$HERE"/gui/go.mod "$HERE"/gui/go.sum "$HERE"/gui/*.go \
              "$HERE"/launcher/go.mod "$HERE"/launcher/core/*.go 2>/dev/null \
         | sha256sum | cut -c1-16)-$VERSION-${PREFIX:-appimage}"

if [[ -x "$OUT" && "$(cat "$OUT.STAMP" 2>/dev/null || true)" == "$STAMP" ]]; then
  echo "keen456-gui already built at $OUT — skipping (rm to rebuild)"
  exit 0
fi

echo "Building keen456-gui (Fyne, in $GO_IMAGE)..."
docker run --rm \
  -v "$HERE":/src:ro -v "$VENDOR":/out \
  -v "${GOCACHE_DIR:-$VENDOR/gocache}":/gocache \
  -e VERSION="$VERSION" -e PREFIX="$PREFIX" -e OUTNAME="$(basename "$OUT")" -e HOSTOWNER="$(id -u):$(id -g)" \
  -e GOCACHE=/gocache/build -e GOMODCACHE=/gocache/mod \
  "$GO_IMAGE" bash -euo pipefail -c '
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  # Fyne (glfw) links these at build time; all are on the AppImage excludelist
  # and come from the host at runtime, so the package Depends on them instead
  # of shipping copies.
  apt-get install -y -qq --no-install-recommends \
    libgl1-mesa-dev libx11-dev libxrandr-dev libxxf86vm-dev libxi-dev \
    libxcursor-dev libxinerama-dev libxkbcommon-dev pkg-config \
    >/dev/null

  # The source is mounted read-only; build from a writable copy so the module
  # cache and the `replace keen456 => ../launcher` path both resolve.
  cp -a /src /build
  cd /build/gui
  CGO_ENABLED=1 go build -trimpath \
    -ldflags "-s -w -X keen456/core.InstallPrefix=$PREFIX -X keen456/core.Version=$VERSION" \
    -o "/out/$OUTNAME" .
  chown "$HOSTOWNER" "/out/$OUTNAME"
  ls -la "/out/$OUTNAME"
'

echo "$STAMP" > "$OUT.STAMP"
echo "Built keen456-gui -> $OUT"
