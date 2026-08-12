# Native Linux build — plan

**Status: all seven phases built** (see [README.md](README.md) for how to use
and build it). Three decisions were taken while implementing that this plan did
not specify:

- **First-link decisions are only asked when this computer has in-game saves**
  for that episode. Zeliard's rule blocks an unlinked pull outright, which here
  would have been a dead end: a device with an empty Keen 5 directory has
  nothing to lose and no way forward except `pull --force`. The safeguard is
  kept where it means something — a device with its own saves, and any push
  over a save already on the server.
- **The js-dos metadata is a template, not a verbatim copy.** `extract-game.sh`
  takes `.jsdos/dosbox.conf` out of `games/keen4.jsdos` and replaces the line
  naming the executable with `__RUNCMD__`, so one source of truth serves all
  three episodes when native seeds a slot the browser must be able to boot.
  (For Keen 4 the round trip is byte-identical to the shipped file.)
- **`KEEN_POGO_DEBUG=1`** logs every key the pogo patch injects. The timing
  state machine is otherwise only observable by reading Keen's animation frame
  by frame.

A native Linux (Debian/Ubuntu, x86_64) version of the keen456 app: a preconfigured
**DOSBox-X** plus a Go launcher, shipped as an **AppImage** and a **.deb** (apt repo),
reaching feature parity with the WASM build — save states with the same shortcuts,
filters, fullscreen, turbo, and server-side save sync interoperating with the web
container.

Lives in `native/` in this repo; the WASM build is untouched.

## Port, don't reinvent

`~/git/zeliard-wasm/native/` is the finished reference implementation of this exact
stack (see its `README.md` + `PLAN.md`). It runs the same DOSBox-X, the same
`docker/saves-api.py` sync protocol, the same AppImage/.deb/apt pipeline. **Start by
copying and parameterizing, not rewriting:**

| From zeliard `native/` | Reuse | Changes for keen456 |
|---|---|---|
| `build-dosbox-x.sh` + pinned DOSBox-X `2026.08.02` | as-is | swap `patches/attack-keys.patch` (zeliard-specific) for a **desktop-pogo patch** built on its structure (§6); keep `patches/filter-cycle.patch` (bare `V` cycles shaders) |
| `launcher/` + `launcher/core/` (Go, static, no deps) | copy, rename module | app name `keen456`; **multi-episode** paths + per-episode sync slots (below) |
| `gui/` (Fyne settings window) | copy | add episode picker + per-episode game-files paths; keen settings |
| `build.sh`, `build-deb.sh`, `test-deb.sh` | near-verbatim | names/paths; extract `games/keen4.jsdos` instead of zeliard bundle |
| `appdir/dosbox-x.conf.tmpl`, mapper, shaders | adapt | conf parity with our `.jsdos` (below); keen mapper bindings |
| `.github/workflows/native-linux.yml` | adapt | tag pattern `native-v*` (this repo also cuts `v*` docker and `android-v*` APK tags — CI and the apt publisher must not follow those) |

Zeliard's hard-won rules carry over verbatim — read its README sections "Server
sync" and "Command line" before touching sync code:

- **Bundle preservation**: native owns only the root-level files it understands;
  everything else in the server bundle (`.jsdos/` metadata, the web quicksave state,
  any future nested entry) is read before a push and written back verbatim; refuse
  to push rather than upload a bundle whose foreign content couldn't be read.
- **First link is a decision, not a timestamp comparison** (`core/link.go`):
  newer-wins only after a device+key has exchanged a save once; before that, show
  both sides and ask.
- **Nothing destructive without `--yes`**; every overwrite backs up first
  (`~/.local/share/keen456/backups/`); `saves clear` refuses while sync is on.
- Exit-time sync reports divergence instead of acting if the server moved
  mid-session.

Build prereqs identical: docker, go, unzip, curl; stages cached in `native/vendor/`
(gitignored), output in `native/dist/`.

## What's different from zeliard (the actual design work)

### 1. Three episodes, two of them BYO commercial

- **Keen 4** shareware v1.4 is freely redistributable → bundled in the package,
  extracted at build time from `games/keen4.jsdos` (same single source of truth as
  the web build). First run copies it to the app-managed dir
  (`~/.local/share/keen456/game/keen4/`), zeliard-style.
- **Keen 5/6** are commercial → never in the package, and **no import/copy flow**
  (too many edge cases). Two modes, by sync state:
  - **Sync off**: the user points the app at their own files —
    `keen456 5 --game-files <dir>` — and the launcher mounts *that* dir as C: and
    runs the episode in place (saves land there too, like plain DOS). The path is
    persisted per episode in `settings.ini` (`keen5_dir=…`), so the flag is only
    needed once. Validation is just "does the dir hold `*.CK5` + a `KEEN5*.EXE`"
    (run whatever `KEENn*.EXE` is present — for Keen 6 that means a supplied
    `KEEN6C.EXE` skips the Creature-Question copy protection, same policy as web;
    warn if only the stock EXE is there).
  - **Sync on**: the game files follow the sync. The server bundle for `keen5`/
    `keen6` already contains the user's game data (the web app uploads the full
    `.jsdos` bundle), so the launcher pulls it into the app-managed per-episode
    dir and runs from there — the app owns the location, `keenN_dir` is ignored
    while sync is on. If the server slot is empty and a local dir is configured,
    a single explicit `keen456 sync push -e 5` seeds it (including a generated
    `.jsdos/dosbox.conf` matching the web template, so the browser can run the
    seeded bundle too).
- **Per-episode everything**: app-managed game dirs, save-state dirs, sync slot.
- **Episode selection**: `keen456 [4|5|6]` (default: last played, else 4); desktop
  entry actions; GUI picker. An episode with no source (no sync bundle, no
  configured dir) gets a one-line hint about `--game-files`.

### 2. DOSBox-X conf — parity with our `.jsdos`, not zeliard's

Baseline from `games/keen4.jsdos` `.jsdos/dosbox.conf`: `machine=svga_s3`,
`core=auto`, `cycles=auto`, `memsize=16`, SB16 + OPL at 44100, `pcspeaker=true`,
autoexec `mount c <episode game dir>; c:; KEENnE.EXE` (whichever `KEENn*.EXE`
the episode's dir holds, for 5/6).
Keep zeliard's fullscreen scheme: `fullresolution=desktop`, `aspect=true`,
windowed by default, **F** → fullscreen toggle via mapper.

### 3. Keys (parity with the web build, `js/app.js` ~line 1878)

| Key | Action | How |
|---|---|---|
| `Ctrl+.` / `Ctrl+\` | quick save/load state | mapper → `hand_savestate` / `hand_loadstate` (same combo as web + zeliard) |
| `F` | fullscreen toggle | mapper |
| `Tab` (hold) | turbo / fast-forward | mapper → `hand_speedlock` (zeliard phase 5, known-good) |
| `V` | cycle filter live | `filter-cycle.patch` (already exists) |

Note: Ctrl is Keen's Jump — `Ctrl+.` while jumping fires a save state. That's
already the shipped web behavior, so keep parity; don't shadow any key Keen uses
(arrows, Ctrl, Alt, Space, Esc, F1–F3, Enter).

### 4. Filters — zeliard's machinery *and* zeliard's defaults, unchanged

Reuse zeliard's `settings.ini` rendering/filter scheme verbatim, **defaults
included** (`rendering = smooth`, `filter = scanlines`) — per explicit user
decision, native keen456 keeps zeliard's defaults so the shared code stays
identical, even though the web keen456 defaults to crisp. Same option set:
`none / scanlines / soft / soft-scanlines / crt / crt-curved` + any DOSBox-X
shader name as passthrough. Ignore the web app's `smoothamt` blur-intensity
setting — passthrough shaders cover that ground.

The web aspect-ratio menu (1:1/5:4/16:9/…) is a **non-goal**; native is
aspect-correct 4:3 like zeliard.

### 5. Server sync — same container, per-episode slots

The keen456 container runs the **same** `docker/saves-api.py` protocol
(`GET/PUT /api/saves/<slot>`, `X-Client-Id`, `X-Save-Modified`, newer-wins).
Differences from zeliard:

- **Slot = episode id** (`keen4` | `keen5` | `keen6`) — exactly what the web app
  uses (`slotFor(g) = g`), so native and browser share saves per episode with no
  namespace translation.
- **Key**: web keys are short per-game keys (`keen.syncId.<g>`, 4-char, zeliard
  style). Native keeps **one `sync_key` in settings.ini applied to all episodes**
  (the web app supports a shared key across games since the slot separates them);
  link state tracked per key+slot in `sync-links.json`.
- **What crosses over**: Keen's in-game saves (`SAVEGAM?.CK?` slots + `CONFIG.CK?`)
  are plain root-level game files — fully cross-platform, same as zeliard's `.USR`
  files. DOSBox-X **save states do not cross** (validated against the exact
  emulator build; the js-dos WASM build and this native build fail each other's
  check by construction) — never force-load them, document "save in-game to cross
  platforms".
- Sync core: parameterize zeliard's `core/sync.go` (857 lines, ~40 zeliard-name
  references, slot effectively hardcoded to `auto`) to take app name + slot;
  sync the running episode's slot on its launch/exit.

CLI mirrors zeliard: `keen456 sync [status|pull|push|on|off|key|forget-key|…]`,
`keen456 saves list|backup|clear` — plus `-e 4|5|6` (default: every episode that
has a game dir) where
it matters.

### 6. Desktop pogo — committed (keen's analog of zeliard's attack keys)

Web parity feature `pogodesktop` (`js/app.js` `setupDesktopPogo`): holding **Alt**
does the Pogo+Jump super-bounce (Jump injected staggered ~30 ms after Alt), and
releasing past the hold threshold taps Alt once more to auto-retract the pogo.
Native implementation is a DOSBox-X patch in the exact mold of zeliard's
`attack-keys.patch` — an SDL host-key poll feeding the **emulated** keyboard
(never XTEST, which trips the Wayland remote-desktop portal). Settings follow the
zeliard convention (feature on by default): `pogo = on`, `pogo_hold = 180` (ms
threshold for the auto-retract tap; `off` disables the retract), reaching the
patch via env vars like `ZELIARD_ATK` does.

### 7. Not needed

- **No attack-keys/sword-autofire patch** — zeliard-specific (the pogo patch
  above replaces it as this repo's one custom patch, alongside `filter-cycle`).
- **No zoom** (zeliard-specific border crop); no macOS/Windows.

## Phases

1. **Keen 4 boots** — copy/parameterize `build-dosbox-x.sh`, `launcher/`,
   `build.sh`; AppImage runs shareware Keen 4 with sound, correct aspect,
   persistent game dir. Verify headless: Xvfb + screenshot (zeliard
   `test-headless.sh` pattern).
2. **Episodes** — `keen456 [4|5|6]` selection + `--game-files` run-in-place for
   5/6 (persisted per episode); verify Keen 5/6 boot with the real retail files
   (the GOG files used for the web build).
3. **Parity keys** — mapper (`Ctrl+.`, `Ctrl+\`, `F`, `Tab`), per-episode state
   dirs, `filter-cycle.patch`, `settings.ini` born here.
4. **Filters** — zeliard's shader set + settings, defaults unchanged
   (`smooth` + `scanlines`).
5. **Sync** — port `core/sync.go` + `link.go` multi-slot; CLI incl. seeding an
   empty slot; sync-managed game dirs take over from `--game-files`; cross-play
   test against a real keen456 container (save in browser at a save slot → pull
   native → continue, and back).
6. **Desktop pogo** — the DOSBox-X patch (port the `attack-keys.patch`
   structure), `pogo` / `pogo_hold` settings, verified super-bounce + retract.
7. **GUI + packaging** — Fyne settings window (episode picker, game-files
   paths, sync panel with Test connection); `build-deb.sh` + `test-deb.sh`
   (clean debian:12 + ubuntu:26.04 installs); CI workflow on `native-v*` tags;
   register the package with `linux-package-repo/publish.sh` on pro. The apt
   repo carries **only this native build** — the web/server builds stay
   containers (`v*` tags) and Android stays an APK (`android-v*`), so the
   publisher and CI must filter strictly on `native-v*`.

Each phase ends with the game actually run and seen working (screenshot), not
just compiled.
