package core

import (
	"strings"
	"testing"
)

// The new keys must survive a write and a read — the settings window saves the
// whole struct, so a key that renders but does not parse resets on every save.
func TestSettingsRoundTripNewKeys(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	s := DefaultSettings()
	s.Output, s.Vsync = "surface", false
	s.TurboKey, s.TurboFrameskip, s.PauseKey = "tab", 3, "pause"
	if err := Save(s); err != nil {
		t.Fatal(err)
	}
	got := Load()
	if got.Output != "surface" || got.Vsync || got.TurboKey != "tab" ||
		got.TurboFrameskip != 3 || got.PauseKey != "pause" {
		t.Fatalf("round trip lost a key: %+v", got)
	}
}

func TestDefaultsAreKeenSafe(t *testing.T) {
	s := DefaultSettings()
	// B never reaches the game once it is the pause key, and Keen needs it for
	// save names and B-A-T. Ctrl is Jump, Alt is Pogo.
	if s.PauseKeyName() != "f11" {
		t.Errorf("pause key default = %q, want f11", s.PauseKeyName())
	}
	if s.TurboKeyName() != "shift" {
		t.Errorf("turbo key default = %q, want shift", s.TurboKeyName())
	}
	if !s.Vsync || s.OutputMode() != "opengl" {
		t.Errorf("display defaults: vsync=%v output=%q", s.Vsync, s.OutputMode())
	}
	for _, bad := range []string{"ctrl", "alt", "space", ""} {
		s.TurboKey = bad
		if s.TurboKeyName() != "shift" {
			t.Errorf("turbo_key %q must fall back to shift, got %q", bad, s.TurboKeyName())
		}
	}
}

func TestTurboEnv(t *testing.T) {
	s := DefaultSettings()
	s.TurboFrameskip = 99 // hand-edited out of range
	env := strings.Join(s.TurboEnv(), " ")
	for _, want := range []string{"KEEN_FF_KEY=shift", "KEEN_FF_FRAMESKIP=6", "KEEN_PAUSE_KEY=f11"} {
		if !strings.Contains(env, want) {
			t.Errorf("env %q missing %s", env, want)
		}
	}
}

func TestSurfaceOutputHasNoShader(t *testing.T) {
	s := DefaultSettings()
	if !s.UsesGLShader() {
		t.Error("opengl must support glshader")
	}
	s.Output = "surface"
	if s.UsesGLShader() {
		t.Error("surface cannot run a glshader")
	}
	s.Output = "direct3d" // not offered on Linux
	if s.OutputMode() != "opengl" {
		t.Errorf("unknown output must fall back to opengl, got %q", s.OutputMode())
	}
}
