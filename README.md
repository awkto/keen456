# keen456 — Commander Keen 4·5·6 in the browser

Play the **Commander Keen "Goodbye, Galaxy!" / "Aliens Ate My Babysitter"** trilogy
(episodes 4, 5, 6) directly in a web browser. 100% client-side — no server, nothing uploaded.

**▶ Live:** https://awkto.github.io/keen456/

## How it works

This is the **js-dos baseline** ("Path 1"): the real DOS game binaries run under
[js-dos](https://js-dos.com) (DOSBox compiled to WebAssembly), entirely in your browser tab.

- **Keen 4** — the freely-redistributable **shareware v1.4** ships with the site, so it plays
  instantly with no setup. See [`games/`](games/) for the redistribution notice.
- **Keen 5 & 6** — commercial. Buy them on
  [GOG](https://www.gog.com/game/commander_keen_complete_pack) /
  [Steam](https://store.steampowered.com/app/9180/Commander_Keen_Pack/), then **drag-and-drop
  your own data files** onto the page. They are assembled into a `.jsdos` bundle in-browser and
  never leave your machine. *(The same picker also accepts your full retail Keen 4 files.)*

### Supplying your own data (Keen 5/6, or full Keen 4)

Select (or drop) these files for the episode you own:

| File | Example (Keen 5) |
|------|------------------|
| `AUDIO.CK?`    | `AUDIO.CK5`    |
| `EGAGRAPH.CK?` | `EGAGRAPH.CK5` |
| `GAMEMAPS.CK?` | `GAMEMAPS.CK5` |
| the game `.EXE` | `KEEN5E.EXE`  |

> **Keen 6 note:** the retail game shows a "Creature Question" copy-protection prompt at startup
> (the answers are in the game manual). A pre-patched **`KEEN6C.EXE`** boots straight past it —
> supply that instead of the stock `KEEN6.EXE` (the launcher runs the `KEEN6*.EXE` it finds). The
> RawCopy `KEEN6.COM` loader is *not* sufficient under js-dos's DOSBox, so `KEEN6C.EXE` is the way.

## Controls & settings

- **Keyboard** (Keen defaults): arrows move · **Ctrl** = jump · **Alt** = pogo · **Space** = fire.
- **Touch** (phones/tablets, or force it in Settings): the screen splits — game on top, an
  on-screen D-pad + Jump/Pogo/Shoot buttons on the bottom.
- **Settings** (on the launcher): aspect ratio (As-is, 1:1, 5:4, 4:3, 16:10, 16:9, Fit-to-window),
  crisp vs. smooth pixels, and the touch-controls mode (auto/on/off).
- **Saves persist** automatically in your browser (IndexedDB, per episode) and survive reloads.

### Server sync (container only)

When the site is served by the container (not a static host like GitHub Pages), an optional
**☁ Server sync** card appears. Turn it on to keep your saved games on the server too, so they
outlive the browser and can be shared across devices. Each browser gets a long **sync key**; copy
it to another device (or paste one in via *Use this key*) to share the same server-side saves.
Newer save wins on each side. The feature is opt-in (off by default) and hidden entirely on static hosts.

Saves are stored in `SAVE_DIR` (default `/saves`) scoped by sync key — **mount a volume there**
so they survive container updates: `-v keen456-saves:/saves`.

## Project layout

```
index.html        launcher UI
css/app.css        styling
js/app.js          launch logic + in-browser .jsdos bundle builder
js/fflate.min.js   vendored zip library (assembles bundles client-side)
games/keen4.jsdos  prebuilt Keen 4 shareware bundle (redistributable)
ROADMAP.md         Path 2: Omnispeak → WebAssembly (native engine port)
```

## Self-hosting with Docker

A container image is published to Docker Hub as **`awkto/keen456`** by GitHub Actions on every
`v*.*.*` tag (`:latest` tracks the newest release).

```bash
docker run -d --name keen456 --restart unless-stopped \
  -p 127.0.0.1:5023:80 \
  -v /path/to/keen-data:/data:ro \
  -v keen456-saves:/saves \
  awkto/keen456:latest
```

The `-v keen456-saves:/saves` volume keeps server-side saves (see *Server sync*) across updates.

**Server / kiosk mode:** mount a directory of your own Keen files at `/data`. On startup the
container detects each episode, builds its `.jsdos` bundle, and writes `games/manifest.json` — the
launcher then shows **only the available games** as one-click buttons and hides the upload UI.
Layout under `/data` can be flat or one subdir per episode:

```
/data/AUDIO.CK5  EGAGRAPH.CK5  GAMEMAPS.CK5  KEEN5E.EXE      # flat, or…
/data/keen5/AUDIO.CK5  EGAGRAPH.CK5  GAMEMAPS.CK5  KEEN5E.EXE
```

Keen 4 falls back to the bundled shareware if `/data` has no Keen 4. Commercial Keen 5/6 data is
never baked into the image — it only ever lives in your mounted `/data`. With no `/data`, the
container runs in normal bring-your-own-data mode.

## Roadmap

See [`ROADMAP.md`](ROADMAP.md). Short version: this js-dos build is **Path 1** (fast, authentic,
emulated). **Path 2** is compiling the [Omnispeak](https://github.com/sulix/omnispeak) engine
reimplementation to WebAssembly for a native-web build with crisp scaling, modern controls, and
no DOS-emulation layer. Path 2 will be developed on a separate branch.

## Local development

```
python3 -m http.server 8087   # then open http://127.0.0.1:8087
```
(js-dos requires `http://`, not `file://`.)

## Licensing

- **This launcher code** (everything except `games/` and `js/fflate.min.js`) is MIT — see
  [`LICENSE`](LICENSE).
- **`js/fflate.min.js`** is [fflate](https://github.com/101arrowz/fflate), MIT.
- **js-dos** is loaded from its CDN under its own (GPL) license; it is not redistributed here.
- **Commander Keen** is © id Software. Only the freely-redistributable Keen 4 shareware data is
  included. **Do not commit Keen 5/6 data to this repository.**
