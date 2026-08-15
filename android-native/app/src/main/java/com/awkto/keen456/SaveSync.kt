package com.awkto.keen456

import android.content.Context
import android.content.SharedPreferences
import android.util.Log
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.SecureRandom
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.zip.ZipEntry
import java.util.zip.ZipInputStream
import java.util.zip.ZipOutputStream
import org.json.JSONArray
import org.json.JSONObject

/**
 * Server-side save sync — the Kotlin port of the desktop launcher's
 * native/launcher/core/{sync.go,link.go}, same wire protocol as the WASM app
 * and docker/saves-api.py: saves scoped by an opaque sync key (X-Client-Id),
 * client-supplied epoch-ms timestamps (X-Save-Modified), newer-wins on both
 * sides — except on FIRST contact with a slot that already holds a save,
 * which is never resolved automatically (the settings UI asks; see the
 * link-state rules below).
 *
 * One instance per episode: the slot is the episode id (keen4/keen5/keen6),
 * exactly the web app's slotFor(g) and the Go launcher's sy.slot, so all
 * three platforms share saves per episode with no namespace translation. The
 * synced blob is a bootable .jsdos zip with the game files at the root.
 * Entries this build does not own (js-dos metadata, the web app's quicksave
 * state) are carried through every push byte for byte — rebuilding the bundle
 * without them once destroyed the browser's quicksave on desktop, and must
 * not happen here.
 *
 * DOSBox-X save states (DATA_DIR/save/) are deliberately NOT synced: they are
 * snapshots of emulator internals, valid only for the build that wrote them.
 *
 * All methods block; callers run them on a single executor so operations
 * never interleave (the Go code gets the same property from its one launcher
 * process).
 */
class SaveSync(private val ctx: Context, private val ep: Episode) {

    companion object {
        private const val TAG = "KeenSync"

        /** Web alphabet: no I/O/0/1 — the key is meant to be read aloud and typed. */
        private const val ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

        /**
         * NormalizeSyncKey's port: uppercase, strip separators, 4-32 chars,
         * dashes every 4. Returns "" when the input can't be a valid key.
         */
        fun normalizeKey(v: String): String {
            val clean = v.trim().uppercase().filter { it in 'A'..'Z' || it in '0'..'9' }
            if (clean.length < 4 || clean.length > 32) return ""
            if (clean.length == 4) return clean
            return clean.chunked(4).joinToString("-")
        }

        fun generateKey(): String {
            val raw = ByteArray(4)
            SecureRandom().nextBytes(raw)
            return raw.map { ALPHABET[(it.toInt() and 0xff) % ALPHABET.length] }.joinToString("")
        }

        /** App bookkeeping that must never travel nor count as save progress. */
        private fun ignored(name: String) = name.startsWith(".")

        /**
         * Whether a bundle entry is a root-level game file that this build
         * manages. Everything else — `.jsdos/` metadata, `save/`, any nested
         * path — belongs to whoever put it there and is preserved untouched.
         * Same rule as the desktop's ownedByUs (sync.go).
         */
        private fun ownedByUs(name: String): Boolean {
            if (name.contains('/') || name.contains('\\') || name == "." || name == "..") return false
            return !name.equals("dosbox.conf", ignoreCase = true) && !ignored(name)
        }

        fun fmtTime(epochMs: Long): String =
            SimpleDateFormat("yyyy-MM-dd HH:mm", Locale.US).format(Date(epochMs))
    }

    private val prefs: SharedPreferences = ctx.getSharedPreferences("keen456", Context.MODE_PRIVATE)
    private val slot: String = ep.id
    private val gameDir: File get() = GameSetup.gameDir(ctx, ep)

    /** foreign: the remote bundle's entries this build does not own (see class doc). */
    private var foreign = HashMap<String, ByteArray>()
    private var foreignLoaded = false

    /** The slot's modified time we last observed on the server. */
    private var remoteSeen = 0L

    // --- configuration ------------------------------------------------------
    // Server/token/key are GLOBAL (one identity, as on web/desktop); only the
    // slot differs per episode.

    /** Sync server URL, "" = sync off. Always returned with a trailing slash. */
    var base: String
        get() {
            val b = prefs.getString("syncBase", "")!!.trim()
            return if (b.isEmpty() || b.endsWith("/")) b else "$b/"
        }
        set(v) { prefs.edit().putString("syncBase", v.trim()).apply() }

    var token: String
        get() = prefs.getString("syncToken", "")!!.trim()
        set(v) { prefs.edit().putString("syncToken", v.trim()).apply() }

    /** This device's save identity, generated and stored on first use. */
    val key: String
        get() {
            prefs.getString("syncKey", null)?.let { if (it.isNotEmpty()) return it }
            val k = generateKey()
            prefs.edit().putString("syncKey", k).apply()
            Log.i(TAG, "generated sync key $k")
            return k
        }

    /** Adopt a typed-in key (normalized). Returns false if it isn't a valid key. */
    fun setKey(v: String): Boolean {
        val k = normalizeKey(v)
        if (k.isEmpty()) return false
        if (k != prefs.getString("syncKey", "")) {
            prefs.edit().putString("syncKey", k).apply()
            // A different key is a different save identity: reset the bundle
            // knowledge so the next exchange re-inspects the server's copy.
            foreign = HashMap(); foreignLoaded = false; remoteSeen = 0L
        }
        return true
    }

    val enabled: Boolean get() = base.isNotEmpty()

    // --- link state (link.go) ----------------------------------------------
    // Stored as JSON in prefs: {"KEY/slot": {"last_synced": 123}, ...} — per
    // key AND slot, as on desktop (linkID = key + "/" + slot): having linked
    // keen4 says nothing about first contact with an existing keen5 save.

    private fun linkId(k: String = key) = "$k/$slot"

    private fun loadLinks(): JSONObject =
        try { JSONObject(prefs.getString("syncLinks", "{}")!!) } catch (_: Exception) { JSONObject() }

    private fun saveLinks(o: JSONObject) = prefs.edit().putString("syncLinks", o.toString()).apply()

    fun isLinked(): Boolean = loadLinks().has(linkId())

    fun markSynced(remote: Long) {
        val o = loadLinks()
        o.put(linkId(), JSONObject().put("last_synced", remote))
        saveLinks(o)
    }

    fun needsDecision(remote: Long) = remote != 0L && !isLinked()

    /**
     * After a pull() attempt: whether that contact found an existing cloud
     * save this device is not linked to yet (uses the timestamp pull already
     * fetched — no extra round trip).
     */
    fun pendingDecision() = needsDecision(remoteSeen)

    private fun shouldPull(remote: Long, local: Long): Boolean {
        if (remote == 0L) return false
        if (needsDecision(remote)) {
            Log.i(TAG, "not linked to $slot for key $key yet — not touching either copy")
            return false
        }
        return remote > local
    }

    private fun shouldPush(remote: Long, local: Long): Boolean {
        if (local == 0L) return false
        if (needsDecision(remote)) {
            Log.i(TAG, "not linked to $slot for key $key yet — refusing to overwrite the server's save")
            return false
        }
        return local > remote
    }

    // --- local side ---------------------------------------------------------

    /** Newest owned-file mtime in the game dir, epoch ms (0 = nothing to sync). */
    private fun localModified(): Long =
        gameDir.listFiles()?.filter { it.isFile && !ignored(it.name) }
            ?.maxOfOrNull { it.lastModified() } ?: 0L

    /**
     * The player's in-game saves — SAVEGAM?.CK<n>, the files Keen writes from
     * its own save menu. The honest "has anyone played here" test.
     */
    private fun countGameSaves(): Pair<Int, Long> {
        val suffix = ".CK${ep.num}"
        val saves = gameDir.listFiles()?.filter {
            it.isFile && it.name.uppercase().startsWith("SAVEGAM") && it.name.uppercase().endsWith(suffix)
        } ?: emptyList()
        return Pair(saves.size, saves.maxOfOrNull { it.lastModified() } ?: 0L)
    }

    private fun stampDir(epochMs: Long) {
        gameDir.listFiles()?.forEach { if (it.isFile) it.setLastModified(epochMs) }
    }

    // --- HTTP ---------------------------------------------------------------

    private fun open(method: String, path: String): HttpURLConnection {
        val conn = URL(base + path).openConnection() as HttpURLConnection
        conn.requestMethod = method
        conn.connectTimeout = 5000
        conn.readTimeout = 60000
        conn.setRequestProperty("X-Client-Id", key)
        if (token.isNotEmpty()) conn.setRequestProperty("Authorization", "Bearer $token")
        return conn
    }

    private fun HttpURLConnection.readBody(): ByteArray =
        (if (responseCode in 200..399) inputStream else errorStream)?.use { it.readBytes() }
            ?: ByteArray(0)

    fun healthy(): Boolean {
        if (!enabled) return false
        return try {
            val conn = open("GET", "api/health")
            val code = conn.responseCode
            conn.readBody()
            when {
                code == 401 || code == 403 -> {
                    Log.w(TAG, "server at $base requires a token"); false
                }
                code != 200 -> { Log.w(TAG, "no sync API at $base (HTTP $code)"); false }
                else -> true
            }
        } catch (e: Exception) {
            Log.w(TAG, "server unreachable: $e")
            false
        }
    }

    /** slot -> (modified, size); null on failure. */
    private fun remoteList(): Map<String, Pair<Long, Long>>? = try {
        val conn = open("GET", "api/saves")
        val code = conn.responseCode
        val body = conn.readBody()
        if (code != 200) {
            Log.w(TAG, "list: HTTP $code")
            null
        } else {
            val arr = JSONArray(String(body))
            (0 until arr.length()).associate {
                val o = arr.getJSONObject(it)
                o.getString("slot") to Pair(o.optLong("modified"), o.optLong("size"))
            }
        }
    } catch (e: Exception) {
        Log.w(TAG, "list failed: $e")
        null
    }

    /** The slot's current bundle, or null if there is none (404). Throws on error. */
    private fun fetchBundle(): ByteArray? {
        val conn = open("GET", "api/saves/$slot")
        val code = conn.responseCode
        val body = conn.readBody()
        if (code == 404) return null
        if (code != 200) throw RuntimeException("HTTP $code")
        return body
    }

    // --- bundle (un)packing -------------------------------------------------

    private fun loadForeign(blob: ByteArray) {
        val found = HashMap<String, ByteArray>()
        try {
            ZipInputStream(ByteArrayInputStream(blob)).use { zin ->
                var e: ZipEntry? = zin.nextEntry
                while (e != null) {
                    if (!e.isDirectory && !ownedByUs(e.name)) found[e.name] = zin.readBytes()
                    e = zin.nextEntry
                }
            }
        } catch (ex: Exception) {
            Log.w(TAG, "reading bundle: $ex")
            return
        }
        foreign = found
        foreignLoaded = true
    }

    /**
     * Rebuild the web app's blob for this slot: foreign entries first,
     * verbatim; then the canonical js-dos metadata (from assets, with
     * __RUNCMD__ resolved to this episode's executable — only when the bundle
     * didn't already carry it, i.e. a brand-new save with no browser
     * history); then the current game-dir files at the root.
     */
    private fun zipBundle(): ByteArray {
        val buf = ByteArrayOutputStream()
        ZipOutputStream(buf).use { zw ->
            for ((name, data) in foreign) {
                zw.putNextEntry(ZipEntry(name))
                zw.write(data)
                zw.closeEntry()
            }
            val runcmd = Episodes.findExecutable(gameDir, ep) ?: "KEEN${ep.num}E.EXE"
            for ((entry, asset) in mapOf(
                ".jsdos/dosbox.conf" to "jsdos-meta/jsdos-dosbox.conf.tmpl",
                "dosbox.conf" to "jsdos-meta/root-dosbox.conf",
            )) {
                if (foreign.containsKey(entry)) continue
                zw.putNextEntry(ZipEntry(entry))
                val text = ctx.assets.open(asset).bufferedReader().use { it.readText() }
                    .replace("__RUNCMD__", runcmd)
                zw.write(text.toByteArray())
                zw.closeEntry()
            }
            for (f in gameDir.listFiles().orEmpty()) {
                if (!f.isFile || !ownedByUs(f.name)) continue
                val ze = ZipEntry(f.name)
                ze.time = f.lastModified()
                zw.putNextEntry(ze)
                f.inputStream().use { it.copyTo(zw) }
                zw.closeEntry()
            }
        }
        return buf.toByteArray()
    }

    /** Extract a bundle's root game files into the game dir; everything else stays out. */
    private fun unzipBundle(blob: ByteArray) {
        gameDir.mkdirs()
        ZipInputStream(ByteArrayInputStream(blob)).use { zin ->
            var e: ZipEntry? = zin.nextEntry
            while (e != null) {
                if (!e.isDirectory && ownedByUs(e.name)) {
                    File(gameDir, File(e.name).name).writeBytes(zin.readBytes())
                }
                e = zin.nextEntry
            }
        }
    }

    /** Plain archive of the game dir — backup insurance before irreversible overwrites. */
    private fun backupGameDir(tag: String): File {
        val buf = ByteArrayOutputStream()
        ZipOutputStream(buf).use { zw ->
            for (f in gameDir.listFiles().orEmpty()) {
                if (!f.isFile) continue
                val ze = ZipEntry(f.name)
                ze.time = f.lastModified()
                zw.putNextEntry(ze)
                f.inputStream().use { it.copyTo(zw) }
                zw.closeEntry()
            }
        }
        val dir = File(GameSetup.baseDir(ctx), "backups")
        dir.mkdirs()
        val stamp = SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US).format(Date())
        val out = File(dir, "$slot-$tag-$stamp.zip")
        out.writeBytes(buf.toByteArray())
        Log.i(TAG, "backed up $slot game dir to $out")
        return out
    }

    // --- the operations (sync.go) ------------------------------------------

    /**
     * Pull the server's save when it is newer; always learn what foreign
     * content the bundle holds. Run at launch, while DOSBox-X is still
     * booting — Keen reads SAVEGAM files when the player opens the load
     * menu, so an extraction that lands mid-boot cannot race a save the game
     * is using. Returns true if the game dir was updated.
     */
    fun pull(): Boolean {
        if (!healthy()) return false
        val mods = remoteList() ?: return false
        val remote = mods[slot]?.first ?: 0L
        remoteSeen = remote
        if (remote == 0L) {
            foreignLoaded = true // nothing on the server: nothing to preserve
            return false
        }
        // Download unconditionally, even when we will not apply it: the bundle
        // is the only place the foreign entries exist, and push must not run
        // without them.
        val blob = try { fetchBundle() } catch (e: Exception) {
            Log.w(TAG, "pull: $e"); return false
        } ?: return false
        loadForeign(blob)
        if (!shouldPull(remote, localModified())) return false
        try {
            unzipBundle(blob)
        } catch (e: Exception) {
            Log.w(TAG, "pull: extracting: $e")
            return false
        }
        // Stamp the extracted files to the remote timestamp so a pull doesn't
        // immediately look like fresh local changes.
        stampDir(remote)
        markSynced(remote)
        Log.i(TAG, "pulled $slot (server was newer)")
        return true
    }

    /** Upload the game dir when it is newer, carrying foreign entries through. */
    fun push() {
        val local = localModified()
        if (local == 0L || !healthy()) return
        val mods = remoteList() ?: return
        val remote = mods[slot]?.first ?: 0L
        // Refuse to push over a bundle we have not inspected — uploading now
        // would silently drop whatever the other platform stored in it.
        if (remote != 0L && (!foreignLoaded || remote != remoteSeen)) {
            val blob = try { fetchBundle() } catch (e: Exception) { null }
            if (blob == null) {
                Log.w(TAG, "push skipped: cannot read the server's bundle — pushing would discard the web app's save")
                return
            }
            loadForeign(blob)
            remoteSeen = remote
        }
        if (!shouldPush(remote, local)) return
        uploadBundle(local)
    }

    private fun uploadBundle(local: Long) {
        try {
            val blob = zipBundle()
            val conn = open("PUT", "api/saves/$slot")
            conn.doOutput = true
            conn.setRequestProperty("X-Save-Modified", local.toString())
            conn.outputStream.use { it.write(blob) }
            val code = conn.responseCode
            conn.readBody()
            if (code != 200) {
                Log.w(TAG, "push: HTTP $code")
                return
            }
            remoteSeen = local
            markSynced(local)
            Log.i(TAG, "pushed $slot (${blob.size / 1024} KB, ${foreign.size} preserved entries)")
        } catch (e: Exception) {
            Log.w(TAG, "push: $e")
        }
    }

    /**
     * The end-of-session settle-up: push if this session is the newer side,
     * report rather than act if the server moved ahead while we played —
     * that is a divergence, and it is the player's call (see FinalSync in
     * sync.go for the full reasoning).
     */
    fun finalPush() {
        if (!healthy()) return
        val mods = remoteList() ?: return
        val remote = mods[slot]?.first ?: 0L
        val local = localModified()
        if (remote > local && remote != 0L) {
            Log.w(TAG, "server save (${fmtTime(remote)}) is newer than this session (${fmtTime(local)}) — another device wrote while you played; nothing changed")
            return
        }
        push()
    }

    // --- settings-UI operations --------------------------------------------

    data class Status(
        val key: String,
        val serverReach: Boolean,
        val remoteModified: Long,
        val remoteSize: Long,
        val localModified: Long,
        val localSaves: Int,
        val localSaveTime: Long,
        val linked: Boolean,
        val needsDecision: Boolean,
        val err: String?,
    )

    /** Inspect both sides without changing either. */
    fun status(): Status {
        val (n, newest) = countGameSaves()
        val local = localModified()
        if (!healthy()) {
            return Status(key, false, 0, 0, local, n, newest, isLinked(), false,
                if (enabled) "no sync server reachable at $base" else null)
        }
        val mods = remoteList()
            ?: return Status(key, true, 0, 0, local, n, newest, isLinked(), false, "listing saves failed")
        val remote = mods[slot] ?: Pair(0L, 0L)
        return Status(key, true, remote.first, remote.second, local, n, newest,
            isLinked(), needsDecision(remote.first), null)
    }

    /**
     * Take the server's save for this slot, after backing up the local one.
     * Links the device. Returns the backup file (null if there was nothing
     * local to back up). Throws with a user-readable message on failure.
     */
    fun adoptCloud(): File? {
        if (!healthy()) throw RuntimeException("no sync server reachable at $base")
        val mods = remoteList() ?: throw RuntimeException("listing saves failed")
        val remote = mods[slot]?.first ?: 0L
        if (remote == 0L) throw RuntimeException("there is no $slot save on the server for key $key")
        val blob = fetchBundle() ?: throw RuntimeException("the server's save could not be read")
        var backup: File? = null
        if (localModified() != 0L) backup = backupGameDir("before-cloud")
        loadForeign(blob)
        unzipBundle(blob)
        stampDir(remote)
        remoteSeen = remote
        markSynced(remote)
        Log.i(TAG, "adopted the server's $slot save for key $key")
        return backup
    }

    /**
     * Keep this device's save and upload it, preserving whatever the other
     * platform stored in the bundle. Links the device.
     */
    fun adoptLocal() {
        if (!healthy()) throw RuntimeException("no sync server reachable at $base")
        val local = localModified()
        if (local == 0L) throw RuntimeException("there is no local save to upload yet")
        val mods = remoteList() ?: throw RuntimeException("listing saves failed")
        if ((mods[slot]?.first ?: 0L) != 0L) {
            val blob = fetchBundle()
                ?: throw RuntimeException("cannot read the server's bundle — uploading now could discard the web app's save")
            loadForeign(blob)
        } else {
            foreignLoaded = true
        }
        uploadBundle(local)
        Log.i(TAG, "uploaded this device's $slot save for key $key")
    }
}
