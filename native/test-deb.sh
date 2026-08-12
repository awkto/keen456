#!/usr/bin/env bash
# Verify a built .deb really installs on the distros we claim to support, and
# that every shared library it needs is satisfied afterwards.
#
#   ./native/test-deb.sh native/dist/keen456_1.0.0_amd64.deb
#
# This exists because the failure mode is invisible on the build host: the
# package is compiled in Debian 12 but installed on Ubuntu, where several
# library packages were renamed for the 64-bit time_t transition
# (libasound2 -> libasound2t64). A wrong Depends only shows up as an
# unsatisfiable install on the user's machine, and a missing one only as a
# runtime "error while loading shared libraries".
set -euo pipefail

DEB="${1:?usage: $0 <path/to/keen456_*.deb>}"
DEB="$(cd "$(dirname "$DEB")" && pwd)/$(basename "$DEB")"
IMAGES=("${@:2}")
[[ ${#IMAGES[@]} -eq 0 ]] && IMAGES=(debian:12 ubuntu:26.04)

fail=0
for img in "${IMAGES[@]}"; do
  echo "=== $img ==="
  if ! docker run --rm -v "$DEB":/tmp/pkg.deb:ro "$img" bash -euo pipefail -c '
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq >/dev/null

    # apt-get install (not dpkg -i) so Depends are actually resolved — this is
    # what fails if a package name does not exist on this distro.
    apt-get install -y -qq /tmp/pkg.deb >/dev/null

    command -v keen456 >/dev/null || { echo "FAIL: /usr/bin/keen456 missing"; exit 1; }
    command -v keen456-gui >/dev/null || { echo "FAIL: /usr/bin/keen456-gui missing"; exit 1; }
    keen456 --version

    # Every NEEDED library must resolve, both for the launcher and for
    # dosbox-x with the bundled lib dir on the path, exactly as the launcher
    # runs it. ldd prints "not found" for anything unsatisfied.
    missing=$(LD_LIBRARY_PATH=/usr/lib/keen456/lib ldd /usr/lib/keen456/dosbox-x \
      | grep "not found" || true)
    if [ -n "$missing" ]; then
      echo "FAIL: unresolved libraries in dosbox-x:"; echo "$missing"; exit 1
    fi
    # keen456-gui is cgo/Fyne and links the X11+GL stack directly, so it has
    # its own set of Depends to get wrong.
    missing=$(ldd /usr/bin/keen456-gui | grep "not found" || true)
    if [ -n "$missing" ]; then
      echo "FAIL: unresolved libraries in keen456-gui:"; echo "$missing"; exit 1
    fi

    # Assets the launcher will look for under the FHS layout.
    for f in /usr/share/keen456/dosbox-x.conf.tmpl \
             /usr/share/keen456/mapper-keen456.map \
             /usr/share/keen456/game/keen4/KEEN4E.EXE \
             /usr/share/keen456/jsdos-meta/jsdos-dosbox.conf.tmpl \
             /usr/share/keen456/jsdos-meta/root-dosbox.conf \
             /usr/share/applications/keen456.desktop \
             /usr/share/pixmaps/keen456.png; do
      [ -e "$f" ] || { echo "FAIL: missing $f"; exit 1; }
    done
    [ -n "$(ls /usr/share/keen456/shaders/*.glsl 2>/dev/null)" ] || { echo "FAIL: no shaders"; exit 1; }

    # No commercial episode may ever be in the package — only Keen 4 shareware
    # is redistributable. A stray *.CK5/*.CK6 would be a licensing problem, not
    # just a packaging one.
    stray=$(find /usr/share/keen456 -iname "*.CK5" -o -iname "*.CK6" -o -iname "KEEN5*.EXE" -o -iname "KEEN6*.EXE")
    if [ -n "$stray" ]; then
      echo "FAIL: commercial game data in the package:"; echo "$stray"; exit 1
    fi

    # The episode-scoped CLI must work without a display.
    keen456 --help | grep -q "keen456 4 | 5 | 6" || { echo "FAIL: help text"; exit 1; }
    keen456 saves list | grep -q "Keen 4" || { echo "FAIL: saves list"; exit 1; }

    # Removal must leave nothing behind under /usr.
    apt-get remove -y -qq keen456 >/dev/null
    [ ! -e /usr/bin/keen456 ] || { echo "FAIL: /usr/bin/keen456 survived removal"; exit 1; }
    [ ! -e /usr/bin/keen456-gui ] || { echo "FAIL: /usr/bin/keen456-gui survived removal"; exit 1; }
    echo "OK"
  '; then
    echo "*** FAILED on $img"
    fail=1
  fi
done

[[ $fail -eq 0 ]] || exit 1
echo "All package checks passed."
