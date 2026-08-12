// Command keen456-gui is the settings window and launcher panel — what the
// desktop entry opens.
//
// It is a separate binary, and a separate Go module, on purpose: the launcher
// stays a static CGO_ENABLED=0 executable with no external dependencies, and
// only this one links a GUI toolkit.
//
// Settings are read from and written to the same
// ~/.config/keen456/settings.ini the launcher reads, so hand-editing still
// works.
package main

import (
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"fyne.io/fyne/v2"
	fyneapp "fyne.io/fyne/v2/app"
	"fyne.io/fyne/v2/container"
	"fyne.io/fyne/v2/dialog"
	"fyne.io/fyne/v2/layout"
	"fyne.io/fyne/v2/storage"
	"fyne.io/fyne/v2/theme"
	"fyne.io/fyne/v2/widget"

	"keen456/core"
)

// filters are the friendly names settings.ini accepts, in the same order the
// in-game V key cycles them.
var filters = []string{"none", "scanlines", "soft", "soft-scanlines", "crt", "crt-curved"}

type ui struct {
	win fyne.Window
	set core.Settings

	episode  *widget.Select
	dirs     map[string]*widget.Entry // episode id -> game-files path
	dirNotes map[string]*widget.Label

	filter    *widget.Select
	rendering *widget.Select
	pogo      *widget.Check
	pogoHold  *widget.Entry

	sync      *widget.Check
	server    *widget.Entry
	key       *widget.Entry
	token     *widget.Entry
	syncState *widget.Label
}

func epLabel(ep core.Episode) string {
	return fmt.Sprintf("Keen %d — %s", ep.Num, ep.Title)
}

func main() {
	a := fyneapp.NewWithID("dev.awkto.keen456")
	w := a.NewWindow("Commander Keen 4/5/6")

	u := &ui{win: w, set: core.Load(),
		dirs: map[string]*widget.Entry{}, dirNotes: map[string]*widget.Label{}}
	w.SetContent(u.build())
	w.Resize(fyne.NewSize(560, 720))
	w.CenterOnScreen()
	// Surface an unresolved first link as soon as the window opens, rather
	// than waiting for the user to press Test connection.
	go func() { time.Sleep(300 * time.Millisecond); fyne.Do(func() { u.checkSync(false) }) }()
	w.ShowAndRun()
}

func (u *ui) build() fyne.CanvasObject {
	var epNames []string
	for _, ep := range core.Episodes {
		epNames = append(epNames, epLabel(ep))
	}
	u.episode = widget.NewSelect(epNames, nil)
	u.episode.SetSelected(epLabel(u.set.StartEpisode()))

	u.filter = widget.NewSelect(filters, nil)
	u.filter.SetSelected(u.currentFilter())

	u.rendering = widget.NewSelect([]string{"smooth", "crisp"}, nil)
	if u.set.Rendering == "" {
		u.set.Rendering = "smooth"
	}
	u.rendering.SetSelected(u.set.Rendering)

	u.pogo = widget.NewCheck("Holding Alt does the Pogo+Jump super-bounce", nil)
	u.pogo.SetChecked(u.set.Pogo)
	u.pogoHold = widget.NewEntry()
	u.pogoHold.SetPlaceHolder("180")
	if u.set.PogoHold < 0 {
		u.pogoHold.SetText("off")
	} else {
		u.pogoHold.SetText(strconv.Itoa(u.set.PogoHold))
	}
	u.pogoHold.Validator = func(s string) error {
		s = strings.TrimSpace(s)
		if s == "" || s == "off" {
			return nil
		}
		if n, err := strconv.Atoi(s); err != nil || n < 0 {
			return fmt.Errorf("milliseconds, or \"off\"")
		}
		return nil
	}

	display := widget.NewForm(
		widget.NewFormItem("Video filter", u.filter),
		widget.NewFormItem("Pixels", u.rendering),
	)
	controls := widget.NewForm(
		widget.NewFormItem("Desktop pogo", u.pogo),
		widget.NewFormItem("Auto-retract after", container.NewBorder(nil, nil, nil,
			widget.NewLabel("ms held"), u.pogoHold)),
	)

	return container.NewBorder(nil, u.buttons(), nil, nil,
		container.NewVScroll(container.NewVBox(
			section("Episode"),
			widget.NewForm(widget.NewFormItem("Play", u.episode)),
			widget.NewSeparator(),
			section("Game files"), u.gameFilesBox(),
			widget.NewSeparator(),
			section("Display"), display,
			widget.NewSeparator(),
			section("Controls"), controls,
			widget.NewSeparator(),
			section("Save sync"), u.syncBox(),
		)),
	)
}

// gameFilesBox is where the multi-episode part of this build lives: Keen 4
// shareware ships with the package, Keen 5 and 6 never can, so the user points
// the app at their own copy and it runs in place.
func (u *ui) gameFilesBox() fyne.CanvasObject {
	items := []*widget.FormItem{}
	for _, ep := range core.Episodes {
		ep := ep
		e := widget.NewEntry()
		e.SetText(u.set.EpisodeDir(ep))
		if ep.Shareware() {
			e.SetPlaceHolder("shareware included — set only for the registered version")
		} else {
			e.SetPlaceHolder(fmt.Sprintf("directory holding EGAGRAPH.CK%d, KEEN%d*.EXE …",
				ep.Num, ep.Num))
		}
		note := widget.NewLabel("")
		note.Wrapping = fyne.TextWrapWord
		e.OnChanged = func(string) { u.refreshDirNote(ep) }
		browse := widget.NewButtonWithIcon("", theme.FolderOpenIcon(), func() {
			d := dialog.NewFolderOpen(func(lu fyne.ListableURI, err error) {
				if err != nil || lu == nil {
					return
				}
				e.SetText(lu.Path())
			}, u.win)
			if p := strings.TrimSpace(e.Text); p != "" {
				if lu, err := storage.ListerForURI(storage.NewFileURI(p)); err == nil {
					d.SetLocation(lu)
				}
			}
			d.Resize(fyne.NewSize(560, 480))
			d.Show()
		})
		u.dirs[ep.ID], u.dirNotes[ep.ID] = e, note
		items = append(items,
			widget.NewFormItem(fmt.Sprintf("Keen %d", ep.Num),
				container.NewBorder(nil, nil, nil, browse, e)),
			widget.NewFormItem("", note))
		u.refreshDirNote(ep)
	}
	hint := widget.NewLabel("Keen 5 and 6 are commercial: they run from your own files, " +
		"in place — in-game saves land there too. With save sync on, the game files " +
		"come from the sync server instead and these paths are ignored.")
	hint.Wrapping = fyne.TextWrapWord
	return container.NewVBox(widget.NewForm(items...), hint)
}

// refreshDirNote says, in one line, whether the path currently typed can
// actually run that episode — the check the launcher would do at startup.
func (u *ui) refreshDirNote(ep core.Episode) {
	note := u.dirNotes[ep.ID]
	if note == nil {
		return
	}
	p := strings.TrimSpace(u.dirs[ep.ID].Text)
	if p == "" {
		if ep.Shareware() {
			note.SetText("Using the bundled shareware episode.")
		} else {
			note.SetText("")
		}
		return
	}
	exe, err := core.ValidateGameDir(p, ep)
	if err != nil {
		note.SetText("✗ " + err.Error())
		return
	}
	if ep.Num == 6 && !strings.EqualFold(exe, "KEEN6C.EXE") {
		// Playable, but not without the manual on the desk — so not a plain ✓.
		note.SetText("⚠ runs " + exe + " — the stock executable asks the manual " +
			"question at startup; add KEEN6C.EXE to skip it.")
		return
	}
	note.SetText("✓ runs " + exe)
}

// syncBox: three typed fields, validated, plus the one thing that matters —
// whether any of it actually works.
func (u *ui) syncBox() fyne.CanvasObject {
	u.sync = widget.NewCheck("Keep saves on a server (cross-play with the web app)", nil)
	u.sync.SetChecked(u.set.Sync)

	u.server = widget.NewEntry()
	u.server.SetPlaceHolder("https://keen456.example.com/")
	u.server.SetText(u.set.SyncBase)
	u.server.Validator = func(s string) error {
		s = strings.TrimSpace(s)
		if s == "" {
			return nil // only required when sync is on; checked on save
		}
		p, err := url.Parse(s)
		if err != nil || p.Host == "" || (p.Scheme != "http" && p.Scheme != "https") {
			return fmt.Errorf("must be a full http(s):// URL")
		}
		return nil
	}

	u.key = widget.NewEntry()
	u.key.SetPlaceHolder(u.storedKey())
	u.key.SetText(u.set.SyncKey)
	u.key.Validator = func(s string) error {
		if strings.TrimSpace(s) == "" || core.NormalizeSyncKey(s) != "" {
			return nil
		}
		return fmt.Errorf("4-32 letters and digits")
	}
	copyKey := widget.NewButtonWithIcon("", theme.ContentCopyIcon(), func() {
		k := core.NormalizeSyncKey(u.key.Text)
		if k == "" {
			k = u.storedKey()
		}
		u.win.Clipboard().SetContent(k)
	})

	u.token = widget.NewPasswordEntry()
	u.token.SetPlaceHolder("only for servers started with SYNC_TOKEN")
	u.token.SetText(u.set.SyncToken)

	u.syncState = widget.NewLabel("")
	u.syncState.Wrapping = fyne.TextWrapWord
	test := widget.NewButton("Test connection", func() { u.checkSync(true) })

	form := widget.NewForm(
		widget.NewFormItem("Server", u.server),
		widget.NewFormItem("Save key", container.NewBorder(nil, nil, nil, copyKey, u.key)),
		widget.NewFormItem("Token", u.token),
	)
	note := widget.NewLabel("One key covers all three episodes — each has its own slot " +
		"on the server. Type the key into the web app to continue the same saves there. " +
		"Cross-play travels through Keen's own in-game saves; quick save states stay on " +
		"the machine that wrote them.")
	note.Wrapping = fyne.TextWrapWord
	// The status label gets its own full-width row rather than sitting beside
	// the button: a wrapping label in an HBox is given its minimum width, which
	// is one character, and the text comes out as a vertical column.
	return container.NewVBox(u.sync, form,
		container.NewHBox(test), u.syncState, note)
}

// checkSync runs the real client against the real server, per episode, and if
// an episode has no shared history it asks instead of guessing.
func (u *ui) checkSync(explicit bool) {
	s := u.collect()
	if !s.Sync || strings.TrimSpace(s.SyncBase) == "" {
		if explicit {
			u.syncState.SetText("Turn sync on and set a server URL first")
		}
		return
	}
	u.syncState.SetText("Checking…")
	go func() {
		lay, err := core.ResolveLayout()
		if err != nil {
			fyne.Do(func() { u.syncState.SetText(err.Error()) })
			return
		}
		meta := filepath.Join(lay.Share, "jsdos-meta")
		var lines []string
		var ask *core.Syncer
		var askSt core.SyncStatus
		for _, ep := range core.Episodes {
			sy, err := core.NewSyncer(s, ep, core.ManagedGameDir(ep), meta)
			if err != nil {
				lines = append(lines, err.Error())
				break
			}
			st := sy.Status()
			switch {
			case st.Err != "":
				lines = append(lines, st.Err)
				// A server-level failure is the same for every episode.
				fyne.Do(func() { u.syncState.SetText(strings.Join(lines, "\n")) })
				return
			case st.NeedsDecision:
				lines = append(lines, fmt.Sprintf("Keen %d: not linked yet — choose which save to keep", ep.Num))
				if ask == nil {
					ask, askSt = sy, st
				}
			case st.RemoteModified == 0:
				lines = append(lines, fmt.Sprintf("Keen %d: nothing on the server yet", ep.Num))
			default:
				lines = append(lines, fmt.Sprintf("Keen %d: linked — server save from %s",
					ep.Num, humanAge(time.UnixMilli(st.RemoteModified))))
			}
		}
		key := "?"
		if sy, err := core.NewSyncer(s, core.Episodes[0], core.ManagedGameDir(core.Episodes[0]), meta); err == nil {
			key = sy.Key()
		}
		text := "Connected as " + key + "\n" + strings.Join(lines, "\n")
		fyne.Do(func() {
			u.syncState.SetText(text)
			if ask != nil {
				u.askWhichSave(ask, askSt)
			}
		})
	}()
}

// askWhichSave is the case a machine must not decide for itself: this device
// has never synced this episode with this key, and there is already a save on
// it. Comparing timestamps across two machines that never exchanged anything
// is not conflict resolution, so both copies are described and the user picks.
func (u *ui) askWhichSave(sy *core.Syncer, st core.SyncStatus) {
	ep := sy.Episode()
	local := "no in-game saves yet (nothing has been played here)"
	if st.LocalSaves > 0 {
		local = fmt.Sprintf("%d in-game save(s), newest %s",
			st.LocalSaves, humanAge(time.UnixMilli(st.LocalSaveTime)))
	}
	body := widget.NewRichTextFromMarkdown(fmt.Sprintf(
		"This device has never synced **Keen %d** with save key **%s**, and there "+
			"is already a save on the server.\n\n"+
			"- **On the server:** %s (%d KB)\n"+
			"- **On this computer:** %s\n\n"+
			"Whichever you keep, the other is not deleted: the local copy is "+
			"backed up first, and the web app's own quicksave inside the "+
			"server bundle is preserved either way.",
		ep.Num, st.Key, humanAge(time.UnixMilli(st.RemoteModified)),
		st.RemoteSize/1024, local))
	body.Wrapping = fyne.TextWrapWord

	var d dialog.Dialog
	useCloud := widget.NewButton("Use the server's save", func() {
		d.Hide()
		u.syncState.SetText("Downloading the server's save…")
		go func() {
			backup, err := sy.AdoptCloud()
			fyne.Do(func() {
				if err != nil {
					dialog.ShowError(err, u.win)
					u.syncState.SetText("Could not take the server's save")
					return
				}
				msg := fmt.Sprintf("Keen %d now uses the server's save", ep.Num)
				if backup != "" {
					msg += " (previous local copy backed up)"
				}
				u.syncState.SetText(msg)
			})
		}()
	})
	useCloud.Importance = widget.HighImportance
	keepLocal := widget.NewButton("Keep this computer's save", func() {
		d.Hide()
		u.syncState.SetText("Uploading this computer's save…")
		go func() {
			err := sy.AdoptLocal()
			fyne.Do(func() {
				if err != nil {
					dialog.ShowError(err, u.win)
					u.syncState.SetText("Could not upload the local save")
					return
				}
				u.syncState.SetText(fmt.Sprintf("Server now has this computer's Keen %d save", ep.Num))
			})
		}()
	})
	later := widget.NewButton("Decide later", func() {
		d.Hide()
		u.syncState.SetText("Not linked — nothing syncs for this episode until you choose")
	})

	d = dialog.NewCustomWithoutButtons(
		fmt.Sprintf("Which Keen %d save should this device use?", ep.Num),
		container.NewBorder(nil,
			container.NewHBox(later, layout.NewSpacer(), keepLocal, useCloud),
			nil, nil, body),
		u.win)
	d.Resize(fyne.NewSize(540, 360))
	d.Show()
}

func (u *ui) buttons() fyne.CanvasObject {
	save := widget.NewButton("Save", func() {
		if u.save() {
			u.syncState.SetText("Settings saved")
		}
	})
	play := widget.NewButtonWithIcon("Play", theme.MediaPlayIcon(), func() {
		if !u.save() {
			return
		}
		ep := u.selectedEpisode()
		if _, err := core.ResolveSource(u.set, ep); err != nil {
			dialog.ShowError(err, u.win)
			return
		}
		exe, err := core.LauncherPath()
		if err != nil {
			dialog.ShowError(err, u.win)
			return
		}
		cmd := exec.Command(exe, strconv.Itoa(ep.Num))
		cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
		if err := cmd.Start(); err != nil {
			dialog.ShowError(err, u.win)
			return
		}
		// The game owns the screen from here; don't leave a stray window
		// behind it. Settings are already on disk.
		u.win.Close()
	})
	play.Importance = widget.HighImportance

	logBtn := widget.NewButton("Open log folder", func() {
		_ = exec.Command("xdg-open", core.DataDir()).Start()
	})
	return container.NewVBox(
		widget.NewSeparator(),
		container.NewHBox(logBtn, layout.NewSpacer(), save, play),
	)
}

func (u *ui) selectedEpisode() core.Episode {
	for _, ep := range core.Episodes {
		if epLabel(ep) == u.episode.Selected {
			return ep
		}
	}
	return core.Episodes[0]
}

// collect turns the widget state into Settings without touching disk.
func (u *ui) collect() core.Settings {
	s := u.set
	s.Episode = u.selectedEpisode().Num
	s.GameDirs = map[string]string{}
	for _, ep := range core.Episodes {
		if e := u.dirs[ep.ID]; e != nil {
			if p := strings.TrimSpace(e.Text); p != "" {
				s.GameDirs[ep.ID] = p
			}
		}
	}
	s.Filter = u.filter.Selected
	s.Rendering = u.rendering.Selected
	s.Pogo = u.pogo.Checked
	switch h := strings.TrimSpace(u.pogoHold.Text); h {
	case "off":
		s.PogoHold = -1
	case "":
		s.PogoHold = 180
	default:
		if n, err := strconv.Atoi(h); err == nil && n >= 0 {
			s.PogoHold = n
		}
	}
	s.Sync = u.sync.Checked
	s.SyncBase = strings.TrimSpace(u.server.Text)
	s.SyncToken = strings.TrimSpace(u.token.Text)
	if k := core.NormalizeSyncKey(u.key.Text); k != "" {
		s.SyncKey = k
	} else if strings.TrimSpace(u.key.Text) == "" {
		s.SyncKey = "" // fall back to the generated sync-key file
	}
	return s
}

// save validates, writes settings.ini and reports whether it succeeded.
func (u *ui) save() bool {
	s := u.collect()
	if s.Sync {
		if err := u.server.Validate(); err != nil || strings.TrimSpace(s.SyncBase) == "" {
			dialog.ShowError(fmt.Errorf("save sync needs a full http(s):// server URL"), u.win)
			return false
		}
	}
	if err := u.key.Validate(); err != nil {
		dialog.ShowError(fmt.Errorf("save key: %w", err), u.win)
		return false
	}
	if err := u.pogoHold.Validate(); err != nil {
		dialog.ShowError(fmt.Errorf("auto-retract: %w", err), u.win)
		return false
	}
	// A game-files path that cannot run its episode is refused here rather
	// than at the next launch, where the message would arrive without the
	// field that caused it.
	for _, ep := range core.Episodes {
		p := strings.TrimSpace(s.GameDirs[ep.ID])
		if p == "" {
			continue
		}
		if _, err := core.ValidateGameDir(p, ep); err != nil {
			dialog.ShowError(fmt.Errorf("Keen %d game files: %w", ep.Num, err), u.win)
			return false
		}
	}
	if err := core.Save(s); err != nil {
		dialog.ShowError(err, u.win)
		return false
	}
	u.set = s
	return true
}

// currentFilter maps settings.ini's free-form filter value onto the dropdown,
// which only offers the six friendly names. Anything else (a raw DOSBox-X
// shader name or a path, both still valid in the file) shows as its own entry
// rather than being silently rewritten.
func (u *ui) currentFilter() string {
	f := u.set.Filter
	if f == "" {
		return "none"
	}
	for _, k := range filters {
		if k == f {
			return f
		}
	}
	u.filter.Options = append(append([]string{}, filters...), f)
	return f
}

// storedKey is the key sync would use right now, for display only — it never
// generates one, so opening the window doesn't create a save identity.
func (u *ui) storedKey() string {
	if k := core.NormalizeSyncKey(u.set.SyncKey); k != "" {
		return k
	}
	b, err := os.ReadFile(filepath.Join(core.ConfigDir(), "sync-key"))
	if err != nil {
		return "generated on first sync"
	}
	if k := strings.TrimSpace(string(b)); k != "" {
		return k
	}
	return "generated on first sync"
}

func section(title string) fyne.CanvasObject {
	l := widget.NewLabel(title)
	l.TextStyle = fyne.TextStyle{Bold: true}
	return l
}

func humanAge(t time.Time) string {
	d := time.Since(t)
	switch {
	case d < time.Minute:
		return "just now"
	case d < time.Hour:
		return strconv.Itoa(int(d.Minutes())) + " min ago"
	case d < 24*time.Hour:
		return strconv.Itoa(int(d.Hours())) + " h ago"
	}
	return t.Format("2 Jan 15:04")
}
