package com.awkto.keen456

/**
 * Bridge to the handful of Keen-specific entry points patched into DOSBox-X.
 * nativeSetEnv / nativeStatusLine live in libmain.so (patch 0003);
 * nativeSetScaleLinear lives in libSDL2.so (patch 0006 — the GL filter is
 * fixed at texture creation, so that is where the state has to be). JNI
 * resolves native methods across every loaded library, so the split is
 * invisible here — but all of them are loaded by SDLActivity.loadLibraries(),
 * so every call must happen after super.onCreate().
 *
 * Unlike zeliard there is no zoom/crop: Keen's 320x200 frame has no border to
 * cut, so the picture is the plain top-aligned 4:3 width-fit (patch 0006 with
 * the zoom values left at their zero defaults). TouchOverlayView's panelTop
 * is the same width-fit height — keep the two in agreement.
 */
object Native {

    /**
     * Smooth (1, linear) / Crisp (0, nearest) pixels, applied live: this SDL's
     * GLES2 renderer fixes the GL filter when the frame texture is created, so
     * the native side (patch 0006) recreates the window texture at the next
     * present when this changes.
     */
    external fun nativeSetScaleLinear(linear: Int)

    /**
     * Set a process environment variable inside the emulator process.
     *
     * On desktop the Go launcher exports KEEN_POGO / KEEN_POGO_HOLD into the
     * DOSBox-X child process; Android has no equivalent (one process, no
     * exec), so the launcher pokes them in directly before the SDL thread
     * starts. The in-emulator pogo poll latches these on its first call,
     * which happens well after video init, so setting them in onCreate is
     * early enough.
     */
    external fun nativeSetEnv(key: String, value: String)

    /** DOSBox-X's status line (what would be the window title). Debug aid. */
    external fun nativeStatusLine(): String
}
