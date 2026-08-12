// Command keen456 starts Commander Keen 4, 5 or 6: the AppImage's AppRun, and
// /usr/bin/keen456 in the Debian package. It gives the bundled, preconfigured
// DOSBox-X a persistent home and runs it.
//
//   - copies the bundled Keen 4 shareware to
//     $XDG_DATA_HOME/keen456/game/keen4 on first run (the DOS game writes its
//     in-game saves next to its own binaries, so the directory must be
//     writable and must outlive the install),
//   - runs Keen 5/6 from the directory the user pointed at with --game-files,
//     or from the app-managed directory the sync server filled,
//   - regenerates dosbox-x.conf there from the template on every launch (so
//     config improvements ship with updates while the game dir is preserved),
//   - pulls newer saves from the sync server before starting and pushes after,
//   - execs dosbox-x against it.
//
// Settings live in ~/.config/keen456/settings.ini; keen456-gui edits them.
package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"keen456/core"
)

func fatal(err error) {
	fmt.Fprintln(os.Stderr, "keen456: "+err.Error())
	os.Exit(1)
}

func writeConf(tmplPath, confPath, gameDir, dataDir, runCmd, glshader string) error {
	tmpl, err := os.ReadFile(tmplPath)
	if err != nil {
		return err
	}
	conf := strings.ReplaceAll(string(tmpl), "${GAME_DIR}", gameDir)
	conf = strings.ReplaceAll(conf, "${DATA_DIR}", dataDir)
	conf = strings.ReplaceAll(conf, "${RUNCMD}", runCmd)
	conf = strings.ReplaceAll(conf, "${GLSHADER}", glshader)
	return os.WriteFile(confPath, []byte(conf), 0o644)
}

// copyFile always overwrites — used for assets the app owns (conf template,
// mapper), as opposed to the never-overwrite game files.
func copyFile(src, dst string) error {
	data, err := os.ReadFile(src)
	if err != nil {
		return err
	}
	return os.WriteFile(dst, data, 0o644)
}

// launchArgs is what `keen456 [4|5|6] [--game-files DIR]` amounts to.
type launchArgs struct {
	ep        core.Episode
	epGiven   bool
	gameFiles string
}

func parseLaunchArgs(args []string, s core.Settings) (launchArgs, error) {
	la := launchArgs{ep: s.StartEpisode()}
	for i := 0; i < len(args); i++ {
		a := args[i]
		switch {
		case a == "--game-files" || a == "-g":
			if i+1 >= len(args) {
				return la, fmt.Errorf("--game-files needs a directory")
			}
			i++
			la.gameFiles = args[i]
		case strings.HasPrefix(a, "--game-files="):
			la.gameFiles = strings.TrimPrefix(a, "--game-files=")
		case !strings.HasPrefix(a, "-"):
			ep, ok := core.ParseEpisode(a)
			if !ok {
				return la, fmt.Errorf("unknown episode %q — expected 4, 5 or 6", a)
			}
			la.ep, la.epGiven = ep, true
		default:
			return la, fmt.Errorf("unknown option %q — try `keen456 --help`", a)
		}
	}
	return la, nil
}

func main() {
	if runCommand(os.Args[1:]) {
		return
	}
	settings := core.Load()
	la, err := parseLaunchArgs(os.Args[1:], settings)
	if err != nil {
		fatal(err)
	}
	ep := la.ep

	lay, err := core.ResolveLayout()
	if err != nil {
		fatal(err)
	}
	share := lay.Share
	data := core.DataDir()

	// --game-files is remembered, so the flag is only ever needed once. It is
	// validated before being stored: a typo that silently persists would send
	// every later run to a directory with no game in it.
	if la.gameFiles != "" {
		dir, err := filepath.Abs(la.gameFiles)
		if err != nil {
			fatal(err)
		}
		if _, err := core.ValidateGameDir(dir, ep); err != nil {
			fatal(err)
		}
		settings.SetEpisodeDir(ep, dir)
		if err := core.Save(settings); err != nil {
			fatal(err)
		}
		if settings.Sync && strings.TrimSpace(settings.SyncBase) != "" {
			// Storing it is still right — it is what `sync push --force` seeds
			// the server from — but it is not what this run will play from,
			// and saying so beats silently ignoring the flag.
			fmt.Printf("keen456: remembered %s for Keen %d, but sync is on, so the "+
				"game runs from the sync server's copy.\n"+
				"         `keen456 sync push --force -e %d` uploads that directory.\n",
				dir, ep.Num, ep.Num)
		} else {
			fmt.Printf("keen456: Keen %d will run from %s\n", ep.Num, dir)
		}
	}

	src, err := core.ResolveSource(settings, ep)
	if err != nil {
		fatal(err)
	}

	// The bundled shareware seeds its app-managed directory on first run.
	if src.Managed && ep.Shareware() {
		if err := core.CopyGameFiles(filepath.Join(share, "game", ep.ID), src.Dir); err != nil {
			fatal(fmt.Errorf("installing game files to %s: %w", src.Dir, err))
		}
	}

	// Sync owns the app-managed directory when it is on, and for Keen 5/6 the
	// server bundle is also where the game files come from — so pull before
	// checking whether there is anything to run.
	var syncer *core.Syncer
	if src.SyncOwned {
		sy, serr := core.NewSyncer(settings, ep, src.Dir, filepath.Join(share, "jsdos-meta"))
		if serr != nil {
			fmt.Fprintln(os.Stderr, "keen456: sync disabled: "+serr.Error())
		} else {
			syncer = sy
			syncer.Pull()
		}
	}

	runCmd, err := core.ValidateGameDir(src.Dir, ep)
	if err != nil {
		fatal(sourceHint(settings, ep, src, err))
	}

	confPath := filepath.Join(data, "dosbox-x.conf")
	shaderDir := filepath.Join(share, "shaders")
	if err := os.MkdirAll(data, 0o755); err != nil {
		fatal(err)
	}
	if err := writeConf(filepath.Join(share, "dosbox-x.conf.tmpl"), confPath,
		src.Dir, data, strings.ToUpper(runCmd), settings.GLShader(shaderDir)); err != nil {
		fatal(fmt.Errorf("writing %s: %w", confPath, err))
	}
	// Mapper: Ctrl+. / Ctrl+\ save/load state, F fullscreen, Tab (hold) turbo.
	// Owned by the app, refreshed every launch.
	if err := copyFile(filepath.Join(share, "mapper-keen456.map"),
		filepath.Join(data, "mapper-keen456.map")); err != nil {
		fatal(fmt.Errorf("installing mapper: %w", err))
	}
	// Save states are per episode: slot 1 must not mean the same file for
	// Keen 4 and Keen 5.
	statesDir := core.StatesDir(ep)
	if err := os.MkdirAll(statesDir, 0o755); err != nil {
		fatal(err)
	}

	// Remember what was played, so plain `keen456` resumes the same episode.
	if settings.Episode != ep.Num {
		settings.Episode = ep.Num
		if err := core.Save(settings); err != nil {
			fmt.Fprintln(os.Stderr, "keen456: could not record the episode: "+err.Error())
		}
	}

	fmt.Printf("keen456: Keen %d — %s (%s)\n", ep.Num, ep.Title, src.Dir)

	cmd := exec.Command(lay.Dosbox, "-conf", confPath, "-savedir", statesDir, "-log-con")
	cmd.Dir = data
	// last-run.log is written by DOSBox-X itself ([log] logfile in the conf
	// template) — unbuffered, so it's complete even after a crash or kill.
	cmd.Stdout, cmd.Stderr, cmd.Stdin = os.Stdout, os.Stderr, os.Stdin
	cmd.Env = append(os.Environ(),
		"LD_LIBRARY_PATH="+lay.Libs+pathListSuffix(os.Getenv("LD_LIBRARY_PATH")),
	)
	// SDL on X11 (XWayland on Wayland desktops) unless the user overrides —
	// the same combination the filters and fullscreen scheme were tuned on.
	if os.Getenv("SDL_VIDEODRIVER") == "" {
		cmd.Env = append(cmd.Env, "SDL_VIDEODRIVER=x11")
	}
	// Desktop pogo runs inside the patched DOSBox-X (native/patches/) — it
	// feeds the emulated keyboard, so no synthetic host input and no Wayland
	// remote-desktop portal prompts.
	if settings.Pogo {
		hold := fmt.Sprint(settings.PogoHold)
		if settings.PogoHold < 0 {
			hold = "off"
		}
		cmd.Env = append(cmd.Env, "KEEN_POGO=1", "KEEN_POGO_HOLD="+hold)
	}
	// V key cycles video filters in-game (patched DOSBox-X, session-only).
	cmd.Env = append(cmd.Env, "KEEN_FILTERS="+settings.FilterCycle(shaderDir))

	// Server sync: pull already happened above (never races DOSBox-X's own
	// file writes); push periodically and on exit.
	var syncStop, syncDone chan struct{}
	if syncer != nil {
		syncStop, syncDone = make(chan struct{}), make(chan struct{})
		go syncer.Run(syncStop, syncDone)
	}

	err = cmd.Run()

	// Final push of whatever the session saved.
	if syncStop != nil {
		close(syncStop)
		select {
		case <-syncDone:
		case <-time.After(45 * time.Second):
		}
	}

	if err != nil {
		if ee, ok := err.(*exec.ExitError); ok {
			os.Exit(ee.ExitCode())
		}
		fatal(err)
	}
}

// sourceHint turns "there is no game here" into the one sentence that says
// what to do about it, which differs by how the episode was meant to be found.
func sourceHint(s core.Settings, ep core.Episode, src core.Source, err error) error {
	switch {
	case src.SyncOwned && s.EpisodeDir(ep) != "":
		return fmt.Errorf("%w\n\nSync is on, so Keen %d runs from the files on the "+
			"sync server, and its slot is still empty. Seed it once from your own "+
			"copy:\n  keen456 sync push --force -e %d", err, ep.Num, ep.Num)
	case src.SyncOwned:
		return fmt.Errorf("%w\n\nSync is on and the server has no Keen %d yet. Either "+
			"play Keen %d in the browser once (the web app uploads the whole "+
			"bundle), or point this computer at your own copy and seed the "+
			"server:\n  keen456 %d --game-files /path/to/keen%d\n  keen456 sync push "+
			"--force -e %d", err, ep.Num, ep.Num, ep.Num, ep.Num, ep.Num)
	case !src.Managed:
		return fmt.Errorf("%w\n\nThat is the directory Keen %d is configured to use "+
			"(keen%d_dir in settings.ini). Point it somewhere else with:\n"+
			"  keen456 %d --game-files /path/to/keen%d", err, ep.Num, ep.Num, ep.Num, ep.Num)
	}
	return err
}

func pathListSuffix(existing string) string {
	if existing == "" {
		return ""
	}
	return ":" + existing
}

// openSettings hands off to the settings window. Convenience for AppImage
// users, whose single entry point is this binary; the package puts
// keen456-gui on PATH directly.
func openSettings() {
	gui := core.GuiPath()
	if gui == "" {
		fatal(fmt.Errorf("this build has no settings UI; edit %s/settings.ini",
			core.ConfigDir()))
	}
	if err := syscall.Exec(gui, []string{gui}, os.Environ()); err != nil {
		fatal(err)
	}
}
