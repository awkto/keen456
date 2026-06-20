#!/usr/bin/env bash
# Bundle the static web app (repo root) into android/www so Capacitor can package
# it into the APK. The web app is the single source of truth; www/ is generated.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
WWW="$HERE/www"

rm -rf "$WWW"
mkdir -p "$WWW"
cp "$ROOT/index.html" "$WWW/"
cp -r "$ROOT/css" "$ROOT/js" "$ROOT/games" "$ROOT/icons" "$WWW/"

echo "bundled web app into $WWW:"
ls -la "$WWW"
