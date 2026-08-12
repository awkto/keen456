package main

// The `keen456 sync ...` and `keen456 saves ...` subcommands: everything the
// settings window can do to a save, from a terminal.
//
// Design rules, because these commands touch the only copy of something the
// player cannot get back:
//   - nothing destructive happens without --yes, and the prompt says exactly
//     what will be destroyed and what will survive;
//   - anything that overwrites a save writes a backup first, and prints where;
//   - "force" means "I have decided", not "skip the safety" — a forced pull
//     still backs up, and a forced push still preserves the web app's save.
//
// Everything episode-scoped takes `-e 4|5|6`. Left out, a command applies to
// every episode this computer has game files for.

import (
	"bufio"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"keen456/core"
)

const usage = `usage: keen456 [episode] [options]

  keen456                 start the last episode you played (default: 4)
  keen456 4 | 5 | 6       start that episode
  keen456 5 --game-files DIR
                          run Keen 5 from your own copy of the game files
                          (remembered, so the flag is only needed once)
  --settings              open the settings window
  --version, --help

sync                      (-e 4|5|6 — default: every episode you have)
  keen456 sync              sync now: download if the server is newer,
                            upload if this computer is newer
  keen456 sync status       show both sides and the link state
  keen456 sync pull --force take the server's save, whatever the timestamps
                            (backs up this computer's save first)
  keen456 sync push --force upload this computer's save, whatever the
                            timestamps (the web app's save is preserved).
                            Also how an empty server slot is seeded from your
                            own Keen 5/6 files.
  keen456 sync on|off       enable or disable syncing
  keen456 sync key <KEY>    switch to another save key (one key covers all
                            three episodes — the slot keeps them apart)
  keen456 sync key          show the current key
  keen456 sync forget-key   disconnect: sync off, key cleared, nothing deleted
        --delete-remote     also delete the saves stored under that key
  keen456 sync delete-remote --yes
                            delete the server's save for the current key

saves                     (-e 4|5|6 — default: every episode you have)
  keen456 saves list        the in-game saves on this computer
  keen456 saves backup      write a copy of this computer's save to a file
  keen456 saves clear --yes delete this computer's in-game saves
                            (refused while sync is on, so a wipe cannot
                            propagate to the server)

Settings file: %s
Saves and log: %s
`

// runCommand handles a subcommand and reports whether it consumed the
// arguments. Returning false means "no subcommand — start the game".
func runCommand(args []string) bool {
	if len(args) == 0 {
		return false
	}
	switch args[0] {
	case "--version", "-v":
		fmt.Println("keen456 " + core.Version)
	case "--help", "-h", "help":
		fmt.Printf(usage, filepath.Join(core.ConfigDir(), "settings.ini"), core.DataDir())
	case "--settings", "-s":
		openSettings()
	case "sync":
		cmdSync(args[1:])
	case "saves":
		cmdSaves(args[1:])
	default:
		return false
	}
	return true
}

func has(args []string, flag string) bool {
	for _, a := range args {
		if a == flag {
			return true
		}
	}
	return false
}

// episodeFlag pulls `-e N` / `--episode N` out of args.
func episodeFlag(args []string) (core.Episode, bool) {
	for i, a := range args {
		var v string
		switch {
		case a == "-e" || a == "--episode":
			if i+1 < len(args) {
				v = args[i+1]
			}
		case strings.HasPrefix(a, "--episode="):
			v = strings.TrimPrefix(a, "--episode=")
		case strings.HasPrefix(a, "-e="):
			v = strings.TrimPrefix(a, "-e=")
		default:
			continue
		}
		ep, ok := core.ParseEpisode(v)
		if !ok {
			fatal(fmt.Errorf("unknown episode %q — expected 4, 5 or 6", v))
		}
		return ep, true
	}
	return core.Episode{}, false
}

// targets is the list of episodes a command applies to: the one `-e` names, or
// every episode this computer can actually produce game files for.
func targets(args []string) []core.Episode {
	if ep, ok := episodeFlag(args); ok {
		return []core.Episode{ep}
	}
	s := core.Load()
	var out []core.Episode
	for _, ep := range core.Episodes {
		if _, err := core.ResolveSource(s, ep); err == nil {
			out = append(out, ep)
		}
	}
	if len(out) == 0 {
		out = []core.Episode{core.Episodes[0]}
	}
	return out
}

// gameDirFor is the directory this episode's saves live in right now.
func gameDirFor(s core.Settings, ep core.Episode) string {
	src, err := core.ResolveSource(s, ep)
	if err != nil {
		return ""
	}
	return src.Dir
}

// syncerFor builds a client for one episode against the current settings, or
// exits with a message explaining what is missing.
func syncerFor(ep core.Episode) *core.Syncer {
	s := core.Load()
	lay, err := core.ResolveLayout()
	if err != nil {
		fatal(err)
	}
	dir := gameDirFor(s, ep)
	if dir == "" {
		// No local source yet: sync still has somewhere to put the server's
		// copy — the app-managed directory is exactly what it is for.
		dir = core.ManagedGameDir(ep)
	}
	sy, err := core.NewSyncer(s, ep, dir, filepath.Join(lay.Share, "jsdos-meta"))
	if err != nil {
		fatal(err)
	}
	return sy
}

func when(ms int64) string {
	if ms == 0 {
		return "never"
	}
	t := time.UnixMilli(ms)
	return fmt.Sprintf("%s (%s)", t.Format("2006-01-02 15:04"), ago(t))
}

func ago(t time.Time) string {
	d := time.Since(t)
	switch {
	case d < time.Minute:
		return "just now"
	case d < time.Hour:
		return fmt.Sprintf("%d min ago", int(d.Minutes()))
	case d < 24*time.Hour:
		return fmt.Sprintf("%d h ago", int(d.Hours()))
	}
	return fmt.Sprintf("%d days ago", int(d.Hours()/24))
}

func confirm(prompt string) bool {
	fmt.Printf("%s [y/N]: ", prompt)
	line, _ := bufio.NewReader(os.Stdin).ReadString('\n')
	line = strings.ToLower(strings.TrimSpace(line))
	return line == "y" || line == "yes"
}

func cmdSync(args []string) {
	sub := ""
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		sub = args[0]
	}
	switch sub {
	case "", "now":
		for _, ep := range targets(args) {
			syncNow(ep, true)
		}
	case "status":
		for _, ep := range targets(args) {
			syncStatus(ep)
		}
	case "pull", "download":
		for _, ep := range targets(args) {
			syncPull(ep, has(args, "--force"))
		}
	case "push", "upload":
		for _, ep := range targets(args) {
			syncPush(ep, has(args, "--force"))
		}
	case "on":
		setSync(true)
	case "off":
		setSync(false)
	case "key":
		syncKey(args[1:])
	case "forget-key":
		forgetKey(has(args, "--delete-remote"), has(args, "--yes"))
	case "delete-remote":
		for _, ep := range targets(args) {
			deleteRemote(ep, has(args, "--yes"))
		}
	default:
		fatal(fmt.Errorf("unknown sync command %q — try `keen456 --help`", sub))
	}
}

// header names the episode a block of output is about — every sync and saves
// command can span all three.
func header(ep core.Episode) {
	fmt.Printf("== Keen %d — %s\n", ep.Num, ep.Title)
}

// syncNow is the ordinary exchange, also run on game start and game exit.
func syncNow(ep core.Episode, verbose bool) {
	s := core.Load()
	if !s.Sync {
		if verbose {
			fmt.Println("Sync is off. Turn it on with `keen456 sync on`.")
		}
		return
	}
	sy := syncerFor(ep)
	st := sy.Status()
	if st.Err != "" {
		if verbose {
			header(ep)
			fmt.Println(st.Err)
		}
		return
	}
	if st.NeedsDecision {
		if verbose {
			header(ep)
			fmt.Printf("This computer has never synced Keen %d with save key %s, and "+
				"the server already has a save (%s).\n", ep.Num, st.Key, when(st.RemoteModified))
			fmt.Println("Nothing has been changed. Choose one:")
			fmt.Printf("  keen456 sync pull --force -e %d   use the server's save\n", ep.Num)
			fmt.Printf("  keen456 sync push --force -e %d   keep this computer's save\n", ep.Num)
		}
		return
	}
	sy.Pull()
	sy.Push()
	if verbose {
		syncStatus(ep)
	}
}

func syncStatus(ep core.Episode) {
	s := core.Load()
	header(ep)
	fmt.Printf("Sync:     %s\n", onOffStr(s.Sync))
	if strings.TrimSpace(s.SyncBase) == "" {
		fmt.Println("Server:   (not set)")
		fmt.Println()
		return
	}
	fmt.Printf("Server:   %s (slot %s)\n", s.SyncBase, ep.ID)
	sy := syncerFor(ep)
	st := sy.Status()
	fmt.Printf("Save key: %s\n", st.Key)
	if st.Err != "" {
		fmt.Printf("Status:   %s\n\n", st.Err)
		return
	}
	fmt.Printf("\nOn the server:    %s", when(st.RemoteModified))
	if st.RemoteModified != 0 {
		fmt.Printf(", %d KB", st.RemoteSize/1024)
	}
	fmt.Println()
	if st.LocalSaves > 0 {
		fmt.Printf("On this computer: %d in-game save(s), newest %s\n",
			st.LocalSaves, when(st.LocalSaveTime))
	} else {
		fmt.Println("On this computer: no in-game saves yet")
	}
	fmt.Printf("Last agreed:      %s\n", when(core.LastSynced(st.Key, st.Slot)))

	fmt.Println()
	switch {
	case st.NeedsDecision:
		fmt.Println("Not linked yet — this computer has never synced this episode with")
		fmt.Println("this key, and there is already a save on the server. Nothing will")
		fmt.Println("sync automatically until you choose:")
		fmt.Printf("  keen456 sync pull --force -e %d   use the server's save\n", ep.Num)
		fmt.Printf("  keen456 sync push --force -e %d   keep this computer's save\n", ep.Num)
	case st.RemoteModified == 0:
		fmt.Println("Linked. No save on the server yet — it will be created on the")
		fmt.Println("first upload.")
	default:
		fmt.Println("Linked. Newer-wins applies automatically on game start and exit.")
	}
	fmt.Println()
}

func syncPull(ep core.Episode, force bool) {
	sy := syncerFor(ep)
	if !force {
		st := sy.Status()
		if st.NeedsDecision {
			fatal(fmt.Errorf("this computer is not linked to key %s for Keen %d yet — "+
				"`keen456 sync pull --force -e %d` to take the server's save "+
				"(your local save is backed up first)", st.Key, ep.Num, ep.Num))
		}
		sy.Pull()
		syncStatus(ep)
		return
	}
	header(ep)
	backup, err := sy.AdoptCloud()
	if err != nil {
		fatal(err)
	}
	if backup != "" {
		fmt.Printf("Previous save on this computer backed up to:\n  %s\n", backup)
	}
	fmt.Printf("This computer now has the server's Keen %d save.\n\n", ep.Num)
}

func syncPush(ep core.Episode, force bool) {
	s := core.Load()
	sy := syncerFor(ep)
	if !force {
		st := sy.Status()
		if st.NeedsDecision {
			fatal(fmt.Errorf("this computer is not linked to key %s for Keen %d yet — "+
				"`keen456 sync push --force -e %d` to overwrite the server's save "+
				"with this computer's", st.Key, ep.Num, ep.Num))
		}
		sy.Push()
		syncStatus(ep)
		return
	}
	header(ep)
	// Seeding: with sync on, Keen 5/6 run from the app-managed directory, which
	// starts out empty. If the user has their own copy configured, this is the
	// one explicit step that puts it on the server (game files included, which
	// is what makes the episode playable in the browser and on other devices).
	if seeded, err := seedManagedDir(s, ep); err != nil {
		fatal(err)
	} else if seeded != "" {
		fmt.Printf("Seeded the server's Keen %d slot from %s\n", ep.Num, seeded)
	}
	if err := sy.AdoptLocal(); err != nil {
		fatal(err)
	}
	fmt.Printf("Server now has this computer's Keen %d save (the web app's own save\n"+
		"inside the bundle was preserved).\n\n", ep.Num)
}

// seedManagedDir copies the user's own game files into the app-managed
// directory when sync is on and that directory is still empty. Returns the
// source it copied from, or "" if there was nothing to do.
func seedManagedDir(s core.Settings, ep core.Episode) (string, error) {
	if !s.Sync {
		return "", nil
	}
	managed := core.ManagedGameDir(ep)
	if core.HasGameFiles(managed, ep) {
		return "", nil
	}
	own := strings.TrimSpace(s.EpisodeDir(ep))
	if own == "" {
		return "", nil
	}
	if _, err := core.ValidateGameDir(own, ep); err != nil {
		return "", err
	}
	if err := core.CopyGameFiles(own, managed); err != nil {
		return "", err
	}
	// A seed is "these files, as of now" — the source files can be decades
	// old, and an upload stamped 1991 would lose every later comparison.
	now := time.Now()
	entries, _ := os.ReadDir(managed)
	for _, e := range entries {
		if !e.IsDir() {
			os.Chtimes(filepath.Join(managed, e.Name()), now, now)
		}
	}
	return own, nil
}

func setSync(on bool) {
	s := core.Load()
	s.Sync = on
	if err := core.Save(s); err != nil {
		fatal(err)
	}
	fmt.Printf("Sync is now %s.\n", onOffStr(on))
	if on && strings.TrimSpace(s.SyncBase) == "" {
		fmt.Println("Set a server first: sync_base in " +
			filepath.Join(core.ConfigDir(), "settings.ini"))
	}
	if on {
		fmt.Println("Keen 5/6 now run from the files on the sync server; the")
		fmt.Println("keen5_dir/keen6_dir paths are ignored while sync is on.")
	}
}

func syncKey(args []string) {
	s := core.Load()
	if len(args) == 0 || strings.HasPrefix(args[0], "-") {
		// The key is local — settings.ini or the sync-key file — so showing it
		// must not need a server to be configured.
		k, err := core.ResolveSyncKey(s)
		if err != nil {
			fatal(err)
		}
		fmt.Printf("%s\n", k)
		return
	}
	k := core.NormalizeSyncKey(args[0])
	if k == "" {
		fatal(fmt.Errorf("%q is not a valid save key (4-32 letters and digits)", args[0]))
	}
	s.SyncKey = k
	if err := core.Save(s); err != nil {
		fatal(err)
	}
	fmt.Printf("Save key is now %s (all three episodes).\n", k)
	// A new key is a new relationship: nothing is assumed about whose save wins.
	unlinked := false
	for _, ep := range core.Episodes {
		if !core.IsLinked(k, ep.ID) {
			unlinked = true
		}
	}
	if unlinked {
		fmt.Println("This computer has not synced with that key before — run")
		fmt.Println("`keen456 sync status` to see both sides before syncing.")
	}
}

func forgetKey(deleteRemote, yes bool) {
	s := core.Load()
	// Disconnecting is local: it must work even when the server this device
	// was pointed at is gone or was never set. Only --delete-remote needs one.
	key, err := core.ResolveSyncKey(s)
	if err != nil {
		fatal(err)
	}
	if deleteRemote {
		if !yes && !confirm(fmt.Sprintf(
			"Delete the saves stored on the server under key %s, for all three "+
				"episodes? This cannot be undone. Saves on this computer are not "+
				"touched.", key)) {
			fmt.Println("Cancelled.")
			return
		}
		for _, ep := range core.Episodes {
			if err := syncerFor(ep).DeleteRemote(); err != nil {
				fmt.Fprintf(os.Stderr, "keen456: Keen %d: %v\n", ep.Num, err)
			}
		}
		fmt.Printf("Deleted the server's saves for key %s.\n", key)
	}
	core.Unlink(key, "")
	s.Sync = false
	s.SyncKey = ""
	if err := core.Save(s); err != nil {
		fatal(err)
	}
	// The generated key file is the fallback identity; clear it too so the next
	// connection starts clean rather than silently reusing the old one.
	os.Remove(filepath.Join(core.ConfigDir(), "sync-key"))
	fmt.Println("Disconnected: sync is off and the save key is cleared.")
	fmt.Println("Saves on this computer are untouched.")
}

func deleteRemote(ep core.Episode, yes bool) {
	sy := syncerFor(ep)
	key := sy.Key()
	st := sy.Status()
	if st.Err != "" {
		fatal(fmt.Errorf("%s", st.Err))
	}
	if st.RemoteModified == 0 {
		fmt.Printf("There is no Keen %d save on the server for key %s.\n", ep.Num, key)
		return
	}
	if !yes && !confirm(fmt.Sprintf(
		"Delete the server's Keen %d save for key %s (%s, %d KB)? This also removes "+
			"the web app's save stored inside it, and cannot be undone.",
		ep.Num, key, when(st.RemoteModified), st.RemoteSize/1024)) {
		fmt.Println("Cancelled.")
		return
	}
	if err := sy.DeleteRemote(); err != nil {
		fatal(err)
	}
	fmt.Printf("Deleted the server's Keen %d save for key %s. Saves on this computer "+
		"are untouched.\n", ep.Num, key)
}

func cmdSaves(args []string) {
	sub := ""
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		sub = args[0]
	}
	s := core.Load()
	for _, ep := range targets(args) {
		dir := gameDirFor(s, ep)
		switch sub {
		case "", "list":
			listSaves(s, ep, dir)
		case "backup":
			backupSaves(ep, dir)
		case "clear":
			clearSaves(s, ep, dir, has(args, "--yes"))
		default:
			fatal(fmt.Errorf("unknown saves command %q — try `keen456 --help`", sub))
		}
	}
}

func listSaves(s core.Settings, ep core.Episode, dir string) {
	header(ep)
	if dir == "" {
		fmt.Printf("No game files configured — `keen456 %d --game-files DIR`\n\n", ep.Num)
		return
	}
	names, _ := core.SaveFiles(dir, ep)
	for _, n := range names {
		info, err := os.Stat(filepath.Join(dir, n))
		if err != nil {
			continue
		}
		fmt.Printf("  %-16s %s\n", n, when(info.ModTime().UnixMilli()))
	}
	if len(names) == 0 {
		fmt.Println("No in-game saves on this computer yet.")
		fmt.Println("(Keen writes one when you save from its own menu.)")
		fmt.Println()
		return
	}
	fmt.Printf("\n%d in-game save(s) in %s\n\n", len(names), dir)
}

func backupSaves(ep core.Episode, dir string) {
	header(ep)
	if dir == "" {
		fmt.Printf("No game files configured — `keen456 %d --game-files DIR`\n\n", ep.Num)
		return
	}
	if names, _ := core.SaveFiles(dir, ep); len(names) == 0 {
		fmt.Println("Nothing to back up — no in-game saves on this computer.")
		return
	}
	// Deliberately not routed through a Syncer: backing up is local, and must
	// work on a machine with no sync server configured.
	p, err := core.BackupGameDir(dir, ep.ID, "manual")
	if err != nil {
		fatal(err)
	}
	fmt.Printf("Backed up to:\n  %s\n\n", p)
}

func clearSaves(s core.Settings, ep core.Episode, dir string, yes bool) {
	header(ep)
	// Refusing while sync is on is the point: a local wipe would otherwise look
	// like the newest state and propagate to the server on the next push.
	if s.Sync {
		fatal(fmt.Errorf("sync is on — clearing saves now would upload the wipe " +
			"to the server on the next sync.\nDisconnect first " +
			"(`keen456 sync off`, or `keen456 sync forget-key`), then retry"))
	}
	names, _ := core.SaveFiles(dir, ep)
	if len(names) == 0 {
		fmt.Println("No in-game saves to clear.")
		return
	}
	if !yes && !confirm(fmt.Sprintf(
		"Delete %d Keen %d in-game save(s) on this computer? This cannot be undone.",
		len(names), ep.Num)) {
		fmt.Println("Cancelled.")
		return
	}
	removed := 0
	for _, n := range names {
		if err := os.Remove(filepath.Join(dir, n)); err == nil {
			removed++
		}
	}
	fmt.Printf("Deleted %d in-game save(s).\n\n", removed)
}

func onOffStr(b bool) string {
	if b {
		return "on"
	}
	return "off"
}
