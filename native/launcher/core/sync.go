package core

// Server-side save sync — same wire protocol as the web app / the container's
// docker/saves-api.py: saves scoped by an opaque sync key (X-Client-Id),
// client-supplied epoch-ms timestamps (X-Save-Modified), newer-wins on both
// sides.
//
// The slot is the episode id — keen4 / keen5 / keen6 — which is exactly what
// the web app uses (slotFor(g) = g), so native and browser share saves per
// episode with no namespace translation. One sync key covers all three
// episodes, because the slot already keeps them apart.
//
// A slot holds a .jsdos bundle (zip: game files at the root, js-dos metadata
// under .jsdos/, plus a js-dos-only root dosbox.conf). For Keen 5 and 6 that
// bundle is also how the *game files* reach this machine — the web app uploads
// the whole bundle, and the user's own data files are in it.
//
// What crosses platforms is Keen's own in-game saves (SAVEGAM?.CK? and
// CONFIG.CK?): plain root-level game files that mean the same thing to any
// build on any machine. DOSBox-X save states do NOT cross — they are snapshots
// of emulator internals, validated against the build, machine type and memory
// size that wrote them, so the js-dos WASM build and this native build fail
// each other's check by construction. They stay in ~/.local/share/keen456/
// states/ and are never uploaded; the web app's own quicksave state lives
// inside the bundle and is preserved untouched (see loadForeign).
//
// Sync runs: pull (remote newer) before the game starts, push (local newer) on
// exit and every 2 minutes while playing.

import (
	"archive/zip"
	"bytes"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const syncPeriod = 2 * time.Minute

type Syncer struct {
	base    string // ends with /
	key     string
	token   string // optional bearer token (servers with SYNC_TOKEN set)
	client  *http.Client
	ep      Episode
	slot    string // = ep.ID, the web app's slot for this episode
	gameDir string
	metaDir string

	// foreign holds the entries of the remote bundle that this build does not
	// own: the web app's save-state quicksave, and anything else nested.
	// They are carried through every push verbatim — see loadForeign.
	foreign       map[string][]byte
	foreignLoaded bool

	remoteSeen int64 // the slot's modified time we last observed on the server
}

// NewSyncer builds a client for one episode's slot.
func NewSyncer(s Settings, ep Episode, gameDir, jsdosMetaDir string) (*Syncer, error) {
	base := strings.TrimSpace(s.SyncBase)
	if base == "" {
		// Reachable both from the launcher (sync on, server missing) and from
		// `keen456 sync push` with sync off, so it names the setting rather
		// than assuming which one the user got wrong.
		return nil, fmt.Errorf("no sync server set — put one in sync_base in %s",
			filepath.Join(ConfigDir(), "settings.ini"))
	}
	if !strings.HasSuffix(base, "/") {
		base += "/"
	}
	key, err := ResolveSyncKey(s)
	if err != nil {
		return nil, err
	}
	return &Syncer{
		base:    base,
		key:     key,
		token:   strings.TrimSpace(s.SyncToken),
		client:  &http.Client{Timeout: 120 * time.Second},
		ep:      ep,
		slot:    ep.ID,
		gameDir: gameDir,
		metaDir: jsdosMetaDir,
		foreign: map[string][]byte{},
	}, nil
}

// NormalizeSyncKey mirrors the web app's key box: uppercase, strip
// separators, 4-32 chars, dashes every 4. Returns "" if the value can't be a
// web-compatible key.
func NormalizeSyncKey(v string) string {
	var b strings.Builder
	for _, r := range strings.ToUpper(strings.TrimSpace(v)) {
		if (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') {
			b.WriteRune(r)
		}
	}
	clean := b.String()
	if len(clean) < 4 || len(clean) > 32 {
		return ""
	}
	if len(clean) == 4 {
		return clean
	}
	var out strings.Builder
	for i, r := range clean {
		if i > 0 && i%4 == 0 {
			out.WriteByte('-')
		}
		out.WriteRune(r)
	}
	return out.String()
}

// ResolveSyncKey picks this device's save identity, generating and storing one
// if there is none yet.
//
// Order: settings.ini sync_key (normalized) wins; else the sync-key file; else
// a fresh key in the WEB APP'S format (4 chars, same alphabet) so it can be
// typed into a browser — that's what makes cross-play linkable both ways.
func ResolveSyncKey(s Settings) (string, error) {
	if k := NormalizeSyncKey(s.SyncKey); k != "" {
		return k, nil
	}
	if strings.TrimSpace(s.SyncKey) != "" {
		return "", fmt.Errorf("sync_key %q is not a valid key (4-32 letters/digits)", s.SyncKey)
	}
	path := filepath.Join(ConfigDir(), "sync-key")
	if b, err := os.ReadFile(path); err == nil {
		if k := strings.TrimSpace(string(b)); k != "" {
			return k, nil
		}
	}
	// Web alphabet: no I/O/0/1 — the key is meant to be read aloud and typed.
	const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
	raw := make([]byte, 4)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	key := ""
	for _, c := range raw {
		key += string(alphabet[int(c)%len(alphabet)])
	}
	if err := os.MkdirAll(ConfigDir(), 0o755); err != nil {
		return "", err
	}
	if err := os.WriteFile(path, []byte(key+"\n"), 0o600); err != nil {
		return "", err
	}
	return key, nil
}

// Key is the save identity this client is using — the code the user types into
// the web app to link the same save.
func (sy *Syncer) Key() string { return sy.key }

// Slot is the episode id this syncer talks to.
func (sy *Syncer) Slot() string { return sy.slot }

// Episode is the episode this syncer covers.
func (sy *Syncer) Episode() Episode { return sy.ep }

// Base is the sync server URL, always ending in a slash.
func (sy *Syncer) Base() string { return sy.base }

func (sy *Syncer) req(method, path string, body io.Reader) (*http.Request, error) {
	r, err := http.NewRequest(method, sy.base+path, body)
	if err != nil {
		return nil, err
	}
	r.Header.Set("X-Client-Id", sy.key)
	if sy.token != "" {
		r.Header.Set("Authorization", "Bearer "+sy.token)
	}
	return r, nil
}

func (sy *Syncer) Healthy() bool {
	req, err := sy.req("GET", "api/health", nil)
	if err != nil {
		return false
	}
	resp, err := sy.client.Do(req)
	if err != nil {
		logSync("server unreachable: %v", err)
		return false
	}
	defer resp.Body.Close()
	io.Copy(io.Discard, resp.Body)
	if resp.StatusCode == 401 || resp.StatusCode == 403 {
		logSync("server at %s requires a token — set sync_token in settings.ini", sy.base)
		return false
	}
	if resp.StatusCode != 200 {
		logSync("no sync API at %s (HTTP %d)", sy.base, resp.StatusCode)
		return false
	}
	return true
}

// remoteSlot returns the server's modified time and size for this episode's
// slot (0 when the server holds nothing for it).
func (sy *Syncer) remoteSlot() (modified, size int64, err error) {
	req, err := sy.req("GET", "api/saves", nil)
	if err != nil {
		return 0, 0, err
	}
	resp, err := sy.client.Do(req)
	if err != nil {
		return 0, 0, err
	}
	defer resp.Body.Close()
	if resp.StatusCode == 401 || resp.StatusCode == 403 {
		return 0, 0, fmt.Errorf("HTTP %d — server requires a token, set sync_token in settings.ini", resp.StatusCode)
	}
	if resp.StatusCode != 200 {
		return 0, 0, fmt.Errorf("list: HTTP %d", resp.StatusCode)
	}
	var list []struct {
		Slot     string `json:"slot"`
		Modified int64  `json:"modified"`
		Size     int64  `json:"size"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&list); err != nil {
		return 0, 0, err
	}
	for _, e := range list {
		if e.Slot == sy.slot {
			return e.Modified, e.Size, nil
		}
	}
	return 0, 0, nil
}

// localModified is the newest file mtime in the dir, in epoch ms (0 = nothing
// to sync). Comparisons are mtime vs mtime, like the web client's Date.now().
func localModified(dir string) int64 {
	var newest int64
	entries, err := os.ReadDir(dir)
	if err != nil {
		return 0
	}
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		if info, err := e.Info(); err == nil {
			if ms := info.ModTime().UnixMilli(); ms > newest {
				newest = ms
			}
		}
	}
	return newest
}

// fetchBundle downloads the current bundle for this slot, or nil if there is
// none.
func (sy *Syncer) fetchBundle() ([]byte, error) {
	req, err := sy.req("GET", "api/saves/"+sy.slot, nil)
	if err != nil {
		return nil, err
	}
	resp, err := sy.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode == 404 {
		return nil, nil
	}
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	return io.ReadAll(resp.Body)
}

// loadForeign records the parts of the remote bundle this build does not own,
// so a later push can put them back byte for byte.
//
// This is the difference between cross-play and data loss. The web app's
// quicksave is a DOSBox-X save state js-dos stores inside the same bundle;
// native can neither read nor write it (a save state only loads in the build
// that wrote it). Rebuilding the bundle from the game dir alone would drop it.
func (sy *Syncer) loadForeign(blob []byte) {
	zr, err := zip.NewReader(bytes.NewReader(blob), int64(len(blob)))
	if err != nil {
		return
	}
	foreign := map[string][]byte{}
	for _, f := range zr.File {
		if f.FileInfo().IsDir() || !ownedByUs(f.Name) {
			r, err := f.Open()
			if err != nil {
				continue
			}
			data, err := io.ReadAll(r)
			r.Close()
			if err == nil {
				foreign[f.Name] = data
			}
		}
	}
	sy.foreign, sy.foreignLoaded = foreign, true
}

// ownedByUs reports whether a bundle entry is a root-level game file that this
// build manages. Everything else — `.jsdos/` metadata, nested save/ paths,
// anything the browser put there — belongs to whoever wrote it and is
// preserved untouched.
func ownedByUs(name string) bool {
	clean := path.Clean(name)
	if strings.Contains(clean, "/") || clean == "." || clean == ".." {
		return false
	}
	return !strings.EqualFold(clean, "dosbox.conf")
}

// Pull downloads the server's save when it is newer, and always learns what
// foreign content the bundle holds. Run before the game starts so it never
// races DOSBox-X's own writes.
func (sy *Syncer) Pull() {
	if !sy.Healthy() {
		return
	}
	logSync("server ok at %s (slot %s)", sy.base, sy.slot)
	remote, _, err := sy.remoteSlot()
	if err != nil {
		logSync("list failed: %v", err)
		return
	}
	sy.remoteSeen = remote
	if remote == 0 {
		sy.foreignLoaded = true // nothing on the server: nothing to preserve
		return
	}

	// Download unconditionally, even when we will not apply it: the bundle is
	// the only place the foreign entries exist, and Push must not run without
	// them.
	blob, err := sy.fetchBundle()
	if err != nil || blob == nil {
		logSync("pull: %v", err)
		return
	}
	sy.loadForeign(blob)

	saves, _ := SaveFiles(sy.gameDir, sy.ep)
	if !ShouldPull(sy.key, sy.slot, remote, localModified(sy.gameDir), len(saves)) {
		return
	}
	if err := os.MkdirAll(sy.gameDir, 0o755); err != nil {
		logSync("pull: %v", err)
		return
	}
	if err := unzipBundle(blob, sy.gameDir); err != nil {
		logSync("pull: extracting: %v", err)
		return
	}
	// Stamp the extracted files' collective mtime to the remote timestamp so a
	// pull doesn't immediately look like fresh local changes.
	stampDir(sy.gameDir, remote)
	MarkSynced(sy.key, sy.slot, remote)
	logSync("pulled %s (server was newer)", sy.slot)
}

// Push uploads the game dir when it is newer than what the server has,
// carrying the foreign entries through unchanged.
func (sy *Syncer) Push() {
	local := localModified(sy.gameDir)
	if local == 0 {
		return
	}
	if !sy.Healthy() {
		return
	}
	remote, _, err := sy.remoteSlot()
	if err != nil {
		logSync("push: list failed: %v", err)
		return
	}

	// Refuse to push over a bundle we have not inspected — uploading now would
	// silently drop whatever the other platform stored in it.
	if remote != 0 && (!sy.foreignLoaded || remote != sy.remoteSeen) {
		blob, err := sy.fetchBundle()
		if err != nil || blob == nil {
			logSync("push skipped: cannot read the server's bundle (%v) — "+
				"pushing now would discard the web app's save", err)
			return
		}
		sy.loadForeign(blob)
		sy.remoteSeen = remote
	}
	if !ShouldPush(sy.key, sy.slot, remote, local) {
		return
	}
	if err := sy.upload(local); err != nil {
		logSync("push: %v", err)
		return
	}
	logSync("pushed %s (%d preserved entries)", sy.slot, len(sy.foreign))
}

// upload rebuilds and PUTs the bundle, stamped with modified.
func (sy *Syncer) upload(modified int64) error {
	blob, err := zipBundle(sy.gameDir, sy.metaDir, sy.ep, sy.foreign)
	if err != nil {
		return err
	}
	req, err := sy.req("PUT", "api/saves/"+sy.slot, bytes.NewReader(blob))
	if err != nil {
		return err
	}
	req.Header.Set("X-Save-Modified", strconv.FormatInt(modified, 10))
	resp, err := sy.client.Do(req)
	if err != nil {
		return err
	}
	io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 200 {
		return fmt.Errorf("upload failed: HTTP %d", resp.StatusCode)
	}
	sy.remoteSeen = modified
	MarkSynced(sy.key, sy.slot, modified)
	return nil
}

// Run pushes periodically while the game runs, then polls and settles up once
// the game has exited.
//
// The periodic runs are push-only on purpose: pulling would rewrite the game
// dir underneath a running DOSBox-X.
func (sy *Syncer) Run(stop <-chan struct{}, done chan<- struct{}) {
	defer close(done)
	tick := time.NewTicker(syncPeriod)
	defer tick.Stop()
	for {
		select {
		case <-stop:
			sy.FinalSync()
			return
		case <-tick.C:
			sy.Push()
		}
	}
}

// FinalSync runs after the game exits: poll the server, upload this session if
// it is the newer one, and report rather than act if the server moved ahead
// while we were playing.
//
// It deliberately does not auto-pull here. Newer-wins is right at startup,
// when the local copy is whatever we left behind; applying it moments after a
// session would silently discard the session that just ended, because the only
// way the server can be newer is that another device wrote while we played.
// That is a divergence, and it is the player's call.
func (sy *Syncer) FinalSync() {
	if !sy.Healthy() {
		return
	}
	remote, _, err := sy.remoteSlot()
	if err != nil {
		logSync("final sync: %v", err)
		return
	}
	local := localModified(sy.gameDir)
	if remote > local && remote != 0 {
		logSync("the server's %s save (%s) is newer than this session (%s) — "+
			"another device wrote while you were playing. Nothing was changed; "+
			"run `keen456 sync status -e %d` to compare, then `keen456 sync pull "+
			"--force -e %d` to take the server's copy.",
			sy.slot,
			time.UnixMilli(remote).Format("2006-01-02 15:04"),
			time.UnixMilli(local).Format("2006-01-02 15:04"),
			sy.ep.Num, sy.ep.Num)
		return
	}
	sy.Push()
}

// jsdosConf builds the `.jsdos/dosbox.conf` a seeded bundle needs so the
// browser can boot what native uploaded. The template is the one from
// games/keen4.jsdos with its run command replaced by __RUNCMD__ at build time
// (extract-game.sh), so there is still one source of truth for the emulator
// config; only the executable name differs per episode.
func jsdosConf(metaDir, gameDir string, ep Episode) ([]byte, error) {
	tmpl, err := os.ReadFile(filepath.Join(metaDir, "jsdos-dosbox.conf.tmpl"))
	if err != nil {
		return nil, fmt.Errorf("jsdos metadata: %w", err)
	}
	exe, err := FindExecutable(gameDir, ep)
	if err != nil {
		return nil, err
	}
	return []byte(strings.ReplaceAll(string(tmpl), "__RUNCMD__", strings.ToUpper(exe))), nil
}

// zipBundle rebuilds the web app's bundle for this slot: a bootable .jsdos zip
// with the metadata entries and the current game-dir files at the root.
func zipBundle(dir, metaDir string, ep Episode, foreign map[string][]byte) ([]byte, error) {
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)

	// Foreign entries first, verbatim: the js-dos metadata and the web app's
	// quicksave state as the server already holds them.
	for name, data := range foreign {
		w, err := zw.Create(name)
		if err != nil {
			return nil, err
		}
		if _, err := w.Write(data); err != nil {
			return nil, err
		}
	}
	// Only supply the js-dos metadata ourselves when the bundle didn't already
	// carry it (a brand-new save with no browser history).
	if _, ok := foreign[".jsdos/dosbox.conf"]; !ok {
		data, err := jsdosConf(metaDir, dir, ep)
		if err != nil {
			return nil, err
		}
		w, err := zw.Create(".jsdos/dosbox.conf")
		if err != nil {
			return nil, err
		}
		if _, err := w.Write(data); err != nil {
			return nil, err
		}
	}
	if _, ok := foreign["dosbox.conf"]; !ok {
		data, err := os.ReadFile(filepath.Join(metaDir, "root-dosbox.conf"))
		if err != nil {
			return nil, fmt.Errorf("jsdos metadata: %w", err)
		}
		w, err := zw.Create("dosbox.conf")
		if err != nil {
			return nil, err
		}
		if _, err := w.Write(data); err != nil {
			return nil, err
		}
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	for _, e := range entries {
		if e.IsDir() || !ownedByUs(e.Name()) {
			continue
		}
		data, err := os.ReadFile(filepath.Join(dir, e.Name()))
		if err != nil {
			return nil, err
		}
		info, _ := e.Info()
		hdr := &zip.FileHeader{Name: e.Name(), Method: zip.Deflate}
		if info != nil {
			hdr.Modified = info.ModTime()
		}
		w, err := zw.CreateHeader(hdr)
		if err != nil {
			return nil, err
		}
		if _, err := w.Write(data); err != nil {
			return nil, err
		}
	}
	if err := zw.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// zipGameDir archives the player's game dir as-is.
func zipGameDir(dir string) ([]byte, error) {
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		data, err := os.ReadFile(filepath.Join(dir, e.Name()))
		if err != nil {
			return nil, err
		}
		hdr := &zip.FileHeader{Name: e.Name(), Method: zip.Deflate}
		if info, err := e.Info(); err == nil {
			hdr.Modified = info.ModTime()
		}
		w, err := zw.CreateHeader(hdr)
		if err != nil {
			return nil, err
		}
		if _, err := w.Write(data); err != nil {
			return nil, err
		}
	}
	if err := zw.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// unzipBundle extracts a bundle's root game files into the game dir. Metadata
// (.jsdos/*, the js-dos-only root dosbox.conf) and anything nested stays out —
// the native conf is generated by the launcher.
func unzipBundle(blob []byte, dir string) error {
	zr, err := zip.NewReader(bytes.NewReader(blob), int64(len(blob)))
	if err != nil {
		return err
	}
	for _, f := range zr.File {
		name := path.Clean(f.Name)
		if f.FileInfo().IsDir() || !ownedByUs(f.Name) {
			continue
		}
		r, err := f.Open()
		if err != nil {
			return err
		}
		data, err := io.ReadAll(r)
		r.Close()
		if err != nil {
			return err
		}
		if err := os.WriteFile(filepath.Join(dir, name), data, 0o644); err != nil {
			return err
		}
	}
	return nil
}

func stampDir(dir string, epochMs int64) {
	t := time.UnixMilli(epochMs)
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		if !e.IsDir() {
			os.Chtimes(filepath.Join(dir, e.Name()), t, t)
		}
	}
}

func logSync(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "keen456: sync: "+format+"\n", args...)
}

// ---- explicit conflict resolution (driven by the CLI and settings UI) ------

// SyncStatus is what the CLI and settings window show before asking the user
// to choose: both sides, described plainly.
type SyncStatus struct {
	Key            string
	Slot           string
	ServerReach    bool
	RemoteModified int64 // 0 = no save on the server for this key+episode
	RemoteSize     int64
	LocalModified  int64 // newest mtime in the game dir (0 = no game dir yet)
	LocalSaves     int   // this episode's in-game saves on this computer
	LocalSaveTime  int64 // newest of those, 0 if there are none
	Linked         bool
	NeedsDecision  bool
	Err            string
}

// Status inspects both sides without changing either.
func (sy *Syncer) Status() SyncStatus {
	st := SyncStatus{Key: sy.key, Slot: sy.slot, LocalModified: localModified(sy.gameDir)}
	saves, newest := SaveFiles(sy.gameDir, sy.ep)
	st.LocalSaves, st.LocalSaveTime = len(saves), newest
	st.Linked = IsLinked(sy.key, sy.slot)
	if !sy.Healthy() {
		st.Err = "no sync server reachable at " + sy.base
		return st
	}
	st.ServerReach = true
	modified, size, err := sy.remoteSlot()
	if err != nil {
		st.Err = err.Error()
		return st
	}
	st.RemoteModified, st.RemoteSize = modified, size
	st.NeedsDecision = NeedsDecision(sy.key, sy.slot, st.RemoteModified, st.LocalSaves)
	return st
}

// BackupGameDir snapshots a game directory before an irreversible overwrite,
// and returns the file it wrote. Cheap insurance: the whole directory is about
// a megabyte.
//
// It is a plain function, not a Syncer method, because backing up is not a
// sync operation: `keen456 saves backup` must work on a machine that has never
// heard of a sync server. (It is also deliberately NOT built through
// zipBundle, which needs the js-dos metadata and a detectable executable — a
// backup must not be able to fail because of a missing file that has nothing
// to do with the save.)
func BackupGameDir(gameDir, slot, tag string) (string, error) {
	blob, err := zipGameDir(gameDir)
	if err != nil {
		return "", err
	}
	dir := filepath.Join(DataDir(), "backups")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	p := filepath.Join(dir, fmt.Sprintf("%s-%s-%s.zip",
		slot, tag, time.Now().Format("20060102-150405")))
	if err := os.WriteFile(p, blob, 0o644); err != nil {
		return "", err
	}
	return p, nil
}

// BackupGameDir snapshots the directory this syncer is about to overwrite.
func (sy *Syncer) BackupGameDir(tag string) (string, error) {
	return BackupGameDir(sy.gameDir, sy.slot, tag)
}

// AdoptCloud takes the server's save for this key+episode, after backing up
// whatever is in the game dir now. Links the device.
func (sy *Syncer) AdoptCloud() (backup string, err error) {
	if !sy.Healthy() {
		return "", fmt.Errorf("no sync server reachable at %s", sy.base)
	}
	remote, _, err := sy.remoteSlot()
	if err != nil {
		return "", err
	}
	if remote == 0 {
		return "", fmt.Errorf("there is no %s save on the server for key %s", sy.slot, sy.key)
	}
	blob, err := sy.fetchBundle()
	if err != nil {
		return "", err
	}
	if blob == nil {
		return "", fmt.Errorf("the server's %s save for key %s could not be read", sy.slot, sy.key)
	}
	if localModified(sy.gameDir) != 0 {
		if backup, err = sy.BackupGameDir("before-cloud"); err != nil {
			return "", fmt.Errorf("backing up the local save first: %w", err)
		}
	}
	if err := os.MkdirAll(sy.gameDir, 0o755); err != nil {
		return backup, err
	}
	sy.loadForeign(blob)
	if err := unzipBundle(blob, sy.gameDir); err != nil {
		return backup, err
	}
	stampDir(sy.gameDir, remote)
	sy.remoteSeen = remote
	MarkSynced(sy.key, sy.slot, remote)
	logSync("adopted the server's %s save for key %s", sy.slot, sy.key)
	return backup, nil
}

// AdoptLocal keeps this device's save and uploads it, preserving whatever the
// other platform stored in the bundle. Links the device.
func (sy *Syncer) AdoptLocal() error {
	if !sy.Healthy() {
		return fmt.Errorf("no sync server reachable at %s", sy.base)
	}
	local := localModified(sy.gameDir)
	if local == 0 {
		return fmt.Errorf("there is nothing in %s to upload yet", sy.gameDir)
	}
	remote, _, err := sy.remoteSlot()
	if err != nil {
		return err
	}
	if remote != 0 {
		blob, err := sy.fetchBundle()
		if err != nil || blob == nil {
			return fmt.Errorf("cannot read the server's bundle, so uploading "+
				"now could discard the web app's save: %v", err)
		}
		sy.loadForeign(blob)
	} else {
		sy.foreignLoaded = true
	}
	if err := sy.upload(local); err != nil {
		return err
	}
	logSync("uploaded this device's %s save for key %s (%d preserved entries)",
		sy.slot, sy.key, len(sy.foreign))
	return nil
}

// DeleteRemote removes the save stored under this key+episode on the server.
// Nothing else uses this key, so it is unrecoverable — callers must confirm
// first.
func (sy *Syncer) DeleteRemote() error {
	req, err := sy.req("DELETE", "api/saves/"+sy.slot, nil)
	if err != nil {
		return err
	}
	resp, err := sy.client.Do(req)
	if err != nil {
		return err
	}
	io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 200 && resp.StatusCode != 404 {
		return fmt.Errorf("delete failed: HTTP %d", resp.StatusCode)
	}
	Unlink(sy.key, sy.slot)
	return nil
}

// DownloadBundle returns the server's bundle for this key+episode, for backups.
func (sy *Syncer) DownloadBundle() ([]byte, error) { return sy.fetchBundle() }
