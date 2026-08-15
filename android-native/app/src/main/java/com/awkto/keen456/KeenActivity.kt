package com.awkto.zeliard

import android.content.pm.ActivityInfo
import android.os.Build
import android.os.Bundle
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import java.io.File
import org.libsdl.app.SDLActivity

/**
 * The whole app: DOSBox-X (as libmain.so) running Zeliard, with the touch
 * controls stacked on top of SDL's surface.
 *
 * There is no launcher, no game list and no menu — this build exists to boot one
 * game, so onCreate installs the game if needed, writes the config the emulator
 * reads, and lets SDLActivity take it from there.
 */
class ZeliardActivity : SDLActivity() {

    private var overlay: TouchOverlayView? = null
    private var filterView: FilterOverlayView? = null

    /**
     * Save sync (⚙ ▸ Sync). One executor serializes every sync operation so a
     * periodic push can never interleave with a settings-dialog action — the
     * ordering guarantee SaveSync's methods assume.
     */
    private lateinit var sync: SaveSync
    private val syncExec = java.util.concurrent.Executors.newSingleThreadExecutor()
    private val syncHandler = android.os.Handler(android.os.Looper.getMainLooper())
    private val periodicPush = object : Runnable {
        override fun run() {
            // Push-only on purpose, as on desktop: a periodic pull would
            // rewrite the game dir underneath the running emulator.
            if (sync.enabled) syncExec.execute { sync.push() }
            syncHandler.postDelayed(this, 2 * 60_000L)
        }
    }

    /**
     * Both libraries come out of native/build-android.sh; libmain.so is the
     * patched DOSBox-X and exports SDL_main, which SDLActivity looks up.
     */
    override fun getLibraries(): Array<String> = arrayOf("SDL2", "main")

    /**
     * Hand DOSBox-X the config on its command line as well.
     *
     * Patch 0003 also re-reads this file late in startup, and that is still
     * needed — the working-directory logic calls ClearExtraData(), which wipes
     * every section (including [autoexec], so the game would never launch). But
     * settings consumed *before* that point, `[log] logfile` in particular, only
     * take effect if the config is parsed at the normal time, which is what
     * `-conf` does. The late re-parse then refills the sections, so nothing ends
     * up applied twice.
     */
    override fun getArguments(): Array<String> =
        arrayOf("-conf", File(GameSetup.baseDir(this), "dosbox-x.conf").absolutePath)

    /**
     * Files must be in place before the emulator thread starts: SDL_main reads
     * <base>/dosbox-x.conf almost immediately, and its [autoexec] mounts the game
     * directory. SDLActivity does not start that thread until the surface is
     * created, which is after onCreate returns.
     */
    override fun onCreate(savedInstanceState: Bundle?) {
        GameSetup.prepare(this)
        sync = SaveSync(this)
        if (sync.enabled) {
            // Launch pull, async: DOSBox-X spends the next several seconds in
            // the boot/intro, and Zeliard only reads .USR files when the player
            // opens the load screen, so a pull that lands mid-boot is safe.
            // First contact with an existing cloud save is never auto-resolved
            // — surface it instead (⚙ ▸ Sync has the choice buttons).
            syncExec.execute {
                val pulled = sync.pull()
                val decision = sync.pendingDecision()
                runOnUiThread {
                    if (pulled) toast("Cloud save loaded")
                    else if (decision) toast("Cloud save found — open ⚙ ▸ Sync to link this device")
                }
            }
        }
        // Always scheduled (the tick checks sync.enabled itself), so turning
        // sync on in Settings starts pushing without an app restart.
        syncHandler.postDelayed(periodicPush, 2 * 60_000L)
        super.onCreate(savedInstanceState)

        // Hand the in-emulator attack-keys code its settings. Desktop passes
        // these through the environment of the DOSBox-X child process; here there
        // is only one process, so poke them straight in (see Native.nativeSetEnv).
        Native.nativeSetEnv("ZELIARD_ATK", "1")
        Native.nativeSetEnv("ZELIARD_AUTOFIRE", "10")
        // Fast-forward runs at CPU_CycleMax * pct/100 for the duration of the
        // hold: with the tick limiter off, cheaper emulated milliseconds mean
        // a proportionally faster fast-forward on a host-bound phone. 67 was
        // asked for as "~50% faster" (#42). Android-only — desktop launchers
        // don't set this, so their FF speed is unchanged.
        Native.nativeSetEnv("ZELIARD_FF_CYCLES_PCT", "67")

        // Soft/sharp pixels for the GPU upscale ("1" = linear, "0" = nearest).
        // Applied at the next present (patch 0006 recreates the frame texture),
        // so it also switches live from the settings dialog.
        val prefs = getSharedPreferences("zeliard", MODE_PRIVATE)
        Native.nativeSetScaleLinear(if (prefs.getString("pixels", "smooth") == "crisp") 0 else 1)

        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        // Border crop (the Z button) persists across launches. The native side
        // (a src rect on SDL's GPU blit, patch 0006) and the overlay's layout
        // both follow this one flag; Native.setZoom only pokes doubles, so
        // calling it before the SDL thread starts is fine.
        val zoom = prefs.getBoolean("zoom", false)
        Native.setZoom(zoom)

        val fillParent = {
            ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT,
            )
        }
        // The filter goes on before the controls, so the control pad (and the
        // Save/Load popup) always draw above it.
        filterView = FilterOverlayView(this).also { fv ->
            fv.zoomed = zoom
            fv.filter = prefs.getString("filter", "scanlines") ?: "scanlines"
            addContentView(fv, fillParent())
        }
        overlay = TouchOverlayView(this).also { ov ->
            ov.zoomed = zoom
            ov.onZoomChanged = { z ->
                Native.setZoom(z)
                filterView?.zoomed = z
                prefs.edit().putBoolean("zoom", z).apply()
            }
            ov.onOpenSettings = { showSettings(prefs) }
            ov.onToggleKeyboard = { toggleKeyboard() }
            addContentView(ov, fillParent())
        }
    }

    /**
     * The ⌨ pill: raise (or dismiss) the device soft keyboard so the player can
     * type save-file names, as on the web. showTextInput focuses SDL's invisible
     * DummyEdit; its SDLInputConnection turns every committed character into
     * plain SDL key events (nativeGenerateScancodeForUnichar — with shift
     * synthesis), which DOSBox-X's normal keyboard path consumes. SDL_TEXTINPUT
     * is compiled out of DOSBox-X on Android, so this key-event route is the one
     * that works. ZeliardKeyboard shims the package-private pieces.
     */
    private fun toggleKeyboard() {
        if (org.libsdl.app.ZeliardKeyboard.isShown()) {
            org.libsdl.app.ZeliardKeyboard.hide()
        } else {
            org.libsdl.app.ZeliardKeyboard.show()
        }
    }

    /**
     * Settings (the ⚙ pill): two tabs — Display (filter, pixels, fullscreen)
     * and Sync (server save sync). Kept as a plain dialog built in code — the
     * app has no other screens, and a full settings Activity would tear down
     * the emulator surface underneath it.
     */
    private fun showSettings(prefs: android.content.SharedPreferences) {
        val filterNames = arrayOf("Off", "Scanlines", "CRT — scanlines + mask + vignette", "RGB grille")
        val filterKeys = arrayOf("off", "scanlines", "crt", "rgb")
        val pixelNames = arrayOf("Smooth (soft pixels)", "Crisp (sharp pixels)")
        val pixelKeys = arrayOf("smooth", "crisp")

        val curFilter = filterKeys.indexOf(prefs.getString("filter", "scanlines")).coerceAtLeast(0)
        val curPixels = pixelKeys.indexOf(prefs.getString("pixels", "smooth")).coerceAtLeast(0)

        val dark = android.graphics.Color.parseColor("#0b1526")
        val text = android.graphics.Color.parseColor("#e9eef7")
        val dim = android.graphics.Color.parseColor("#8fa3c4")
        val gold = android.graphics.Color.parseColor("#e8b84b")
        val panel = android.graphics.Color.parseColor("#18304f")
        val pad = (resources.displayMetrics.density * 20).toInt()

        fun header(label: String) = android.widget.TextView(this).apply {
            this.text = label
            setTextColor(dim)
            textSize = 13f
            isAllCaps = true
            setPadding(0, pad / 2, 0, pad / 4)
        }
        fun radios(names: Array<String>, checkedIdx: Int, onPick: (Int) -> Unit) =
            android.widget.RadioGroup(this).apply {
                for ((i, n) in names.withIndex()) {
                    addView(android.widget.RadioButton(this@ZeliardActivity).apply {
                        this.text = n
                        id = i
                        setTextColor(text)
                    })
                }
                check(checkedIdx)
                setOnCheckedChangeListener { _, id -> onPick(id) }
            }
        fun field(hint: String, value: String) = android.widget.EditText(this).apply {
            this.hint = hint
            setText(value)
            // Dark ink: these render on the EditText's stock light background,
            // where the dialog's light body colour would be white-on-white.
            setTextColor(android.graphics.Color.parseColor("#0b1526"))
            setHintTextColor(android.graphics.Color.parseColor("#7286a6"))
            textSize = 14f
            inputType = android.text.InputType.TYPE_CLASS_TEXT or
                android.text.InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
        }

        // --- Display tab ----------------------------------------------------
        val displayTab = android.widget.LinearLayout(this).apply {
            orientation = android.widget.LinearLayout.VERTICAL
            addView(header("Screen filter"))
            addView(radios(filterNames, curFilter) { i ->
                prefs.edit().putString("filter", filterKeys[i]).apply()
                filterView?.filter = filterKeys[i]
            })
            addView(header("Pixels"))
            addView(radios(pixelNames, curPixels) { i ->
                prefs.edit().putString("pixels", pixelKeys[i]).apply()
                Native.nativeSetScaleLinear(if (pixelKeys[i] == "crisp") 0 else 1)
            })
            addView(header("Fullscreen"))
            val fsNames = arrayOf("On (hide system bars)", "Off (show status bar)")
            addView(radios(fsNames, if (prefs.getBoolean("fullscreen", true)) 0 else 1) { i ->
                prefs.edit().putBoolean("fullscreen", i == 0).apply()
                applySystemBars()
            })
        }

        // --- Sync tab -------------------------------------------------------
        val serverField = field("https://sync-server/ (blank = off)", sync.base)
        val keyField = field("save key", sync.key)
        val tokenField = field("token (optional)", sync.token)
        val statusView = android.widget.TextView(this).apply {
            setTextColor(text)
            textSize = 13f
            setPadding(0, pad / 4, 0, pad / 4)
            this.text = "…"
        }
        // Reads the fields, persists them, and reports whether they parse.
        // Every sync action below goes through this first, so what runs is
        // always what the user sees in the boxes.
        fun applyFields(): Boolean {
            sync.base = serverField.text.toString()
            sync.token = tokenField.text.toString()
            if (sync.enabled && !sync.setKey(keyField.text.toString())) {
                statusView.text = "That key is not valid (4-32 letters/digits)."
                return false
            }
            keyField.setText(sync.key)
            return true
        }
        fun refreshStatus() {
            if (!applyFields()) return
            if (!sync.enabled) {
                statusView.text = "Sync is off. Set a server to sync saves with the web app and desktop."
                return
            }
            statusView.text = "Checking…"
            syncExec.execute {
                val st = sync.status()
                runOnUiThread {
                    statusView.text = buildString {
                        if (st.err != null) { append(st.err); return@buildString }
                        append("Cloud: ")
                        append(if (st.remoteModified == 0L) "no save for key ${st.key}"
                               else "save from ${SaveSync.fmtTime(st.remoteModified)} (${st.remoteSize / 1024} KB)")
                        append("\nThis device: ")
                        append(if (st.localSaves == 0) "no in-game saves yet"
                               else "${st.localSaves} save(s), newest ${SaveSync.fmtTime(st.localSaveTime)}")
                        append("\n")
                        append(when {
                            st.needsDecision -> "⚠ First link to an existing cloud save — choose below which copy to keep."
                            st.linked -> "Linked — saves sync automatically (newer side wins)."
                            else -> "Not linked yet — it links on the first sync."
                        })
                    }
                }
            }
        }
        fun syncButton(label: String, onTap: () -> Unit) = android.widget.Button(this).apply {
            this.text = label
            isAllCaps = false
            setTextColor(text)
            setBackgroundColor(panel)
            setOnClickListener { onTap() }
        }
        fun confirmThen(message: String, action: () -> Unit) {
            android.app.AlertDialog.Builder(this)
                .setMessage(message)
                .setPositiveButton("Yes") { _, _ -> action() }
                .setNegativeButton("Cancel", null)
                .show()
        }
        fun runSyncOp(op: () -> String) {
            if (!applyFields()) return
            statusView.text = "Working…"
            syncExec.execute {
                val msg = try { op() } catch (e: Exception) { e.message ?: "failed" }
                runOnUiThread {
                    android.widget.Toast.makeText(this, msg, android.widget.Toast.LENGTH_LONG).show()
                    refreshStatus()
                }
            }
        }
        val syncTab = android.widget.LinearLayout(this).apply {
            orientation = android.widget.LinearLayout.VERTICAL
            addView(header("Sync server"))
            addView(serverField)
            addView(header("Save key (same key = same save, everywhere)"))
            val keyRow = android.widget.LinearLayout(this@ZeliardActivity).apply {
                orientation = android.widget.LinearLayout.HORIZONTAL
                addView(keyField, android.widget.LinearLayout.LayoutParams(
                    0, android.view.ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
                addView(syncButton("New key") {
                    keyField.setText(SaveSync.generateKey())
                    refreshStatus()
                })
            }
            addView(keyRow)
            addView(header("Token"))
            addView(tokenField)
            addView(header("Status"))
            addView(statusView)
            addView(syncButton("Check / sync now") {
                runSyncOp {
                    // Safe both ways at any time: pull only applies when the
                    // cloud is newer and this device is linked (Zeliard reads
                    // saves at the load screen, not while playing), push only
                    // when this device is newer.
                    val pulled = sync.pull()
                    sync.push()
                    if (pulled) "Cloud save loaded — visible at the next in-game load."
                    else "Synced."
                }
            })
            addView(header("First-link decision"))
            addView(android.widget.TextView(this@ZeliardActivity).apply {
                setTextColor(dim); textSize = 12f
                this.text = "Only needed the first time this device meets an existing cloud save."
            })
            val decideRow = android.widget.LinearLayout(this@ZeliardActivity).apply {
                orientation = android.widget.LinearLayout.HORIZONTAL
                addView(syncButton("Use cloud save") {
                    confirmThen("Replace this device's game files with the cloud save? " +
                        "The current files are backed up first.") {
                        runSyncOp {
                            sync.adoptCloud()
                            "Cloud save loaded — visible at the next in-game load."
                        }
                    }
                }, android.widget.LinearLayout.LayoutParams(
                    0, android.view.ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
                addView(syncButton("Upload this save") {
                    confirmThen("Upload this device's save over the one in the cloud?") {
                        runSyncOp { sync.adoptLocal(); "Uploaded." }
                    }
                }, android.widget.LinearLayout.LayoutParams(
                    0, android.view.ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
            }
            addView(decideRow)
        }

        // --- tabs -----------------------------------------------------------
        val tabs = listOf("Display" to displayTab, "Sync" to syncTab)
        val tabButtons = ArrayList<android.widget.TextView>()
        fun selectTab(idx: Int) {
            for ((i, t) in tabs.withIndex()) {
                t.second.visibility = if (i == idx) View.VISIBLE else View.GONE
                tabButtons[i].setTextColor(if (i == idx) gold else dim)
            }
            if (idx == 1) refreshStatus()
        }
        val tabRow = android.widget.LinearLayout(this).apply {
            orientation = android.widget.LinearLayout.HORIZONTAL
            for ((i, t) in tabs.withIndex()) {
                val b = android.widget.TextView(this@ZeliardActivity).apply {
                    this.text = t.first
                    textSize = 15f
                    isAllCaps = true
                    setPadding(0, 0, pad, pad / 3)
                    setOnClickListener { selectTab(i) }
                }
                tabButtons.add(b)
                addView(b)
            }
        }

        val col = android.widget.LinearLayout(this).apply {
            orientation = android.widget.LinearLayout.VERTICAL
            setBackgroundColor(dark)
            setPadding(pad, pad, pad, pad / 2)
            addView(tabRow)
            for (t in tabs) addView(t.second)
        }
        selectTab(0)

        val scroll = android.widget.ScrollView(this).apply {
            setBackgroundColor(dark)
            addView(col)
        }
        android.app.AlertDialog.Builder(this)
            .setView(scroll)
            .setPositiveButton("Done") { _, _ -> applyFields() }
            .create()
            .also { dlg ->
                dlg.window?.setBackgroundDrawable(android.graphics.drawable.ColorDrawable(dark))
                dlg.show()
                dlg.getButton(android.app.AlertDialog.BUTTON_POSITIVE)?.setTextColor(text)
            }
    }

    /**
     * Pin the app to portrait, whatever SDL thinks.
     *
     * SDL overrides the manifest's screenOrientation once its window exists: with
     * no SDL_ORIENTATIONS hint and a resizable window it asks for
     * SCREEN_ORIENTATION_FULL_USER, handing the decision to the device's rotation
     * lock. This app is portrait by design — the game occupies the top of the
     * screen at 4:3 and the on-screen controls get the whole area beneath it,
     * which is the layout the web app uses on phones. In landscape there is
     * nowhere to put controls that isn't on top of the game.
     */
    override fun setOrientationBis(w: Int, h: Int, resizable: Boolean, hint: String) {
        requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) applySystemBars() else overlay?.releaseAll()
    }

    /**
     * Settings ▸ Fullscreen. On = immersive (bars hidden, the default). Off =
     * status + navigation bars stay visible; the window shrinks, the SDL surface
     * and both overlays re-lay-out from the new size, and the controls region
     * absorbs the lost height (the game pane's height only depends on width).
     */
    private fun applySystemBars() {
        val on = getSharedPreferences("zeliard", MODE_PRIVATE).getBoolean("fullscreen", true)
        if (on) {
            goImmersive()
        } else {
            @Suppress("DEPRECATION")
            window.decorView.systemUiVisibility = View.SYSTEM_UI_FLAG_LAYOUT_STABLE
        }
    }

    override fun onPause() {
        // A key held when the app goes to the background would otherwise stay
        // held in the emulator and the character keeps walking on return.
        overlay?.releaseAll()
        super.onPause()
    }

    override fun onStop() {
        // The Android equivalent of the desktop's exit-time settle-up: upload
        // this session if it is the newer side, report-not-act if the server
        // moved ahead while we played. Backgrounding is the closest thing this
        // app has to "exiting" — Android may never call anything later.
        if (this::sync.isInitialized && sync.enabled) {
            syncExec.execute { sync.finalPush() }
        }
        super.onStop()
    }

    private fun toast(msg: String) =
        android.widget.Toast.makeText(this, msg, android.widget.Toast.LENGTH_LONG).show()

    private fun goImmersive() {
        val decor: View = window.decorView
        @Suppress("DEPRECATION")
        decor.systemUiVisibility = (
            View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                or View.SYSTEM_UI_FLAG_FULLSCREEN
                or View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
            )
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            window.attributes = window.attributes.apply {
                layoutInDisplayCutoutMode =
                    WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
            }
        }
    }

    /**
     * Back = the game's pause/menu key rather than "quit". Quitting from a hardware
     * gesture would drop an unsaved run, and Zeliard's own Esc menu is where you
     * save. Holding back still backgrounds the app via the system.
     */
    override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
        if (keyCode == KeyEvent.KEYCODE_BACK) {
            overlay?.tapKey(KeyEvent.KEYCODE_ESCAPE)
            return true
        }
        return super.onKeyDown(keyCode, event)
    }
}
