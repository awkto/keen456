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

> **Keen 6 note:** the retail game shows a "Creature Question" copy-protection prompt at startup;
> the answers are in the game manual. (Bypassing it is an Omnispeak feature — see the roadmap.)

## Project layout

```
index.html        launcher UI
css/app.css        styling
js/app.js          launch logic + in-browser .jsdos bundle builder
js/fflate.min.js   vendored zip library (assembles bundles client-side)
games/keen4.jsdos  prebuilt Keen 4 shareware bundle (redistributable)
ROADMAP.md         Path 2: Omnispeak → WebAssembly (native engine port)
```

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
