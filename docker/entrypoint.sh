#!/bin/sh
# Build .jsdos bundles + a manifest from a mounted /data dir, then serve the site.
#
# Mount your own Keen 4/5/6 files at /data (flat, or one subdir per episode):
#   AUDIO.CK4 EGAGRAPH.CK4 GAMEMAPS.CK4 KEEN4E.EXE   (and likewise .CK5 / .CK6)
# Commercial Keen 5/6 data is never baked into the image — it only lives in /data.
set -e

WEB=/usr/share/nginx/html
GAMES="$WEB/games"
DATA=/data

# build_episode <ep> <src_dir> -> writes games/keen<ep>.jsdos, returns 0 on success
build_episode() {
  ep="$1"; src="$2"
  audio=$(find "$src" -maxdepth 1 -iname "AUDIO.CK$ep"    2>/dev/null | head -1)
  ega=$(  find "$src" -maxdepth 1 -iname "EGAGRAPH.CK$ep" 2>/dev/null | head -1)
  maps=$( find "$src" -maxdepth 1 -iname "GAMEMAPS.CK$ep" 2>/dev/null | head -1)
  exe=$(  find "$src" -maxdepth 1 -iname "KEEN$ep*.EXE"   2>/dev/null | head -1)
  [ -z "$exe" ] && exe=$(find "$src" -maxdepth 1 -iname "*.EXE" 2>/dev/null | head -1)
  [ -n "$audio" ] && [ -n "$ega" ] && [ -n "$maps" ] && [ -n "$exe" ] || return 1

  work=$(mktemp -d)
  mkdir -p "$work/.jsdos"
  cp "$audio" "$work/AUDIO.CK$ep"
  cp "$ega"   "$work/EGAGRAPH.CK$ep"
  cp "$maps"  "$work/GAMEMAPS.CK$ep"
  exename=$(basename "$exe" | tr '[:lower:]' '[:upper:]')
  cp "$exe" "$work/$exename"

  cat > "$work/.jsdos/dosbox.conf" <<CONF
[dosbox]
machine=svga_s3
memsize=16
[cpu]
core=auto
cputype=auto
cycles=auto
[mixer]
nosound=false
rate=44100
[sblaster]
sbtype=sb16
oplmode=auto
oplrate=44100
[speaker]
pcspeaker=true
[dos]
xms=true
ems=true
umb=true
[autoexec]
echo off
mount c .
c:
$exename
CONF
  printf '[cpu]\ncycles=auto\n' > "$work/dosbox.conf"

  ( cd "$work" && zip -rq -X "$GAMES/keen$ep.jsdos" .jsdos AUDIO.CK$ep EGAGRAPH.CK$ep GAMEMAPS.CK$ep "$exename" dosbox.conf )
  rm -rf "$work"
  return 0
}

games_json=""
add_game() {
  [ -n "$games_json" ] && games_json="$games_json,"
  games_json="$games_json{\"episode\":$1,\"bundle\":\"games/keen$1.jsdos\"}"
}

if [ -d "$DATA" ]; then
  echo "[keen456] scanning $DATA for Keen data..."
  for ep in 4 5 6; do
    for d in "$DATA" "$DATA"/*; do
      [ -d "$d" ] || continue
      if build_episode "$ep" "$d"; then
        echo "[keen456] built Keen $ep from $d"
        add_game "$ep"
        break
      fi
    done
  done
fi

# Fall back to the bundled Keen 4 shareware if /data didn't supply Keen 4.
if [ -f "$GAMES/keen4.jsdos" ] && ! echo "$games_json" | grep -q '"episode":4'; then
  add_game 4
fi

if [ -n "$games_json" ]; then
  printf '{"serverMode":true,"games":[%s]}\n' "$games_json" > "$GAMES/manifest.json"
  echo "[keen456] manifest: $(cat "$GAMES/manifest.json")"
else
  rm -f "$GAMES/manifest.json"
  echo "[keen456] no game data found; running in bring-your-own-data mode"
fi

exec nginx -g 'daemon off;'
