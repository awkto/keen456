// Package core holds the parts of the native build that both the launcher
// (cmd keen456) and the settings UI (cmd keen456-gui) need: where things are
// installed, the settings file, the episode model, and the save-sync client.
//
// It deliberately has no external dependencies — the launcher links only the
// standard library, and only the GUI pulls in a toolkit.
package core

import (
	"os"
	"path/filepath"
)

// Baked in at build time:
//
//	go build -ldflags "-X keen456/core.InstallPrefix=/usr -X keen456/core.Version=1.0.0"
//
// InstallPrefix empty (the default) selects the AppImage/AppDir layout, where
// everything lives in a usr/ subtree under the mount root. A distro package
// sets it and gets the FHS layout instead.
var (
	InstallPrefix = ""
	Version       = "dev"
)

// Layout is where this install keeps its three kinds of payload.
type Layout struct {
	Share  string // read-only assets: game files, shaders, conf template, mapper
	Dosbox string // the patched dosbox-x binary
	Libs   string // private shared libraries, prepended to LD_LIBRARY_PATH
}

// ResolveLayout reports where this install's payload lives.
func ResolveLayout() (Layout, error) {
	if InstallPrefix != "" {
		pkg := filepath.Join(InstallPrefix, "lib", "keen456")
		return Layout{
			Share:  filepath.Join(InstallPrefix, "share", "keen456"),
			Dosbox: filepath.Join(pkg, "dosbox-x"),
			Libs:   filepath.Join(pkg, "lib"),
		}, nil
	}
	// AppImage: $APPDIR is the mount root. Unpacked AppDir: the directory
	// holding this executable, which is the AppRun.
	root := os.Getenv("APPDIR")
	if root == "" {
		exe, err := os.Executable()
		if err != nil {
			return Layout{}, err
		}
		root = filepath.Dir(exe)
	}
	return Layout{
		Share:  filepath.Join(root, "usr", "share", "keen456"),
		Dosbox: filepath.Join(root, "usr", "bin", "dosbox-x"),
		Libs:   filepath.Join(root, "usr", "lib"),
	}, nil
}

// LauncherPath is the `keen456` binary that actually starts the game — what
// the GUI's Play button runs. Next to this executable for a package install,
// or the AppRun we were started from inside an AppImage.
func LauncherPath() (string, error) {
	if InstallPrefix != "" {
		return filepath.Join(InstallPrefix, "bin", "keen456"), nil
	}
	if d := os.Getenv("APPDIR"); d != "" {
		return filepath.Join(d, "AppRun"), nil
	}
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	return filepath.Join(filepath.Dir(exe), "keen456"), nil
}

// GuiPath is the keen456-gui settings window, next to whichever binary is
// running. Empty (with no error) when this install has no GUI.
func GuiPath() string {
	var p string
	switch {
	case InstallPrefix != "":
		p = filepath.Join(InstallPrefix, "bin", "keen456-gui")
	case os.Getenv("APPDIR") != "":
		p = filepath.Join(os.Getenv("APPDIR"), "usr", "bin", "keen456-gui")
	default:
		exe, err := os.Executable()
		if err != nil {
			return ""
		}
		p = filepath.Join(filepath.Dir(exe), "keen456-gui")
	}
	if !fileExists(p) {
		return ""
	}
	return p
}

// DataDir holds everything the player owns that isn't settings: the
// app-managed per-episode game dirs (with their in-game saves), save states,
// the generated conf and the log.
func DataDir() string {
	if d := os.Getenv("XDG_DATA_HOME"); d != "" {
		return filepath.Join(d, "keen456")
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return filepath.Join(os.TempDir(), "keen456")
	}
	return filepath.Join(home, ".local", "share", "keen456")
}

// ConfigDir holds settings.ini, the generated sync-key and sync-links.json.
func ConfigDir() string {
	if d := os.Getenv("XDG_CONFIG_HOME"); d != "" {
		return filepath.Join(d, "keen456")
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return filepath.Join(os.TempDir(), "keen456")
	}
	return filepath.Join(home, ".config", "keen456")
}

// ManagedGameDir is the app-owned directory for one episode: where the
// bundled shareware is copied on first run, and where sync puts the game
// files it carries. Per episode, because each one is a separate C: drive with
// its own in-game saves.
func ManagedGameDir(ep Episode) string {
	return filepath.Join(DataDir(), "game", ep.ID)
}

// StatesDir holds DOSBox-X save states, per episode — they are emulator
// snapshots tied to one running program, so slot 1 must mean a different file
// for Keen 4 than for Keen 5.
func StatesDir(ep Episode) string {
	return filepath.Join(DataDir(), "states", ep.ID)
}

// LogPath is the DOSBox-X log — the file to ask a user for when diagnosing.
func LogPath() string { return filepath.Join(DataDir(), "last-run.log") }

func fileExists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}
