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
const launchable = {};      // key -> bundle url (server games + bundled demo) for deep-links
let currentKey = null;      // episode key of the running game (for autosave)
let savedBlobUrl = null;    // object URL of a snapshot we booted from
let saveTimer = null;       // periodic autosave interval

const $ = (id) => document.getElementById(id);

// ---- persistent saves (self-managed) ---------------------------------------
// js-dos autoSave is unreliable here, so we snapshot the emulator filesystem
// (ci.persist(false) → a standalone .jsdos bundle holding the game's saves +
// config) into our own IndexedDB, keyed per episode. We boot from that snapshot
// next time so progress is restored, and the launcher can Download/Upload/Delete
// it (portable across browsers/devices). Same approach as the zeliard build.
const SAVE_DB = "keen-saves";
const SAVE_STORE = "blobs";

function idbOpen() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(SAVE_DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(SAVE_STORE);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function saveGet(key) {
  try { const db = await idbOpen();
    return await new Promise((res) => {
      const t = db.transaction(SAVE_STORE, "readonly").objectStore(SAVE_STORE).get(key);
      t.onsuccess = () => res(t.result || null); t.onerror = () => res(null);
    });
  } catch (_) { return null; }
}
async function savePut(key, blob) {
  try { const db = await idbOpen();
    return await new Promise((res) => {
      const t = db.transaction(SAVE_STORE, "readwrite").objectStore(SAVE_STORE).put(blob, key);
      t.onsuccess = () => res(true); t.onerror = () => res(false);
    });
  } catch (_) { return false; }
}
async function saveDelete(key) {
  try { const db = await idbOpen();
    await new Promise((res) => {
      const t = db.transaction(SAVE_STORE, "readwrite").objectStore(SAVE_STORE).delete(key);
      t.onsuccess = () => res(); t.onerror = () => res();
    });
  } catch (_) {}
}
async function saveListKeys() {
  try { const db = await idbOpen();
    return await new Promise((res) => {
      const t = db.transaction(SAVE_STORE, "readonly").objectStore(SAVE_STORE).getAllKeys();
      t.onsuccess = () => res(t.result || []); t.onerror = () => res([]);
    });
  } catch (_) { return []; }
}

let capturing = false;
// Snapshot the running emulator's filesystem into our IndexedDB under `key`.
async function captureSave(key) {
  if (!gameCi || typeof gameCi.persist !== "function" || capturing || !key) return;
  capturing = true;
  try {
    const u = await gameCi.persist(false);   // full standalone .jsdos bundle
    if (u && u.length) await savePut(key, new Blob([u], { type: "application/octet-stream" }));
  } catch (e) { console.warn("captureSave failed for", key, e); } finally { capturing = false; }
}

// ---- settings (persisted in localStorage) ----------------------------------

const SETTING_DEFAULTS = { aspect: "4/3", rendering: "pixelated", touch: "auto", engine: "dosbox", pogohold: "180", pogodesktop: "off", filter: "off" };
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
async function launch(url, key) {
  $("launcher").hidden = true;
  $("topbar").hidden = true;
  $("footer").hidden = true;
  $("game-stage").hidden = false;
  currentKey = key;

  // Emulator engine: DOSBox (default, lighter) or DOSBox-X (adds real-time
  // save/load states). The xstate class reveals the SAVE/LOAD buttons.
  const engine = getSetting("engine") === "dosboxX" ? "dosboxX" : "dosbox";
  $("game-stage").classList.toggle("xstate", engine === "dosboxX");

  const touch = touchEnabled();
  if (touch) {
    $("game-stage").classList.add("touch");
    $("touch-controls").hidden = false;
    // Size the game pane to the chosen display aspect so the canvas fills it
    // with no black letterbox below (the freed height goes to the controls).
    const AR = { "4/3": "4 / 3", "5/4": "5 / 4", "16/10": "16 / 10", "16/9": "16 / 9",
                 "1/1": "1 / 1", "AsIs": "16 / 10", "Fit": "16 / 10" };
    $("dos").style.aspectRatio = AR[getSetting("aspect")] || "4 / 3";
  }

  // Boot from our saved snapshot for this episode if we have one (restores
  // progress); otherwise boot the supplied bundle.
  let bootUrl = url;
  const saved = await saveGet(key);
  if (saved) { savedBlobUrl = URL.createObjectURL(saved); bootUrl = savedBlobUrl; }

  // Dos() boots DOSBox-WASM into #dos and loads the .jsdos bundle.
  dosCi = Dos($("dos"), {
    url: bootUrl,
    key,
    // Load the emulator engine from our vendored copy (js/jsdos/emulators/) rather
    // than the js-dos CDN, so the app works fully offline (incl. inside the APK).
    pathPrefix: new URL("js/jsdos/emulators/", document.baseURI).href,
    autoStart: true,
    autoSave: false,           // we persist explicitly via captureSave()
    backend: engine,           // "dosbox" (default) or "dosboxX" (save states)
    noCloud: true,             // self-contained: no cloud account prompts
    thinSidebar: touch,        // slim the js-dos sidebar on touch (CSS hides it)
    renderAspect: getSetting("aspect"),
    imageRendering: getSetting("rendering"),
    onEvent: (event, arg) => {
      if (event === "ci-ready") {
        gameCi = arg;          // command interface for touch input + persist()
        try { if (/[?&#]debug/.test(location.href)) window.__keenCi = arg; } catch (_) {}
      }
      if (event === "error") {
        alert("js-dos error:\n\n" + arg +
          "\n\nIf you supplied your own files, double-check they are the right episode's " +
          "AUDIO/EGAGRAPH/GAMEMAPS .CK? files plus the game .EXE.");
      }
    },
  });

  // Apply the chosen visual filter and keep its overlay glued to the canvas.
  startCrtSync();
  renderCrt();

  // Safety-net autosave while playing (covers the game's in-menu saves).
  clearInterval(saveTimer);
  saveTimer = setInterval(() => captureSave(key), 30000);
  // First snapshot a few seconds in, so even a very short BYO session persists
  // the uploaded game data (the 30s timer / quit handlers might not fire in time,
  // e.g. swiping the Android app away doesn't always emit visibilitychange).
  setTimeout(() => captureSave(key), 5000);

  // Give the running game its own URL (#keen<ep>) so the browser Back button /
  // system back gesture quits it — this replaces the old on-screen Quit button.
  if (location.hash !== "#" + key) history.pushState({ playing: key }, "", "#" + key);
}

// Back leaves the game's #hash and fires popstate — snapshot progress, then
// reload to tear the emulator down cleanly and return to the launcher.
window.addEventListener("popstate", async () => {
  if (!dosCi) return;
  clearInterval(saveTimer);
  await captureSave(currentKey);
  location.reload();
});
// Extra safety: snapshot when the tab is hidden/backgrounded (covers closing it).
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden" && dosCi) captureSave(currentKey);
});

// Deep-link: opening the page at #keen<ep> auto-launches that game (server games
// + the bundled demo). We normalize to the base URL first so a launcher entry
// sits behind the game and Back returns to it.
function deepLink() {
  const key = decodeURIComponent((location.hash || "").replace(/^#/, ""));
  history.replaceState(null, "", location.pathname + location.search);
  if (key && launchable[key]) launch(launchable[key], key);
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
    extra = /6C\.EXE$/i.test(exe.name)
      ? `<div class="ok" style="margin-top:.5rem">✓ Using ${exe.name} — boots straight past the Keen 6 copy-protection prompt.</div>`
      : `<div style="margin-top:.5rem">⚠ Keen 6 shows a "Creature Question" copy-protection prompt at startup (the answers are in the game's manual). A pre-patched <code>KEEN6C.EXE</code> boots past it — supply that instead of the stock <code>KEEN6.EXE</code>.</div>`;
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
  // Persist the uploaded game data right away (keyed per episode) so it survives
  // even if the in-game snapshot never gets a chance to capture — e.g. on Android
  // the WebView can be frozen/killed before the autosave or quit handler runs.
  // Later captureSave() calls overwrite this with a full snapshot incl. saves.
  if (pendingKey) savePut(pendingKey, blob);
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
  // Long-hold auto-tap: read live from data-hold-tap / data-hold-ms at release time
  // (the Settings dropdown updates data-hold-ms — "off" | "0" always | "40".."250"),
  // so changes apply without rebinding. Used by POGO — holding for the super pogo+jump
  // and releasing at the apex auto-taps pogo again to retract it ("put it away").
  let timers = [];        // staggered key-downs (cancelled on release)
  let autoTimers = [];    // the post-release auto-tap (cancelled on next press)
  let pressAt = 0;
  let released = true;

  const press = (e) => {
    e.preventDefault();
    // Capture the pointer so this button keeps every move/up event for the
    // whole hold — the OS can't reroute it into a long-press gesture.
    try { btn.setPointerCapture(e.pointerId); } catch (_) {}
    btn.classList.add("active");
    if (e.pointerId != null) activeByPointer.set(e.pointerId, keys);
    timers.forEach(clearTimeout); timers = [];
    autoTimers.forEach(clearTimeout); autoTimers = [];
    pressAt = Date.now();
    released = false;
    keys.forEach((k, i) => {
      if (stagger && i > 0) timers.push(setTimeout(() => sendKey(k, true), stagger * i));
      else sendKey(k, true);
    });
  };
  const release = (e) => {
    if (released) return;   // pointerup + lostpointercapture both fire; run once
    released = true;
    timers.forEach(clearTimeout); timers = [];
    btn.classList.remove("active");
    keys.forEach((k) => sendKey(k, false));
    if (e && e.pointerId != null) activeByPointer.delete(e.pointerId);
    // Long hold → one extra tap of holdTap, just after the keys lift, so the
    // pogo retracts at the apex. A short tap behaves exactly as before. "off"
    // disables it; "0" always retracts on release; otherwise threshold in ms.
    const holdTap = parseInt(btn.dataset.holdTap || "0", 10) || 0;
    const holdMsRaw = btn.dataset.holdMs;
    if (holdTap && holdMsRaw != null && holdMsRaw !== "off" && pressAt
        && (Date.now() - pressAt) >= (parseInt(holdMsRaw, 10) || 0)) {
      autoTimers.push(setTimeout(() => sendKey(holdTap, true), 30));
      autoTimers.push(setTimeout(() => sendKey(holdTap, false), 120));
    }
    pressAt = 0;
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

// On-screen keyboard: a hidden <input> whose focus raises the device soft
// keyboard. We forward typed characters/keys to the emulator (held briefly so
// the emulator polls them). Lets you type save-game names on touch devices.
function setupKeyboard() {
  const btn = $("kbd-btn");
  const proxy = $("kbd-proxy");
  if (!btn || !proxy) return;

  const SHIFT = 340;                 // GLFW left shift
  const SPECIAL = {                  // keys that arrive as keydown (even on Android)
    Enter: 257, Backspace: 259, Tab: 258, Escape: 256,
    ArrowUp: 265, ArrowDown: 264, ArrowLeft: 263, ArrowRight: 262,
  };
  const PUNCT = { "-":45,"=":61,"[":91,"]":93,";":59,"'":39,",":44,".":46,"/":47,"\\":92,"`":96 };

  // press a key, then release it a few frames later so the emulator registers it
  const hold = (code, shift) => {
    if (shift) sendKey(SHIFT, true);
    sendKey(code, true);
    setTimeout(() => { sendKey(code, false); if (shift) sendKey(SHIFT, false); }, 50);
  };
  const typeChar = (ch) => {
    if (ch === " ") return hold(32);
    if (ch === "\n") return hold(257);
    const u = ch.toUpperCase().charCodeAt(0);
    if ((u >= 65 && u <= 90) || (u >= 48 && u <= 57)) return hold(u, ch >= "A" && ch <= "Z");
    if (PUNCT[ch] != null) return hold(PUNCT[ch]);
  };

  const toggle = (e) => {
    e.preventDefault();
    if (document.activeElement === proxy) { proxy.blur(); btn.classList.remove("active"); }
    else { proxy.value = ""; proxy.focus(); btn.classList.add("active"); }
  };
  btn.addEventListener("pointerup", toggle);
  btn.addEventListener("contextmenu", (e) => e.preventDefault());
  proxy.addEventListener("blur", () => btn.classList.remove("active"));

  // Printable characters: soft keyboards fire `beforeinput` (keydown is unreliable
  // on Android — it reports keyCode 229). Keep the field empty after each char.
  proxy.addEventListener("beforeinput", (e) => {
    if (e.inputType === "insertText" && e.data) { for (const ch of e.data) typeChar(ch); }
    e.preventDefault();
    proxy.value = "";
  });
  // Enter / Backspace / arrows / Esc: these do fire keydown. stopPropagation so
  // js-dos's own key handler doesn't also process them (would double the input).
  proxy.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (SPECIAL[e.key] != null) { hold(SPECIAL[e.key]); e.preventDefault(); }
  });
  proxy.addEventListener("keyup", (e) => { e.stopPropagation(); });
  proxy.addEventListener("keypress", (e) => { e.stopPropagation(); });
}

// Emulator save states (DOSBox-X only): js-dos triggers these via a backend event.
function backendTrigger(event) {
  if (gameCi && typeof gameCi.sendBackendEvent === "function") {
    try { gameCi.sendBackendEvent({ type: "wc-trigger-event", event }); } catch (_) {}
  }
}
// Realtime save states behind a 💾 popup (DOSBox-X). Tapping 💾 opens a Save/Load
// popup; tapping either runs the emulator state action (and persists) and closes it.
function setupSaveLoad() {
  const trigger = $("saveload-btn");
  const popup = $("saveload-popup");
  const save = $("savestate-btn");
  const load = $("loadstate-btn");
  if (!trigger || !popup) return;

  const isOpen = () => popup.classList.contains("open");
  const open = () => { popup.hidden = false; popup.classList.add("open"); };
  const close = () => { popup.classList.remove("open"); popup.hidden = true; };

  trigger.addEventListener("pointerup", (e) => { e.preventDefault(); isOpen() ? close() : open(); });
  trigger.addEventListener("contextmenu", (e) => e.preventDefault());
  trigger.addEventListener("touchstart", (e) => e.preventDefault(), { passive: false });

  const act = (btn, fn) => {
    if (!btn) return;
    btn.addEventListener("pointerup", (e) => {
      e.preventDefault(); btn.classList.add("active"); fn();
      setTimeout(() => btn.classList.remove("active"), 200); close();
    });
    btn.addEventListener("contextmenu", (e) => e.preventDefault());
    btn.addEventListener("touchstart", (e) => e.preventDefault(), { passive: false });
  };
  act(save, () => { backendTrigger("hand_savestate"); setTimeout(() => captureSave(currentKey), 700); });
  act(load, () => backendTrigger("hand_loadstate"));

  // Tap outside the popup/trigger to dismiss.
  document.addEventListener("pointerdown", (e) => {
    if (isOpen() && !popup.contains(e.target) && !trigger.contains(e.target)) close();
  }, true);
}

// ---- visual filters (CRT / scanlines) --------------------------------------
// Two render paths, both into a WebGL canvas sized to the game canvas:
//  • OVERLAY (default, zero-cost): a static multiplier drawn once and composited
//    via mix-blend-mode:multiply. Can't move pixels, so scanlines/mask/vignette
//    only. Pitch is locked to the EGA 320x200 grid so lines sit on game rows.
//  • SAMPLE (curved): js-dos frames can't be read directly, but captureStream
//    taps the compositor output — we feed that into a <video>, upload it as a
//    texture every frame and re-render it WARPED (real barrel curvature) with
//    scanlines/mask/vignette baked in. Our opaque canvas then covers the flat
//    original. Costs ~1 frame of display latency + 1 upload+draw per frame, only
//    while a sampling filter is selected; the emulator (worker) is unaffected.
const GAME_W = 320, GAME_H = 200;        // Keen Galaxy EGA resolution
const FILTERS = {
  off:       null,
  scanlines: { type: 1, scan: 0.45, mask: 0,    vig: 0,    css: "" },
  crt:       { type: 3, scan: 0.45, mask: 0.18, vig: 0.45, css: "" },
  curved:    { sample: true, scan: 0.42, mask: 0.16, vig: 0.50, curve: 0.12, css: "" },
  rgb:       { type: 2, scan: 0,    mask: 0.22, vig: 0,    css: "" },
  soft:      { type: 1, scan: 0.30, mask: 0,    vig: 0,    css: "blur(0.6px) saturate(1.06)" },
  amber:     { type: 1, scan: 0.42, mask: 0,    vig: 0.25, css: "grayscale(1) sepia(1) hue-rotate(-18deg) saturate(3.2) brightness(1.05)" },
  green:     { type: 1, scan: 0.42, mask: 0,    vig: 0.25, css: "grayscale(1) sepia(1) hue-rotate(72deg) saturate(2.6) brightness(1.04)" },
};
let crtStop = null;     // resize/poll observer teardown
let crtGL = null;       // { gl, buf, overlay, sample, tex }
let crtRAF = 0;         // sampling render-loop handle
let crtVideo = null, crtStream = null;

const CRT_VS = `attribute vec2 aPos; varying vec2 vUv;
  void main(){ vUv = vec2(aPos.x*0.5+0.5, 1.0-(aPos.y*0.5+0.5)); gl_Position = vec4(aPos,0.0,1.0); }`;
// Overlay: outputs a multiplier (composited via mix-blend-mode:multiply).
const CRT_FS_OVERLAY = `precision highp float; varying vec2 vUv;
  uniform vec2 uGame; uniform int uFilter; uniform float uScan; uniform float uMask; uniform float uVig;
  void main(){
    vec3 m = vec3(1.0); vec2 uv = vUv;
    if (uFilter==1 || uFilter==3){ float s=sin(3.14159265*uv.y*uGame.y); m*=mix(1.0-uScan,1.0,s*s); }
    if (uFilter==2 || uFilter==3){ float ph=mod(floor(uv.x*uGame.x),3.0); vec3 t=vec3(1.0-uMask);
      if(ph<0.5)t.r=1.0; else if(ph<1.5)t.g=1.0; else t.b=1.0; m*=t; }
    if (uVig>0.0){ vec2 p=uv*2.0-1.0; m*=1.0-uVig*dot(p,p)*0.5; }
    gl_FragColor = vec4(m, 1.0);
  }`;
// Sample: warps the captured game texture (real curvature) + bakes in the CRT look.
const CRT_FS_SAMPLE = `precision highp float; varying vec2 vUv;
  uniform sampler2D uTex; uniform vec2 uGame; uniform float uScan; uniform float uMask; uniform float uVig; uniform float uCurve;
  void main(){
    vec2 p = vUv*2.0-1.0;
    p *= 1.0 + uCurve*dot(p,p);                       // barrel warp the SAMPLE coords -> pixels bend
    vec2 uv = p*0.5+0.5;
    if (uv.x<0.0||uv.x>1.0||uv.y<0.0||uv.y>1.0){ gl_FragColor=vec4(0.0,0.0,0.0,1.0); return; }
    vec3 c = texture2D(uTex, uv).rgb;
    float s=sin(3.14159265*uv.y*uGame.y); c*=mix(1.0-uScan,1.0,s*s);
    float ph=mod(floor(uv.x*uGame.x),3.0); vec3 t=vec3(1.0-uMask);
    if(ph<0.5)t.r=1.0; else if(ph<1.5)t.g=1.0; else t.b=1.0; c*=t;
    c*=1.0-uVig*dot(p,p)*0.5;
    gl_FragColor = vec4(c, 1.0);
  }`;

function crtProgram(gl, fs) {
  const mk = (ty, src) => { const sh = gl.createShader(ty); gl.shaderSource(sh, src); gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) { console.warn("CRT shader:", gl.getShaderInfoLog(sh)); return null; } return sh; };
  const v = mk(gl.VERTEX_SHADER, CRT_VS), f = mk(gl.FRAGMENT_SHADER, fs);
  if (!v || !f) return null;
  const prog = gl.createProgram(); gl.attachShader(prog, v); gl.attachShader(prog, f); gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) { console.warn("CRT link:", gl.getProgramInfoLog(prog)); return null; }
  return { prog, loc: gl.getAttribLocation(prog, "aPos"), uni: {
    game: gl.getUniformLocation(prog, "uGame"), filter: gl.getUniformLocation(prog, "uFilter"),
    scan: gl.getUniformLocation(prog, "uScan"), mask: gl.getUniformLocation(prog, "uMask"),
    vig: gl.getUniformLocation(prog, "uVig"), curve: gl.getUniformLocation(prog, "uCurve"),
    tex: gl.getUniformLocation(prog, "uTex"),
  } };
}

function crtInit(canvas) {
  const gl = canvas.getContext("webgl", { premultipliedAlpha: false, antialias: false, preserveDrawingBuffer: true });
  if (!gl) return null;
  const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);
  const overlay = crtProgram(gl, CRT_FS_OVERLAY), sample = crtProgram(gl, CRT_FS_SAMPLE);
  if (!overlay || !sample) return null;
  const tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  // No UNPACK_FLIP_Y: the vertex shader already flips Y (vUv.y=0 at top), so an
  // unflipped texture upload maps screen-top -> game-top correctly.
  return { gl, buf, overlay, sample, tex };
}

function crtBind(p) {
  const gl = crtGL.gl;
  gl.useProgram(p.prog);
  gl.bindBuffer(gl.ARRAY_BUFFER, crtGL.buf);
  gl.enableVertexAttribArray(p.loc);
  gl.vertexAttribPointer(p.loc, 2, gl.FLOAT, false, 0, 0);
}

// Match the overlay canvas to the game canvas (CSS box + backing at full DPR).
function crtSize(cv, game) {
  const r = game.getBoundingClientRect();
  if (!r.width || !r.height) return null;
  cv.style.left = r.left + "px"; cv.style.top = r.top + "px";
  cv.style.width = r.width + "px"; cv.style.height = r.height + "px";
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }   // resize keeps the GL context/resources
  return { w, h };
}

function crtStopSample() {
  if (crtRAF) { cancelAnimationFrame(crtRAF); crtRAF = 0; }
  if (crtStream) { try { crtStream.getTracks().forEach((t) => t.stop()); } catch (_) {} crtStream = null; }
  if (crtVideo) { try { crtVideo.pause(); crtVideo.srcObject = null; } catch (_) {} crtVideo = null; }
}

function renderCrt() {
  const cv = $("crt-canvas");
  const game = document.querySelector("#dos canvas");
  if (!cv || !game) return;
  const def = FILTERS[getSetting("filter")];
  if (def && def.sample && crtRAF) return;     // sample loop already running & self-sizing
  crtStopSample();
  // Colour-shift / blur ride on the game canvas's own CSS filter.
  game.style.filter = (def && def.css) || "";
  cv.style.mixBlendMode = (def && def.sample) ? "normal" : "multiply";
  if (!def) { cv.classList.remove("on"); return; }
  const size = crtSize(cv, game);
  if (!size) return;
  if (!crtGL) crtGL = crtInit(cv);
  if (!crtGL) { cv.classList.remove("on"); return; }
  const { gl } = crtGL;

  if (def.sample) { cv.classList.add("on"); startCrtSampleLoop(cv, game, def); return; }
  if (!def.type) { cv.classList.remove("on"); return; }   // CSS-only filter, no overlay

  crtBind(crtGL.overlay);
  const u = crtGL.overlay.uni;
  gl.viewport(0, 0, size.w, size.h);
  gl.uniform2f(u.game, GAME_W, GAME_H);
  gl.uniform1i(u.filter, def.type);
  gl.uniform1f(u.scan, def.scan);
  gl.uniform1f(u.mask, def.mask);
  gl.uniform1f(u.vig, def.vig);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  cv.classList.add("on");
}

// Capture the game and re-render it warped, every frame, into our (opaque) canvas
// which covers the flat original. Only used by sampling filters (curved).
function startCrtSampleLoop(cv, game, def) {
  const gl = crtGL.gl;
  try {
    crtStream = game.captureStream();
    crtVideo = document.createElement("video");
    crtVideo.muted = true; crtVideo.playsInline = true; crtVideo.srcObject = crtStream;
    crtVideo.play().catch(() => {});
  } catch (e) {
    console.warn("CRT capture failed:", e);
    cv.classList.remove("on"); cv.style.mixBlendMode = "multiply"; return;
  }
  const u = crtGL.sample.uni;
  const draw = () => {
    crtRAF = requestAnimationFrame(draw);
    if (!crtVideo || crtVideo.readyState < 2) return;
    const s = crtSize(cv, game); if (!s) return;
    crtBind(crtGL.sample);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, crtGL.tex);
    try { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, crtVideo); } catch (_) { return; }
    gl.viewport(0, 0, s.w, s.h);
    gl.uniform1i(u.tex, 0);
    gl.uniform2f(u.game, GAME_W, GAME_H);
    gl.uniform1f(u.scan, def.scan);
    gl.uniform1f(u.mask, def.mask);
    gl.uniform1f(u.vig, def.vig);
    gl.uniform1f(u.curve, def.curve);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  };
  draw();
}

// Keep the overlay aligned as the canvas mounts (async) / resizes / fullscreens.
function startCrtSync() {
  if (crtStop) return;
  const dos = $("dos");
  const ro = (typeof ResizeObserver !== "undefined") ? new ResizeObserver(renderCrt) : null;
  if (ro && dos) ro.observe(dos);
  const onResize = () => renderCrt();
  window.addEventListener("resize", onResize);
  document.addEventListener("fullscreenchange", onResize);
  let tries = 0;
  const poll = setInterval(() => {
    const c = document.querySelector("#dos canvas");
    if (c) { if (ro) ro.observe(c); renderCrt(); }
    if (c || ++tries > 25) clearInterval(poll);
  }, 200);
  crtStop = () => {
    if (ro) ro.disconnect();
    window.removeEventListener("resize", onResize);
    document.removeEventListener("fullscreenchange", onResize);
    clearInterval(poll);
  };
}

function setupTouchControls() {
  document.querySelectorAll("#touch-controls [data-keys]").forEach(bindTouchButton);
  setupJoystick();
  setupKeyboard();
  setupSaveLoad();

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

// ---- launcher: saved-game download / upload / delete -----------------------

const VALID_EPISODES = [4, 5, 6];
const epOfKey = (k) => (String(k).match(/^keen([1-9])$/) || [])[1];

async function refreshSavesUI() {
  const list = $("saves-list");
  if (!list) return;
  const card = $("saves-card");
  const keys = (await saveListKeys()).filter((k) => /^keen[1-9]$/.test(k)).sort();
  if (!keys.length) {
    // Nothing saved yet: hide the whole card so the launcher leads with the demo /
    // import options. It reappears at the top once a game is played or imported.
    if (card) card.hidden = true;
    list.innerHTML = "";
    return;
  }
  if (card) card.hidden = false;
  // Persisted episodes (played or uploaded) are surfaced as prominent "Play" game
  // buttons — the same presentation as detected server games — so an uploaded game
  // is a first-class, click-to-play option that survives reloads (no re-upload).
  const rows = await Promise.all(keys.map(async (k) => {
    const ep = epOfKey(k);
    const title = EPISODE_TITLES[ep] || "";
    const b = await saveGet(k);
    const kb = b ? Math.round(b.size / 1024) : 0;
    return `<div class="save-row game">` +
      `<button class="play-btn" data-play="${k}">▶ Play Keen ${ep}${title ? " — " + title : ""}</button>` +
      `<div class="save-meta"><small>Saved in this browser · ${kb}&nbsp;KB</small>` +
      `<span class="save-row-btns">` +
      `<button class="save-btn" data-dl="${k}">⤓ Download</button>` +
      `<button class="save-btn danger" data-del="${k}" aria-label="Delete">🗑</button>` +
      `</span></div></div>`;
  }));
  list.innerHTML = rows.join("");
  list.querySelectorAll("[data-play]").forEach((b) => b.addEventListener("click", () => playSave(b.getAttribute("data-play"))));
  list.querySelectorAll("[data-dl]").forEach((b) => b.addEventListener("click", () => downloadSave(b.getAttribute("data-dl"))));
  list.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", () => deleteSaveUI(b.getAttribute("data-del"))));
}

// Resume a stored game straight from its IndexedDB snapshot — no re-upload of the
// data files needed (the snapshot is a full standalone bundle: game data + saves).
// launch() boots from the snapshot for this key, so the passed URL is a placeholder.
async function playSave(key) {
  const blob = await saveGet(key);
  if (!blob) return;
  launch(URL.createObjectURL(blob), key);
}

async function downloadSave(key) {
  const blob = await saveGet(key);
  if (!blob) return;
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = key + "-save.jsdos";   // a .jsdos is a zip of the save/game files
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

async function deleteSaveUI(key) {
  if (!confirm(`Delete the saved game for Keen ${epOfKey(key)} in this browser? This cannot be undone.`)) return;
  await saveDelete(key);
  await refreshSavesUI();
}

// Import a downloaded save. Detect the episode from the filename, else by
// sniffing a .CKx file inside the .jsdos (zip) bundle.
async function importSave(file) {
  if (!file) return;
  const buf = new Uint8Array(await file.arrayBuffer());
  let ep = (file.name.match(/keen[ _-]?([1-9])/i) || [])[1];
  if (!ep) {
    try {
      for (const n of Object.keys(fflate.unzipSync(buf))) {
        const m = n.match(/\.CK([1-9])$/i); if (m) { ep = m[1]; break; }
      }
    } catch (_) {}
  }
  ep = parseInt(ep, 10);
  if (!VALID_EPISODES.includes(ep)) {
    alert("Couldn't tell which episode this save is for — expected a Keen " + VALID_EPISODES.join("/") + " save.");
    return;
  }
  await savePut("keen" + ep, new Blob([buf], { type: "application/octet-stream" }));
  await refreshSavesUI();
  alert("Save imported for Keen " + ep + ". It loads next time you play that episode.");
}

// ---- settings UI -----------------------------------------------------------

// Push the pogo-hold setting onto the POGO button so bindTouchButton reads it live.
function applyPogoHold() {
  const btn = document.querySelector("#touch-controls .abtn.pogo");
  if (btn) btn.dataset.holdMs = getSetting("pogohold");
}

// Desktop POGO on the physical Alt key — mirrors the on-screen POGO button when
// the "also apply to desktop controls" checkbox is on. The native Alt already
// gives the game Pogo (342), so we (a) inject Jump (Ctrl 341) staggered ~30ms
// after, so Alt does the Pogo+Jump super-bounce like mobile, and (b) on release
// past the pogohold threshold inject one extra Alt tap to auto-retract the pogo.
// Observed in the capture phase so js-dos still receives the native Alt; reuses
// the same pogohold ms. Off => plain native Alt (pogo only), unchanged.
const JUMP_KEY = 341;        // GLFW left Ctrl = Jump
function setupDesktopPogo() {
  const st = {};   // "AltLeft" | "AltRight" -> { t0, jumpTimer, jumpDown }
  const code = (e) => (e.code === "AltLeft" ? 342 : e.code === "AltRight" ? 346 : 0);
  window.addEventListener("keydown", (e) => {
    if (!code(e) || e.repeat) return;
    if (!gameCi || getSetting("pogodesktop") !== "on") return;
    const s = st[e.code] || (st[e.code] = {});
    s.t0 = Date.now(); s.jumpDown = false;
    clearTimeout(s.jumpTimer);
    s.jumpTimer = setTimeout(() => { s.jumpDown = true; sendKey(JUMP_KEY, true); }, 30);
  }, true);
  window.addEventListener("keyup", (e) => {
    const gc = code(e); if (!gc) return;
    const s = st[e.code]; if (!s) return;
    const t0 = s.t0; s.t0 = 0;
    clearTimeout(s.jumpTimer);
    if (s.jumpDown) { sendKey(JUMP_KEY, false); s.jumpDown = false; }   // release Jump with Alt
    if (!gameCi || getSetting("pogodesktop") !== "on") return;
    const ms = getSetting("pogohold");
    if (ms === "off" || !t0 || (Date.now() - t0) < (parseInt(ms, 10) || 0)) return;
    setTimeout(() => sendKey(gc, true), 30);    // extra Alt tap -> retract pogo
    setTimeout(() => sendKey(gc, false), 120);
  }, true);
}

function setupSettings() {
  // Low thresholds (0/40/80) were removed — a tap shorter than the threshold is
  // the only escape from a stuck-ON pogo, and human taps rarely beat ~80ms, so
  // those left no reliable escape. 130 is the floor. Migrate dropped values.
  if (["0", "40", "80"].includes(getSetting("pogohold"))) setSetting("pogohold", "180");
  [["set-aspect", "aspect"], ["set-rendering", "rendering"], ["set-touch", "touch"],
   ["set-engine", "engine"], ["set-pogohold", "pogohold"], ["set-filter", "filter"]]
    .forEach(([id, key]) => {
      const sel = $(id);
      if (!sel) return;
      sel.value = getSetting(key);
      sel.addEventListener("change", () => {
        setSetting(key, sel.value);
        if (key === "pogohold") applyPogoHold();
        if (key === "filter") renderCrt();   // re-draw immediately if a game is running
      });
    });
  const dp = $("set-pogodesktop");
  if (dp) {
    dp.checked = getSetting("pogodesktop") === "on";
    dp.addEventListener("change", () => setSetting("pogodesktop", dp.checked ? "on" : "off"));
  }
  applyPogoHold();
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
      launchable["keen" + g.episode] = g.bundle;   // enable deep-link / back routing
      btn.addEventListener("click", () => launch(g.bundle, "keen" + g.episode));
      list.appendChild(btn);
    });
  $("server-games").hidden = false;
}

// ---- wiring ----------------------------------------------------------------

window.addEventListener("DOMContentLoaded", () => {
  // Ask the browser/Android WebView to keep our IndexedDB (saved games + uploaded
  // BYO game data) durable so it isn't evicted under storage pressure.
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (_) {}
  // On Android (Capacitor) the app being backgrounded is the most reliable moment
  // to snapshot — visibilitychange isn't always delivered before the WebView freezes.
  try {
    const App = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App;
    if (App && App.addListener) App.addListener("pause", () => captureSave(currentKey));
  } catch (_) {}
  setupSettings();
  setupDesktopPogo();
  setupTouchControls();
  launchable["keen4"] = "games/keen4.jsdos";   // bundled demo (overridden by server manifest if present)
  setupServerMode().then(deepLink);            // deep-link after the manifest (if any) has loaded

  refreshSavesUI();
  $("save-upload").addEventListener("click", () => $("save-file-input").click());
  $("save-file-input").addEventListener("change", (e) => {
    const f = e.target.files[0]; e.target.value = ""; importSave(f);
  });

  $("play-keen4").addEventListener("click", () => launch("games/keen4.jsdos", "keen4"));
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
