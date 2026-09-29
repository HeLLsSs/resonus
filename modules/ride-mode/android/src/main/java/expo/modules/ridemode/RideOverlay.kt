package expo.modules.ridemode

import android.content.Context
import android.content.Intent
import android.graphics.PixelFormat
import android.media.AudioManager
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.util.Log
import android.view.ContextThemeWrapper
import android.view.Gravity
import android.view.KeyEvent
import android.view.LayoutInflater
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.view.WindowManager
import android.widget.ImageButton
import android.widget.TextView
import kotlin.math.abs
import kotlin.math.roundToInt

/** What the floating player shows, pushed by JS (`src/lib/rideMode.ts`). */
internal data class OverlayState(val title: String, val isPlaying: Boolean)

/**
 * The floating player: a pill over whatever app is in front, Waze
 * included, with the song's title and three buttons. Drawn on the
 * application's own window manager rather than from a service: it is only
 * ever up while ride mode is, and ride mode is JS, which the music keeps
 * alive through expo-audio's foreground service for as long as anything
 * plays. Music stopped and the app put away, the pill goes with the
 * process, which is where a rider who stopped the music wants it.
 *
 * The buttons go to JS, which is what knows whether the phone, a speaker or
 * a Jam is playing; with JS gone they press the media keys the widget's
 * buttons press. The title is the handle: dragged, it moves the pill;
 * tapped, it opens the app on the ride screen.
 */
internal object RideOverlay {
  /** The deep link the title opens. `resonuls` is the app's scheme (app.json). */
  private const val RIDE_LINK = "resonuls://ride"
  private const val KEY_X = "overlayX"
  private const val KEY_Y = "overlayY"
  /** The layout has 60dp buttons; a thick glove gets these. */
  private const val LARGE_BUTTON_DP = 80
  private const val LARGE_TITLE_SP = 18f
  private const val LARGE_TITLE_WIDTH_DP = 140

  private val main = Handler(Looper.getMainLooper())
  private var view: View? = null
  private var params: WindowManager.LayoutParams? = null

  val shown: Boolean
    get() = view != null

  /** Whether the user has let the app draw over others; asked for on the system's screen. */
  fun canDraw(context: Context): Boolean = Settings.canDrawOverlays(context)

  fun requestPermission(context: Context) {
    val intent = Intent(
      Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
      Uri.parse("package:${context.packageName}"),
    ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    runCatching { context.startActivity(intent) }
      .onFailure { Log.w(Intercom.TAG, "could not open the overlay permission screen: ${it.message}") }
  }

  /**
   * Puts the pill up, or refreshes it. [large] makes the buttons a size for
   * thick gloves; it is read when the pill is made, so a change in the
   * settings shows the next time it comes up.
   */
  fun show(context: Context, state: OverlayState, large: Boolean = false) {
    val app = context.applicationContext
    if (!canDraw(app)) return
    main.post {
      if (view != null) {
        apply(state)
        return@post
      }
      val wm = app.getSystemService(Context.WINDOW_SERVICE) as? WindowManager ?: return@post
      val themed = ContextThemeWrapper(app, android.R.style.Theme_Material_NoActionBar)
      val root = LayoutInflater.from(themed).inflate(R.layout.ride_overlay, null)
      val prefs = app.getSharedPreferences(RideConfig.PREFS, Context.MODE_PRIVATE)
      val layout = WindowManager.LayoutParams(
        WindowManager.LayoutParams.WRAP_CONTENT,
        WindowManager.LayoutParams.WRAP_CONTENT,
        if (Build.VERSION.SDK_INT >= 26) {
          WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
        } else {
          @Suppress("DEPRECATION")
          WindowManager.LayoutParams.TYPE_PHONE
        },
        WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
        PixelFormat.TRANSLUCENT,
      ).apply {
        gravity = Gravity.TOP or Gravity.START
        // Where it was left last time, or under the status bar to begin with.
        x = prefs.getInt(KEY_X, dp(app, 12))
        y = prefs.getInt(KEY_Y, dp(app, 96))
      }
      if (large) enlarge(app, root)
      wire(app, root, wm, layout)
      runCatching { wm.addView(root, layout) }
        .onSuccess {
          view = root
          params = layout
          apply(state)
        }
        .onFailure { Log.w(Intercom.TAG, "could not draw the floating player: ${it.message}") }
    }
  }

  fun update(state: OverlayState) {
    main.post { apply(state) }
  }

  fun hide() {
    main.post {
      val root = view ?: return@post
      val wm = root.context.applicationContext.getSystemService(Context.WINDOW_SERVICE) as? WindowManager
      runCatching { wm?.removeView(root) }
      view = null
      params = null
    }
  }

  /** The buttons at [LARGE_BUTTON_DP] instead of the layout's own, and the title to match. */
  private fun enlarge(app: Context, root: View) {
    val size = dp(app, LARGE_BUTTON_DP)
    for (id in intArrayOf(R.id.ride_prev, R.id.ride_play, R.id.ride_next)) {
      root.findViewById<ImageButton>(id).apply {
        layoutParams = layoutParams.also {
          it.width = size
          it.height = size
        }
      }
    }
    root.findViewById<TextView>(R.id.ride_title).apply {
      textSize = LARGE_TITLE_SP
      layoutParams = layoutParams.also { it.width = dp(app, LARGE_TITLE_WIDTH_DP) }
    }
  }

  private fun apply(state: OverlayState) {
    val root = view ?: return
    root.findViewById<TextView>(R.id.ride_title).apply {
      text = state.title
      // A marquee only runs on a selected view, and nothing else selects it.
      isSelected = true
    }
    root.findViewById<ImageButton>(R.id.ride_play)
      .setImageResource(if (state.isPlaying) R.drawable.ic_ride_pause else R.drawable.ic_ride_play)
  }

  private fun wire(app: Context, root: View, wm: WindowManager, layout: WindowManager.LayoutParams) {
    root.findViewById<ImageButton>(R.id.ride_prev).setOnClickListener { act(app, "previous") }
    root.findViewById<ImageButton>(R.id.ride_play).setOnClickListener { act(app, "toggle") }
    root.findViewById<ImageButton>(R.id.ride_next).setOnClickListener { act(app, "next") }

    val title = root.findViewById<TextView>(R.id.ride_title)
    title.setOnClickListener { act(app, "open") }
    val slop = ViewConfiguration.get(app).scaledTouchSlop
    var downX = 0f
    var downY = 0f
    var startX = 0
    var startY = 0
    var dragging = false
    title.setOnTouchListener { v, event ->
      when (event.actionMasked) {
        MotionEvent.ACTION_DOWN -> {
          downX = event.rawX
          downY = event.rawY
          startX = layout.x
          startY = layout.y
          dragging = false
          true
        }
        MotionEvent.ACTION_MOVE -> {
          val dx = event.rawX - downX
          val dy = event.rawY - downY
          if (!dragging && (abs(dx) > slop || abs(dy) > slop)) dragging = true
          if (dragging) {
            layout.x = (startX + dx).roundToInt()
            layout.y = (startY + dy).roundToInt()
            runCatching { wm.updateViewLayout(root, layout) }
          }
          true
        }
        MotionEvent.ACTION_UP -> {
          if (dragging) {
            app.getSharedPreferences(RideConfig.PREFS, Context.MODE_PRIVATE)
              .edit()
              .putInt(KEY_X, layout.x)
              .putInt(KEY_Y, layout.y)
              .apply()
          } else {
            v.performClick()
          }
          true
        }
        MotionEvent.ACTION_CANCEL -> true
        else -> false
      }
    }
  }

  /**
   * A button. JS first, which knows what is playing where; with JS gone,
   * the media keys, which reach expo-audio's session the way the headset's
   * buttons do. Opening the app is the system's job either way.
   */
  private fun act(app: Context, action: String) {
    if (action == "open") {
      val intent = Intent(Intent.ACTION_VIEW, Uri.parse(RIDE_LINK))
        .setPackage(app.packageName)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      runCatching { app.startActivity(intent) }
        .onFailure { Log.w(Intercom.TAG, "could not open the app: ${it.message}") }
      return
    }
    if (RideModeModule.instance?.emitAction(action) == true) return
    val audio = app.getSystemService(Context.AUDIO_SERVICE) as? AudioManager ?: return
    val key = when (action) {
      "previous" -> KeyEvent.KEYCODE_MEDIA_PREVIOUS
      "next" -> KeyEvent.KEYCODE_MEDIA_NEXT
      else -> KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE
    }
    audio.dispatchMediaKeyEvent(KeyEvent(KeyEvent.ACTION_DOWN, key))
    audio.dispatchMediaKeyEvent(KeyEvent(KeyEvent.ACTION_UP, key))
  }

  private fun dp(context: Context, value: Int): Int =
    (value * context.resources.displayMetrics.density).roundToInt()
}
