package core

// Link state: which sync keys this device has agreed to share a save with, and
// the server timestamp it last agreed on. Tracked per key AND per episode
// slot, because one key covers all three episodes and each one is linked (or
// not) on its own.
//
// Without it, sync had only mtimes to go on, and compared them across machines
// that had never exchanged anything. Pointing a fresh install at an existing
// key therefore did whatever the clocks happened to say — usually nothing,
// because a freshly installed game dir looks newer than a save made yesterday.
// That is not a conflict-resolution rule, it is a coin toss.
//
// So: the first time a device is pointed at a key that already holds a save,
// there is no shared history and no basis for choosing. That case is not
// resolved automatically — it is reported, and the settings UI asks. Once the
// user picks a side the device is linked, a common point is recorded, and
// ordinary newer-wins takes over from there.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
)

type linkRecord struct {
	// LastSynced is the server `modified` value both sides agreed on at the
	// last successful pull or push.
	LastSynced int64 `json:"last_synced"`
}

type linkFile struct {
	Keys map[string]linkRecord `json:"keys"`
}

var linkMu sync.Mutex

func linkPath() string { return filepath.Join(ConfigDir(), "sync-links.json") }

// linkID is how a key+slot pair is recorded. Keys written by the
// single-episode ancestors of this file had no slot; there are none in the
// wild for keen456, so the format is simply "KEY/slot".
func linkID(key, slot string) string { return key + "/" + slot }

func loadLinks() linkFile {
	lf := linkFile{Keys: map[string]linkRecord{}}
	data, err := os.ReadFile(linkPath())
	if err != nil {
		return lf
	}
	if err := json.Unmarshal(data, &lf); err != nil || lf.Keys == nil {
		return linkFile{Keys: map[string]linkRecord{}}
	}
	return lf
}

func saveLinks(lf linkFile) error {
	if err := os.MkdirAll(ConfigDir(), 0o755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(lf, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(linkPath(), append(data, '\n'), 0o600)
}

// IsLinked reports whether this device has already agreed to share this
// episode's save with key.
func IsLinked(key, slot string) bool {
	linkMu.Lock()
	defer linkMu.Unlock()
	_, ok := loadLinks().Keys[linkID(key, slot)]
	return ok
}

// MarkSynced records a successful exchange at the server timestamp remote,
// linking key+slot if it wasn't already.
func MarkSynced(key, slot string, remote int64) {
	linkMu.Lock()
	defer linkMu.Unlock()
	lf := loadLinks()
	lf.Keys[linkID(key, slot)] = linkRecord{LastSynced: remote}
	_ = saveLinks(lf)
}

// Unlink forgets key for one slot, so the next connection asks again. An empty
// slot forgets the key for every episode — what `sync forget-key` does.
func Unlink(key, slot string) {
	linkMu.Lock()
	defer linkMu.Unlock()
	lf := loadLinks()
	if slot == "" {
		for _, ep := range Episodes {
			delete(lf.Keys, linkID(key, ep.ID))
		}
	} else {
		delete(lf.Keys, linkID(key, slot))
	}
	_ = saveLinks(lf)
}

// NeedsDecision reports whether connecting to key+slot would be a first link
// to a save that already exists AND this computer has its own in-game saves
// for that episode — the case a machine must not decide by itself.
//
// The in-game saves are the honest test of "has anything been played here".
// A game directory's mtime only says when it was installed or synced: the
// bundled shareware copy, or a directory the sync server just filled, looks as
// recent as the moment it landed while holding no progress at all. Asking the
// user to choose between "the server's save" and "nothing" is not a question,
// it is a dead end — on a fresh device with no local saves the pull is
// unambiguous and happens automatically.
func NeedsDecision(key, slot string, remote int64, localSaves int) bool {
	return remote != 0 && localSaves > 0 && !IsLinked(key, slot)
}

// ShouldPull reports whether a pull may proceed automatically. An unlinked key
// whose slot holds a save never overwrites local progress silently: the game
// dir may hold in-game saves the user has not backed up, and overwriting them
// is not reversible.
func ShouldPull(key, slot string, remote, local int64, localSaves int) bool {
	if remote == 0 {
		return false
	}
	if NeedsDecision(key, slot, remote, localSaves) {
		logSync("this device is not linked to save key %s for %s yet, and has "+
			"in-game saves of its own — not touching either copy. Run `keen456 "+
			"sync status -e %d` to compare, or open the settings window to "+
			"choose which save to keep.", key, slot, epNum(slot))
		return false
	}
	// Nothing played here yet: whatever the server has is the only progress
	// there is, so take it regardless of which side's files look newer.
	if localSaves == 0 {
		return true
	}
	return remote > local
}

// epNum turns a slot back into the episode number the CLI flags use.
func epNum(slot string) int {
	if ep, ok := EpisodeByID(slot); ok {
		return ep.Num
	}
	return 0
}

// ShouldPush reports whether a push may proceed automatically. Same rule in
// the other direction, and stricter: a save already on the server is never
// overwritten by a device that has not agreed to share with it — including a
// device with nothing of its own to send, where an accidental push would
// replace real progress with a pristine game directory.
func ShouldPush(key, slot string, remote, local int64) bool {
	if local == 0 {
		return false
	}
	if remote != 0 && !IsLinked(key, slot) {
		logSync("this device is not linked to save key %s for %s yet — refusing "+
			"to overwrite the save already on the server. Run `keen456 sync "+
			"status -e %d` to compare.", key, slot, epNum(slot))
		return false
	}
	return local > remote
}

// LastSynced is the server timestamp this device and key+slot last agreed on,
// or 0 if they never have.
func LastSynced(key, slot string) int64 {
	linkMu.Lock()
	defer linkMu.Unlock()
	return loadLinks().Keys[linkID(key, slot)].LastSynced
}
