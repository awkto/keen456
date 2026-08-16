package com.awkto.keen456

import android.app.Activity
import android.app.AlertDialog
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.util.Log
import android.view.Gravity
import android.view.ViewGroup
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import androidx.documentfile.provider.DocumentFile
import java.io.File
import java.util.concurrent.Executors
import java.util.zip.ZipInputStream

/**
 * The launcher screen: pick an episode, and get Keen 5/6's files onto the
 * device. The counterpart of the web app's game console and the desktop
 * launcher's episode selection — the piece the zeliard original never needed
 * (one game, always bundled).
 *
 * Keen 4 shareware ships in the APK and always plays. Keen 5/6 are commercial:
 * their cards show Import (SAF folder or .zip of the player's own files, the
 * same validation as the desktop launcher) and — when a sync server is
 * configured — Fetch from sync, which adopts the cloud copy the web app
 * uploaded (game files travel inside the save bundle).
 *
 * The game itself runs in KeenActivity in a separate :game process, so coming
 * back here and starting a different episode always gets a working SDL.
 */
class PickerActivity : Activity() {

    private companion object {
        const val TAG = "KeenPicker"
        const val REQ_IMPORT_TREE = 41
        const val REQ_IMPORT_ZIP = 42
        val ACCENTS = mapOf("keen4" to "#e8b84b", "keen5" to "#54c8e0", "keen6" to "#6ee0a0")
    }

    private val exec = Executors.newSingleThreadExecutor()
    private var importTarget: Episode? = null
    private lateinit var list: LinearLayout

    private val dark = Color.parseColor("#0b1526")
    private val panel = Color.parseColor("#18304f")
    private val textCol = Color.parseColor("#e9eef7")
    private val dim = Color.parseColor("#8fa3c4")

    private fun dp(v: Int) = (resources.displayMetrics.density * v).toInt()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Seed the shareware here too: the picker's "ready" test and a first
        // launch straight into Keen 4 both want it in place.
        exec.execute { GameSetup.seedShareware(this) }

        list = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(20), dp(24), dp(20), dp(24))
        }
        val scroll = ScrollView(this).apply {
            setBackgroundColor(dark)
            addView(list, ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        }
        setContentView(scroll)
    }

    override fun onResume() {
        super.onResume()
        rebuild()
    }

    /**
     * Prefs are re-opened with MODE_MULTI_PROCESS on every read: the sync
     * server is configured inside the game's :game process, and without the
     * flag this process would keep serving its cached first read forever.
     */
    @Suppress("DEPRECATION")
    private fun prefs() = getSharedPreferences("keen456", Context.MODE_PRIVATE or Context.MODE_MULTI_PROCESS)

    private fun rebuild() {
        list.removeAllViews()

        list.addView(TextView(this).apply {
            text = "COMMANDER KEEN 4·5·6"
            setTextColor(textCol)
            textSize = 22f
            typeface = android.graphics.Typeface.DEFAULT_BOLD
        })
        list.addView(TextView(this).apply {
            text = "Native DOSBox-X build — pick an episode"
            setTextColor(dim)
            textSize = 13f
            setPadding(0, dp(2), 0, dp(16))
        })

        val last = prefs().getString("lastEpisode", null)
        val syncOn = prefs().getString("syncBase", "")!!.isNotBlank()
        for (ep in Episodes.ALL) {
            list.addView(card(ep, ep.id == last, syncOn), LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { bottomMargin = dp(14) })
        }

        list.addView(TextView(this).apply {
            text = "Keen 4 shareware is included — own the registered version? Import its " +
                "files to play the full game (your saves are kept). Keen 5 and 6 are " +
                "commercial — import your own game files (a folder or .zip holding the " +
                "KEEN .EXE and .CK files), or configure save sync in-game (⚙ ▸ Sync) and " +
                "fetch the copy the web app uploaded."
            setTextColor(dim)
            textSize = 12f
            setPadding(0, dp(8), 0, 0)
        })
    }

    private fun card(ep: Episode, lastPlayed: Boolean, syncOn: Boolean): LinearLayout {
        val accent = Color.parseColor(ACCENTS[ep.id] ?: "#e8b84b")
        val ready = Episodes.hasGameFiles(GameSetup.gameDir(this, ep), ep) || ep.shareware

        return LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(panel)
            setPadding(dp(16), dp(12), dp(16), dp(12))

            addView(TextView(this@PickerActivity).apply {
                text = "KEEN ${ep.num}" + if (lastPlayed) "   ·   last played" else ""
                setTextColor(accent)
                textSize = 16f
                typeface = android.graphics.Typeface.DEFAULT_BOLD
            })
            addView(TextView(this@PickerActivity).apply {
                text = ep.title
                setTextColor(textCol)
                textSize = 14f
            })
            addView(TextView(this@PickerActivity).apply {
                text = when {
                    ep.shareware && GameSetup.isFullVersion(this@PickerActivity, ep) ->
                        "Registered version — your game files are installed"
                    ep.shareware -> "Shareware — included · registered version can be imported"
                    ready -> "Your game files are installed"
                    else -> "Needs your game files"
                }
                setTextColor(dim)
                textSize = 12f
                setPadding(0, dp(2), 0, dp(8))
            })

            val row = LinearLayout(this@PickerActivity).apply {
                orientation = LinearLayout.HORIZONTAL
            }
            fun action(label: String, filled: Boolean, onTap: () -> Unit) {
                row.addView(Button(this@PickerActivity).apply {
                    text = label
                    isAllCaps = false
                    textSize = 14f
                    setTextColor(if (filled) Color.parseColor("#14110a") else textCol)
                    setBackgroundColor(if (filled) accent else Color.parseColor("#0a1426"))
                    setOnClickListener { onTap() }
                }, LinearLayout.LayoutParams(0, dp(44), 1f).apply { marginEnd = dp(8) })
            }
            if (ready) {
                action("▶  Play", true) { play(ep) }
                // Keen 4's import is how the shareware becomes the registered
                // version (its files replace the bundled ones, saves are kept).
                action(if (ep.shareware) "Import full version" else "Re-import", false) {
                    importInto(ep)
                }
            } else {
                action("Import files", true) { importInto(ep) }
                if (syncOn) action("Fetch from sync", false) { fetchFromSync(ep) }
            }
            addView(row)
        }
    }

    private fun play(ep: Episode) {
        startActivity(Intent(this, KeenActivity::class.java)
            .putExtra(KeenActivity.EXTRA_EPISODE, ep.id))
    }

    // --- import (SAF) -------------------------------------------------------

    private fun importInto(ep: Episode) {
        importTarget = ep
        val items = arrayOf("Pick a folder", "Pick a .zip")
        AlertDialog.Builder(this)
            .setTitle("Import Keen ${ep.num} game files")
            .setItems(items) { _, which ->
                if (which == 0) {
                    startActivityForResult(
                        Intent(Intent.ACTION_OPEN_DOCUMENT_TREE), REQ_IMPORT_TREE)
                } else {
                    startActivityForResult(Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                        addCategory(Intent.CATEGORY_OPENABLE)
                        type = "*/*"
                    }, REQ_IMPORT_ZIP)
                }
            }
            .show()
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        val ep = importTarget ?: return
        val uri = data?.data ?: return
        if (resultCode != RESULT_OK) return
        when (requestCode) {
            REQ_IMPORT_TREE -> runImport(ep) { importTree(ep, uri) }
            REQ_IMPORT_ZIP -> runImport(ep) { importZip(ep, uri) }
        }
    }

    private fun runImport(ep: Episode, body: () -> Int) {
        val wait = Toast.makeText(this, "Importing…", Toast.LENGTH_SHORT).also { it.show() }
        exec.execute {
            val result = try {
                val n = body()
                val dir = GameSetup.gameDir(this, ep)
                when {
                    n == 0 -> "Nothing to import there."
                    Episodes.hasGameFiles(dir, ep) -> {
                        val note = if (ep.num == 6 &&
                            Episodes.findExecutable(dir, ep)?.equals("KEEN6C.EXE", true) != true)
                            "\nNote: only the stock KEEN6.EXE was found — the game will ask its " +
                            "\"which creature is this?\" manual question at startup. Drop a " +
                            "KEEN6C.EXE in and re-import to skip it."
                        else ""
                        val k4note = when {
                            !ep.shareware -> ""
                            GameSetup.isFullVersion(this, ep) ->
                                "\nRegistered version detected — the full game is installed."
                            else ->
                                "\nThe game data still matches the bundled shareware — if you " +
                                "meant to install the registered version, check the folder " +
                                "held its GAMEMAPS/EGAGRAPH/AUDIO .CK4 files."
                        }
                        "Imported $n file(s) — Keen ${ep.num} is ready.$note$k4note"
                    }
                    else -> "Imported $n file(s), but that doesn't look like Keen ${ep.num} " +
                        "(need KEEN${ep.num}*.EXE and *.CK${ep.num} files)."
                }
            } catch (e: Exception) {
                Log.w(TAG, "import failed", e)
                "Import failed: ${e.message}"
            }
            runOnUiThread {
                wait.cancel()
                AlertDialog.Builder(this).setMessage(result)
                    .setPositiveButton("OK") { _, _ -> rebuild() }.show()
            }
        }
    }

    /**
     * Whether an import may write this destination. Game files may be replaced
     * — that's what turns the seeded Keen 4 shareware into the registered
     * version, and what makes Re-import actually re-import for 5/6. The
     * player's progress never is: SAVEGAM* (in-game saves) and CONFIG.* (game
     * settings + high scores) are kept once they exist.
     */
    private fun importMayWrite(dest: File): Boolean {
        if (!dest.exists()) return true
        val u = dest.name.uppercase()
        return !(u.startsWith("SAVEGAM") || u.startsWith("CONFIG."))
    }

    /**
     * Copy the picked folder's root files in, under the importMayWrite rule.
     * Source mtimes are preserved so a fresh import can't outrank a real save
     * on the sync server; a source with no usable mtime gets the fixed old
     * stamp.
     */
    private fun importTree(ep: Episode, uri: Uri): Int {
        val tree = DocumentFile.fromTreeUri(this, uri) ?: return 0
        val dir = GameSetup.gameDir(this, ep)
        dir.mkdirs()
        var n = 0
        for (doc in tree.listFiles()) {
            if (!doc.isFile) continue
            val name = doc.name ?: continue
            val dest = File(dir, name)
            if (!importMayWrite(dest)) continue
            contentResolver.openInputStream(doc.uri)?.use { input ->
                dest.outputStream().use { input.copyTo(it) }
            } ?: continue
            val mtime = doc.lastModified()
            dest.setLastModified(if (mtime > 0) mtime else GameSetup.ASSET_MTIME_MS)
            n++
        }
        return n
    }

    /** Extract a picked .zip's root-level entries, same rules as importTree. */
    private fun importZip(ep: Episode, uri: Uri): Int {
        val dir = GameSetup.gameDir(this, ep)
        dir.mkdirs()
        var n = 0
        contentResolver.openInputStream(uri)?.use { raw ->
            ZipInputStream(raw).use { zin ->
                var e = zin.nextEntry
                while (e != null) {
                    if (!e.isDirectory) {
                        // Flatten: some zips nest the game in a folder. File()
                        // takes the basename, which also defuses zip-slip.
                        val dest = File(dir, File(e.name).name)
                        if (importMayWrite(dest)) {
                            dest.outputStream().use { zin.copyTo(it) }
                            dest.setLastModified(
                                if (e.time > 0) e.time else GameSetup.ASSET_MTIME_MS)
                            n++
                        }
                    }
                    e = zin.nextEntry
                }
            }
        }
        return n
    }

    // --- fetch from sync ----------------------------------------------------

    /**
     * Seed an episode from the sync server: the web app's bundle carries the
     * game files, so "adopt the cloud copy" is exactly the desktop's sync-owned
     * managed dir. Only offered while the episode has no files here, so there
     * is nothing local to lose — adoptCloud() links the device as a side
     * effect, which is correct: this device's copy IS the cloud copy now.
     */
    private fun fetchFromSync(ep: Episode) {
        val wait = Toast.makeText(this, "Fetching from sync…", Toast.LENGTH_SHORT).also { it.show() }
        exec.execute {
            val msg = try {
                SaveSync(this, ep).adoptCloud()
                "Keen ${ep.num} fetched from sync."
            } catch (e: Exception) {
                "Fetch failed: ${e.message}"
            }
            runOnUiThread {
                wait.cancel()
                AlertDialog.Builder(this).setMessage(msg)
                    .setPositiveButton("OK") { _, _ -> rebuild() }.show()
            }
        }
    }
}
