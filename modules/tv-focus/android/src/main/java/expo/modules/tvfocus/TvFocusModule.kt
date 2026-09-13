package expo.modules.tvfocus

import android.app.Activity
import android.content.pm.PackageManager
import android.graphics.Canvas
import android.graphics.ColorFilter
import android.graphics.Paint
import android.graphics.PixelFormat
import android.graphics.Rect
import android.graphics.RectF
import android.graphics.drawable.Drawable
import android.os.Handler
import android.os.Looper
import android.view.ViewGroup
import android.view.ViewTreeObserver
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Shows where the remote is, on a television.
 *
 * A phone tells you where you are by where your finger is. A television has
 * only a D-pad, so the one thing it must show is which control would answer if
 * you pressed OK. Android already knows: every focusable view is in a focus
 * order it walks for you. What it does not do is draw anything, because a view
 * is only highlighted if its own background says so — and React Native's views
 * have no such background. So the app is perfectly navigable and completely
 * invisible: arrows move the focus, OK opens a screen, and nothing on the
 * screen ever said which row was about to open.
 *
 * The cheap fix would be a focus style on every pressable. There are over three
 * hundred of them across ninety-four files, and every screen written after
 * today would have to remember. This draws the ring once instead, from the
 * outside: a drawable in the window's overlay, following whatever Android says
 * has the focus. It costs nothing per screen and it cannot be forgotten.
 *
 * **Only on a TV.** A phone has no focus to speak of and would get a green ring
 * around whatever a keyboard happened to land on, so the whole thing is behind
 * the leanback feature check and never attaches anywhere else.
 */
class TvFocusModule : Module() {
  private val main = Handler(Looper.getMainLooper())
  private var ring: FocusRing? = null
  private var watching: ViewGroup? = null

  /** Runs before every frame: the focus moves with scrolling and animation,
   *  not only when it changes, so the ring is placed per frame rather than on
   *  a focus event. It costs a rectangle comparison when nothing has moved. */
  private val beforeDraw = ViewTreeObserver.OnPreDrawListener {
    place()
    true
  }

  override fun definition() = ModuleDefinition {
    Name("TvFocus")

    // Read once, synchronously, because the type scale is decided when the
    // theme module loads and cannot wait for a promise. `Platform.isTV` reads
    // the UI mode, which an emulator and a few boxes get wrong; the leanback
    // feature is what the Play Store itself goes by.
    Constants {
      mapOf("isTv" to isTv())
    }

    OnCreate { main.post { attach() } }
    // The window is rebuilt when the activity is recreated, so the overlay has
    // to be found again rather than assumed to have survived.
    OnActivityEntersForeground { main.post { attach() } }
    OnDestroy { main.post { detach() } }
  }

  private fun isTv(): Boolean {
    val packages = appContext.reactContext?.packageManager ?: return false
    return packages.hasSystemFeature(PackageManager.FEATURE_LEANBACK)
  }

  private fun attach() {
    if (!isTv()) return
    val activity: Activity = appContext.currentActivity ?: return
    val decor = activity.window?.decorView as? ViewGroup ?: return
    if (decor === watching) return
    detach()
    val drawn = FocusRing(decor.resources.displayMetrics.density)
    // The overlay draws above every child and takes part in no layout, so
    // React Native never sees it and nothing it measures moves.
    decor.overlay.add(drawn)
    decor.viewTreeObserver.addOnPreDrawListener(beforeDraw)
    ring = drawn
    watching = decor
  }

  private fun detach() {
    val decor = watching ?: return
    ring?.let { decor.overlay.remove(it) }
    if (decor.viewTreeObserver.isAlive) decor.viewTreeObserver.removeOnPreDrawListener(beforeDraw)
    ring = null
    watching = null
  }

  /** Puts the ring around whatever has the focus, or takes it away. */
  private fun place() {
    val decor = watching ?: return
    val drawn = ring ?: return
    // What an overlay repaints is the drawable's own bounds, so they span the
    // window: the ring moves anywhere inside it and always leaves clean.
    drawn.setBounds(0, 0, decor.width, decor.height)
    val focused = decor.findFocus()
    if (focused == null || focused.width == 0 || focused.height == 0) {
      drawn.around(null)
      return
    }
    // The React root view takes the focus whenever nothing smaller has it.
    // A ring around the entire screen says nothing, so anything covering most
    // of the window is treated as nothing being focused at all.
    val nearlyEverything = focused.width * focused.height > decor.width * decor.height * 0.8
    if (nearlyEverything) {
      drawn.around(null)
      return
    }
    val where = IntArray(2)
    val window = IntArray(2)
    focused.getLocationInWindow(where)
    decor.getLocationInWindow(window)
    val left = where[0] - window[0]
    val top = where[1] - window[1]
    drawn.around(Rect(left, top, left + focused.width, top + focused.height))
  }
}

/**
 * The ring itself: a rounded outline just outside the focused control.
 *
 * It is drawn in the app's own green rather than the accent picked in
 * Settings, for the same reason the login screen is: the ring has to be
 * legible before anybody has chosen anything, and a pale accent on a dark
 * screen at three metres is not.
 */
private class FocusRing(density: Float) : Drawable() {
  private val outline = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    style = Paint.Style.STROKE
    color = APP_GREEN
    strokeWidth = 3f * density
  }
  /** A darker, wider line under the bright one, so the ring survives being
   *  drawn over a bright album cover as well as over a black background. */
  private val shadow = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    style = Paint.Style.STROKE
    color = 0x99000000.toInt()
    strokeWidth = 6f * density
  }
  private val gap = 4f * density
  private val corner = 12f * density
  private var target: Rect? = null

  fun around(rect: Rect?) {
    if (rect == target) return
    target = rect
    invalidateSelf()
  }

  override fun draw(canvas: Canvas) {
    val rect = target ?: return
    val outer = RectF(
      rect.left - gap,
      rect.top - gap,
      rect.right + gap,
      rect.bottom + gap,
    )
    canvas.drawRoundRect(outer, corner, corner, shadow)
    canvas.drawRoundRect(outer, corner, corner, outline)
  }

  override fun setAlpha(alpha: Int) = Unit

  override fun setColorFilter(filter: ColorFilter?) = Unit

  @Deprecated("Drawable requires it", ReplaceWith("PixelFormat.TRANSLUCENT"))
  override fun getOpacity() = PixelFormat.TRANSLUCENT

  private companion object {
    /** `DEFAULT_ACCENT` in `src/theme`, which is the app's green. */
    const val APP_GREEN = 0xFF1DB954.toInt()
  }
}
