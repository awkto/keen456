package core

// The three episodes, and the one question that has no equivalent in the
// single-game builds this port comes from: *where do this episode's game files
// live?*
//
// Keen 4 shareware is redistributable, so it ships in the package and is
// copied to an app-managed directory on first run. Keen 5 and 6 are
// commercial: the user points the app at their own files and the launcher runs
// them in place, or — with sync on — the files come down from the sync server
// (the web app uploads the whole bundle, game data included) into an
// app-managed directory. There is deliberately no import/copy flow.

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// Episode is one of Keen 4/5/6. ID doubles as the sync slot, matching the web
// app's slotFor(g) exactly, so native and browser share saves per episode with
// no namespace translation.
type Episode struct {
	Num   int
	ID    string
	Title string
}

var Episodes = []Episode{
	{4, "keen4", "Secret of the Oracle"},
	{5, "keen5", "The Armageddon Machine"},
	{6, "keen6", "Aliens Ate My Babysitter!"},
}

// Shareware reports whether this episode ships with the package. Only Keen 4
// (v1.4 shareware) is freely redistributable.
func (e Episode) Shareware() bool { return e.Num == 4 }

func (e Episode) String() string { return fmt.Sprintf("Keen %d (%s)", e.Num, e.Title) }

// ParseEpisode accepts "4", "keen4" or "Keen 4".
func ParseEpisode(v string) (Episode, bool) {
	v = strings.ToLower(strings.TrimSpace(v))
	v = strings.TrimPrefix(v, "keen")
	v = strings.TrimSpace(v)
	for _, e := range Episodes {
		if v == fmt.Sprint(e.Num) || v == e.ID {
			return e, true
		}
	}
	return Episode{}, false
}

// EpisodeByID looks up an episode by its id / sync slot.
func EpisodeByID(id string) (Episode, bool) { return ParseEpisode(id) }

// Source says where one episode's game files are for this run, and who owns
// that directory.
type Source struct {
	Ep  Episode
	Dir string // mounted as C:
	// Managed is true for the app-owned directory under ~/.local/share: the
	// bundled shareware copy, or whatever sync brought down. False means the
	// user's own directory, run in place — saves land there, like plain DOS.
	Managed bool
	// SyncOwned is true when sync is on, i.e. the directory's contents are the
	// sync server's business and keenN_dir is deliberately ignored.
	SyncOwned bool
}

// ResolveSource decides which directory an episode runs from.
//
// Sync wins when it is on: the server bundle carries the game files as well as
// the saves, so the app owns the location and keenN_dir is ignored (documented
// behaviour, not an oversight — two writers for one C: drive is how saves get
// lost). Otherwise a configured keenN_dir is run in place. Failing both, only
// Keen 4 has a source of its own: the bundled shareware.
func ResolveSource(s Settings, ep Episode) (Source, error) {
	if s.Sync && strings.TrimSpace(s.SyncBase) != "" {
		return Source{Ep: ep, Dir: ManagedGameDir(ep), Managed: true, SyncOwned: true}, nil
	}
	if d := strings.TrimSpace(s.EpisodeDir(ep)); d != "" {
		return Source{Ep: ep, Dir: expandUser(d)}, nil
	}
	if ep.Shareware() {
		return Source{Ep: ep, Dir: ManagedGameDir(ep), Managed: true}, nil
	}
	return Source{}, fmt.Errorf(
		"Keen %d is a commercial episode, so it is not part of this package.\n"+
			"Point the app at your own copy of the game files:\n"+
			"  keen456 %d --game-files /path/to/keen%d\n"+
			"(the path is remembered, so the flag is only needed once)",
		ep.Num, ep.Num, ep.Num)
}

// expandUser resolves a leading ~ so a hand-edited settings.ini behaves like
// the shell the user typed the path into.
func expandUser(p string) string {
	if p == "~" || strings.HasPrefix(p, "~/") {
		if home, err := os.UserHomeDir(); err == nil {
			return filepath.Join(home, strings.TrimPrefix(strings.TrimPrefix(p, "~"), "/"))
		}
	}
	return p
}

// FindExecutable picks the episode's DOS executable out of a game directory:
// whatever KEEN<n>*.EXE is present.
//
// For Keen 6 the choice matters. The stock KEEN6.EXE asks a
// "which creature is this?" manual question at startup; the community
// KEEN6C.EXE is the same game with that copy protection removed. If both are
// there, prefer the one that lets the game start — same policy as the web
// build — and say so when only the stock one is.
func FindExecutable(dir string, ep Episode) (string, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return "", fmt.Errorf("reading %s: %w", dir, err)
	}
	prefix := fmt.Sprintf("KEEN%d", ep.Num)
	var found []string
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		n := strings.ToUpper(e.Name())
		if strings.HasPrefix(n, prefix) && strings.HasSuffix(n, ".EXE") {
			found = append(found, e.Name())
		}
	}
	if len(found) == 0 {
		return "", fmt.Errorf("no %s*.EXE in %s", prefix, dir)
	}
	sort.Strings(found)
	if ep.Num == 6 {
		for _, f := range found {
			if strings.EqualFold(f, "KEEN6C.EXE") {
				return f, nil
			}
		}
		fmt.Fprintf(os.Stderr, "keen456: %s has only the stock %s — Keen 6 will ask "+
			"its \"which creature is this?\" manual question at startup. A KEEN6C.EXE "+
			"in the same directory is used instead when present.\n", dir, found[0])
	}
	return found[0], nil
}

// ValidateGameDir reports whether dir can actually run this episode, and with
// which executable. The test is the same one the web build uses: the episode's
// data files plus an executable that can load them.
func ValidateGameDir(dir string, ep Episode) (string, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return "", fmt.Errorf("%s: %w", dir, err)
	}
	suffix := fmt.Sprintf(".CK%d", ep.Num)
	data := 0
	for _, e := range entries {
		if !e.IsDir() && strings.HasSuffix(strings.ToUpper(e.Name()), suffix) {
			data++
		}
	}
	if data == 0 {
		return "", fmt.Errorf("%s holds no *%s files — that is not a Keen %d directory",
			dir, suffix, ep.Num)
	}
	return FindExecutable(dir, ep)
}

// HasGameFiles reports whether a directory looks like it holds this episode,
// without caring which executable would run. Used to decide whether an
// app-managed dir has been seeded yet.
func HasGameFiles(dir string, ep Episode) bool {
	_, err := ValidateGameDir(dir, ep)
	return err == nil
}

// SaveFiles reports the episode's in-game saves in dir — the SAVEGAM?.CK?
// files Keen writes from its own save menu, newest first by mtime.
//
// These are the files that cross platforms: plain game data that means the
// same thing to the browser build, the Android build and this one. (A DOSBox-X
// save state does not — it only loads in the exact build that wrote it.)
func SaveFiles(dir string, ep Episode) (names []string, newest int64) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, 0
	}
	suffix := fmt.Sprintf(".CK%d", ep.Num)
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		n := strings.ToUpper(e.Name())
		if !strings.HasPrefix(n, "SAVEGAM") || !strings.HasSuffix(n, suffix) {
			continue
		}
		names = append(names, e.Name())
		if info, err := e.Info(); err == nil {
			if ms := info.ModTime().UnixMilli(); ms > newest {
				newest = ms
			}
		}
	}
	sort.Strings(names)
	return names, newest
}

// CopyGameFiles copies the root files of src into dst without overwriting
// anything already there — used to seed an app-managed directory from the
// bundled shareware, and to seed a sync slot from the user's own directory.
//
// Existing files are left alone because they include the player's in-game
// saves and files the game itself rewrites.
func CopyGameFiles(src, dst string) error {
	if err := os.MkdirAll(dst, 0o755); err != nil {
		return err
	}
	entries, err := os.ReadDir(src)
	if err != nil {
		return err
	}
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		target := filepath.Join(dst, e.Name())
		if _, err := os.Stat(target); err == nil {
			continue
		}
		data, err := os.ReadFile(filepath.Join(src, e.Name()))
		if err != nil {
			return err
		}
		if err := os.WriteFile(target, data, 0o644); err != nil {
			return err
		}
		// Keep the source mtime: freshly copied files must not look "newer"
		// than a real in-game save on the sync server (newer-wins would
		// clobber it).
		if info, err := e.Info(); err == nil {
			os.Chtimes(target, info.ModTime(), info.ModTime())
		}
	}
	return nil
}
