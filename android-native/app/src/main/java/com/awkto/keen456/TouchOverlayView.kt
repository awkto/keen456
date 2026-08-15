package com.awkto.keen456

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
 * The app is **portrait**: the emulator draws a 4:3 picture across the top of
 * the screen (SDL_DBX_SetContentAspect + the top-aligned GPU fit), and
 * everything under it belongs to this view. That mirrors the web app's touch
 * layout — same arrangement, same palette, so the two front-ends read as one
 * product:
 *
 *     ┌───────────────────────┐
 *     │        game pane      │   (plain width-fit 4:3, top-aligned)
 *     ├───────────────────────┤
 *     │                  Y  N │
 *     │            SHOOT POGO │
 *     │  (stick)              │
 *     │              JUMP     │
 *     │ ⚙ ESC 💾 ⌨ ⏎  FF     │
 *     └───────────────────────┘
 *
 * One View owns every control and every pointer. That is deliberate: Keen is
 * played with two thumbs at once (run + jump/shoot), and a single view
 * hit-testing all pointers itself is the only way to get reliable
 * simultaneous presses — separate child views fight over pointer capture as
 * soon as a thumb slides.
 *
 * Buttons do NOT implement combos. They press plain keys:
 *
 *   JUMP  -> Ctrl            (Keen's jump key)
 *   POGO  -> Alt             desktop-pogo.patch inside DOSBox-X injects the
 *                            staggered Jump for the super-bounce and the
 *                            auto-retract tap, exactly as on desktop/web
 *   SHOOT -> Space
 *   FF    -> Tab, held       (speedlock turbo via the mapper, as on desktop)
 *
 * so the timing logic exists once, in the emulator, for all platforms.
 */
class TouchOverlayView(context: Context) : View(context) {

    private companion object {
        /** Display aspect of the emulator picture; must match sdl.srcAspect (4:3). */
        const val GAME_ASPECT = 4f / 3f
    }

    private class Control(
        val id: String,
        val label: String,
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
    private val teal = Color.parseColor("#54c8e0")      // --accent2; .abtn.pogo
    private val shootRed = Color.parseColor("#ff6b6b")  // .abtn.shoot
    private val jumpGreen = Color.parseColor("#6ee06e") // .abtn.jump
    private val green = Color.parseColor("#6ee0a0")
    private val greenBg = Color.parseColor("#143a2f")
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
        // Action cluster, as on the web (.actions grid): SHOOT and POGO on
        // top, JUMP centred beneath them — the thumb rests on JUMP.
        controls += Control("shoot", "SHOOT", intArrayOf(KeyEvent.KEYCODE_SPACE), shootRed, ink, true, 0.7f)
        controls += Control("pogo", "POGO", intArrayOf(KeyEvent.KEYCODE_ALT_LEFT), teal, ink, true, 0.7f)
        controls += Control("jump", "JUMP", intArrayOf(KeyEvent.KEYCODE_CTRL_LEFT), jumpGreen, ink, true, 0.7f)

        // Y / N for the game's keyboard confirm prompts (top of the panel,
        // right side — where the web keeps #yn-keys).
        controls += Control("ny", "Y", intArrayOf(KeyEvent.KEYCODE_Y), btnBg, gold, false)
        controls += Control("nn", "N", intArrayOf(KeyEvent.KEYCODE_N), btnBg, gold, false)

        // Bottom menu row. FF is hold-to-fast-forward: it holds Tab, which the
        // mapper binds to DOSBox-X's speedlock (same as desktop). 💾 opens the
        // Save/Load popup (no key of its own; the popup buttons tap the
        // mapper's save/load-state combos). ⚙ and ⌨ are handed to the
        // activity.
        controls += Control("gear", "⚙", intArrayOf(), btnBg, textCol, false)
        controls += Control("esc", "ESC", intArrayOf(KeyEvent.KEYCODE_ESCAPE), btnBg, textCol, false, 0.8f)
        controls += Control("saveload", "💾", intArrayOf(), greenBg, green, false)
        controls += Control("kbd", "⌨", intArrayOf(), btnBg, textCol, false)
        controls += Control("enter", "⏎", intArrayOf(KeyEvent.KEYCODE_ENTER), btnBg, textCol, false)
        controls += Control("ff", "FF ▶▶", intArrayOf(KeyEvent.KEYCODE_TAB), btnBg, gold, false, 0.7f)
    }

    private fun byId(id: String) = controls.first { it.id == id }

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        super.onSizeChanged(w, h, oldw, oldh)
        layoutControls(w.toFloat(), h.toFloat())
    }

    private fun layoutControls(w: Float, h: Float) {
        val pad = w * 0.025f
        val gap = w * 0.012f

        // The picture is the plain top-aligned width-fit 4:3 rect (no zoom
        // pane — Keen has no border to crop). Must agree with patch 0006's
        // aspect fit, or the controls detach from the picture.
        panelTop = w / GAME_ASPECT
        if (panelTop > h * 0.75f) panelTop = h * 0.75f   // guard: never eat the whole screen

        // --- Y/N pair at the top-right of the panel --------------------------
        val nW = w * 0.11f
        val nH = min(nW * 0.8f, dp(40f))
        val nY = panelTop + pad
        byId("nn").rect.set(w - pad - nW, nY, w - pad, nY + nH)
        byId("ny").rect.set(w - pad - nW * 2f - gap, nY, w - pad - nW - gap, nY + nH)

        // --- bottom row: ⚙ ESC 💾 ⌨ ⏎ FF ------------------------------------
        // Compact web-sized pills spread across the width; dp(10) keeps them
        // clear of the immersive-mode gesture bar.
        val menu = listOf("gear", "esc", "saveload", "kbd", "enter", "ff")
        val mW = min((w - 2 * pad - gap * (menu.size - 1)) / menu.size, w * 0.13f)
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
        val rowTop = nY + nH + gap * 2f
        val rowBottom = mY - gap * 2f

        // Sized to match the WASM app's overlay: stick ring r = 0.17w, action
        // circles r = 0.09w.
        val region = rowBottom - rowTop
        stickR = min(w * 0.17f, region * 0.30f)
        val aR = min(w * 0.09f, region * 0.20f)
        val blockH = maxOf(stickR * 2f, aR * 4.2f)
        // Sit above centre and well clear of the screen edges — thumbs curl in
        // from the sides, so flush-to-the-edge placement felt cramped.
        val nudge = dp(12f)
        val rowMid = maxOf((rowTop + rowBottom) / 2f, rowTop + blockH / 2f) - nudge

        stickCx = pad + stickR + nudge
        stickCy = rowMid
        knobX = stickCx
        knobY = stickCy
        fun place(c: Control, ccx: Float, ccy: Float, r: Float) =
            c.rect.set(ccx - r, ccy - r, ccx + r, ccy + r)
        // Web grid: SHOOT top-left, POGO top-right, JUMP centred beneath.
        val pogoCx = w - pad - aR - nudge
        val shootCx = pogoCx - aR * 2.2f
        val upperCy = rowMid - blockH / 2f + aR
        place(byId("shoot"), shootCx, upperCy, aR)
        place(byId("pogo"), pogoCx, upperCy, aR)
        place(byId("jump"), (shootCx + pogoCx) / 2f, upperCy + aR * 2.2f, aR)

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
            fillPaint.color = c.fill
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
            textPaint.color = c.labelColor
            val base = textPaint.textSize
            textPaint.textSize = base * c.textScale * (if (c.circle) 1.15f else 1f)
            val fm = textPaint.fontMetrics
            canvas.drawText(c.label, c.rect.centerX(), c.rect.centerY() - (fm.ascent + fm.descent) / 2f, textPaint)
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
                // The mapper's combos, same as desktop: Ctrl+. save, Ctrl+\ load.
                popupSave.contains(x, y) -> tapCombo(KeyEvent.KEYCODE_CTRL_LEFT, KeyEvent.KEYCODE_PERIOD)
                popupLoad.contains(x, y) -> tapCombo(KeyEvent.KEYCODE_CTRL_LEFT, KeyEvent.KEYCODE_BACKSLASH)
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
     * Eight-way from the stick, with a dead zone. Diagonals hold both keys —
     * Keen wants them for climbing ledges and shooting diagonally on the pogo.
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

    /**
     * Tap a two-key combo (modifier first): down mod, down key, then release
     * in reverse. Used for the mapper's save/load-state bindings.
     */
    private fun tapCombo(mod: Int, code: Int) {
        SDLActivity.onNativeKeyDown(mod)
        postDelayed({ SDLActivity.onNativeKeyDown(code) }, 30)
        postDelayed({ SDLActivity.onNativeKeyUp(code) }, 110)
        postDelayed({ SDLActivity.onNativeKeyUp(mod) }, 150)
    }
}
