package com.awkto.zeliard

/**
 * Bridge to the handful of Zeliard-specific entry points patched into DOSBox-X.
 * nativeSetEnv / nativeStatusLine live in libmain.so (patch 0003); nativeSetZoom
 * lives in libSDL2.so (patch 0006 — the zoom is a source rectangle on SDL's GPU
 * blit, so that is where the state has to be). JNI resolves native methods
 * across every loaded library, so the split is invisible here — but all of them
 * are loaded by SDLActivity.loadLibraries(), so every call must happen after
 * super.onCreate().
 */
object Native {

    /**
     * Zoom/crop — same numbers as the web app's Z button (css/app.css): scale
     * 1.42, picture pane fixed at 96/75 of the width-fit height in BOTH zoom
     * states (un-zoomed letterboxes between black bars, so the controls never
     * shift on toggle), and the vertical crop comes entirely off the top
     * (origin 1.0) so the HUD at the bottom is never cut. TouchOverlayView's
     * panelTop must match ZOOM_PANE, or the controls detach from the picture.
     */
    const val ZOOM_SCALE = 1.42
    const val ZOOM_PANE = 96.0 / 75.0
    const val ZOOM_ORIGIN_Y = 1.0

    /**
     * Turn the border crop on or off. Takes effect at the next present. The
     * pane factor is passed in both states — the pane height never changes,
     * only whether the picture is cropped to fill it.
     */
    fun setZoom(enabled: Boolean) {
        nativeSetZoom(if (enabled) ZOOM_SCALE else 1.0, ZOOM_PANE, ZOOM_ORIGIN_Y)
    }

    private external fun nativeSetZoom(scale: Double, pane: Double, originY: Double)

    /**
     * Smooth (1, linear) / Crisp (0, nearest) pixels, applied live: this SDL's
     * GLES2 renderer fixes the GL filter when the frame texture is created, so
     * the native side (patch 0006) recreates the window texture at the next
     * present when this changes. Lives in libSDL2.so like nativeSetZoom.
     */
    external fun nativeSetScaleLinear(linear: Int)
    /**
     * Set a process environment variable inside the emulator process.
     *
     * On desktop the Go launcher exports ZELIARD_ATK / ZELIARD_AUTOFIRE into the
     * DOSBox-X child process; Android has no equivalent (one process, no exec),
     * so the launcher pokes them in directly before the SDL thread starts. The
     * in-emulator attack-keys poll latches these on its first call, which happens
     * well after video init, so setting them in onCreate is early enough.
     */
    external fun nativeSetEnv(key: String, value: String)

    /** DOSBox-X's status line (what would be the window title). Debug aid. */
    external fun nativeStatusLine(): String
}
