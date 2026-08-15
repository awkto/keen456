package com.awkto.zeliard

import android.content.Context
import android.util.Log
import java.io.File

/**
 * First-run install: unpack the bundled game into app storage and generate the
 * DOSBox-X config next to it. This is the Android counterpart of the desktop
 * launcher's extract-game.sh + conf templating — the emulator itself only knows
 * how to read `<base>/dosbox-x.conf` (patch 0003).
 */
object GameSetup {
    private const val TAG = "ZeliardSetup"
    private const val GAME_ASSET_DIR = "game"
    private const val CONF_ASSET = "dosbox-x.conf.tmpl"

    /**
     * External files dir when available (user-reachable over USB/MTP, so saves
     * and last-run.log can be pulled off the device), internal otherwise. The
     * emulator looks in both, in this same order.
     */
    fun baseDir(ctx: Context): File = ctx.getExternalFilesDir(null) ?: ctx.filesDir

    fun gameDir(ctx: Context): File = File(baseDir(ctx), "game")

    /**
     * Idempotent. Re-extracts only when the installed marker doesn't match this
     * build, so player saves written into the game dir survive app restarts but
     * an app update still refreshes the game files.
     */
    fun prepare(ctx: Context) {
        val base = baseDir(ctx)
        val game = gameDir(ctx)
        base.mkdirs()

        // The marker lives OUTSIDE the game dir: save sync ships the game dir's
        // root files to other platforms, and app bookkeeping must not travel
        // (nor count as save progress — see localModified in SaveSync).
        // Installs made before this file moved just re-extract once, which is
        // what an app update does anyway.
        val stamp = File(base, ".game-installed")
        val legacyStamp = File(game, ".installed")
        val want = BuildConfig.VERSION_CODE.toString()
        if (stamp.isFile && stamp.readText().trim() == want) {
            Log.i(TAG, "game already installed (build $want) at $game")
        } else {
            Log.i(TAG, "installing game files into $game")
            game.mkdirs()
            copyAssetDir(ctx, GAME_ASSET_DIR, game)
            stamp.writeText(want)
            legacyStamp.delete()
        }

        // Regenerated every launch: the paths are absolute and can move between
        // installs (and it is how settings will reach the emulator later).
        val conf = File(base, "dosbox-x.conf")
        val text = ctx.assets.open(CONF_ASSET).bufferedReader().use { it.readText() }
            .replace("\${GAME_DIR}", game.absolutePath)
            .replace("\${DATA_DIR}", base.absolutePath)
        conf.writeText(text)
        Log.i(TAG, "wrote ${conf.absolutePath}")
    }

    private fun copyAssetDir(ctx: Context, assetPath: String, dest: File) {
        val entries = ctx.assets.list(assetPath) ?: emptyArray()
        if (entries.isEmpty()) {
            // A leaf: assets.list() returns empty for files as well as empty dirs.
            copyAssetFile(ctx, assetPath, dest)
            return
        }
        dest.mkdirs()
        for (name in entries) {
            copyAssetDir(ctx, "$assetPath/$name", File(dest, name))
        }
    }

    /**
     * Extracted assets get a FIXED old mtime, not "now". Save sync compares
     * newest-file mtimes across devices (newer wins), so a fresh install
     * stamped with the install time would look newer than a real save made
     * yesterday and clobber it. The desktop launcher preserves the bundle's
     * own timestamps for the same reason.
     */
    private const val ASSET_MTIME_MS = 1577836800000L // 2020-01-01T00:00:00Z

    private fun copyAssetFile(ctx: Context, assetPath: String, dest: File) {
        dest.parentFile?.mkdirs()
        ctx.assets.open(assetPath).use { input ->
            dest.outputStream().use { output -> input.copyTo(output) }
        }
        dest.setLastModified(ASSET_MTIME_MS)
    }
}
