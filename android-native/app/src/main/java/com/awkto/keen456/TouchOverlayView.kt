package com.awkto.zeliard

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.View
import org.libsdl.app.SDLActivity
import kotlin.math.abs
import kotlin.math.hypot
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * On-screen controls, drawn below the game.
 *
 * The app is **portrait**: the emulator draws a 4:3 picture across the top of the
 * screen (SDL_DBX_SetContentAspect + the top-aligned GPU fit), and everything
 * under it belongs to this view. That mirrors the web app's touch layout, where
 * the game pane is `75vw` tall and the controls take all the remaining height —
 * same arrangement, same palette, so the two front-ends read as one product:
 *
 *     ┌───────────────────────┐
 *     │        game pane      │   (fixed height, Native.ZOOM_PANE; un-zoomed
 *     ├───────────────────────┤    the frame letterboxes inside it)
 *     │ Z 1 2 3 4 5 6 7 8 9 Y N│
 *     │                    ↕  │
 *     │  (stick)         S   M│
 *     │                       │
 *     │ ESC 💾 ⌨ F7 SPD ⏎ FF │
 *     └───────────────────────┘
 *
 * Same arrangement as the WASM app (#42): one strip at the top, the menu keys
 * on one compact row at the very bottom, and the whole middle belonging to the
 * stick and actions. (They started as a column between the stick and the
 * cluster, which crushed them, #40, then as a second row under the strip,
 * which read as clutter next to the WASM app.) 💾 opens the same two-press
 * Save/Load popup the web app uses.
 *
 * One View owns every control and every pointer. That is deliberate: Zeliard is
 * played with two thumbs at once (steer + swing), and a single view hit-testing
 * all pointers itself is the only way to get reliable simultaneous presses —
 * separate child views fight over pointer capture as soon as a thumb slides.
 *
 * Buttons do NOT implement combos or auto-fire. They press plain keys, and the
 * attack-keys patch compiled into DOSBox-X turns those into the real behaviour,
 * exactly as on desktop:
 *
 *   SWORD (S)  -> auto-firing sword; with the stick held down, a held thrust
 *   COMBO (A)  -> UP+DOWN held together plus an auto-repeating sword
 *
 * so the timing logic exists once, in the emulator, for all three platforms.
 */
class TouchOverlayView(context: Context) : View(context) {

    private companion object {
        /** Display aspect of the emulator picture; must match sdl.srcAspect (4:3). */
        const val GAME_ASPECT = 4f / 3f
    }

    private class Control(
        val id: String,
        val label: String,
        val subLabel: String?,
        val keys: IntArray,
        val fill: Int,
        val labelColor: Int,
        val circle: Boolean,
        val textScale: Float = 1f,
    ) {
        val rect = RectF()
        var pressed = false
    }

    // Palette lifted from the web app (css/app.css).
    private val gold = Color.parseColor("#e8b84b")
    private val teal = Color.parseColor("#54c8e0")
    private val crimson = Color.parseColor("#d6453f")
    private val green = Color.parseColor("#6ee0a0")     // --good; .nbtn.zoom-btn
    private val greenBg = Color.parseColor("#143a2f")   // .nbtn.zoom-btn background
    private val greenInk = Color.parseColor("#06200f")  // .nbtn.zoom-btn.active text
    private val border = Color.parseColor("#2a3f63")
    private val textCol = Color.parseColor("#e9eef7")
    private val panelBg = Color.parseColor("#081020")   // .touch-controls background
    private val btnBg = Color.parseColor("#18304f")     // .mbtn background
    private val stickBg = Color.parseColor("#0a1426")
    private val ink = Color.parseColor("#14110a")

    private val fillPaint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val strokePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        color = border
    }
    private val textPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        textAlign = Paint.Align.CENTER
        isFakeBoldText = true
    }

    private val controls = ArrayList<Control>()

    /** Top of the controls panel — directly under the emulator picture. */
    private var panelTop = 0f

    /**
     * Border-crop state (the Z button). The pane height is fixed in both states
     * (see layoutControls), so toggling only changes the Z button's colour here;
     * the native side of the state is applied by the activity via
     * [onZoomChanged] -> Native.setZoom.
     */
    var zoomed = false
        set(value) {
            if (field == value) return
            field = value
            invalidate()
        }

    /** Called after the user toggles zoom; the activity persists + applies it. */
    var onZoomChanged: ((Boolean) -> Unit)? = null

    /** Called when the ⚙ pill is tapped; the activity shows the settings dialog. */
    var onOpenSettings: (() -> Unit)? = null

    /** Called when the ⌨ pill is tapped; the activity toggles the soft keyboard. */
    var onToggleKeyboard: (() -> Unit)? = null

    // --- save/load popup (the 💾 pill, mirroring the web app's) -------------
    private var saveLoadOpen = false
    private val popupSave = RectF()
    private val popupLoad = RectF()

    // --- stick state --------------------------------------------------------
    private var stickCx = 0f
    private var stickCy = 0f
    private var stickR = 0f
    private var knobX = 0f
    private var knobY = 0f
    private var stickPointer = -1
    private val stickKeys = HashSet<Int>()

    /** pointerId -> the control it is holding (stick pointers are tracked apart). */
    private val pointerControl = HashMap<Int, Control>()

    /**
     * Ref-counted physical key state. Two sources can hold the same key at once
     * (e.g. the stick holding DOWN while a button also wants it), so a key is
     * only released when the last holder lets go — otherwise sliding a thumb
     * cancels a hold that another finger still wants.
     */
    private val keyHolds = HashMap<Int, Int>()

    private fun dp(v: Float) = v * resources.displayMetrics.density

    init {
        isFocusable = false
        setWillNotDraw(false)
        buildControls()
    }

    private fun buildControls() {
        controls.clear()
        // Action cluster, as in the web overlay: COMBO on top, SWORD and MAGIC
        // beneath it.
        controls += Control("combo", "↕", "SWORD", intArrayOf(KeyEvent.KEYCODE_A), gold, ink, true)
        controls += Control("sword", "SWORD", null, intArrayOf(KeyEvent.KEYCODE_S), crimson, Color.WHITE, true, 0.8f)
        controls += Control("magic", "MAGIC", null, intArrayOf(KeyEvent.KEYCODE_ALT_LEFT), teal, ink, true, 0.8f)

        // Bottom menu row. FF is hold-to-fast-forward: it just holds F, and
        // the attack-keys patch inside the emulator drives the speedlock
        // handler on press/release — same shape as SWORD/COMBO. 💾 opens the
        // Save/Load popup (no key of its own; the popup buttons tap G / L,
        // which the same emulator poll turns into save/load state).
        controls += Control("esc", "ESC", null, intArrayOf(KeyEvent.KEYCODE_ESCAPE), btnBg, textCol, false)
        controls += Control("saveload", "💾", null, intArrayOf(), greenBg, green, false)
        // Soft-keyboard toggle, as on the web (#kbd-btn): the game's save-file
        // prompt needs free typing. No key of its own — handleDown hands it to
        // the activity, which raises/hides the IME through the SDL glue.
        controls += Control("kbd", "⌨", null, intArrayOf(), btnBg, textCol, false)
        controls += Control("f7", "F7", null, intArrayOf(KeyEvent.KEYCODE_F7), btnBg, textCol, false)
        controls += Control("f9", "SPD", null, intArrayOf(KeyEvent.KEYCODE_F9), btnBg, gold, false)
        controls += Control("enter", "⏎", null, intArrayOf(KeyEvent.KEYCODE_ENTER), btnBg, textCol, false)
        controls += Control("ff", "FF ▶▶", null, intArrayOf(KeyEvent.KEYCODE_F), btnBg, gold, false, 0.7f)
        // Settings (filters etc.) — no key; handleDown hands it to the activity.
        controls += Control("gear", "⚙", null, intArrayOf(), btnBg, textCol, false)

        // Zoom toggle at the head of the number strip, as on the web
        // (.nbtn.zoom-btn). Presses no key — handleDown special-cases it.
        controls += Control("zoom", "Z", null, intArrayOf(), greenBg, green, false)

        // Number / yes-no strip: needed for the F9 speed prompt and the game's
        // Y/N confirmations. Always visible, as on the web.
        for (i in 1..9) {
            controls += Control("n$i", "$i", null, intArrayOf(KeyEvent.KEYCODE_0 + i), btnBg, textCol, false)
        }
        controls += Control("ny", "Y", null, intArrayOf(KeyEvent.KEYCODE_Y), btnBg, gold, false)
        controls += Control("nn", "N", null, intArrayOf(KeyEvent.KEYCODE_N), btnBg, gold, false)
    }

    private fun byId(id: String) = controls.first { it.id == id }

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        super.onSizeChanged(w, h, oldw, oldh)
        layoutControls(w.toFloat(), h.toFloat())
    }

    private fun layoutControls(w: Float, h: Float) {
        val pad = w * 0.025f
        val gap = w * 0.012f

        // The picture pane has ONE fixed height in both zoom states — ZOOM_PANE
        // times the 4:3 width-fit — so nothing below it moves when Z toggles.
        // Un-zoomed, the native side letterboxes the frame between black bars
        // inside that pane; this must agree with SDL_DBX_SetContentZoom's pane,
        // or the controls detach from the picture.
        panelTop = w / GAME_ASPECT * Native.ZOOM_PANE.toFloat()
        if (panelTop > h * 0.75f) panelTop = h * 0.75f   // guard: never eat the whole screen

        // --- Z + number / Y-N strip across the top of the panel -------------
        val strip = listOf("zoom") + (1..9).map { "n$it" } + listOf("ny", "nn")
        val nW = (w - 2 * pad - gap * (strip.size - 1)) / strip.size
        val nH = min(nW * 1.15f, dp(40f))
        var nx = pad
        val nY = panelTop + pad
        for (id in strip) {
            byId(id).rect.set(nx, nY, nx + nW, nY + nH)
            nx += nW + gap
        }

        // --- bottom row: ESC 💾 F7 SPD ⏎ FF ---------------------------------
        // At the very bottom of the screen, as on the WASM app (#42): compact
        // web-sized pills (0.12w x 0.066w) spread across the width. This frees
        // the whole middle of the panel for the stick and actions. dp(10)
        // keeps the pills clear of the immersive-mode gesture bar.
        val menu = listOf("gear", "esc", "saveload", "kbd", "f7", "f9", "enter", "ff")
        val mW = min((w - 2 * pad - gap * (menu.size - 1)) / menu.size, w * 0.12f)
        val mH = min(mW * 0.55f, dp(40f))
        val mY = h - pad - dp(10f) - mH
        val mStep = (w - 2 * pad - mW) / (menu.size - 1)
        for ((i, id) in menu.withIndex()) {
            val mx = pad + i * mStep
            byId(id).rect.set(mx, mY, mx + mW, mY + mH)
        }

        // Save/Load popup, stacked just above the 💾 pill (drawn while open).
        val sl = byId("saveload").rect
        val pw = w * 0.26f
        val ph = dp(46f)
        val px0 = (sl.centerX() - pw / 2f).coerceIn(pad, w - pad - pw)
        popupLoad.set(px0, sl.top - gap * 2f - ph, px0 + pw, sl.top - gap * 2f)
        popupSave.set(px0, popupLoad.top - gap - ph, px0 + pw, popupLoad.top - gap)

        // --- main row: stick | action cluster --------------------------------
        // Centred between the strip and the bottom row — the WASM arrangement:
        // thumbs land mid-panel, and the bottom row stays out of their way.
        val rowTop = nY + nH + gap * 2f
        val rowBottom = mY - gap * 2f
        val region = rowBottom - rowTop

        // Sized to match the WASM app's overlay, measured off side-by-side
        // device screenshots (#42): stick ring r = 0.17w, action circles
        // r = 0.09w. Bigger read as comically oversized next to it.
        stickR = min(w * 0.17f, region * 0.30f)
        val aR = min(w * 0.09f, region * 0.20f)
        // Tall enough for the stick or for the two-row action cluster.
        val blockH = maxOf(stickR * 2f, aR * 4.2f)
        // Sit above centre and well clear of the screen edges — thumbs curl in
        // from the sides, so flush-to-the-edge placement felt cramped (dp(4)
        // was still too close to the edges on-device).
        val nudge = dp(12f)
        val rowMid = maxOf((rowTop + rowBottom) / 2f, rowTop + blockH / 2f) - nudge

        stickCx = pad + stickR + nudge
        stickCy = rowMid
        knobX = stickCx
        knobY = stickCy
        fun place(c: Control, ccx: Float, ccy: Float, r: Float) =
            c.rect.set(ccx - r, ccy - r, ccx + r, ccy + r)
        val magicCx = w - pad - aR - nudge
        val swordCx = magicCx - aR * 2.2f
        val lowerCy = rowMid + blockH / 2f - aR
        place(byId("magic"), magicCx, lowerCy, aR)
        place(byId("sword"), swordCx, lowerCy, aR)
        place(byId("combo"), (swordCx + magicCx) / 2f, lowerCy - aR * 2.2f, aR)

        textPaint.textSize = nH * 0.5f
        strokePaint.strokeWidth = dp(1.5f)
    }

    // --- drawing ------------------------------------------------------------
    override fun onDraw(canvas: Canvas) {
        // Panel behind the controls; above it is the emulator surface, which must
        // stay untouched, so only paint from panelTop down.
        fillPaint.color = panelBg
        canvas.drawRect(0f, panelTop, width.toFloat(), height.toFloat(), fillPaint)

        // Stick well + knob
        fillPaint.color = stickBg
        canvas.drawCircle(stickCx, stickCy, stickR, fillPaint)
        strokePaint.color = border
        canvas.drawCircle(stickCx, stickCy, stickR, strokePaint)
        fillPaint.color = teal
        fillPaint.alpha = if (stickPointer >= 0) 255 else 210
        canvas.drawCircle(knobX, knobY, stickR * 0.42f, fillPaint)

        for (c in controls) {
            // The zoom toggle shows its state, web-style: dark green idle,
            // solid green with dark text while the crop is on.
            val zoomActive = c.id == "zoom" && zoomed
            fillPaint.color = if (zoomActive) green else c.fill
            if (c.pressed) fillPaint.alpha = (fillPaint.alpha * 0.6f).roundToInt().coerceIn(0, 255)
            if (c.circle) {
                val r = c.rect.width() / 2f
                canvas.drawCircle(c.rect.centerX(), c.rect.centerY(), r, fillPaint)
                canvas.drawCircle(c.rect.centerX(), c.rect.centerY(), r, strokePaint)
            } else {
                val rr = dp(9f)
                canvas.drawRoundRect(c.rect, rr, rr, fillPaint)
                canvas.drawRoundRect(c.rect, rr, rr, strokePaint)
            }
            textPaint.color = if (zoomActive) greenInk else c.labelColor
            val base = textPaint.textSize
            textPaint.textSize = base * c.textScale * (if (c.circle) 1.15f else 1f)
            val fm = textPaint.fontMetrics
            if (c.subLabel == null) {
                canvas.drawText(c.label, c.rect.centerX(), c.rect.centerY() - (fm.ascent + fm.descent) / 2f, textPaint)
            } else {
                val yc = c.rect.centerY()
                canvas.drawText(c.label, c.rect.centerX(), yc - (fm.ascent + fm.descent) / 2f - textPaint.textSize * 0.42f, textPaint)
                val sub = textPaint.textSize
                textPaint.textSize = sub * 0.62f
                canvas.drawText(c.subLabel, c.rect.centerX(), yc + textPaint.textSize * 1.0f, textPaint)
                textPaint.textSize = sub
            }
            textPaint.textSize = base
        }

        // Save/Load popup, above everything else while open.
        if (saveLoadOpen) {
            val rr = dp(9f)
            for ((rect, label, color) in listOf(
                Triple(popupSave, "SAVE", gold),
                Triple(popupLoad, "LOAD", teal),
            )) {
                fillPaint.color = btnBg
                canvas.drawRoundRect(rect, rr, rr, fillPaint)
                strokePaint.color = color
                canvas.drawRoundRect(rect, rr, rr, strokePaint)
                strokePaint.color = border
                textPaint.color = color
                val fm = textPaint.fontMetrics
                canvas.drawText(label, rect.centerX(), rect.centerY() - (fm.ascent + fm.descent) / 2f, textPaint)
            }
        }
    }

    // --- input --------------------------------------------------------------
    override fun onTouchEvent(event: MotionEvent): Boolean {
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN, MotionEvent.ACTION_POINTER_DOWN -> {
                val i = event.actionIndex
                return handleDown(event.getPointerId(i), event.getX(i), event.getY(i))
            }
            MotionEvent.ACTION_MOVE -> {
                if (stickPointer >= 0) {
                    val i = event.findPointerIndex(stickPointer)
                    if (i >= 0) updateStick(event.getX(i), event.getY(i))
                }
                return true
            }
            MotionEvent.ACTION_UP, MotionEvent.ACTION_POINTER_UP -> {
                handleUp(event.getPointerId(event.actionIndex))
                return true
            }
            MotionEvent.ACTION_CANCEL -> {
                releaseAll()
                return true
            }
        }
        return false
    }

    private fun handleDown(pointerId: Int, x: Float, y: Float): Boolean {
        // Touches on the game picture are not ours; let them through so the
        // emulator still sees them (and so a stray tap up there does nothing).
        if (y < panelTop) return false

        // An open Save/Load popup takes the whole tap: run the choice, or just
        // close on a tap anywhere else (as the web popup does).
        if (saveLoadOpen) {
            saveLoadOpen = false
            invalidate()
            when {
                popupSave.contains(x, y) -> tapKey(KeyEvent.KEYCODE_G)
                popupLoad.contains(x, y) -> tapKey(KeyEvent.KEYCODE_L)
            }
            return true
        }

        if (hypot(x - stickCx, y - stickCy) <= stickR * 1.15f && stickPointer < 0) {
            stickPointer = pointerId
            updateStick(x, y)
            invalidate()
            return true
        }
        for (c in controls) {
            if (!hit(c, x, y)) continue
            if (c.id == "zoom") {
                // A toggle, not a key: flip the crop and re-lay-out. Not added
                // to pointerControl — there is nothing to release on up.
                zoomed = !zoomed
                onZoomChanged?.invoke(zoomed)
                return true
            }
            if (c.id == "saveload") {
                saveLoadOpen = true
                invalidate()
                return true
            }
            if (c.id == "gear") {
                onOpenSettings?.invoke()
                return true
            }
            if (c.id == "kbd") {
                onToggleKeyboard?.invoke()
                return true
            }
            pointerControl[pointerId] = c
            c.pressed = true
            c.keys.forEach { holdKey(it, true) }
            invalidate()
            return true
        }
        // Consume touches that land on the panel but miss every control. If the
        // first finger down fell through, Android would route the whole gesture
        // to the view underneath and a second finger landing on a button would
        // never reach us.
        return true
    }

    private fun hit(c: Control, x: Float, y: Float): Boolean {
        if (!c.circle) return c.rect.contains(x, y)
        val r = c.rect.width() / 2f
        return hypot(x - c.rect.centerX(), y - c.rect.centerY()) <= r
    }

    private fun handleUp(pointerId: Int) {
        if (pointerId == stickPointer) {
            stickPointer = -1
            knobX = stickCx
            knobY = stickCy
            stickKeys.forEach { holdKey(it, false) }
            stickKeys.clear()
            invalidate()
            return
        }
        pointerControl.remove(pointerId)?.let { c ->
            c.pressed = false
            c.keys.forEach { holdKey(it, false) }
            invalidate()
        }
    }

    /**
     * Eight-way from the stick, with a dead zone. Diagonals hold both keys, which
     * is what Zeliard wants for jump-forward and the down+sword thrust.
     */
    private fun updateStick(x: Float, y: Float) {
        var dx = x - stickCx
        var dy = y - stickCy
        val dist = hypot(dx, dy)
        val max = stickR * 0.72f
        if (dist > max) {
            dx = dx / dist * max
            dy = dy / dist * max
        }
        knobX = stickCx + dx
        knobY = stickCy + dy

        val want = HashSet<Int>()
        val dead = stickR * 0.28f
        if (dist > dead) {
            // A direction counts when it is at least ~41% of the dominant axis,
            // which gives each of the eight sectors a comfortable target.
            val ax = abs(dx)
            val ay = abs(dy)
            if (ax > dead * 0.5f && ax >= ay * 0.41f) {
                want += if (dx < 0) KeyEvent.KEYCODE_DPAD_LEFT else KeyEvent.KEYCODE_DPAD_RIGHT
            }
            if (ay > dead * 0.5f && ay >= ax * 0.41f) {
                want += if (dy < 0) KeyEvent.KEYCODE_DPAD_UP else KeyEvent.KEYCODE_DPAD_DOWN
            }
        }
        if (want != stickKeys) {
            (stickKeys - want).forEach { holdKey(it, false) }
            (want - stickKeys).forEach { holdKey(it, true) }
            stickKeys.clear()
            stickKeys.addAll(want)
        }
        invalidate()
    }

    private fun holdKey(code: Int, down: Boolean) {
        val n = keyHolds[code] ?: 0
        if (down) {
            keyHolds[code] = n + 1
            if (n == 0) SDLActivity.onNativeKeyDown(code)
        } else if (n > 0) {
            keyHolds[code] = n - 1
            if (n == 1) SDLActivity.onNativeKeyUp(code)
        }
    }

    /** Force every held key up. Used when the app loses focus mid-press. */
    fun releaseAll() {
        saveLoadOpen = false
        keyHolds.forEach { (code, n) -> if (n > 0) SDLActivity.onNativeKeyUp(code) }
        keyHolds.clear()
        stickKeys.clear()
        pointerControl.clear()
        controls.forEach { it.pressed = false }
        stickPointer = -1
        knobX = stickCx
        knobY = stickCy
        invalidate()
    }

    /** Tap a key that has no button of its own (e.g. the hardware Back -> ESC). */
    fun tapKey(code: Int) {
        SDLActivity.onNativeKeyDown(code)
        postDelayed({ SDLActivity.onNativeKeyUp(code) }, 60)
    }
}
