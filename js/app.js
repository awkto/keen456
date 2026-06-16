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

const SETTING_DEFAULTS = { aspect: "AsIs", rendering: "pixelated", touch: "auto" };
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

  if (touchEnabled()) {
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

  const press = (e) => {
    e.preventDefault();
    btn.classList.add("active");
    keys.forEach((k) => sendKey(k, true));
    if (e.pointerId != null) activeByPointer.set(e.pointerId, keys);
  };
  const release = (e) => {
    btn.classList.remove("active");
    keys.forEach((k) => sendKey(k, false));
    if (e && e.pointerId != null) activeByPointer.delete(e.pointerId);
  };

  btn.addEventListener("pointerdown", press);
  btn.addEventListener("pointerup", release);
  btn.addEventListener("pointercancel", release);
  btn.addEventListener("pointerleave", release);
  btn.addEventListener("contextmenu", (e) => e.preventDefault());
}

function setupTouchControls() {
  document.querySelectorAll("#touch-controls [data-keys]").forEach(bindTouchButton);
  // Safety net: if a pointer is lost (window blur, etc.), release everything.
  const releaseAll = () => {
    activeByPointer.forEach((keys) => keys.forEach((k) => sendKey(k, false)));
    activeByPointer.clear();
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

// ---- wiring ----------------------------------------------------------------

window.addEventListener("DOMContentLoaded", () => {
  setupSettings();
  setupTouchControls();

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
