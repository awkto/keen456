# Vendored js-dos (offline)

js-dos **v8.4.0**, copied from https://v8.js-dos.com/latest/ so the app runs with
no network dependency (the DOSBox WebAssembly engine no longer streams from the CDN).

Files:
- `js-dos.js`, `js-dos.css` — loaded directly by `index.html`.
- `emulators/` — the emulator payload. `index.html`/`app.js` pass
  `pathPrefix: ".../js/jsdos/emulators/"` to `Dos()` so it loads these locally
  instead of the CDN default (`https://v8.js-dos.com/latest/emulators/`):
  - `emulators.js`
  - `wdosbox.js` / `wdosbox.wasm`      — default DOSBox backend
  - `wdosbox-x.js` / `wdosbox-x.wasm`  — DOSBox-X backend (real-time save states)
  - `wlibzip.js` / `wlibzip.wasm`      — zip handling (both backends)
  - `file-explorer.js`                 — js-dos file browser (vendored for completeness)

To update: re-download the same file set from v8.js-dos.com and bump the version note.
Note: the CDN's `emulators-ui-loader.png` (a CSS loader background) 404s upstream, so it is intentionally not vendored.
