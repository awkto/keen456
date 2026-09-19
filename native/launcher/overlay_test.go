package main

import (
	"strings"
	"testing"

	"keen456/core"
)

func TestMenuKeyYieldsToTurbo(t *testing.T) {
	s := core.DefaultSettings()
	if menuKey(s) != "tab" {
		t.Errorf("menu key = %q, want tab", menuKey(s))
	}
	s.TurboKey = "tab"
	if menuKey(s) != "grave" {
		t.Errorf("with turbo on tab the menu must move to grave, got %q", menuKey(s))
	}
}

// Keen ships no maps: the emulator only leaves M to the game when neither
// maps variable is set, and M is a letter save-game names need.
func TestOverlayEnvSetsNoMaps(t *testing.T) {
	env := strings.Join(overlayEnv(t.TempDir(), core.Episodes[0], core.DefaultSettings()), "\n")
	if !strings.Contains(env, "KEEN_OVERLAY=1") {
		t.Error("overlay not enabled")
	}
	if strings.Contains(env, "KEEN_MAPS") {
		t.Errorf("maps variables must not be set:\n%s", env)
	}
}
