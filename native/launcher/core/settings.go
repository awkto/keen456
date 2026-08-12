package core

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// Settings is the flat key=value file the user can edit by hand, and what the
// settings window reads and writes.
//
// Rendering and filter defaults are deliberately the ones the zeliard native
// build ships (smooth + scanlines) rather than the web keen456 defaults
// (crisp): the filter machinery is shared code, and the native builds behave
// the same way as each other.
type Settings struct {
	Episode  int               // last played, and what `keen456` with no argument starts
	GameDirs map[string]string // episode id -> the user's own game directory

	Pogo      bool   // Alt does the Pogo+Jump super-bounce (web parity)
	PogoHold  int    // ms Alt must be held for the auto-retract tap; -1 = off
	Rendering string // smooth | crisp
	Filter    string // none | scanlines | soft | soft-scanlines | crt | crt-curved | any shader

	Sync      bool   // server-side save sync
	SyncBase  string // base URL of a keen456 container
	SyncKey   string // optional key override (web-style, e.g. AWKX) — else sync-key file
	SyncToken string // optional bearer token for servers that require auth
}

const defaultPogoHold = 180

func DefaultSettings() Settings {
	return Settings{
		Episode:   4,
		GameDirs:  map[string]string{},
		Pogo:      true,
		PogoHold:  defaultPogoHold,
		Rendering: "smooth",
		Filter:    "scanlines",
	}
}

// EpisodeDir is the user's own directory for an episode, or "" if they have
// not pointed the app at one.
func (s Settings) EpisodeDir(ep Episode) string { return s.GameDirs[ep.ID] }

// SetEpisodeDir records the directory `--game-files` pointed at, so the flag
// is only ever needed once.
func (s *Settings) SetEpisodeDir(ep Episode, dir string) {
	if s.GameDirs == nil {
		s.GameDirs = map[string]string{}
	}
	s.GameDirs[ep.ID] = dir
}

// StartEpisode is the episode `keen456` with no argument runs.
func (s Settings) StartEpisode() Episode {
	for _, e := range Episodes {
		if e.Num == s.Episode {
			return e
		}
	}
	return Episodes[0]
}

func onOff(b bool) string {
	if b {
		return "on"
	}
	return "off"
}

// renderSettings produces settings.ini content for s — the same commented file
// whether it's the first-run default or a write-back from the settings UI.
func renderSettings(s Settings) string {
	hold := strconv.Itoa(s.PogoHold)
	if s.PogoHold < 0 {
		hold = "off"
	}
	return `# Commander Keen 4/5/6 native settings — edit and restart the game.

# episode: which episode ` + "`keen456`" + ` starts with no argument (4, 5 or 6).
# Updated automatically to the last one you played.
episode = ` + strconv.Itoa(s.Episode) + `

# keen4_dir / keen5_dir / keen6_dir: your own copy of an episode's game files.
#   Keen 4 shareware ships with this package, so keen4_dir is only needed for
#   the registered version. Keen 5 and 6 are commercial and are never bundled:
#   point these at the directory holding EGAGRAPH.CK5 / KEEN5.EXE and so on.
#   The game runs IN PLACE there, so its in-game saves land there too.
#   Set by ` + "`keen456 5 --game-files /path/to/keen5`" + `; ignored while sync
#   is on, because then the game files come from the sync server instead.
keen4_dir = ` + s.GameDirs["keen4"] + `
keen5_dir = ` + s.GameDirs["keen5"] + `
keen6_dir = ` + s.GameDirs["keen6"] + `

# pogo: on/off — holding Alt does the Pogo+Jump super-bounce (parity with the
#   web build's "pogo on desktop Alt"): Jump is injected just after Alt, and
#   releasing Alt after pogo_hold milliseconds taps it once more to retract the
#   pogo. pogo_hold = off keeps the super-bounce without the auto-retract.
pogo = ` + onOff(s.Pogo) + `
pogo_hold = ` + hold + `

# rendering: smooth (blurred/bilinear pixels) or crisp (sharp pixels)
# filter: none / scanlines / soft / soft-scanlines / crt / crt-curved —
#   or any DOSBox-X shader name (scan3x, tv2x, rgb2x, advmame2x, ...) or a
#   path to your own .glsl.
#   soft = soft pixels (blur + saturation, like the web app's smooth look);
#   soft-scanlines = soft pixels + scanlines combined.
#   A filter other than "none" takes precedence over the rendering choice.
#   In-game, V cycles through all six for the session (the value here stays
#   the startup default).
rendering = ` + s.Rendering + `
filter = ` + s.Filter + `

# sync: on/off — keep saves on a server too, shared across devices AND with
# the web app (the same save continues in the browser — cross-play). Each
# episode has its own slot on the server, so one key covers all three.
# sync_base: URL of a keen456 container, e.g. https://keen456.example.com/
# sync_key: the save's identity — the same short code the web app shows
#   (e.g. AWKX). Set it here to link this device to an existing web save.
#   Left empty, the key in the sync-key file next to this file is used
#   (generated on first sync; web-compatible). Copy either to share a save.
# sync_token: only for servers that require auth (sent as a Bearer token);
#   leave empty for open/home-LAN servers.
sync = ` + onOff(s.Sync) + `
sync_base = ` + s.SyncBase + `
sync_key = ` + s.SyncKey + `
sync_token = ` + s.SyncToken + `
`
}

// Save writes s to settings.ini.
func Save(s Settings) error {
	if err := os.MkdirAll(ConfigDir(), 0o755); err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(ConfigDir(), "settings.ini"),
		[]byte(renderSettings(s)), 0o644)
}

// GLShader maps the rendering/filter settings onto a DOSBox-X glshader value:
// a built-in shader name, or the path of a bundled .glsl under shaderDir.
// Besides the friendly aliases, any other filter value is passed straight
// through to DOSBox-X — a built-in shader name (scan3x, tv2x, advmame2x, …),
// a bundled .glsl basename, or an absolute path to the user's own shader.
func (s Settings) GLShader(shaderDir string) string {
	switch s.Filter {
	case "none", "":
		if s.Rendering == "crisp" {
			return "sharp"
		}
		return "none"
	case "scanlines":
		// Sine-profile lines at game-row pitch (like the web overlay) — they
		// scale with the window instead of thinning out on HiDPI.
		return filepath.Join(shaderDir, "keen-scanlines.glsl")
	case "soft":
		// Soft pixels: blur + saturation, the web "soft" minus its scanlines.
		return filepath.Join(shaderDir, "keen-soft.glsl")
	case "soft-scanlines", "combo":
		return filepath.Join(shaderDir, "keen-soft-scanlines.glsl")
	case "crt":
		return filepath.Join(shaderDir, "crt-easymode.glsl")
	case "crt-curved":
		return filepath.Join(shaderDir, "crt-geom.glsl")
	}
	if p := filepath.Join(shaderDir, s.Filter+".glsl"); fileExists(p) {
		return p
	}
	return s.Filter
}

// FilterCycle is the glshader list the in-game V key cycles through (patched
// DOSBox-X, KEEN_FILTERS env): the six friendly filters, with "none" honoring
// the rendering choice the same way GLShader does.
func (s Settings) FilterCycle(shaderDir string) string {
	none := "none"
	if s.Rendering == "crisp" {
		none = "sharp"
	}
	return strings.Join([]string{
		none,
		filepath.Join(shaderDir, "keen-scanlines.glsl"),
		filepath.Join(shaderDir, "keen-soft.glsl"),
		filepath.Join(shaderDir, "keen-soft-scanlines.glsl"),
		filepath.Join(shaderDir, "crt-easymode.glsl"),
		filepath.Join(shaderDir, "crt-geom.glsl"),
	}, ":")
}

// Load reads settings.ini, creating a commented default file on first run.
// Unknown keys are reported and ignored.
func Load() Settings {
	s := DefaultSettings()
	path := filepath.Join(ConfigDir(), "settings.ini")
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			Save(s)
		}
		return s
	}
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") || strings.HasPrefix(line, "[") {
			continue
		}
		k, v, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		k, v = strings.TrimSpace(k), strings.TrimSpace(v)
		switch k {
		case "episode":
			if ep, ok := ParseEpisode(v); ok {
				s.Episode = ep.Num
			}
		case "keen4_dir", "keen5_dir", "keen6_dir":
			if v != "" {
				s.GameDirs[strings.TrimSuffix(k, "_dir")] = v
			}
		case "pogo":
			s.Pogo = v != "off" && v != "false" && v != "0"
		case "pogo_hold":
			if v == "off" || v == "false" {
				s.PogoHold = -1
			} else if n, err := strconv.Atoi(v); err == nil && n >= 0 {
				s.PogoHold = n
			}
		case "rendering":
			if v == "smooth" || v == "crisp" {
				s.Rendering = v
			}
		case "filter":
			s.Filter = v
		case "sync":
			s.Sync = v == "on" || v == "true" || v == "1"
		case "sync_base":
			s.SyncBase = v
		case "sync_key":
			s.SyncKey = v
		case "sync_token":
			s.SyncToken = v
		default:
			fmt.Fprintf(os.Stderr, "keen456: settings.ini: unknown key %q ignored\n", k)
		}
	}
	return s
}
