package com.awkto.keen456

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.RadialGradient
import android.graphics.RectF
import android.graphics.Shader
import android.view.View

/**
 * The screen filter (Settings ▸ Screen filter): scanlines / CRT / RGB grille,
 * drawn over the emulator picture. The Android counterpart of the web app's
 * #crt-canvas overlay, with the same filter list and strengths (js/app.js
 * FILTERS) — pitch locked to the 320x200 game grid so lines sit on game rows.
 *
 * The web overlay multiplies the frame through a WebGL shader; a plain View
 * can't multiply what a SurfaceView shows underneath it, but translucent black
 * composites as c*(1-a) — exactly a multiply by (1-a) — so scanlines, grille
 * and vignette all come out right. The colour cast of the RGB grille is the one
 * approximation: translucent colour stripes also *add* a little of their colour
 * where the game is dark, so their alpha is kept low.
 *
 * Not interactive (touches fall through to the game), and it only redraws on
 * filter/zoom/layout changes — the emulator's frames never invalidate it, so
 * the running cost is zero.
 *
 * Geometry mirrors patch 0006's GPU blit and TouchOverlayView.layoutControls:
 * the plain top-aligned width-fit 4:3 rect (no zoom pane — Keen has no border
 * to crop). Keep all three in agreement or the lines detach from the game
 * rows.
 */
class FilterOverlayView(context: Context) : View(context) {

    private companion object {
        const val GAME_ASPECT = 4f / 3f
        const val GAME_W = 320
        const val GAME_H = 200
    }

    /** Ported from the web app's FILTERS map (scan/mask/vig strengths). */
    private class FilterDef(val scan: Float, val mask: Float, val vig: Float)

    private val filters = mapOf(
        "scanlines" to FilterDef(0.45f, 0f, 0f),
        "crt" to FilterDef(0.45f, 0.18f, 0.45f),
        "rgb" to FilterDef(0f, 0.22f, 0f),
    )

    var filter: String = "off"
        set(value) {
            if (field == value) return
            field = value
            invalidate()
        }

    private val linePaint = Paint()
    private val stripePaint = Paint()
    private val vigPaint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val imgRect = RectF()
    private val vigMatrix = Matrix()
    private var vigShader: RadialGradient? = null

    init {
        setWillNotDraw(false)
    }

    /** Touches over the picture belong to the game; never consume anything. */
    override fun onTouchEvent(event: android.view.MotionEvent): Boolean = false

    override fun onDraw(canvas: Canvas) {
        val def = filters[filter] ?: return
        val w = width.toFloat()
        val h = height.toFloat()
        if (w <= 0f || h <= 0f) return

        // Same pane as TouchOverlayView.layoutControls, including its guard.
        var paneH = w / GAME_ASPECT
        if (paneH > h * 0.75f) paneH = h * 0.75f

        // The frame rect: the plain top-aligned width-fit (patch 0006's fit).
        val imgW = w
        val imgH = paneH
        imgRect.set(0f, 0f, imgW, imgH)

        val save = canvas.save()
        canvas.clipRect(0f, 0f, w, minOf(paneH, imgRect.bottom))
        if (imgRect.top > 0f) canvas.clipRect(0f, imgRect.top, w, paneH)

        // Scanlines: one dark band per game row, on the row boundaries (the web
        // shader's sin² dip), half a row thick.
        if (def.scan > 0f) {
            val pitch = imgH / GAME_H
            val thick = pitch * 0.5f
            linePaint.color = Color.BLACK
            linePaint.alpha = (def.scan * 255).toInt()
            var y = imgRect.top
            while (y < paneH && y < imgRect.bottom) {
                if (y + thick > 0f) canvas.drawRect(0f, y, w, y + thick, linePaint)
                y += pitch
            }
        }

        // RGB grille: the web tints each game column R/G/B in turn; translucent
        // colour stripes at low alpha give the same aperture-grille texture.
        if (def.mask > 0f) {
            val pitch = imgW / GAME_W
            val a = (def.mask * 0.7f * 255).toInt()
            val cols = intArrayOf(Color.RED, Color.GREEN, Color.BLUE)
            var x = imgRect.left
            var i = 0
            while (x < w && x < imgRect.right) {
                if (x + pitch > 0f) {
                    stripePaint.color = cols[i % 3]
                    stripePaint.alpha = a
                    canvas.drawRect(x, maxOf(0f, imgRect.top), x + pitch * 0.6f, minOf(paneH, imgRect.bottom), stripePaint)
                }
                x += pitch
                i++
            }
        }

        // Vignette: darkening grows with the squared distance from the frame's
        // centre (the web's 1 - vig*dot(p,p)*0.5), corners at 1-vig.
        if (def.vig > 0f) {
            val vig = def.vig
            if (vigShader == null) {
                // Unit-radius gradient; the matrix stretches it to the frame's
                // half-diagonal so the corners land at t=1. Alpha ~ vig * t².
                val stops = floatArrayOf(0f, 0.5f, 0.75f, 1f)
                val colors = intArrayOf(
                    Color.argb(0, 0, 0, 0),
                    Color.argb((vig * 0.25f * 255).toInt(), 0, 0, 0),
                    Color.argb((vig * 0.56f * 255).toInt(), 0, 0, 0),
                    Color.argb((vig * 255).toInt(), 0, 0, 0),
                )
                vigShader = RadialGradient(0f, 0f, 1f, colors, stops, Shader.TileMode.CLAMP)
            }
            vigMatrix.setScale(imgW * 0.7071f, imgH * 0.7071f)
            vigMatrix.postTranslate(imgRect.centerX(), imgRect.centerY())
            vigShader!!.setLocalMatrix(vigMatrix)
            vigPaint.shader = vigShader
            canvas.drawRect(imgRect, vigPaint)
        }

        canvas.restoreToCount(save)
    }
}
