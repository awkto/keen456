#!/usr/bin/env bash
# Frame-cadence benchmark: how evenly does Keen emit frames under a given conf?
#
#   ./native/bench-cadence.sh <label> <core> <cycles> [level] [extra-conf]
#   ./native/bench-cadence.sh base normal "fixed 25000"
#   ./native/bench-cadence.sh v60  normal "fixed 25000" 1 $'[vsync]\nvsyncmode=on\nvsyncrate=60'
#
# Boots Keen 4 straight into a level (/TEDLEVEL), pogos left, records DOSBox-X's
# own AVI (one entry per EMULATED frame, so no screen-grab tearing) and reports
# the gap between frames that actually differ, in emulated vblanks. Keen is
# PIT-timed to 35fps: at the native 70Hz VGA rate a healthy run is ~95% "2v".
# The rare 6v+ gaps are the pogo's held bounce frame / Keen meeting a wall, not
# stalls. Needs ~/keen-data/keen4, the built AppImage, Xvfb, xdotool, ffmpeg.
# Do NOT bind the capture key to F9: it quits Keen in TED mode.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
S="${BENCH_DIR:-$(mktemp -d)}"
if [[ ! -x "$S/squashfs-root/usr/bin/dosbox-x" ]]; then
  ( cd "$S" && "$HERE/dist/Keen456-x86_64.AppImage" --appimage-extract >/dev/null 2>&1 )
fi
LABEL="$1"; CORE="$2"; CYCLES="$3"; LEVEL="${4:-1}"; VSYNC="${5:-}"
APP="$S/squashfs-root/usr"
RUN="$S/run-$LABEL"; rm -rf "$RUN"; mkdir -p "$RUN/game" "$RUN/capture"
cp ~/keen-data/keen4/*.CK4 ~/keen-data/keen4/KEEN4E.EXE "$RUN/game/"
rm -f "$RUN/game/CONFIG.CK4"

sed -e 's/^hand_video .*/hand_video "key 71"/' "$APP/share/keen456/mapper-keen456.map" > "$RUN/mapper.map"

cat > "$RUN/dosbox-x.conf" <<EOF
[sdl]
autolock=false
fullscreen=false
output=surface
mapperfile=$RUN/mapper.map
[render]
aspect=false
scaler=none
$VSYNC
[log]
logfile=$RUN/last-run.log
[dosbox]
quit warning=false
machine=svga_s3
memsize=16
captures=$RUN/capture
saveremark=false
[cpu]
core=$CORE
cputype=auto
cycles=$CYCLES
cycleup=10
cycledown=20
[mixer]
nosound=false
rate=44100
blocksize=1024
prebuffer=20
[sblaster]
sbtype=sb16
sbbase=220
irq=7
dma=1
hdma=5
oplmode=auto
[speaker]
pcspeaker=true
[dos]
xms=true
ems=true
umb=true
[autoexec]
@echo off
mount c "$RUN/game"
c:
KEEN4E.EXE /TEDLEVEL $LEVEL
exit
EOF

export RUN APP
xvfb-run -a -s "-screen 0 1024x768x24" bash -c '
  HOME="$RUN" SDL_AUDIODRIVER=dummy LD_LIBRARY_PATH="$APP/lib:${LD_LIBRARY_PATH:-}" \
    "$APP/bin/dosbox-x" -conf "$RUN/dosbox-x.conf" -nomenu -fastlaunch >"$RUN/stdout.log" 2>&1 &
  PID=$!
  sleep 14
  import -window root "$RUN/before.png"
  xdotool key alt          # pogo on: Keen bounces continuously
  sleep 0.3
  xdotool keydown Left
  sleep 1
  xdotool key Scroll_Lock  # start AVI capture
  sleep 12
  xdotool key Scroll_Lock  # stop
  sleep 1
  import -window root "$RUN/after.png"
  xdotool keyup Left
  kill $PID 2>/dev/null; sleep 1; kill -9 $PID 2>/dev/null
  wait $PID 2>/dev/null
'
AVI="$(ls "$RUN"/capture/*.avi 2>/dev/null | head -1)"
[[ -n "$AVI" ]] || { echo "$LABEL: NO CAPTURE"; tail -5 "$RUN/last-run.log"; exit 1; }
ffmpeg -v error -i "$AVI" -an -f framemd5 - 2>/dev/null | grep -v '^#' | awk -F, '{print $NF}' > "$RUN/hashes.txt"
FPS="$(ffprobe -v error -select_streams v:0 -show_entries stream=r_frame_rate -of csv=p=0 "$AVI")"
python3 - "$RUN/hashes.txt" "$LABEL" "$CORE" "$CYCLES" "$FPS" <<'PY'
import sys, statistics
h=[l.strip() for l in open(sys.argv[1])]
a,b=sys.argv[5].split('/'); RATE=float(a)/float(b)
n=len(h)
changes=[i for i in range(1,n) if h[i]!=h[i-1]]
secs=n/RATE
gaps=[b-a for a,b in zip(changes,changes[1:])]
from collections import Counter
c=Counter(gaps)
top=", ".join(f"{g}v:{c[g]*100//max(1,len(gaps))}%" for g in sorted(c)[:7])
fps=len(changes)/secs if secs else 0
sd=statistics.pstdev(gaps) if gaps else 0
print(f"{sys.argv[2]:>10} core={sys.argv[3]:<8} cycles={sys.argv[4]:<14} emu_frames={n:4d} ({secs:4.1f}s)  game_fps={fps:5.1f}  vga={RATE:.2f}Hz frame-gap(in emulated vblanks) mean={statistics.mean(gaps) if gaps else 0:.2f} sd={sd:.2f}  dist[{top}]")
PY
