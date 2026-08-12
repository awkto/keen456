#!/usr/bin/env bash
# Stage 1 of the native build: compile DOSBox-X from source inside a Debian 12
# container (glibc 2.36) so the resulting AppImage runs on Debian 12+ and
# Ubuntu 23.10+. Output (binary + bundled shared libs) is cached in
# native/vendor/dosbox-x-<version>/ — delete that dir to force a rebuild.
set -euo pipefail

DOSBOX_X_VERSION="${DOSBOX_X_VERSION:-2026.08.02}"
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$HERE/vendor/dosbox-x-$DOSBOX_X_VERSION"

# Cache key: the version AND the inputs that change the binary — the patch set
# and this script. Without the patch hash, adding/removing/editing a patch
# silently reuses the previously compiled binary and the change never lands.
STAMP="$(cat "$HERE"/patches/*.patch "$0" 2>/dev/null | sha256sum | cut -c1-16)"

if [[ -x "$OUT/dosbox-x" ]]; then
  if [[ "$(cat "$OUT/STAMP" 2>/dev/null || true)" == "$STAMP" ]]; then
    echo "dosbox-x $DOSBOX_X_VERSION already built at $OUT — skipping (rm -rf to rebuild)"
    exit 0
  fi
  echo "dosbox-x $DOSBOX_X_VERSION cached build is stale (patches or build script changed) — rebuilding"
  rm -rf "$OUT"
fi

mkdir -p "$OUT"

docker run --rm -v "$OUT":/out -v "$HERE/patches":/patches:ro \
  -e VER="$DOSBOX_X_VERSION" -e STAMP="$STAMP" -e HOSTOWNER="$(id -u):$(id -g)" \
  debian:12-slim bash -euo pipefail -c '
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq --no-install-recommends \
    build-essential autoconf automake libtool pkg-config git ca-certificates \
    libsdl2-dev libsdl2-net-dev libpng-dev zlib1g-dev libgl-dev libncursesw5-dev \
    >/dev/null
  apt-get install -y -qq --no-install-recommends patch >/dev/null
  git clone --depth 1 --branch "dosbox-x-v$VER" \
    https://github.com/joncampbell123/dosbox-x /src
  cd /src
  # Applied in glob order: desktop-pogo (the one feature with no vanilla
  # equivalent) then filter-cycle, which is diffed against the pogo-applied
  # tree. Order matters.
  for p in /patches/*.patch; do
    echo "Applying $(basename "$p")"
    patch -p1 < "$p"
  done
  ./autogen.sh
  ./configure --enable-sdl2
  make -j"$(nproc)" >/dev/null
  strip src/dosbox-x
  cp src/dosbox-x /out/

  # Bundle the shared libraries dosbox-x links against, minus the ones every
  # Linux desktop must provide anyway (glibc family, GL vendor drivers, X11 —
  # the standard AppImage exclude set). SDL2 dlopens X11/Wayland from the host.
  # libgbm/libz/libexpat/libasound/libgpg-error follow the official AppImage
  # excludelist: shipping Debian-12 Mesa bits (libgbm) alongside the host GL
  # stack broke hardware GL on newer distros (shaders fell back to the fixed
  # pipeline), and the others are config-coupled to the host.
  mkdir -p /out/lib
  EXCLUDE="libc\.|libm\.|libdl\.|libpthread\.|librt\.|ld-linux|libresolv\.|libgcc_s\.|libstdc\+\+\.|libGL\.|libGLX|libGLdispatch|libEGL|libOpenGL|libdrm|libX11|libxcb|libXext|libwayland|libgbm|libz\.|libexpat|libasound|libgpg-error"
  ldd src/dosbox-x | awk "/=> \// {print \$3}" | while read -r lib; do
    base="$(basename "$lib")"
    echo "$base" | grep -qE "$EXCLUDE" && continue
    cp -L "$lib" /out/lib/
  done
  echo "$VER" > /out/VERSION
  echo "$STAMP" > /out/STAMP
  chown -R "$HOSTOWNER" /out
  ls -la /out /out/lib
'

echo "Built dosbox-x $DOSBOX_X_VERSION -> $OUT"
