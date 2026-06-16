# Roadmap

## Path 1 — js-dos baseline ✅ (current, on `main`)

Real DOS binaries under DOSBox-WASM, fully client-side.

- [x] M0 — Keen 4 shareware playable from a prebuilt `.jsdos` bundle
- [x] M0 — Drag-drop / file-picker → in-browser `.jsdos` bundle for Keen 5/6 (and full Keen 4)
- [x] M0 — Static site, deployable to GitHub Pages
- [ ] Save-game persistence across reloads (wire up js-dos storage / IndexedDB)
- [ ] Per-game cycles tuning + a simple settings panel
- [ ] Optional cross-origin isolation (COOP/COEP via service worker) to enable
      SharedArrayBuffer on GitHub Pages for smoother audio/perf
- [ ] Mobile/touch on-screen controls

## Path 2 — Omnispeak → WebAssembly (planned, separate branch)

Compile the [Omnispeak](https://github.com/sulix/omnispeak) engine — a pixel-perfect,
bug-for-bug C reimplementation of Keen 4/5/6 — to WebAssembly with Emscripten. This is a
*native-web* build: no DOS-emulation layer, so we get crisp integer scaling, clean fullscreen,
remappable keyboard/gamepad, and room for modern niceties.

> **License note:** Omnispeak is **GPL-2.0**. A publicly hosted WASM build is a derivative work,
> so its (modified) source must be published. The branch will carry the GPL accordingly.

Planned work (to live on branch `path2-omnispeak-wasm`):

- [ ] M1 — Build Omnispeak natively against Keen 4 shareware data; confirm it runs
- [ ] M2 — Emscripten toolchain (emsdk); compile to WASM. Start with the **plain SDL2 renderer**
      (`id_vl_sdl2.c`) for a simpler first boot; move to the GL/EGA-palette-shader path
      (`id_vl_sdl2gl.c`) once running. Target WebGL2.
- [ ] M2 — Main loop: wrap the blocking loop with **ASYNCIFY** first (low effort), measure,
      refactor to callback-driven only if overhead matters
- [ ] M3 — Runtime asset loading: file picker → MEMFS at the engine's expected paths → start
      episode (reuse the same BYO-data UX as Path 1; preload shareware for a zero-config demo)
- [ ] M4 — Persistence: mount **IDBFS** at `USERPATH`, `FS.syncfs()` after saves/config
- [ ] M5 — Audio: Nuked OPL3 in WASM, gated behind a user gesture (autoplay policy)
- [ ] M6 — Input polish (keyboard + gamepad), integer scaling, fullscreen, optional touch
- [ ] M7 — Useful runtime flags exposed in UI/URL (`/EPISODE`, `/NOCOPY` for Keen 6, `/INTEGER`, …)

### Stretch (Path 2)
- [ ] True "see-more" widescreen — widen the viewport constant and fix HUD layout, camera
      clamping, and (the hard part) sprite/entity activation so the wider view isn't full of
      pop-in and empty space. Cosmetic gotchas per level; treat as experimental.
