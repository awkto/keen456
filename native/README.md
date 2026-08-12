# keen456 native — Linux build

Native Linux version of Commander Keen 4/5/6: a preconfigured **DOSBox-X** plus
a launcher, at feature parity with the WASM build (see [PLAN.md](PLAN.md) for
the phased roadmap and scope).

## Install

The normal path is the apt repo — `apt upgrade` then picks up new releases
like any other package:

```bash
curl -fsSL https://gist.githubusercontent.com/awkto/7630588151f0a5c52c32efdff693d98e/raw/add-awkto-apt.sh | bash -s -- keen456
```

Already have the repo configured: `sudo apt install keen456`. Then run
`keen456`, or launch it from the desktop menu.

An **AppImage** is attached to each release too, for non-Debian distros:

```bash
chmod +x Keen456-x86_64.AppImage && ./Keen456-x86_64.AppImage
```

Needs: x86_64, Debian 12+ / Ubuntu 23.10+ (glibc ≥ 2.36), a desktop session
(X11 or Wayland/XWayland).

## The three episodes

**Keen 4 (Secret of the Oracle)** ships with the package — the v1.4 shareware
release, freely redistributable, extracted at build time from the same
`games/keen4.jsdos` bundle the web build serves. The first run copies it to
`~/.local/share/keen456/game/keen4/` so in-game saves persist across runs and
across `apt upgrade`.

**Keen 5 and 6 are commercial** and are never in the package. Point the app at
your own copy:

```bash
keen456 5 --game-files ~/games/keen5     # remembered; the flag is needed once
keen456 5                                # from then on
```

The game runs **in place** in that directory, so its in-game saves land there
too, exactly like running it under plain DOS. The directory needs the episode's
data files (`*.CK5`) and an executable (`KEEN5*.EXE`); for Keen 6 a
`KEEN6C.EXE` is used in preference to the stock `KEEN6.EXE`, which asks the
manual ("which creature is this?") question at startup — same policy as the web
build.

With **save sync on**, Keen 5/6 come from the sync server instead: the web app
uploads the whole bundle, game data included, so the launcher pulls it into
`~/.local/share/keen456/game/keen5/` and runs from there. The app owns that
directory while sync is on and `keen5_dir` is ignored — one C: drive with two
owners is how saves get lost. If the server slot is empty and you have your own
copy configured, seed it once:

```bash
keen456 sync push --force -e 5
```

`keen456` with no argument starts whichever episode you played last; the
desktop entry has an action per episode.

## Keys (beyond the game's own controls)

| Key | Action |
|-----|--------|
| `Ctrl + .` | quick-save state (instant, slot 1) |
| `Ctrl + \` | quick-load state |
| `Alt` (hold) | pogo + jump super-bounce; releasing retracts the pogo |
| `Tab` (hold) | turbo — fast-forward the emulation while held |
| `F` | fullscreen toggle (aspect-correct, pillarboxed) |
| `V` | cycle video filter: none → scanlines → soft → soft-scanlines → crt → crt-curved (session-only; `settings.ini` keeps the startup default) |

`Ctrl` is Keen's Jump, so `Ctrl + .` fires a save state mid-jump. That is
already how the web build behaves; parity wins over tidiness.

Save states live in `~/.local/share/keen456/states/<episode>/` — per episode,
because a state is a snapshot of one running program. More slots via the
DOSBox-X menu (Capture → Save/Load state).

Desktop pogo is implemented inside the bundled DOSBox-X
(`patches/desktop-pogo.patch`): holding Alt already gives Keen the pogo, so the
patch injects **Jump** ~30 ms later for the super-bounce and, when Alt was held
past `pogo_hold`, taps Alt once more on release to retract the pogo. It feeds
the *emulated* keyboard, so it works identically on X11 and Wayland with no
synthetic host input (and no remote-desktop permission prompts).

Troubleshooting: the emulator log of the last run is kept at
`~/.local/share/keen456/last-run.log`. `KEEN_POGO_DEBUG=1` in the environment
logs every key the pogo patch injects.

## Settings

`~/.config/keen456/settings.ini` (created with comments on first run; restart
the game to apply):

| Key | Values | Default |
|-----|--------|---------|
| `episode` | 4 / 5 / 6 — what plain `keen456` starts | `4`, then last played |
| `keen4_dir`, `keen5_dir`, `keen6_dir` | your own game files for an episode | *(empty)* |
| `pogo` | on / off — the Alt super-bounce | `on` |
| `pogo_hold` | ms Alt must be held before the auto-retract tap, or `off` | `180` |
| `rendering` | `smooth` (blurred/bilinear) / `crisp` (sharp pixels) | `smooth` |
| `filter` | `none` / `scanlines` / `soft` / `soft-scanlines` / `crt` / `crt-curved`, or **any DOSBox-X shader** (`scan3x`, `tv2x`, `advmame2x`, … or a path to your own `.glsl`) — non-`none` overrides `rendering` | `scanlines` |
| `sync` | on / off — server-side save sync | `off` |
| `sync_base` | URL of a keen456 container (e.g. `https://keen456.example.com/`) | *(empty)* |
| `sync_key` | web-style save key (e.g. `AWKX`) — links this device to an existing web save | *(empty)* |
| `sync_token` | bearer token for servers running with `SYNC_TOKEN`; empty for open servers | *(empty)* |

The rendering/filter defaults are `smooth` + `scanlines` — the zeliard native
defaults, deliberately kept even though the web keen456 defaults to crisp, so
the shared filter code behaves the same in both native builds. The web app's
aspect-ratio menu has no native equivalent: native is aspect-correct 4:3.

## Command line

Everything the settings window can do to a save, from a terminal — the CLI is
the primary interface on Linux, and the launcher does the syncing either way.
Every episode-scoped command takes `-e 4|5|6`; without it, it applies to every
episode this computer has game files for.

```
keen456                      start the last episode played
keen456 6                    start Keen 6
keen456 5 --game-files DIR   run Keen 5 from your own files (remembered)
keen456 sync                 sync now
keen456 sync status          show both sides and the link state
keen456 sync pull --force    take the server's save (backs up the local one first)
keen456 sync push --force    upload this computer's save; also seeds an empty slot
keen456 sync on | off
keen456 sync key [KEY]       show or switch the save key (covers all episodes)
keen456 sync forget-key      disconnect; --delete-remote also deletes the cloud saves
keen456 sync delete-remote --yes
keen456 saves list | backup | clear --yes
```

Rules these commands follow, because they touch the only copy of something the
player cannot get back: nothing destructive happens without `--yes` or a typed
confirmation that names what will be destroyed and what will survive; anything
that overwrites a save writes a backup to `~/.local/share/keen456/backups/`
first and prints the path; and `--force` means "I have decided", never "skip
the safety" — a forced pull still backs up, and a forced push still preserves
the web app's save inside the bundle.

`keen456 saves clear` refuses while sync is on. A local wipe would otherwise be
the newest state and would upload itself to the server on the next sync.

## Settings UI

`keen456-gui` is the settings window and launcher panel — what the desktop
entry opens (the entry's per-episode actions skip it and start a game directly,
as does running `keen456` from a terminal; AppImage users get it via
`./Keen456-x86_64.AppImage --settings`). It reads and writes the same
`settings.ini`, so hand-editing still works. Beyond the settings themselves it
validates as you type: a game-files path is checked for the episode's data
files and reports which executable would run, the server field must be a full
`http(s)://` URL, the save key is normalised like the web app's, and **Test
connection** runs the real sync client against the real server and reports, per
episode, whether it is linked and how old the stored save is.

The GUI is a separate binary in a separate Go module (`native/gui`, Fyne). That
keeps `keen456` itself a `CGO_ENABLED=0` static binary with no external
dependencies — only the GUI links a toolkit, and only the GUI needs the X11/GL
headers at build time.

## Server sync — cross-play with the web app

With `sync = on` and a `sync_base`, saves are kept on the same server the WASM
app uses (`docker/saves-api.py` protocol), under a short key (e.g. `AWKX`) you
can type into the browser to link the two.

**One key, three slots.** The slot is the episode id (`keen4` / `keen5` /
`keen6`) — exactly what the web app uses — so each episode's save is separate
on the server and a single key covers all of them. Link state is tracked per
key *and* slot in `~/.config/keen456/sync-links.json`.

**What crosses over, and what cannot.** A slot's bundle holds two different
kinds of save:

| In the bundle | What it is | Cross-platform |
|---|---|---|
| `SAVEGAM?.CK?` / `CONFIG.CK?` at the root | Keen's own in-game saves | **Yes** — plain game data, identical meaning everywhere |
| the web app's quicksave | a DOSBox-X *save state* | **No** |

A DOSBox-X save state is a snapshot of emulator internals, and DOSBox-X
validates it against the build that wrote it — emulator version string, machine
type, memory size. The js-dos WASM build and this native build fail that check
by construction, so neither can load the other's state. (Forcing past those
guards is what makes the emulator segfault instead of refusing; see
`forceloadstate` in `appdir/dosbox-x.conf.tmpl`.)

So cross-play works through in-game saves: save from Keen's own menu on one
platform, continue on the other. Each platform's quicksave stays its own.

**Nothing is destroyed to make that work.** Native only owns the root-level
game files in the bundle. Everything else — the `.jsdos/` metadata, any nested
entry the browser wrote — is read off the server before a push and written back
verbatim. Native will refuse to push at all rather than upload a bundle whose
foreign content it could not read first.

For Keen 5/6 the bundle carries the game files as well, which is what lets a
second machine (or the browser) play an episode it never had files for. When
native seeds an empty slot it also writes the `.jsdos/dosbox.conf` the browser
needs, generated from the same config `games/keen4.jsdos` ships with the
episode's own executable substituted in.

Sync runs on game start and again after the game exits. The exit pass is not a
mirror of the startup one: it uploads the session that just ended, but if the
server moved ahead while you were playing it reports the divergence instead of
acting, because the only way that happens is another device writing mid-session
and newer-wins would silently discard the session you just played.

**Linking a device is a decision, not a timestamp comparison.** Ordinary
newer-wins only applies once a device and a key have successfully exchanged a
save for that episode. The first time a device meets a key that already holds a
save *and this computer has in-game saves of its own*, there is no shared
history and comparing mtimes across two machines that never exchanged anything
decides nothing — so the launcher touches neither copy and says so, and the
settings window shows both sides and asks. Choosing "use the server's save"
backs the local game dir up to `~/.local/share/keen456/backups/` first.

A device with **no** in-game saves for that episode is not asked: a freshly
installed shareware copy, or an empty directory waiting for Keen 5, has nothing
to lose, and the server's save is the only progress that exists. That is the
case where asking would be a dead end rather than a safeguard.

Servers started with a `SYNC_TOKEN` env require `sync_token` in settings.ini
(sent as a Bearer token); open servers — the default, fine for home LANs —
need none.

## Build

```bash
./native/build.sh                # -> native/dist/Keen456-x86_64.AppImage
./native/build-deb.sh 1.0.0      # -> native/dist/keen456_1.0.0_amd64.deb
./native/test-deb.sh native/dist/keen456_1.0.0_amd64.deb
./native/test-headless.sh 4      # boot an episode under Xvfb + screenshot
```

Both builds share stages 1-3 (DOSBox-X, launcher, game files) via
`native/vendor/` and differ only in layout: the AppImage keeps everything in a
`usr/` subtree under the mount root, the package uses the FHS
(`/usr/lib/keen456/dosbox-x`, `/usr/share/keen456/`, `/usr/bin/keen456`). The
launcher picks its layout from the `InstallPrefix` value linked in at build
time.

`test-deb.sh` installs the package in clean `debian:12` and `ubuntu:26.04`
containers and checks every library resolves. That check is not optional
paranoia: the package is compiled on Debian 12 but mostly installed on Ubuntu,
which renamed several library packages for the 64-bit time_t transition
(`libasound2` → `libasound2t64`), so `Depends` names them as alternatives and
only a real install proves it. It also fails the build if any commercial
episode data ever ends up inside the package.

Requires: docker (compiles DOSBox-X and the Fyne GUI in Debian 12 containers —
slow the first time, cached in `native/vendor/` after), go, unzip, curl.
The DOSBox-X build applies `patches/*.patch` before compiling, in glob order:
desktop-pogo (the one feature with no vanilla equivalent) and then
filter-cycle, which binds a bare `V` to the shader switch DOSBox-X already
exposes via its own menu and `CONFIG -set` — the mapper has no such action.
Everything else — save states, turbo, key remaps, filters, sync — is vanilla
DOSBox-X driven by the conf and mapper files. Later patches are diffed against
the earlier-patches-applied tree — order matters.

## Release

Tag `native-vX.Y.Z` and push — `.github/workflows/native-linux.yml` builds the
`.deb` and the AppImage (DOSBox-X compile cached between runs), verifies the
package installs on Debian 12 and Ubuntu 26.04, and attaches both to a GitHub
release.

From there it is automatic: `linux-package-repo/publish.sh` runs hourly on pro,
pulls the newest `native-v*` release's `.deb` into `apt.pro.dnsif.ca/pool/main/`
and regenerates and signs the indexes. Note the tag pattern — this repo also
cuts `v*` releases for the web container and `android-v*` for the APK, and
neither the workflow nor the publisher may follow those.

## Layout

```
PLAN.md              phased roadmap (source of truth for scope)
build.sh             AppImage build -> dist/Keen456-x86_64.AppImage
build-deb.sh         Debian package build -> dist/keen456_<ver>_amd64.deb
build-dosbox-x.sh    stage 1: dockerized DOSBox-X source build (pinned version)
build-gui.sh         stage 2b: dockerized Fyne build of keen456-gui (cgo)
extract-game.sh      stage 3: unpack games/keen4.jsdos (shared by both)
test-deb.sh          install the .deb in clean Debian/Ubuntu containers
test-headless.sh     boot an episode under Xvfb and screenshot it
launcher/            Go launcher -> AppRun and /usr/bin/keen456 (no deps)
launcher/core/       settings, paths, episodes and the sync client
gui/                 keen456-gui: the Fyne settings window (separate module)
appdir/              static assets (dosbox-x.conf template, shaders, .desktop)
patches/             DOSBox-X source patches (desktop pogo, V filter cycle)
```

Keen 4's game files come from the same `games/keen4.jsdos` bundle the WASM
build ships, extracted at build time — one source of truth for the game data
and for the js-dos config that cross-play bundles carry.
