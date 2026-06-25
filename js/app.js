/*
 * Commander Keen 4/5/6 launcher (js-dos baseline) — multi-game "Console" UI +
 * per-game sync v2.
 *
 * - Keen 4 shareware ships as a prebuilt bundle (games/keen4.jsdos).
 * - Keen 5/6 (and full Keen 4): the user supplies their own data files, which we
 *   assemble into a .jsdos bundle entirely in the browser (nothing is uploaded).
 *
 * Saves are PER GAME (keen4/keen5/keen6), in IndexedDB. The redesign makes each
 * game first-class: a game-selector bar switches the Play surface, and each game
 * has its OWN server sync key, on/off toggle, device list and first-sync conflict
 * modal. Settings + How-to-play are global.
 *
 * Per-game sync data model (the core change from v1.x):
 *   localStorage["keen.syncId." + g]        — that game's own 4-char key
 *   localStorage["keen.sync."   + g]         — that game's on/off (default off)
 *   localStorage["keen.save.modified." + g]  — local dirty stamp
 *   localStorage["keen.save.synced."   + g]  — last push/pull stamp
 * Server calls for game g use that game's key as X-Client-Id and slot "auto"
 * (one slot per key, since the key is per game). saves-api.py is unchanged.
 *
 * Wrapped in an IIFE: js-dos.js declares globals (incl. `var $`), so we keep our
 * own top-level names out of global scope.
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
let currentKey = null;      // game key of the running game (for autosave)
let savedBlobUrl = null;    // object URL of a snapshot we booted from
let saveTimer = null;       // periodic autosave interval

const $ = (id) => document.getElementById(id);

// ---- per-game model --------------------------------------------------------
const GAMES = ["keen4", "keen5", "keen6"];
const GAME_NUM = { keen4: 4, keen5: 5, keen6: 6 };
const GAME_TITLES = {
  keen4: "Secret of the Oracle",
  keen5: "The Armageddon Machine",
  keen6: "Aliens Ate My Babysitter!",
};
// Per-game presentation (poster glow, hero subline, blurb, accent). Keen 4/5 are
// "Goodbye, Galaxy!"; Keen 6 is "Aliens Ate My Babysitter!".
const GAME_META = {
  keen4: { accent: "#57b6e8", heroSub: "GOODBYE, GALAXY!",
    poster: "radial-gradient(ellipse at 50% 40%, #20407a, #0c0a22 74%)",
    files: "Free", free: true,
    blurb: "Commander Keen 4 — the free shareware episode — running 100% in your browser.", link: "" },
  keen5: { accent: "#f07a7a", heroSub: "GOODBYE, GALAXY!",
    poster: "radial-gradient(ellipse at 50% 40%, #6a223a, #0c0a22 74%)",
    files: "Your files", free: false,
    blurb: "Commander Keen 5 — running from your supplied game files, 100% in your browser.", link: "load your files →" },
  keen6: { accent: "#6ee0a0", heroSub: "ALIENS ATE MY BABYSITTER!",
    poster: "radial-gradient(ellipse at 50% 40%, #226a4a, #0c0a22 74%)",
    files: "Your files", free: false,
    blurb: "Commander Keen 6 — supply your own game files to play, 100% in your browser.", link: "load your files →" },
};
// Episode-title map (legacy name kept for parity with v1.x importer/help text).
const VALID_EPISODES = [4, 5, 6];
const EPISODE_TITLES = { 4: GAME_TITLES.keen4, 5: GAME_TITLES.keen5, 6: GAME_TITLES.keen6 };
const epOfKey = (k) => GAME_NUM[k];
const keyOfEp = (ep) => "keen" + ep;
const isGame = (g) => GAMES.includes(g);

// Current launcher state.
let view = "play";          // play | howto | settings
let game = "keen4";         // selected game
let mView = "play";         // mobile bottom-tab view: play|saves|sync|howto|settings

// ---- persistent saves (self-managed) ---------------------------------------
// js-dos autoSave is unreliable here, so we snapshot the emulator filesystem
// (ci.persist(false) → a standalone .jsdos bundle holding the game's saves +
// config) into our own IndexedDB, keyed per game. We boot from that snapshot
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

let capturing = false;
// Per-game change-detector baselines: lastFsSig[key] is the filesystem
// signature of the last snapshot we wrote/booted, so captureSave only bumps
// `modified` (and uploads) when the game actually wrote something new.
const lastFsSig = {};

// Snapshot the running emulator's filesystem into IndexedDB under `key`. Returns
// {changed}: true only when the game actually wrote something since the last
// snapshot, so callers can upload on real changes only.
async function captureSave(key) {
  if (!gameCi || typeof gameCi.persist !== "function" || capturing || !key) return { changed: false };
  capturing = true;
  try {
    const u = await gameCi.persist(false);   // full standalone .jsdos bundle (cumulative-safe)
    if (!u || !u.length) return { changed: false };
    const sig = fsSignature(u);
    if (sig === lastFsSig[key]) return { changed: false };   // nothing new written to disk
    await savePut(key, new Blob([u], { type: "application/octet-stream" }));
    setLocalModified(key, Date.now());
    lastFsSig[key] = sig;
    return { changed: true };
  } catch (e) { console.warn("captureSave failed for", key, e); return { changed: false }; }
  finally { capturing = false; }
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
// (stable per game, even when BYO bundles get fresh blob: URLs each time).
async function launch(url, key) {
  $("launcher").hidden = true;
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

  // Boot from our saved snapshot for this game if we have one (restores
  // progress); otherwise boot the supplied bundle. Baseline the change-detector
  // to the booted state so the first capture isn't a false "changed".
  let bootUrl = url;
  const saved = await saveGet(key);
  if (saved) {
    savedBlobUrl = URL.createObjectURL(saved); bootUrl = savedBlobUrl;
    try { lastFsSig[key] = fsSignature(new Uint8Array(await saved.arrayBuffer())); } catch (_) { delete lastFsSig[key]; }
  } else { delete lastFsSig[key]; }

  $("dos").innerHTML = "";   // clear any residue from a previous session
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

  // First snapshot a few seconds in, so even a very short BYO session persists
  // the uploaded game data (the timer / quit handlers might not fire in time,
  // e.g. swiping the Android app away doesn't always emit visibilitychange).
  setTimeout(() => captureSave(key), 5000);
  // Light background net (60s): persist + upload ONLY when the game actually
  // wrote a save — covers the game's own in-menu saves without churning the
  // cloud or hitching gameplay. Realtime quicksaves and exit push immediately.
  clearInterval(saveTimer);
  saveTimer = setInterval(async () => {
    const r = await captureSave(key);
    if (r.changed) pushSave(key);
  }, 60000);

  // Give the running game its own URL (#keen<ep>) so the browser Back button /
  // system back gesture quits it — this replaces the old on-screen Quit button.
  if (location.hash !== "#" + key) history.pushState({ playing: key }, "", "#" + key);
}

// Back leaves the game's #hash and fires popstate — snapshot progress, push it,
// then reload to tear the emulator down cleanly and return to the launcher.
window.addEventListener("popstate", async () => {
  if (!dosCi) return;
  clearInterval(saveTimer); saveTimer = null;
  const cap = await captureSave(currentKey);
  if (cap.changed || localModified(currentKey) > lastSynced(currentKey)) await pushSave(currentKey);
  location.reload();
});
// Extra safety: snapshot when the tab is hidden/backgrounded (covers closing it).
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden" && dosCi) {
    captureSave(currentKey).then((r) => { if (r.changed || localModified(currentKey) > lastSynced(currentKey)) pushSave(currentKey); });
  }
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
  // Persist the uploaded game data right away (keyed per game) so it survives
  // even if the in-game snapshot never gets a chance to capture — e.g. on Android
  // the WebView can be frozen/killed before the autosave or quit handler runs.
  // Later captureSave() calls overwrite this with a full snapshot incl. saves.
  if (pendingKey) { savePut(pendingKey, blob); setLocalModified(pendingKey, Date.now()); pushSave(pendingKey); }
  if ($("byo-modal")) $("byo-modal").hidden = true;
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
  // Quicksave: trigger the state, then capture + push immediately (don't wait for
  // the 60s net) so closing right after a quicksave still reaches the cloud.
  act(save, () => { backendTrigger("hand_savestate"); setTimeout(async () => { await captureSave(currentKey); await pushSave(currentKey); }, 700); });
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
  const gameCanvas = document.querySelector("#dos canvas");
  if (!cv || !gameCanvas) return;
  // Soft/crisp pixels ride here too (live), so it combines with any overlay and
  // updates without relaunching — on mobile the filter dropdown drives it.
  gameCanvas.style.imageRendering = getSetting("rendering");
  const def = FILTERS[getSetting("filter")];
  if (def && def.sample && crtRAF) return;     // sample loop already running & self-sizing
  crtStopSample();
  // Colour-shift / blur ride on the game canvas's own CSS filter.
  gameCanvas.style.filter = (def && def.css) || "";
  cv.style.mixBlendMode = (def && def.sample) ? "normal" : "multiply";
  if (!def) { cv.classList.remove("on"); return; }
  const size = crtSize(cv, gameCanvas);
  if (!size) return;
  if (!crtGL) crtGL = crtInit(cv);
  if (!crtGL) { cv.classList.remove("on"); return; }
  const { gl } = crtGL;

  if (def.sample) { cv.classList.add("on"); startCrtSampleLoop(cv, gameCanvas, def); return; }
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
function startCrtSampleLoop(cv, gameCanvas, def) {
  const gl = crtGL.gl;
  try {
    crtStream = gameCanvas.captureStream();
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
    const s = crtSize(cv, gameCanvas); if (!s) return;
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

// ============================================================================
// server-side save sync (container deployments) — v2, PER GAME
// ============================================================================
// Optional: when the site is served by the container (not a static host such as
// GitHub Pages), a tiny API (docker/saves-api.py) keeps the save bundles on the
// server. Each GAME has its own sync key (X-Client-Id); its single slot is
// "auto". Presence is detected by probing /api/health; the whole feature stays
// hidden when that 404s. Every sync op below takes a game id and touches ONLY
// that game — the other two are untouched.
let serverMode = false;
let serverManifestActive = false;   // a kiosk/server manifest replaced the play surface
const AUTO_SLOT = "auto";           // one slot per (per-game) key
// Sync target. Same-origin by default (web container). A build can point it at a
// remote server by setting window.KEEN_SYNC_BASE (the APK does this via
// js/sync-config.js, so the packaged app can still reach a real server).
const SYNC_RAW = (window.KEEN_SYNC_BASE || "").trim();
const SYNC_BASE = SYNC_RAW ? SYNC_RAW.replace(/\/+$/, "") + "/" : "";
const apiUrl = (p) => new URL("api/" + p, SYNC_BASE || document.baseURI).href;

// A short, easy-to-type key (4 chars) that scopes ONE game's saves on the server.
// Copy it to another device — or type one in here — to share that game's save.
// (Legacy longer 16-char keys still validate.)
function makeSyncId() {
  const A = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";  // no I/O/0/1 — avoid confusion
  const r = new Uint8Array(4);
  (window.crypto || crypto).getRandomValues(r);
  let s = "";
  for (let i = 0; i < 4; i++) s += A[r[i] % A.length];
  return s;   // e.g. K7QF
}
// Per-game key: auto-generated on demand, stored under keen.syncId.<g>.
function getSyncId(g) {
  let id = localStorage.getItem("keen.syncId." + g);
  if (!id) { id = makeSyncId(); localStorage.setItem("keen.syncId." + g, id); }
  return id;
}
function normalizeSyncId(v) {
  const clean = (v || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (clean.length < 4 || clean.length > 32) return null;   // also accepts legacy 16-char keys
  return clean.length > 4 ? clean.replace(/(.{4})(?=.)/g, "$1-") : clean;
}
function setSyncId(g, v) {
  const id = normalizeSyncId(v);
  if (id) localStorage.setItem("keen.syncId." + g, id);
  return id;
}

// Opt-in PER GAME: sync is OFF until the user enables it for that game, so
// installing/launching never auto-touches an existing save.
const syncEnabled = (g) => localStorage.getItem("keen.sync." + g) === "on";
const setSyncEnabled = (g, on) => localStorage.setItem("keen.sync." + g, on ? "on" : "off");

// Two client-clock (epoch-ms) stamps per game give a real 3-way state so we
// never silently clobber: `modified` bumps whenever the local save changes;
// `synced` records the value at the last successful push/pull. Versus the
// server's stamp, per game:
//   local dirty  = modified > synced       server ahead = server.modified > synced
//   both true    = diverged (must ask)     neither      = in sync
const localModified = (key) => parseInt(localStorage.getItem("keen.save.modified." + key) || "0", 10) || 0;
const setLocalModified = (key, ms) => localStorage.setItem("keen.save.modified." + key, String(ms || Date.now()));
const lastSynced = (key) => parseInt(localStorage.getItem("keen.save.synced." + key) || "0", 10) || 0;
function markSynced(key, ms) {   // local now equals server for this game: clean
  localStorage.setItem("keen.save.modified." + key, String(ms));
  localStorage.setItem("keen.save.synced." + key, String(ms));
}

// A stable signature of the emulator filesystem CONTENTS (not the zip wrapper,
// which isn't byte-stable across re-saves). Unzips the persist bundle and samples
// each file's bytes, so it changes only when the game actually writes a save —
// letting the background net bump `modified`/upload on real changes only.
function fsSignature(zipU8) {
  try {
    const files = fflate.unzipSync(zipU8);
    let h = 2166136261 >>> 0;
    for (const name of Object.keys(files).sort()) {
      for (let i = 0; i < name.length; i++) h = Math.imul(h ^ name.charCodeAt(i), 16777619);
      const b = files[name]; h = Math.imul(h ^ b.length, 16777619);
      const step = Math.max(1, (b.length / 1024) | 0);
      for (let i = 0; i < b.length; i += step) h = Math.imul(h ^ b[i], 16777619);
    }
    return (h >>> 0).toString(36);
  } catch (_) { return "z" + zipU8.length; }
}

async function detectServerMode() {
  try { const r = await fetch(apiUrl("health"), { cache: "no-store" }); serverMode = r.ok; }
  catch (_) { serverMode = false; }
  return serverMode;
}

const fmtKB = (n) => Math.round(n / 1024) + " KB";

// The server meta for ONE game's key (slot "auto"): { modified, size } or null.
async function fetchRemote(g) {
  try {
    const r = await fetch(apiUrl("saves"), { headers: { "X-Client-Id": getSyncId(g) }, cache: "no-store" });
    if (!r.ok) return null;
    for (const s of await r.json()) if (s.slot === AUTO_SLOT) return s;
    return null;
  } catch (_) { return null; }
}

// Classify one game local vs server: empty / local-only / server-only /
// in-sync / local-dirty / server-new / diverged.
function classify(g, remote, blob) {
  const haveLocal = !!(blob && blob.size);
  const base = lastSynced(g);
  const localDirty = haveLocal && localModified(g) > base;
  const serverNew = !!remote && remote.modified > base;
  if (!remote && !haveLocal) return "empty";
  if (!remote) return "local-only";
  if (!haveLocal) return "server-only";
  if (localDirty && serverNew) return "diverged";
  if (serverNew) return "server-new";
  if (localDirty) return "local-dirty";
  return "in-sync";
}

// Per-game sync state (drives the chip, the status line, and the Play guard).
async function syncState(g) {
  if (!serverMode) return { state: "no-server" };
  if (!syncEnabled(g)) return { state: "off" };
  const remote = await fetchRemote(g);
  const blob = await saveGet(g);
  return { state: classify(g, remote, blob), remote, haveLocal: !!(blob && blob.size),
           size: (remote && remote.size) || (blob && blob.size) || 0 };
}

// Upload one game's local save (to that game's key, slot "auto"); marks it
// synced. Returns true on success.
async function pushSave(g) {
  if (!serverMode || !syncEnabled(g) || !g) return false;
  const blob = await saveGet(g);
  if (!blob || !blob.size) return false;
  const modified = localModified(g) || Date.now();
  try {
    const r = await fetch(apiUrl("saves/" + AUTO_SLOT), {
      method: "PUT",
      headers: { "X-Client-Id": getSyncId(g), "X-Save-Modified": String(modified) },
      body: blob,
    });
    if (r.ok) { markSynced(g, modified); return true; }
  } catch (_) {}
  return false;
}

// Download one game's server save into this browser; marks it synced. Returns bytes.
async function pullFromServer(g, modified) {
  try {
    const r = await fetch(apiUrl("saves/" + AUTO_SLOT), { headers: { "X-Client-Id": getSyncId(g) }, cache: "no-store" });
    if (!r.ok) return 0;
    const buf = new Uint8Array(await r.arrayBuffer());
    if (!buf.length) return 0;
    await savePut(g, new Blob([buf], { type: "application/octet-stream" }));
    markSynced(g, modified || Date.now());
    lastFsSig[g] = fsSignature(buf);   // baseline = the just-pulled content
    return buf.length;
  } catch (_) { return 0; }
}

// On launch, auto-download newer server saves — but ONLY for games where it's
// safe (sync on, and this device has no unsynced changes of its own). Divergence
// is left for the Play prompt so nothing is silently overwritten.
async function autoSyncOnStart() {
  if (!serverMode) return;
  for (const g of GAMES) {
    if (!syncEnabled(g)) continue;
    const remote = await fetchRemote(g);
    const blob = await saveGet(g);
    const st = classify(g, remote, blob);
    if ((st === "server-new" || st === "server-only") && remote) await pullFromServer(g, remote.modified);
  }
  await refreshAll();
}

function flashBtn(btn, text) {
  if (!btn) return;
  const orig = btn.textContent; btn.textContent = text;
  setTimeout(() => { btn.textContent = orig; }, 1200);
}

// A short phrase describing the selected game's sync state (sync card status line).
function syncStateText(g, st, size) {
  switch (st) {
    case "in-sync":     return size ? "✓ Backed up to this server — " + fmtKB(size) + "." : "✓ In sync with the server.";
    case "local-dirty": return "⬆ This device has changes not yet uploaded — they upload as you play and on exit.";
    case "server-new":  return "⬇ The server has a newer save — it downloads when you start (or on Play).";
    case "diverged":    return "⚠ This device and the server have both changed — you'll choose which to keep on Play.";
    case "empty":       return "Sync on — no save yet; it uploads after you play.";
    default:            return "Server sync is off for this game.";
  }
}

// ============================================================================
// launcher UI (per game)
// ============================================================================

function setGameAccent() {
  const c = $("console");
  if (c) c.style.setProperty("--game-accent", GAME_META[game].accent);
}

// Have a (local OR launchable) game for this game id?
async function hasPlayable(g) {
  if (launchable[g]) return true;
  const b = await saveGet(g);
  return !!(b && b.size);
}

// Repaint the whole launcher for the current `game` selection + sync state.
async function refreshAll() {
  await refreshGameTabs();
  await refreshPlayView();
  await refreshSavedCard();
  await refreshSyncCard();
  refreshMobilePill();
}

// Game-selector tabs: status chip (Synced / Local only) + active accent.
async function refreshGameTabs() {
  document.querySelectorAll(".game-tab").forEach((tab) => {
    const g = tab.dataset.game;
    const active = (view === "play" && g === game);
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-pressed", active ? "true" : "false");
    tab.style.setProperty("--game-accent", GAME_META[g].accent);
    const on = serverMode && syncEnabled(g);
    tab.classList.toggle("synced", on);
    const txt = tab.querySelector(".gt-status-text");
    if (txt) txt.textContent = on ? "Synced" : "Local only";
  });
  document.querySelectorAll(".m-tab").forEach((t) =>
    t.classList.toggle("active", t.dataset.game === game));
}

async function refreshPlayView() {
  const meta = GAME_META[game];
  setGameAccent();
  $("poster-bg").style.background = meta.poster;
  $("poster-sub").textContent = meta.heroSub;
  $("hero-poster").setAttribute("aria-label", "Play Commander Keen " + GAME_NUM[game]);
  $("hero-blurb-text").textContent = meta.blurb + " ";
  const link = $("hero-link");
  if (meta.link) { link.hidden = false; link.textContent = meta.link; }
  else { link.hidden = true; }
  $("play-main").textContent = "▶ Play Keen " + GAME_NUM[game] + " — " + GAME_TITLES[game];
}

async function refreshSavedCard() {
  const b = await saveGet(game);
  const has = !!(b && b.size);
  $("saved-badge").textContent = "Keen " + GAME_NUM[game];
  $("saved-has").hidden = !has;
  $("saved-none").hidden = has;
  if (has) $("saved-size").textContent = fmtKB(b.size);
}

async function refreshSyncCard() {
  if (!serverMode) {
    $("sync-card").hidden = true;
    $("sync-absent").hidden = false;
    return;
  }
  $("sync-absent").hidden = true;
  $("sync-card").hidden = false;
  $("sync-badge").textContent = "Keen " + GAME_NUM[game];
  const on = syncEnabled(game);
  const toggle = $("sync-toggle"); if (toggle) toggle.checked = on;
  $("sync-key").textContent = getSyncId(game);
  $("sync-on-body").hidden = !on;
  $("sync-off-body").hidden = on;
  $("sync-disconnect").hidden = !on;
  $("sync-off-note").textContent = "Sync is off for Keen " + GAME_NUM[game] +
    " — this save stays in this browser only. Turn it on to back up and share across devices.";
  // Status line + device list reflect THIS game.
  const s = await syncState(game);
  $("sync-status").textContent = on ? syncStateText(game, s.state, s.size)
                                    : "Server sync is off for this game.";
  if (on) renderDevices(s);
  // make sure the (collapsed) link row is hidden when re-rendering
  if ($("link-row")) $("link-row").hidden = true;
}

// Device rows: this browser (always) + a cloud row when the server has a copy.
function renderDevices(s) {
  const rows = $("device-rows");
  if (!rows) return;
  const out = [`<div class="device-row"><span class="dot good"></span>This device<span class="dim"> · now</span></div>`];
  if (s && s.remote) out.push(`<div class="device-row"><span class="dot good"></span>Cloud save<span class="dim"> · ${fmtKB(s.remote.size || 0)}</span></div>`);
  rows.innerHTML = out.join("");
}

function refreshMobilePill() {
  const on = serverMode && syncEnabled(game);
  const c = $("console");
  if (c) c.classList.toggle("m-synced", on);
  const t = $("m-pill-text");
  if (t) t.textContent = "Keen " + GAME_NUM[game] + (on ? " synced" : " local");
  const gl = $("m-global-label");
  if (gl) gl.textContent = mView === "howto" ? "Same controls for all games" : "Global settings — apply to all games";
}

// ---- view + game routing ---------------------------------------------------

function setView(v) {
  view = v;
  const c = $("console"); if (c) c.dataset.view = v;
  document.querySelectorAll(".nav-btn").forEach((b) =>
    b.classList.toggle("active", v !== "play" && b.dataset.view === v));
  // selecting a global view de-highlights all game tabs
  refreshGameTabs();
}

function selectGame(g) {
  if (!isGame(g)) return;
  game = g;
  view = "play";
  const c = $("console"); if (c) c.dataset.view = "play";
  document.querySelectorAll(".nav-btn").forEach((b) => b.classList.remove("active"));
  refreshAll();
}

// Mobile bottom tab → mView. play/saves/sync are game views; howto/settings global.
function setMView(v) {
  mView = v;
  const c = $("console"); if (c) c.dataset.mview = v;
  document.querySelectorAll(".tab-b").forEach((b) =>
    b.classList.toggle("active", b.dataset.mview === v));
  // keep desktop `view` coherent (so a phone-width howto/settings shows globally)
  if (v === "howto" || v === "settings") view = v;
  else view = "play";
  if (c) c.dataset.view = (v === "howto" || v === "settings") ? v : "play";
  refreshMobilePill();
}

// ---- play (with per-game Play guard) ---------------------------------------

let pendingPlay = null;   // { g, state }

function hidePlayModal() { const m = $("sync-play-modal"); if (m) m.hidden = true; pendingPlay = null; }

// Pressing "▶ Play" for the selected game.
async function onPlayGame(g) {
  g = g || game;
  if (serverMode && syncEnabled(g)) {
    const s = await syncState(g);
    if (s.state === "server-only" && s.remote) {
      await pullFromServer(g, s.remote.modified);   // browser empty, cloud has it — just take it
      await refreshAll();
    } else if (s.state === "server-new" || s.state === "diverged") {
      showPlayModal(g, s);                            // behind/diverged — ask which to play
      return;
    }
  }
  launchGame(g);
}

// Launch: the bundled demo / server game if launchable, else the stored snapshot.
async function launchGame(g) {
  if (launchable[g]) { launch(launchable[g], g); return; }
  const blob = await saveGet(g);
  if (blob) { launch(URL.createObjectURL(blob), g); return; }
  // No data at all (5/6 not yet supplied) — prompt for files.
  openByo();
}

function showPlayModal(g, s) {
  const m = $("sync-play-modal"), text = $("sync-play-text");
  if (!m || !text) { launchGame(g); return; }
  pendingPlay = { g, state: s };
  const n = GAME_NUM[g];
  text.textContent = s.state === "diverged"
    ? `This device and the server have each changed the Keen ${n} save since they last matched. Pick which to play — the other is overwritten permanently. (Or Cancel and use “Stop syncing” to keep both.)`
    : `The server has a newer Keen ${n} save than this device${s.remote ? " (" + fmtKB(s.remote.size) + ")" : ""}. Pick which to play — the other is overwritten permanently. (Or Cancel and use “Stop syncing” to keep both.)`;
  m.hidden = false;
}

async function playWith(which) {
  const p = pendingPlay;
  hidePlayModal();
  if (!p) return;
  if (which === "cloud" && p.state.remote) await pullFromServer(p.g, p.state.remote.modified);
  else if (which === "local") { setLocalModified(p.g, Date.now()); await pushSave(p.g); }   // force this device up
  await refreshAll();
  launchGame(p.g);
}

// ---- saved game (per game) -------------------------------------------------

async function downloadSave(g) {
  const blob = await saveGet(g);
  if (!blob) return;
  // In the Android (Capacitor) WebView a programmatic <a download> silently does
  // nothing, so write the file and open the share sheet instead ("Save to Files",
  // Drive, etc.). Falls back to the normal anchor download in a real browser.
  if (await nativeSaveFile(blob, g + "-save.jsdos")) return;
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = g + "-save.jsdos";   // a .jsdos is a zip of the save/game files
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

function blobToBase64(blob) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(",")[1] || "");
    r.onerror = rej;
    r.readAsDataURL(blob);
  });
}

// Save a file via Capacitor (Filesystem + Share). Returns false when not running
// natively or the plugins are unavailable, so the caller can fall back.
async function nativeSaveFile(blob, name) {
  const Cap = window.Capacitor;
  if (!Cap || typeof Cap.isNativePlatform !== "function" || !Cap.isNativePlatform()) return false;
  const Filesystem = Cap.Plugins && Cap.Plugins.Filesystem;
  const Share = Cap.Plugins && Cap.Plugins.Share;
  if (!Filesystem) return false;
  try {
    const data = await blobToBase64(blob);
    const w = await Filesystem.writeFile({ path: name, data, directory: "CACHE" });
    if (Share && w && w.uri) {
      await Share.share({ title: name, files: [w.uri], dialogTitle: "Save your Keen game file" });
    } else {
      alert("Saved to app storage as " + name + ".");
    }
    return true;
  } catch (e) { console.warn("native save failed:", e); return false; }
}

// Delete THIS game's local save (keep its cloud copy). The other games are
// untouched. If sync is on for this game, its cloud copy under its key is kept.
async function deleteSaveUI(g) {
  const synced = serverMode && syncEnabled(g);
  const n = GAME_NUM[g];
  const id = getSyncId(g);
  const msg = synced
    ? `Delete the saved game for Keen ${n} in this browser?\n\nThe cloud copy (Keen ${n}'s key ${id}) is KEPT on the server — write that key down if you might want it back. Your other Keen games are unaffected.`
    : `Delete the saved game for Keen ${n} in this browser? This cannot be undone.`;
  if (!confirm(msg)) return;
  await saveDelete(g);
  localStorage.removeItem("keen.save.modified." + g);
  localStorage.removeItem("keen.save.synced." + g);
  delete lastFsSig[g];
  await refreshAll();
}

// Import a downloaded save into the SELECTED game. (Filename/CKx episode is used
// to validate it matches, but the slot it lands in is the current game.)
async function importSave(file, g) {
  if (!file) return;
  g = g || game;
  const buf = new Uint8Array(await file.arrayBuffer());
  // Try to detect the episode of the uploaded bundle and warn on a mismatch.
  let ep = (file.name.match(/keen[ _-]?([1-9])/i) || [])[1];
  if (!ep) {
    try {
      for (const n of Object.keys(fflate.unzipSync(buf))) {
        const m = n.match(/\.CK([1-9])$/i); if (m) { ep = m[1]; break; }
      }
    } catch (_) {}
  }
  ep = parseInt(ep, 10);
  if (VALID_EPISODES.includes(ep) && ep !== GAME_NUM[g]) {
    if (!confirm(`This save looks like Keen ${ep}, but you're uploading it to Keen ${GAME_NUM[g]}. Use it for Keen ${GAME_NUM[g]} anyway?`)) return;
  }
  await savePut(g, new Blob([buf], { type: "application/octet-stream" }));
  setLocalModified(g, Date.now());
  delete lastFsSig[g];
  await refreshAll();
  pushSave(g).then(refreshSyncCard);
  alert("Save imported for Keen " + GAME_NUM[g] + ". It loads next time you play this game.");
}

// ---- per-game link + first-sync conflict modal -----------------------------
let pendingLink = null;        // { g, id, remote } awaiting the conflict choice
let conflictChoice = "cloud";

function closeConflict() { const m = $("conflict-modal"); if (m) m.hidden = true; pendingLink = null; }

function paintConflict() {
  const tc = $("tile-cloud"), tl = $("tile-local"), btn = $("conflict-confirm");
  if (tc) tc.classList.toggle("sel", conflictChoice === "cloud");
  if (tl) tl.classList.toggle("sel", conflictChoice === "local");
  if (btn) btn.textContent = conflictChoice === "cloud" ? "Keep cloud save" : "Keep this browser";
}

// Link a key for the selected game `g`. If BOTH sides have a save for THIS game,
// the per-game conflict modal opens; otherwise it syncs silently in the obvious
// direction. Only this game is affected.
async function linkToKey(g, rawKey) {
  const id = setSyncId(g, rawKey);
  if (!id) { alert("Enter a sync key (4+ characters, e.g. K7QF)."); return; }
  $("sync-key").textContent = id;
  if ($("sync-key-input")) $("sync-key-input").value = "";
  if ($("link-row")) $("link-row").hidden = true;
  setSyncEnabled(g, true);
  const t = $("sync-toggle"); if (t) t.checked = true;
  // Adopt this key from scratch: reset this game's synced baseline so the
  // server's save is seen as "server-new/only" (rather than already-synced).
  localStorage.removeItem("keen.save.synced." + g);

  const remote = await fetchRemote(g);
  const blob = await saveGet(g);
  const anyRemote = !!remote;
  const anyLocal = !!(blob && blob.size);

  if (anyRemote && anyLocal) {
    // Both sides have a save for THIS game — ask which to keep.
    pendingLink = { g, id, remote };
    conflictChoice = "cloud";
    openConflictModal(g, id, remote.size || 0, blob.size || 0);
    return;
  }
  if (anyRemote) {
    await pullFromServer(g, remote.modified);
    await refreshAll();
    $("sync-status").textContent = `✓ Linked Keen ${GAME_NUM[g]} to ${id} — downloaded the cloud save (${fmtKB(remote.size || 0)}). Press ▶ Play.`;
  } else if (anyLocal) {
    setLocalModified(g, Date.now());
    await pushSave(g);
    await refreshAll();
    $("sync-status").textContent = `✓ Linked Keen ${GAME_NUM[g]} to ${id} — uploaded this device's save.`;
  } else {
    await refreshAll();
    $("sync-status").textContent = `Linked Keen ${GAME_NUM[g]} to key ${id}. No save here or on the server yet — play to create one.`;
  }
}

function openConflictModal(g, id, cloudSize, localSize) {
  const n = GAME_NUM[g];
  $("console").style.setProperty("--game-accent", GAME_META[g].accent);
  $("conflict-badge").lastChild.textContent = `Keen ${n} — ${GAME_TITLES[g]}`;
  $("conflict-num").textContent = String(n);
  $("conflict-key").textContent = id;
  document.querySelectorAll(".cf-game").forEach((el) => { el.textContent = "Keen " + n; });
  $("tile-cloud-size").textContent = fmtKB(cloudSize);
  $("tile-local-size").textContent = fmtKB(localSize);
  paintConflict();
  $("conflict-modal").hidden = false;
}

async function confirmConflict() {
  const link = pendingLink;
  closeConflict();
  if (!link) return;
  const g = link.g;
  if (conflictChoice === "cloud") {
    if (link.remote) await pullFromServer(g, link.remote.modified);
    await refreshAll();
    $("sync-status").textContent = `✓ Keen ${GAME_NUM[g]} cloud save downloaded — press ▶ Play to load it.`;
  } else {
    setLocalModified(g, Date.now());
    await pushSave(g);
    await refreshAll();
    $("sync-status").textContent = `✓ Keen ${GAME_NUM[g]}'s local save was uploaded to this key — in sync from now on.`;
  }
}

// Toggle this game's sync on/off.
async function onToggleSync() {
  const on = $("sync-toggle").checked;
  setSyncEnabled(game, on);
  if (on) { await autoSyncOnStart(); }   // safe pull for this game on enable
  await refreshAll();
}

// Disconnect this game on this device WITHOUT deleting anything: keep the local
// save, keep the cloud copy, stop syncing and forget this game's key. The other
// two games are untouched.
function disconnectSync(g) {
  g = g || game;
  const n = GAME_NUM[g];
  const id = getSyncId(g);
  if (!confirm(`Stop syncing Keen ${n} on this device?\n\nThe saved game here is KEPT, and the cloud copy (key ${id}) is also KEPT — write that key down if you might reconnect. This device just disconnects and forgets Keen ${n}'s key. Your other Keen games are unaffected.`)) return;
  setSyncEnabled(g, false);
  localStorage.removeItem("keen.syncId." + g);
  localStorage.removeItem("keen.save.synced." + g);   // a future re-link starts fresh comparisons
  refreshAll();
}

// ---- settings UI -----------------------------------------------------------

// Push the pogo-hold setting onto the POGO button so bindTouchButton reads it live.
function applyPogoHold() {
  const btn = document.querySelector("#touch-controls .abtn.pogo");
  if (btn) btn.dataset.holdMs = getSetting("pogohold");
}

// Desktop POGO on the physical Alt key — mirrors the on-screen POGO button when
// the "pogo on desktop Alt" switch is on. The native Alt already gives the game
// Pogo (342), so we (a) inject Jump (Ctrl 341) staggered ~30ms after, so Alt does
// the Pogo+Jump super-bounce like mobile, and (b) on release past the pogohold
// threshold inject one extra Alt tap to auto-retract the pogo.
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
  // Migrate legacy pogo-hold values that are no longer offered.
  const ph = getSetting("pogohold");
  if (["0", "40", "80", "130", "250"].includes(ph)) setSetting("pogohold", "180");

  // Segmented controls (buttons) — Engine / Pixels(rendering) / Touch.
  document.querySelectorAll(".seg[data-setting]").forEach((seg) => {
    const key = seg.dataset.setting;
    const paint = () => {
      const cur = getSetting(key);
      seg.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.dataset.value === cur));
    };
    seg.querySelectorAll("button").forEach((b) => {
      b.addEventListener("click", () => {
        setSetting(key, b.dataset.value); paint();
        if (key === "rendering") renderCrt();   // apply soft/crisp live to a running game
      });
    });
    paint();
  });
  // Native selects — Aspect / Pogo auto-retract. (Filter -> setupFilterSelect.)
  [["set-aspect", "aspect"], ["set-pogohold", "pogohold"]].forEach(([id, key]) => {
    const sel = $(id);
    if (!sel) return;
    sel.value = getSetting(key);
    sel.addEventListener("change", () => {
      setSetting(key, sel.value);
      if (key === "pogohold") applyPogoHold();
    });
  });
  setupFilterSelect();
  // Checkbox — desktop pogo.
  const dp = $("set-pogodesktop");
  if (dp) {
    dp.checked = getSetting("pogodesktop") === "on";
    dp.addEventListener("change", () => setSetting("pogodesktop", dp.checked ? "on" : "off"));
  }
  applyPogoHold();
}

// The screen-filter <select>.
//  • Desktop: an overlay picker only (off/scanlines/crt/...). Soft pixels is the
//    separate "Pixels" Crisp/Smooth toggle, so smooth + scanlines combine freely.
//  • Mobile: the Pixels toggle is hidden, so the dropdown folds soft pixels in as
//    composite entries that drive BOTH `rendering` and `filter` from one control.
const MOBILE_FILTER_OPTS = [
  ["off", "Off — crisp pixels"],
  ["smooth", "Smooth — soft pixels"],
  ["scanlines", "Scanlines"],
  ["smooth-scanlines", "Smooth + Scanlines"],
  ["crt", "CRT — scanlines + mask + vignette"],
  ["curved", "CRT curved"],
  ["rgb", "RGB — aperture mask"],
  ["amber", "Amber — monochrome"],
  ["green", "Green — phosphor"],
];
function setupFilterSelect() {
  const sel = $("set-filter");
  if (!sel) return;
  const mq = window.matchMedia("(max-width: 820px)");
  const desktopHTML = sel.innerHTML;   // authored desktop options, captured once
  const encodeMobile = () => {
    const r = getSetting("rendering"), f = getSetting("filter");
    if (r === "smooth" && (f === "off" || !f)) return "smooth";
    if (r === "smooth" && f === "scanlines") return "smooth-scanlines";
    return MOBILE_FILTER_OPTS.some(([v]) => v === f) ? f : "off";
  };
  const build = () => {
    if (mq.matches) {
      sel.innerHTML = MOBILE_FILTER_OPTS
        .map(([v, label]) => `<option value="${v}">${label}</option>`).join("");
      sel.value = encodeMobile();
    } else {
      sel.innerHTML = desktopHTML;
      sel.value = getSetting("filter");
    }
  };
  build();
  sel.addEventListener("change", () => {
    if (mq.matches) {
      const v = sel.value;
      const smooth = v === "smooth" || v === "smooth-scanlines";
      const f = v === "smooth" ? "off" : (v === "smooth-scanlines" ? "scanlines" : v);
      setSetting("rendering", smooth ? "smooth" : "pixelated");
      setSetting("filter", f);
    } else {
      setSetting("filter", sel.value);
    }
    renderCrt();   // applies rendering + filter live if a game is running
  });
  mq.addEventListener("change", build);   // re-sync if the viewport crosses the breakpoint
}

// ---- view + game wiring ----------------------------------------------------

function setupRouting() {
  document.querySelectorAll(".nav-btn").forEach((b) =>
    b.addEventListener("click", () => setView(b.dataset.view)));
  document.querySelectorAll(".game-tab, .m-tab").forEach((b) =>
    b.addEventListener("click", () => selectGame(b.dataset.game)));
  document.querySelectorAll(".tab-b").forEach((b) =>
    b.addEventListener("click", () => setMView(b.dataset.mview)));
  // initialise from defaults
  setView("play");
  setMView("play");
}

// ---- server / kiosk mode ---------------------------------------------------

// When served from the container with a mounted data dir, an entrypoint writes
// games/manifest.json listing the available episodes. We register their bundles
// as launchable (so the game-selector Play buttons boot them).
async function setupServerManifest() {
  let manifest;
  try {
    const res = await fetch("games/manifest.json", { cache: "no-store" });
    if (!res.ok) return;
    manifest = await res.json();
  } catch (_) { return; }
  if (!manifest || !manifest.serverMode || !Array.isArray(manifest.games) || !manifest.games.length) return;
  serverManifestActive = true;
  manifest.games.forEach((g) => { if (g && g.episode) launchable["keen" + g.episode] = g.bundle; });
}

// ---- BYO modal -------------------------------------------------------------

function openByo() { const m = $("byo-modal"); if (m) m.hidden = false; }

// ---- wiring ----------------------------------------------------------------

window.addEventListener("DOMContentLoaded", () => {
  // Ask the browser/Android WebView to keep our IndexedDB (saved games + uploaded
  // BYO game data) durable so it isn't evicted under storage pressure.
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (_) {}

  setupRouting();
  setupSettings();
  setupDesktopPogo();
  setupTouchControls();

  // Best-effort capture if the tab is hidden/closed while playing.
  const bgCapture = () => {
    if (dosCi) captureSave(currentKey).then((r) => { if (r.changed || localModified(currentKey) > lastSynced(currentKey)) pushSave(currentKey); });
  };
  window.addEventListener("pagehide", bgCapture);

  // On Android (Capacitor) the app being backgrounded is the most reliable moment
  // to snapshot — visibilitychange isn't always delivered before the WebView freezes.
  // Also: hardware Back in-game returns to the launcher; at the launcher exits.
  try {
    const App = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App;
    if (App && App.addListener) {
      App.addListener("pause", () => bgCapture());
      App.addListener("backButton", () => {
        if (dosCi) window.history.back();
        else App.exitApp();
      });
    }
  } catch (_) {}

  launchable["keen4"] = "games/keen4.jsdos";   // bundled demo (overridden by server manifest if present)
  setupServerManifest().then(() => { refreshAll(); deepLink(); });   // deep-link after the manifest (if any) loaded

  // Server-side save sync — only when the container backend is present (probe
  // /api/health). On static hosts (GitHub Pages) the sync card stays hidden.
  detectServerMode().then(() => {
    refreshSyncCard();
    refreshGameTabs();
    autoSyncOnStart();   // safe newer-server pull on launch (per game; diverged -> asked on Play)
  });

  // ----- Play view wiring -----
  $("hero-poster").addEventListener("click", () => onPlayGame(game));
  $("play-main").addEventListener("click", () => onPlayGame(game));
  $("hero-link").addEventListener("click", (e) => { e.preventDefault();
    if (GAME_META[game].free) openByo(); else openByo(); });

  // ----- Saved game wiring -----
  $("saved-download").addEventListener("click", () => downloadSave(game));
  $("saved-delete").addEventListener("click", () => deleteSaveUI(game));
  const saveInput = document.createElement("input");
  saveInput.type = "file";
  saveInput.accept = ".jsdos,.zip,.bin,application/octet-stream";
  saveInput.hidden = true;
  document.body.appendChild(saveInput);
  const pickSave = () => saveInput.click();
  $("saved-upload").addEventListener("click", pickSave);
  $("saved-upload-empty").addEventListener("click", pickSave);
  saveInput.addEventListener("change", () => { if (saveInput.files.length) { importSave(saveInput.files[0], game); saveInput.value = ""; } });

  // ----- Server sync wiring -----
  const toggle = $("sync-toggle");
  if (toggle) toggle.addEventListener("change", onToggleSync);
  const copy = $("sync-copy");
  if (copy) copy.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(getSyncId(game)); flashBtn(copy, "Copied!"); } catch (_) {}
  });
  const open = $("sync-link-open"), row = $("link-row");
  if (open && row) open.addEventListener("click", () => {
    row.hidden = !row.hidden;
    if (!row.hidden) { const i = $("sync-key-input"); if (i) i.focus(); }
  });
  const apply = $("sync-apply"), input = $("sync-key-input");
  if (apply && input) {
    apply.addEventListener("click", () => linkToKey(game, input.value));
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") linkToKey(game, input.value); });
  }
  const disc = $("sync-disconnect");
  if (disc) disc.addEventListener("click", () => disconnectSync(game));

  // ----- Conflict modal wiring -----
  const tc = $("tile-cloud"), tl = $("tile-local");
  if (tc) tc.addEventListener("click", () => { conflictChoice = "cloud"; paintConflict(); });
  if (tl) tl.addEventListener("click", () => { conflictChoice = "local"; paintConflict(); });
  const cf = $("conflict-confirm"), cx = $("conflict-cancel"), cm = $("conflict-modal");
  if (cf) cf.addEventListener("click", confirmConflict);
  if (cx) cx.addEventListener("click", closeConflict);
  if (cm) cm.addEventListener("click", (e) => { if (e.target === cm) closeConflict(); });
  // Esc cancels the conflict modal (focus trap kept simple — Esc + backdrop).
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("conflict-modal").hidden) closeConflict();
  });

  // ----- Play guard modal wiring -----
  const pc = $("sync-play-cloud"), pl = $("sync-play-local"), px = $("sync-play-cancel"), pm = $("sync-play-modal");
  if (pc) pc.addEventListener("click", () => playWith("cloud"));
  if (pl) pl.addEventListener("click", () => playWith("local"));
  if (px) px.addEventListener("click", hidePlayModal);
  if (pm) pm.addEventListener("click", (e) => { if (e.target === pm) hidePlayModal(); });

  // ----- BYO modal wiring -----
  const byoModal = $("byo-modal");
  const byoClose = $("byo-close");
  if (byoClose) byoClose.addEventListener("click", () => { byoModal.hidden = true; });
  if (byoModal) byoModal.addEventListener("click", (e) => { if (e.target === byoModal) byoModal.hidden = true; });
  $("play-byo").addEventListener("click", playByo);
  const dz = $("dropzone");
  const fileInput = $("file-input");
  dz.addEventListener("click", () => fileInput.click());
  dz.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") fileInput.click(); });
  fileInput.addEventListener("change", () => { if (fileInput.files.length) handleFiles(fileInput.files); });
  ["dragenter", "dragover"].forEach((ev) =>
    dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add("dragover"); }));
  ["dragleave", "drop"].forEach((ev) =>
    dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove("dragover"); }));
  dz.addEventListener("drop", (e) => {
    const dt = e.dataTransfer;
    if (dt && dt.files && dt.files.length) handleFiles(dt.files);
  });

  // Debug hook (only with ?debug): lets a harness inspect/drive per-game sync.
  try {
    if (/[?&#]debug/.test(location.href)) {
      window.__ksync = { GAMES, syncState, getSyncId, setSyncId, localModified, lastSynced,
        onPlayGame, autoSyncOnStart, pushSave, pullFromServer, refreshAll, disconnectSync,
        linkToKey, selectGame, onToggleSync, syncEnabled, setSyncEnabled,
        get game() { return game; } };
    }
  } catch (_) {}
});

})();
