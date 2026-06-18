/*
 * Commander Keen 4/5/6 launcher (js-dos baseline).
 *
 * - Keen 4 shareware ships as a prebuilt bundle (games/keen4.jsdos).
 * - Keen 5/6 (and full Keen 4): the user supplies their own data files, which we
 *   assemble into a .jsdos bundle entirely in the browser (nothing is uploaded).
 *
 * Wrapped in an IIFE: js-dos.js declares globals (including `var $`), so we must
 * keep our own top-level names ($ , launch, DOSBOX_CONF, …) out of global scope.
 */

(function () {
"use strict";

// dosbox.conf used for user-supplied bundles. __RUNCMD__ is replaced with the
// detected game executable. Kept in sync with games/keen4.jsdos's config.
const DOSBOX_CONF = `[sdl]
autolock=false
fullscreen=false
output=surface
mapperfile=mapper-jsdos.map
usescancodes=true
[dosbox]
machine=svga_s3
memsize=16
[cpu]
core=auto
cputype=auto
cycles=auto
cycleup=10
cycledown=20
[mixer]
nosound=false
rate=44100
blocksize=1024
prebuffer=20
[render]
frameskip=0
aspect=false
scaler=none
[sblaster]
sbtype=sb16
sbbase=220
irq=7
dma=1
hdma=5
sbmixer=true
oplmode=auto
oplemu=default
oplrate=44100
[speaker]
pcspeaker=true
pcrate=44100
[dos]
xms=true
ems=true
umb=true
keyboardlayout=auto
[autoexec]
echo off
mount c .
c:
__RUNCMD__
`;

let dosCi = null;           // running js-dos instance
let gameCi = null;          // emulator command interface (for sending key events)
let pendingBlobUrl = null;  // object URL for a built bundle, awaiting Play
let pendingFiles = null;    // [{name, data:Uint8Array}]
let pendingRunCmd = null;
let pendingKey = null;      // persistence key for the BYO episode

const $ = (id) => document.getElementById(id);

// ---- settings (persisted in localStorage) ----------------------------------

const SETTING_DEFAULTS = { aspect: "4/3", rendering: "pixelated", touch: "auto" };
const getSetting = (k) => localStorage.getItem("keen." + k) || SETTING_DEFAULTS[k];
const setSetting = (k, v) => localStorage.setItem("keen." + k, v);

function touchEnabled() {
  const mode = getSetting("touch");
  if (mode === "on") return true;
  if (mode === "off") return false;
  return window.matchMedia("(pointer: coarse)").matches; // auto
}

// ---- launching -------------------------------------------------------------

// `key` scopes the IndexedDB save storage so saves persist across reloads
// (stable per episode, even when BYO bundles get fresh blob: URLs each time).
function launch(url, key) {
  $("launcher").hidden = true;
  $("topbar").hidden = true;
  $("footer").hidden = true;
  $("game-stage").hidden = false;

  const touch = touchEnabled();
  if (touch) {
    $("game-stage").classList.add("touch");
    $("touch-controls").hidden = false;
  }

  // Dos() boots DOSBox-WASM into #dos and loads the .jsdos bundle at `url`.
  dosCi = Dos($("dos"), {
    url,
    key,
    autoStart: true,
    autoSave: true,            // auto-persist FS changes (savegames/config) to IndexedDB
    backend: "dosbox",
    noCloud: true,             // self-contained: no cloud account prompts
    thinSidebar: touch,        // slim the js-dos sidebar on touch (CSS moves it to the top)
    renderAspect: getSetting("aspect"),
    imageRendering: getSetting("rendering"),
    onEvent: (event, arg) => {
      if (event === "ci-ready") gameCi = arg;   // command interface for touch input
      if (event === "error") {
        alert("js-dos error:\n\n" + arg +
          "\n\nIf you supplied your own files, double-check they are the right episode's " +
          "AUDIO/EGAGRAPH/GAMEMAPS .CK? files plus the game .EXE.");
      }
    },
  });
}

async function quit() {
  try { if (dosCi && typeof dosCi.stop === "function") await dosCi.stop(); } catch (_) {}
  if (pendingBlobUrl) URL.revokeObjectURL(pendingBlobUrl);
  // Full reload is the most reliable way to tear down the emulator cleanly.
  location.reload();
}

// ---- user-supplied data -> .jsdos bundle -----------------------------------

const DATA_RE = {
  audio: /^AUDIO\.CK[456]$/,
  egagraph: /^EGAGRAPH\.CK[456]$/,
  gamemaps: /^GAMEMAPS\.CK[456]$/,
};

async function handleFiles(fileList) {
  const status = $("file-status");
  status.hidden = false;
  $("play-byo").disabled = true;
  pendingFiles = null;

  const files = [];
  for (const f of fileList) {
    const name = f.name.toUpperCase();
    files.push({ name, data: new Uint8Array(await f.arrayBuffer()) });
  }

  const names = files.map((f) => f.name);
  const has = (re) => names.some((n) => re.test(n));
  const exe = files.find((f) => /\.EXE$/.test(f.name) && /KEEN/.test(f.name))
           || files.find((f) => /\.EXE$/.test(f.name));

  // Which episode? Derive from the CKx extension present.
  const epMatch = names.map((n) => n.match(/\.CK([456])$/)).find(Boolean);
  const episode = epMatch ? epMatch[1] : null;

  const checks = [
    [has(DATA_RE.audio), "AUDIO.CK" + (episode || "?")],
    [has(DATA_RE.egagraph), "EGAGRAPH.CK" + (episode || "?")],
    [has(DATA_RE.gamemaps), "GAMEMAPS.CK" + (episode || "?")],
    [!!exe, "game .EXE"],
  ];

  const rows = checks
    .map(([ok, label]) => `<div class="${ok ? "ok" : "miss"}">${ok ? "✓" : "✗"} ${label}</div>`)
    .join("");

  const allOk = checks.every(([ok]) => ok);
  let extra = "";
  if (allOk && episode === "6") {
    extra = `<div style="margin-top:.5rem">⚠ Keen 6 shows a "Creature Question" copy-protection prompt at startup — the answers are in the game's manual. (Bypassing it is a Path 2 / Omnispeak feature, not available under DOS emulation.)</div>`;
  }
  status.innerHTML = `<div><strong>Selected ${files.length} file(s)` +
    (episode ? ` — detected Keen ${episode}` : "") + `:</strong></div>` + rows + extra;

  if (allOk) {
    pendingFiles = files;
    pendingRunCmd = exe.name;
    pendingKey = "keen" + (episode || "x");
    $("play-byo").disabled = false;
  }
}

function buildBundleBlob(files, runCmd) {
  const conf = DOSBOX_CONF.replace("__RUNCMD__", runCmd);
  const tree = {
    ".jsdos/dosbox.conf": fflate.strToU8(conf),
    "dosbox.conf": fflate.strToU8("[cpu]\ncycles=auto\n"),
  };
  for (const f of files) tree[f.name] = f.data;
  const zipped = fflate.zipSync(tree, { level: 6 });
  return new Blob([zipped], { type: "application/octet-stream" });
}

function playByo() {
  if (!pendingFiles) return;
  const blob = buildBundleBlob(pendingFiles, pendingRunCmd);
  pendingBlobUrl = URL.createObjectURL(blob);
  launch(pendingBlobUrl, pendingKey);
}

// ---- touch controls --------------------------------------------------------

const activeByPointer = new Map(); // pointerId -> [keyCodes]

function sendKey(code, down) {
  if (gameCi && typeof gameCi.sendKeyEvent === "function") {
    try { gameCi.sendKeyEvent(code, down); } catch (_) {}
  }
}

function bindTouchButton(btn) {
  const keys = (btn.dataset.keys || "").split(",").map(Number).filter(Boolean);
  if (!keys.length) return;
  // Optional stagger (ms) between successive key-downs. The Galaxy pogo
  // super-jump only boosts if Jump lands a frame or two AFTER the pogo has
  // mounted — pressing both on the same frame (from a standstill) just gives a
  // tiny bounce. data-keys order sets the sequence (e.g. pogo first, then jump).
  const stagger = parseInt(btn.dataset.stagger || "0", 10) || 0;
  let timers = [];

  const press = (e) => {
    e.preventDefault();
    // Capture the pointer so this button keeps every move/up event for the
    // whole hold — the OS can't reroute it into a long-press gesture.
    try { btn.setPointerCapture(e.pointerId); } catch (_) {}
    btn.classList.add("active");
    if (e.pointerId != null) activeByPointer.set(e.pointerId, keys);
    timers.forEach(clearTimeout); timers = [];
    keys.forEach((k, i) => {
      if (stagger && i > 0) timers.push(setTimeout(() => sendKey(k, true), stagger * i));
      else sendKey(k, true);
    });
  };
  const release = (e) => {
    timers.forEach(clearTimeout); timers = [];
    btn.classList.remove("active");
    keys.forEach((k) => sendKey(k, false));
    if (e && e.pointerId != null) activeByPointer.delete(e.pointerId);
  };

  btn.addEventListener("pointerdown", press);
  btn.addEventListener("pointerup", release);
  btn.addEventListener("pointercancel", release);
  btn.addEventListener("lostpointercapture", release);
  // Kill the browser's long-press behaviours (context menu, text selection,
  // iOS callout) that otherwise fire pointercancel mid-hold and drop the keys —
  // this is what made a held super-jump collapse into a tiny pogo bounce.
  btn.addEventListener("contextmenu", (e) => e.preventDefault());
  btn.addEventListener("touchstart", (e) => e.preventDefault(), { passive: false });
}

// Virtual joystick -> arrow keys (8-way). Removes the dead center of a d-pad.
const ARROWS = { up: 265, down: 264, left: 263, right: 262 };
const arrowState = { up: false, down: false, left: false, right: false };

function setArrow(dir, on) {
  if (arrowState[dir] !== on) {
    arrowState[dir] = on;
    sendKey(ARROWS[dir], on);
  }
}
function clearArrows() { Object.keys(ARROWS).forEach((d) => setArrow(d, false)); }

function setupJoystick() {
  const base = $("stick");
  const knob = $("stick-knob");
  if (!base) return;
  let pid = null;

  const update = (cx, cy) => {
    const r = base.getBoundingClientRect();
    const ox = r.left + r.width / 2;
    const oy = r.top + r.height / 2;
    const dx = cx - ox;
    const dy = cy - oy;
    const max = r.width / 2;
    const dist = Math.hypot(dx, dy);
    const k = Math.min(1, dist / max);
    const ang = Math.atan2(dy, dx);
    knob.style.transform = `translate(${Math.cos(ang) * k * max}px, ${Math.sin(ang) * k * max}px)`;

    const want = { up: false, down: false, left: false, right: false };
    if (dist >= max * 0.3) {               // deadzone
      let a = (Math.atan2(-dy, dx) * 180 / Math.PI + 360) % 360; // 0=right, 90=up
      if (a >= 22.5 && a < 67.5) { want.up = want.right = true; }
      else if (a >= 67.5 && a < 112.5) { want.up = true; }
      else if (a >= 112.5 && a < 157.5) { want.up = want.left = true; }
      else if (a >= 157.5 && a < 202.5) { want.left = true; }
      else if (a >= 202.5 && a < 247.5) { want.down = want.left = true; }
      else if (a >= 247.5 && a < 292.5) { want.down = true; }
      else if (a >= 292.5 && a < 337.5) { want.down = want.right = true; }
      else { want.right = true; }
    }
    Object.keys(ARROWS).forEach((d) => setArrow(d, want[d]));
  };
  const reset = () => { pid = null; knob.style.transform = ""; clearArrows(); };

  base.addEventListener("pointerdown", (e) => {
    e.preventDefault(); pid = e.pointerId;
    try { base.setPointerCapture(pid); } catch (_) {}
    update(e.clientX, e.clientY);
  });
  base.addEventListener("pointermove", (e) => { if (e.pointerId === pid) update(e.clientX, e.clientY); });
  base.addEventListener("pointerup", (e) => { if (e.pointerId === pid) reset(); });
  base.addEventListener("pointercancel", (e) => { if (e.pointerId === pid) reset(); });
}

function setupTouchControls() {
  document.querySelectorAll("#touch-controls [data-keys]").forEach(bindTouchButton);
  setupJoystick();

  // Take over touch for the whole control pad: non-passive preventDefault stops
  // long-press selection/callout, double-tap zoom, and scroll across the pad
  // (incl. the joystick and the gaps between buttons).
  const pad = $("touch-controls");
  if (pad) {
    pad.addEventListener("contextmenu", (e) => e.preventDefault());
    pad.addEventListener("touchstart", (e) => e.preventDefault(), { passive: false });
    pad.addEventListener("touchmove", (e) => e.preventDefault(), { passive: false });
  }
  // Safety net: if a pointer is lost (window blur, etc.), release everything.
  const releaseAll = () => {
    activeByPointer.forEach((keys) => keys.forEach((k) => sendKey(k, false)));
    activeByPointer.clear();
    clearArrows();
    document.querySelectorAll("#touch-controls .active").forEach((b) => b.classList.remove("active"));
  };
  window.addEventListener("blur", releaseAll);
}

// ---- settings UI -----------------------------------------------------------

function setupSettings() {
  [["set-aspect", "aspect"], ["set-rendering", "rendering"], ["set-touch", "touch"]]
    .forEach(([id, key]) => {
      const sel = $(id);
      sel.value = getSetting(key);
      sel.addEventListener("change", () => setSetting(key, sel.value));
    });
}

// ---- server / kiosk mode ---------------------------------------------------

const EPISODE_TITLES = {
  4: "Secret of the Oracle",
  5: "The Armageddon Machine",
  6: "Aliens Ate My Babysitter",
};

// When served from the container with a mounted data dir, an entrypoint writes
// games/manifest.json listing the available episodes. In that case we show only
// those games and hide the bring-your-own-data UI.
async function setupServerMode() {
  let manifest;
  try {
    const res = await fetch("games/manifest.json", { cache: "no-store" });
    if (!res.ok) return;
    manifest = await res.json();
  } catch (_) { return; }
  if (!manifest || !manifest.serverMode || !Array.isArray(manifest.games) || !manifest.games.length) return;

  $("demo-card").hidden = true;
  $("byo-card").hidden = true;

  const list = $("server-games-list");
  list.innerHTML = "";
  manifest.games
    .slice()
    .sort((a, b) => a.episode - b.episode)
    .forEach((g) => {
      const btn = document.createElement("button");
      btn.className = "play-btn";
      const title = g.title || EPISODE_TITLES[g.episode] || "";
      btn.textContent = `▶ Play Keen ${g.episode}${title ? " — " + title : ""}`;
      btn.addEventListener("click", () => launch(g.bundle, "keen" + g.episode));
      list.appendChild(btn);
    });
  $("server-games").hidden = false;
}

// ---- wiring ----------------------------------------------------------------

window.addEventListener("DOMContentLoaded", () => {
  setupSettings();
  setupTouchControls();
  setupServerMode();

  $("play-keen4").addEventListener("click", () => launch("games/keen4.jsdos", "keen4"));
  $("back-btn").addEventListener("click", quit);
  $("play-byo").addEventListener("click", playByo);

  const dz = $("dropzone");
  const input = $("file-input");
  dz.addEventListener("click", () => input.click());
  dz.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") input.click(); });
  input.addEventListener("change", () => { if (input.files.length) handleFiles(input.files); });

  ["dragenter", "dragover"].forEach((ev) =>
    dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add("dragover"); })
  );
  ["dragleave", "drop"].forEach((ev) =>
    dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove("dragover"); })
  );
  dz.addEventListener("drop", (e) => {
    const dt = e.dataTransfer;
    if (dt && dt.files && dt.files.length) handleFiles(dt.files);
  });
});

})();
