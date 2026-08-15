#!/usr/bin/env bash
# Unpack games/keen4.jsdos into the APK's assets. Same source bundle the web
# app and the Linux build use (native/extract-game.sh), so all three ship
# byte-identical game files — a save really is portable between them.
#
# Only Keen 4 shareware is redistributable and only it is ever bundled; Keen 5
# and 6 come from the user's own files (imported in the episode picker) or from
# the sync server at runtime.
#
# Generated output; app/src/main/assets/game/ is git-ignored.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
DEST="$HERE/app/src/main/assets/game/keen4"

command -v unzip >/dev/null || { echo "unzip is required" >&2; exit 1; }

rm -rf "$HERE/app/src/main/assets/game"
mkdir -p "$DEST"
# Game files sit at the bundle root; .jsdos/ metadata and the js-dos-only
# dosbox.conf are not part of the DOS game and must not be mounted as C:.
unzip -q -o "$REPO/games/keen4.jsdos" -d "$DEST" -x ".jsdos/*" "dosbox.conf" "DOSBOX.CONF"

echo "game assets -> ${DEST#$REPO/}"
ls "$DEST" | head -40
echo "($(ls "$DEST" | wc -l) files, $(du -sh "$DEST" | cut -f1))"

# js-dos bundle metadata, needed when save sync pushes a brand-new bundle (no
# browser history to preserve it from). The executable line becomes __RUNCMD__
# so one template serves all three episodes — exactly what the Linux build's
# native/extract-game.sh does for vendor/jsdos-meta/.
META="$HERE/app/src/main/assets/jsdos-meta"
rm -rf "$META"
mkdir -p "$META"
unzip -q -p "$REPO/games/keen4.jsdos" ".jsdos/dosbox.conf" \
  | sed -E 's/^KEEN[456][A-Z0-9]*\.EXE$/__RUNCMD__/' > "$META/jsdos-dosbox.conf.tmpl"
grep -q '^__RUNCMD__$' "$META/jsdos-dosbox.conf.tmpl" || {
  echo "build-assets.sh: no KEENn*.EXE line in .jsdos/dosbox.conf — the bundle changed shape" >&2
  exit 1
}
unzip -q -p "$REPO/games/keen4.jsdos" "dosbox.conf" > "$META/root-dosbox.conf"
echo "jsdos metadata -> ${META#$REPO/}"

# The desktop mapper, minus the plain-F fullscreen bind (harmless on desktop,
# but on Android the soft keyboard types straight into the game — an 'f' in a
# save-game name must not toggle SDL fullscreen). What this keeps that Android
# needs: speedlock on plain Tab (the FF button), save/load state on Ctrl+. and
# Ctrl+\ (the 💾 popup) — same combos as the desktop build and the README.
sed 's/^hand_fullscr "key 9 host" "key 9" $/hand_fullscr "key 9 host" /' \
  "$REPO/native/appdir/mapper-keen456.map" > "$HERE/app/src/main/assets/mapper-keen456.map"
grep -q '^hand_fullscr "key 9 host" $' "$HERE/app/src/main/assets/mapper-keen456.map" || {
  echo "build-assets.sh: mapper fullscreen bind changed shape — update the sed above" >&2
  exit 1
}
echo "mapper -> app/src/main/assets/mapper-keen456.map"
