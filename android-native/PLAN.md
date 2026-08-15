# Native Android build — plan

Status: **implemented** (phases 1–5). This file records the design; README.md
is the how-to.

Port of the zeliard-wasm `android-native/` track (see that repo for the full
design history and hard-won gotchas — this port starts from its finished
state). DOSBox-X, pinned to the same tag as the Linux build, cross-compiled
with the NDK into `libmain.so` under a thin Kotlin app. No third-party
prebuilt binaries; patches and build recipe adapted from
CrownParkComputing/Dosbox-X-Android (GPL-2.0) against our own pinned checkout.

## What carries over from zeliard unchanged

- `native/build-android.sh`: pinned tag → patches → NDK cross-build per ABI →
  relink as `libmain.so` exporting `SDL_main` → verify symbols/NEEDED →
  install into `jniLibs/` + copy the version-matched `org.libsdl.app` glue.
- Patches 0001–0008 (configure target, cdrom include, sdlmain JNI bridge +
  conf loading, render aspect, surface GPU scale, SDL2 content-scale +
  Smooth/Crisp, no-drop-privileges, viewport resync) — JNI symbols renamed to
  `com_awkto_keen456`.
- The coexistence conventions: separate dir, `applicationId .dx` suffix,
  separate `android-native-v*` tag family, semver-derived versionCode
  (`major*10000 + minor*100 + patch` — NEVER `GITHUB_RUN_NUMBER`, which reads
  as a downgrade and Android refuses the update).
- GameSetup's fixed old mtime (2020-01-01) on extracted assets, the
  `.game-installed` marker keyed on versionCode, conf regenerated every launch.
- SaveSync: the wire protocol, link-state rules (first contact never
  auto-resolved), foreign-entry preservation, no save-state syncing.
- TouchOverlay principles: one View owns every pointer; buttons press plain
  keys and the in-emulator patch owns all timing; ref-counted key holds.

## What is keen-specific

1. **Three episodes, two of them commercial.** Per-episode managed dirs
   `files/game/keen{4,5,6}`; only Keen 4 shareware is bundled
   (`build-assets.sh`, from `games/keen4.jsdos`). Keen 5/6 arrive by SAF
   import (folder or .zip) in the **PickerActivity**, validated the same way
   the desktop launcher does (`*.CK<n>` data + `KEEN<n>*.EXE`, `KEEN6C.EXE`
   preferred over stock Keen 6), or by sync pulling the web app's bundle.
2. **PickerActivity + `:game` process.** `SDL_main` can run only once per
   process, so the picker launches KeenActivity in its own `:game` process —
   quitting the game (or picking another episode) gets a fresh process every
   time instead of a wedged SDL.
3. **Sync slots = episode ids** (`keen4`/`keen5`/`keen6`), exactly the web
   app's `slotFor(g)` and the Go launcher's `sy.slot`. One SaveSync instance
   per running episode; save detection is `SAVEGAM*.CK<n>` (not `.USR`).
4. **Shared patch is `desktop-pogo.patch`** (not zeliard's attack-keys):
   Alt-hold pogo + staggered Ctrl jump + auto-retract tap, driven from SDL key
   state inside `GFX_Events`, enabled with `KEEN_POGO=1` via
   `Native.nativeSetEnv` (no child-process environment on Android).
   `filter-cycle.patch` stays desktop-only (needs OpenGL).
5. **Controls**: stick = arrows (8-way), JUMP = Ctrl, POGO = Alt (the patch
   injects the combo), SHOOT = Space, plus Y/N, ⏎ status, ESC, FF = held Tab
   (speedlock via mapper), 💾 = Ctrl+. / Ctrl+\ save/load state (mapper), ⌨
   soft keyboard, ⚙ settings. No zoom button — Keen has no border to crop, so
   the pane is the plain width-fit 4:3 rect, top-aligned.
6. **Mapper ships on Android** (unlike zeliard): the desktop
   `mapper-keen456.map` minus the plain-F fullscreen bind (stripped in
   `build-assets.sh` — the soft keyboard types into the game). That is what
   makes Tab-turbo and the save/load-state combos work from the overlay.

## Deliberate non-goals (v1)

- No gamepad mapping, no landscape, no per-episode settings.
- No import **export**: saves leave the device via sync, as on desktop.
- Keen 5/6 files are copied in (not run in place à la desktop `keenN_dir`) —
  SAF gives no stable POSIX path to hand DOSBox-X.

## Release

Tag `android-native-vX.Y.Z` → `.github/workflows/android-native-apk.yml` →
signed `keen456-native-<ver>.apk` on the GitHub release. Same four signing
secrets as the WASM APK workflow (same keystore, different applicationId).
CI fails the build if any Keen 5/6 file lands in the APK (licensing gate,
mirroring `native/test-deb.sh`).
