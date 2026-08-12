#!/usr/bin/env bash
# Shared build stage: unpack games/keen4.jsdos into native/vendor/.
# Used by both build.sh (AppImage) and build-deb.sh (Debian package).
#
#   vendor/game/keen4/  the Keen 4 shareware files, mounted as C:
#   vendor/jsdos-meta/  the js-dos metadata, so cross-play sync can build
#                       bootable bundles the web app can run
#
# Only Keen 4 shareware is redistributable and only it is ever packaged; Keen 5
# and 6 come from the user's own copy or from the sync server at runtime.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(dirname "$HERE")"
VENDOR="$HERE/vendor"

echo "Extracting game files from games/keen4.jsdos..."
GAME="$VENDOR/game/keen4"
rm -rf "$VENDOR/game"; mkdir -p "$GAME"
# The .jsdos bundle is a zip: game files at the root, js-dos metadata under
# .jsdos/ and a js-dos-only root dosbox.conf — exclude both from the game dir.
unzip -q -o "$REPO/games/keen4.jsdos" -d "$GAME" -x ".jsdos/*" "dosbox.conf" "DOSBOX.CONF"

JSDOS_META="$VENDOR/jsdos-meta"
rm -rf "$JSDOS_META"; mkdir -p "$JSDOS_META"
# The emulator config the web app boots with, turned into a template: the one
# line that names the executable becomes __RUNCMD__, so the same config serves
# all three episodes when native seeds a sync slot. Keeping it derived from
# games/keen4.jsdos means there is still exactly one source of truth for the
# js-dos side of the config.
unzip -q -p "$REPO/games/keen4.jsdos" ".jsdos/dosbox.conf" \
  | sed -E 's/^KEEN[456][A-Z0-9]*\.EXE$/__RUNCMD__/' > "$JSDOS_META/jsdos-dosbox.conf.tmpl"
grep -q '^__RUNCMD__$' "$JSDOS_META/jsdos-dosbox.conf.tmpl" || {
  echo "extract-game.sh: no KEENn*.EXE line in .jsdos/dosbox.conf — the bundle changed shape" >&2
  exit 1
}
unzip -q -p "$REPO/games/keen4.jsdos" "dosbox.conf" > "$JSDOS_META/root-dosbox.conf"
