package expo.modules.homewidget

import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.Context
import android.content.Intent
import android.media.AudioManager
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.KeyEvent

/**
 * The home-screen widget: what the launcher calls to draw it, and what its
 * buttons broadcast to.
 *
 * The buttons do not go through JS, and they do not bind to expo-audio's
 * service either: its `onBind` hands out a binder of its own for the module,
 * not media3's, so a MediaController connecting to it waits for an answer
 * that never comes. What every headset button does instead is dispatch a
 * media key through the system, which routes it to whichever session last
 * played, and expo-audio's session answers those: play, pause, and its own
 * handling of next and previous. So the widget presses the same keys. No
 * session at all (the app is not running, or has played nothing yet) means
 * the key goes nowhere; for play, the press goes to JS instead, started with
 * no screen when it is not running, since starting music from nothing is
 * its job.
 *
 * A queue row has no key to press: it goes to JS too (see [HomeWidgetModule]).
 */
class HomeWidgetProvider : AppWidgetProvider() {
  override fun onUpdate(context: Context, appWidgetManager: AppWidgetManager, appWidgetIds: IntArray) {
    HomeWidgetRenderer.refresh(context, WidgetState.load(context), appWidgetIds)
  }

  // A resize: the widget may have crossed into another layout. Only that
  // widget is redrawn, from what was pushed last.
  override fun onAppWidgetOptionsChanged(
    context: Context,
    appWidgetManager: AppWidgetManager,
    appWidgetId: Int,
    newOptions: Bundle,
  ) {
    HomeWidgetRenderer.refresh(context, WidgetState.load(context), intArrayOf(appWidgetId))
  }

  override fun onReceive(context: Context, intent: Intent) {
    when (val action = intent.action ?: "") {
      ACTION_PREV, ACTION_PLAY_PAUSE, ACTION_NEXT -> handleTransport(context.applicationContext, action)
      ACTION_JUMP -> handleJump(
        context.applicationContext,
        intent.getIntExtra(EXTRA_INDEX, -1),
        intent.getStringExtra(EXTRA_ID),
      )
      else -> super.onReceive(context, intent)
    }
  }

  private fun handleTransport(context: Context, action: String) {
    Log.i(TAG, "button: ${action.substringAfterLast('.')}")
    val audio = context.getSystemService(Context.AUDIO_SERVICE) as? AudioManager
    if (audio == null) {
      fallback(context, action)
      return
    }
    val key = when (action) {
      ACTION_PREV -> KeyEvent.KEYCODE_MEDIA_PREVIOUS
      ACTION_NEXT -> KeyEvent.KEYCODE_MEDIA_NEXT
      else -> KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE
    }
    // Read before the key goes out, not off the widget's own picture of it:
    // the picture is what JS last pushed, and JS may be a step behind. Sound
    // now means the key is a pause, and a pause needs no checking.
    val wasPlaying = audio.isMusicActive
    audio.dispatchMediaKeyEvent(KeyEvent(KeyEvent.ACTION_DOWN, key))
    audio.dispatchMediaKeyEvent(KeyEvent(KeyEvent.ACTION_UP, key))
    if (action != ACTION_PLAY_PAUSE || wasPlaying) return

    // Whether anybody heard it: a play that leaves the music silent had no
    // session to reach. The receiver stays alive for the look, which is what
    // goAsync is for.
    val pending = goAsync()
    Handler(Looper.getMainLooper()).postDelayed({
      if (!audio.isMusicActive) {
        Log.i(TAG, "nothing answered the play key: asking JS")
        fallback(context, action)
      }
      pending.finish()
    }, ANSWER_WAIT_MS)
  }

  /**
   * No session to talk to. Whatever the widget showed as playing is not, so
   * it is redrawn paused; and play goes to JS, since starting music from
   * nothing is JS's job: told while it listens, noted for it and JS started
   * when it is not. A skip with nothing playing is nothing.
   */
  private fun fallback(context: Context, action: String) {
    val shown = WidgetState.load(context)
    if (shown.isPlaying) {
      val paused = shown.copy(isPlaying = false)
      paused.save(context)
      HomeWidgetRenderer.refresh(context, paused)
    }
    if (action != ACTION_PLAY_PAUSE) return
    if (HomeWidgetModule.instance?.emitPlay() == true) return
    PendingPlay.save(context)
    wake(context, HomeWidgetRenderer.playerIntent(context, play = true))
  }

  /**
   * A queue row. With JS up it is told which song; otherwise the song is
   * noted for it and JS is started, restores the queue, and finds the note.
   */
  private fun handleJump(context: Context, index: Int, id: String?) {
    if (index < 0 || id.isNullOrEmpty()) return
    Log.i(TAG, "queue row: $index")
    if (HomeWidgetModule.instance?.emitJump(index, id) == true) return
    PendingJump.save(context, index, id)
    wake(context, HomeWidgetRenderer.playerIntent(context, play = false))
  }

  /**
   * JS with no screen, the way the car service starts it. The app is opened
   * on the player only when there is no React host to start, which is not a
   * thing that happens in this process; it is kept because the tap was a
   * request to hear something and silence would be the wrong answer to it.
   */
  private fun wake(context: Context, fallback: Intent) {
    if (JsRuntime.start(context, TAG)) return
    open(context, fallback)
  }

  private fun open(context: Context, intent: Intent) {
    runCatching { context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
      .onFailure { Log.w(TAG, "could not open the app: ${it.message}") }
  }

  companion object {
    private const val TAG = "HomeWidget"
    const val ACTION_PREV = "expo.modules.homewidget.action.PREV"
    const val ACTION_PLAY_PAUSE = "expo.modules.homewidget.action.PLAY_PAUSE"
    const val ACTION_NEXT = "expo.modules.homewidget.action.NEXT"
    const val ACTION_JUMP = "expo.modules.homewidget.action.JUMP"
    const val EXTRA_INDEX = "index"
    const val EXTRA_ID = "id"

    /** Long enough for a paused player to be audible again after the key. */
    private const val ANSWER_WAIT_MS = 900L
  }
}
