#!/usr/bin/env bash
# Headless smoke test: boot an episode under Xvfb with a throwaway $HOME, wait
# for DOS + the game to start, screenshot the window.
#
#   ./native/test-headless.sh [episode] [seconds-to-wait] [out.png] [-- extra args]
#
# Runs the built AppImage by default; KEEN456_BIN=path/to/AppRun (or an
# unpacked AppDir's AppRun) tests an assembled AppDir without packing it.
# KEEN456_HOME=dir reuses a home instead of a throwaway one, which is how the
# sync and save-state checks see state from a previous run.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
EPISODE="${1:-4}"
WAIT="${2:-25}"
SHOT="${3:-$HERE/dist/smoke-keen$EPISODE.png}"
shift $(( $# > 3 ? 3 : $# )) || true
[[ "${1:-}" == "--" ]] && shift || true
EXTRA=("$@")

BIN="${KEEN456_BIN:-$HERE/dist/Keen456-x86_64.AppImage}"
[[ -x "$BIN" ]] || { echo "missing $BIN — run native/build.sh first"; exit 1; }
ARGS=()
[[ "$BIN" == *.AppImage ]] && ARGS+=(--appimage-extract-and-run)

if [[ -n "${KEEN456_HOME:-}" ]]; then
  TMPHOME="$KEEN456_HOME"
  mkdir -p "$TMPHOME"
else
  TMPHOME="$(mktemp -d)"
  trap 'rm -rf "$TMPHOME"' EXIT
fi
mkdir -p "$(dirname "$SHOT")"

xvfb-run -a -s "-screen 0 1024x768x24" bash -c '
  set -e
  HOME="'"$TMPHOME"'" SDL_AUDIODRIVER=dummy "'"$BIN"'" '"${ARGS[*]-}"' '"$EPISODE"' '"${EXTRA[*]-}"' &
  PID=$!
  sleep "'"$WAIT"'"
  import -window root "'"$SHOT"'"
  kill $PID 2>/dev/null || true
  wait $PID 2>/dev/null || true
'
echo "Screenshot: $SHOT"
ls "$TMPHOME/.local/share/keen456/game" 2>/dev/null \
  && echo "Game dirs created OK"
tail -5 "$TMPHOME/.local/share/keen456/last-run.log" 2>/dev/null || true
