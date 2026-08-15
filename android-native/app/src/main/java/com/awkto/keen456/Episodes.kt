package com.awkto.keen456

import java.io.File

/**
 * The three episodes — the Kotlin port of the desktop launcher's
 * native/launcher/core/episodes.go, and the one question the zeliard original
 * never had to answer: *where do this episode's game files live?*
 *
 * Keen 4 shareware is redistributable, so it ships in the APK's assets and is
 * extracted on first run. Keen 5 and 6 are commercial: the player imports
 * their own files in the PickerActivity (SAF folder or .zip), or — with sync
 * on — the files come down from the sync server (the web app uploads the
 * whole bundle, game data included).
 */
data class Episode(val num: Int, val id: String, val title: String) {
    /** Only Keen 4 (v1.4 shareware) is freely redistributable. */
    val shareware: Boolean get() = num == 4
}

object Episodes {
    val ALL = listOf(
        Episode(4, "keen4", "Secret of the Oracle"),
        Episode(5, "keen5", "The Armageddon Machine"),
        Episode(6, "keen6", "Aliens Ate My Babysitter!"),
    )

    fun byId(id: String): Episode? = ALL.firstOrNull { it.id == id }

    /**
     * The episode's DOS executable in a game directory: whatever KEEN<n>*.EXE
     * is present. For Keen 6 the choice matters — the stock KEEN6.EXE asks a
     * "which creature is this?" manual question at startup; the community
     * KEEN6C.EXE is the same game with that copy protection removed. Prefer
     * the one that lets the game start, same policy as web and desktop.
     */
    fun findExecutable(dir: File, ep: Episode): String? {
        val prefix = "KEEN${ep.num}"
        val found = dir.listFiles()
            ?.filter { it.isFile }
            ?.map { it.name }
            ?.filter { it.uppercase().startsWith(prefix) && it.uppercase().endsWith(".EXE") }
            ?.sorted()
            ?: return null
        if (found.isEmpty()) return null
        if (ep.num == 6) found.firstOrNull { it.equals("KEEN6C.EXE", ignoreCase = true) }?.let { return it }
        return found.first()
    }

    /**
     * Whether dir can actually run this episode — the same test the web and
     * desktop builds use: the episode's data files plus an executable that can
     * load them.
     */
    fun hasGameFiles(dir: File, ep: Episode): Boolean {
        val suffix = ".CK${ep.num}"
        val hasData = dir.listFiles()?.any { it.isFile && it.name.uppercase().endsWith(suffix) } == true
        return hasData && findExecutable(dir, ep) != null
    }
}
