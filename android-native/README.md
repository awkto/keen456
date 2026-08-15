# Commander Keen 4·5·6 — native Android build (DOSBox-X)

Real DOSBox-X on Android: the same pinned emulator source the Linux build uses
(`native/build-dosbox-x.sh`'s tag), cross-compiled with the NDK into
`libmain.so` and driven by SDL2's Java glue under a thin Kotlin app. This is a
**parallel track** to the Capacitor/WASM APK in `android/` — both are live,
built and shipped independently, and install side by side
(`com.awkto.keen456` vs `com.awkto.keen456.dx`).

Ported from the zeliard-wasm repo's `android-native/` track; its README and
HANDOVER carry the full war stories. `PLAN.md` here records what is
keen-specific: three episodes (Keen 4 shareware bundled; Keen 5/6 imported by
the player or pulled by save sync), an episode picker in front of the
emulator, Keen touch controls, and the shared `desktop-pogo.patch`.

## Build

```sh
# 1. Native core (once per DOSBox-X version/patch change; ~15 min first time)
./native/build-android.sh                    # arm64-v8a + x86_64
DBX_ABIS="x86_64" ./native/build-android.sh  # emulator only, faster

# 2. Game assets + mapper (fast, run after any games/ or mapper change)
./build-assets.sh

# 3. APK
./gradlew assembleDebug        # or assembleRelease with signing props
adb install app/build/outputs/apk/debug/app-debug.apk
```

Requirements: Android SDK with NDK `27.2.12479018` + `cmake;3.22.1`, JDK 17,
host `autoconf automake libtool nasm unzip`. The build script finds the SDK
via `ANDROID_HOME`/`ANDROID_SDK_ROOT` and prefers the SDK's bundled CMake.

If `adb devices` is silently empty on this dev box: a Docker container owns
port 5037 — `export ANDROID_ADB_SERVER_PORT=5137`.

## How it runs

- **PickerActivity** (launcher): three episode cards. Keen 4 plays
  immediately; Keen 5/6 show an Import button until their files are present
  (pick a folder or .zip of your own copy; validated like the desktop
  launcher, `KEEN6C.EXE` preferred for Keen 6).
- **KeenActivity** (SDLActivity subclass) runs in its own `:game` process —
  SDL_main only runs once per process, and a fresh process per session is
  what lets you come back and switch episodes. It prepares
  `files/game/keen<n>/`, writes `files/dosbox-x.conf` from the template with
  the episode's `${RUNCMD}`, and hands DOSBox-X the conf on its command line.
- Saves: Keen's own `SAVEGAM?.CK<n>` files live in the episode dir. DOSBox-X
  save states (`files/save/`) are per-build and never synced. Save sync
  (⚙ ▸ Sync) speaks the same protocol/slots as the web app and desktop —
  slot = `keen<n>`.
- Debugging a device: pull
  `Android/data/com.awkto.keen456.dx/files/last-run.log` (written unbuffered;
  `LOG_MSG` does not reach logcat).

## Controls

Stick = arrows · JUMP = Ctrl · POGO = Alt (in-emulator patch adds the
staggered Jump for the super-bounce and the retract tap — same behaviour and
`KEEN_POGO_HOLD` timing as desktop/web) · SHOOT = Space · FF = hold Tab
(speedlock) · 💾 = save/load state (Ctrl+. / Ctrl+\ via the mapper) · ⏎ ESC
Y N as labelled · ⌨ soft keyboard for save names · Back = ESC.

## Release

```sh
git tag android-native-v1.0.0 && git push origin android-native-v1.0.0
```

`.github/workflows/android-native-apk.yml` builds the native core (cached on
build-script + patch hash), runs the licensing gate (no Keen 5/6 content may
ship), assembles, signs with the same keystore secrets as the WASM APK, and
attaches `keen456-native-<ver>.apk` to the release. versionCode is derived
from the semver — do not switch it to a run counter (Android would refuse
updates; see PLAN.md).
