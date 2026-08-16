package com.awkto.keen456

import android.content.Context
import android.util.Log
import java.io.File

/**
 * Install + config plumbing: unpack the bundled Keen 4 shareware into app
 * storage, and generate the DOSBox-X config for whichever episode is about to
 * run. This is the Android counterpart of the desktop launcher's
 * extract-game.sh + conf templating — the emulator itself only knows how to
 * read `<base>/dosbox-x.conf` (patch 0003).
 *
 * Unlike zeliard's single game dir, every episode has its own directory
 * (`<base>/game/keen<n>`) because each is its own C: drive, its own saves and
 * its own sync slot — mirroring the desktop's ManagedGameDir(ep).
 */
object GameSetup {
    private const val TAG = "KeenSetup"
    private const val CONF_ASSET = "dosbox-x.conf.tmpl"
    private const val MAPPER_ASSET = "mapper-keen456.map"

    /**
     * External files dir when available (user-reachable over USB/MTP, so saves
     * and last-run.log can be pulled off the device), internal otherwise. The
     * emulator looks in both, in this same order.
     */
    fun baseDir(ctx: Context): File = ctx.getExternalFilesDir(null) ?: ctx.filesDir

    fun gameDir(ctx: Context, ep: Episode): File = File(File(baseDir(ctx), "game"), ep.id)

    /**
     * Seed the bundled Keen 4 shareware. Idempotent: re-extracts only when the
     * installed marker doesn't match this build, and never overwrites a file
     * that already exists — player saves live in the game dir and an app
     * update must not disturb them (same rule as the desktop's CopyGameFiles).
     */
    fun seedShareware(ctx: Context) {
        val base = baseDir(ctx)
        base.mkdirs()
        val ep = Episodes.byId("keen4")!!
        val game = gameDir(ctx, ep)

        // The marker lives OUTSIDE the game dir: save sync ships the game
        // dir's root files to other platforms, and app bookkeeping must not
        // travel (nor count as save progress — see localModified in SaveSync).
        val stamp = File(base, ".game-installed")
        val want = BuildConfig.VERSION_CODE.toString()
        if (stamp.isFile && stamp.readText().trim() == want && Episodes.hasGameFiles(game, ep)) {
            Log.i(TAG, "shareware already installed (build $want) at $game")
            return
        }
        Log.i(TAG, "installing Keen 4 shareware into $game")
        game.mkdirs()
        val assetDir = "game/${ep.id}"
        for (name in ctx.assets.list(assetDir).orEmpty()) {
            val dest = File(game, name)
            if (dest.exists()) continue
            ctx.assets.open("$assetDir/$name").use { input ->
                dest.outputStream().use { output -> input.copyTo(output) }
            }
            dest.setLastModified(ASSET_MTIME_MS)
        }
        stamp.writeText(want)
    }

    /**
     * Write the config the emulator will boot with. Regenerated every launch:
     * the paths are absolute and can move between installs, and the episode
     * (and so `${RUNCMD}`) changes between sessions. Also refreshes the
     * mapper file next to it.
     *
     * Returns null with a reason when the episode can't run yet (commercial
     * episode, no files) — the picker shows that instead of launching.
     */
    fun prepare(ctx: Context, ep: Episode): String? {
        seedShareware(ctx)
        val base = baseDir(ctx)
        val game = gameDir(ctx, ep)
        val exe = Episodes.findExecutable(game, ep)
            ?: return "Keen ${ep.num} is a commercial episode — import your own game files first."

        ctx.assets.open(MAPPER_ASSET).use { input ->
            File(base, MAPPER_ASSET).outputStream().use { input.copyTo(it) }
        }

        val conf = File(base, "dosbox-x.conf")
        val text = ctx.assets.open(CONF_ASSET).bufferedReader().use { it.readText() }
            .replace("\${GAME_DIR}", game.absolutePath)
            .replace("\${DATA_DIR}", base.absolutePath)
            .replace("\${RUNCMD}", exe)
        conf.writeText(text)
        Log.i(TAG, "wrote ${conf.absolutePath} (episode ${ep.id}, $exe)")
        return null
    }

    /**
     * Whether Keen 4's installed data is the registered version rather than the
     * bundled shareware. The player gets it here by importing their own files
     * (PickerActivity) or by save sync pulling the web app's bundle. Detected by
     * comparing GAMEMAPS.CK4's size against the bundled shareware copy — the
     * registered release's maps file differs, and this needs no marker that
     * sync or an import could miss. Non-shareware episodes are trivially "full":
     * any files they have are the player's own.
     */
    fun isFullVersion(ctx: Context, ep: Episode): Boolean {
        if (!ep.shareware) return true
        val name = "GAMEMAPS.CK${ep.num}"
        val installed = File(gameDir(ctx, ep), name)
        if (!installed.isFile) return false
        val assetLen = try {
            ctx.assets.open("game/${ep.id}/$name").use { ins ->
                var total = 0L
                val buf = ByteArray(8192)
                while (true) {
                    val r = ins.read(buf)
                    if (r < 0) break
                    total += r
                }
                total
            }
        } catch (e: Exception) {
            return false
        }
        return installed.length() != assetLen
    }

    /**
     * Extracted/imported files get a FIXED old mtime, not "now". Save sync
     * compares newest-file mtimes across devices (newer wins), so a fresh
     * install stamped with the install time would look newer than a real save
     * made yesterday and clobber it. The desktop launcher preserves the
     * bundle's own timestamps for the same reason.
     */
    const val ASSET_MTIME_MS = 1577836800000L // 2020-01-01T00:00:00Z
}
