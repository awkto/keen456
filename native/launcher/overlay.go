package main

import (
	"os"
	"path/filepath"

	"keen456/core"
)

// The in-game overlay — volume OSD and the Tab menu — is drawn by the patched
// DOSBox-X (native/patches/05-keen-overlay.patch, ported from zeliard-wasm).
// It cannot find anything by itself: the emulator does not know where this
// install keeps its files. The launcher tells it, through the environment.
//
// zeliard's overlay also carries a reference-map viewer on M. Keen ships no
// maps, so neither KEEN_MAPS nor KEEN_MAPS_URL is set and the emulator leaves
// M alone — it is a letter the player needs for save-game names.

// menuKey is the key that opens the in-game menu. Tab, unless Tab is the
// player's turbo key — then the two would fight, and the menu moves to the
// backquote key rather than turbo moving anywhere.
func menuKey(settings core.Settings) string {
	if settings.TurboKeyName() == "tab" {
		return "grave"
	}
	return "tab"
}

// overlayEnv switches the overlay on and tells it where everything is. See the
// header of keen_overlay.cpp for the other end of each of these. Volume is
// remembered per install, not per episode: it is a property of the room the
// computer is in.
func overlayEnv(data string, ep core.Episode, settings core.Settings) []string {
	env := []string{
		"KEEN_OVERLAY=1",
		"KEEN_OVERLAY_STATE=" + filepath.Join(data, "overlay.ini"),
		"KEEN_MENU_KEY=" + menuKey(settings),
	}
	// The menu's "Back up saves" and "Settings window" rows run these. The
	// launcher is named by its real path, not os.Args[0]: inside an AppImage
	// the running binary is AppRun, and that is what has to be run again.
	if p, err := core.LauncherPath(); err == nil {
		if _, serr := os.Stat(p); serr == nil {
			env = append(env, "KEEN_LAUNCHER="+p)
		}
	}
	if p := core.GuiPath(); p != "" {
		env = append(env, "KEEN_GUI="+p)
	}
	return env
}
