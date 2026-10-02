// Adapted from wavio (github.com/Joel-Mercier/wavio, MIT) for Resonus.
package expo.modules.carauto

import android.util.Log
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * The one way into logcat for the Android Auto module. Everything goes through
 * here so the verbose trace can be turned on and off in one place instead of at
 * every call site. Set `verbose = true` while debugging the browse/play flow.
 *
 * The last [KEEP] lines are also kept in memory, the verbose ones included
 * whether or not they went to logcat, for the diagnostics screen to show and
 * share: a report written at home has no logcat of what happened in the car.
 */
object CarAutoLog {
  private const val TAG = "CarAuto"
  private const val KEEP = 200

  private val recent = ArrayDeque<String>(KEEP)
  /** Not thread-safe, so only used under the lock on [recent]. */
  private val clock = SimpleDateFormat("HH:mm:ss.SSS", Locale.US)

  private fun keep(level: Char, msg: String) {
    synchronized(recent) {
      if (recent.size >= KEEP) recent.removeFirst()
      recent.addLast("${clock.format(Date())} $level $msg")
    }
  }

  /** The kept lines, oldest first, one per line. */
  fun recent(): String = synchronized(recent) { recent.joinToString("\n") }

  /**
   * On for debug builds. What goes wrong here goes wrong inside a car, where
   * there is nothing to look at and no way to ask, so the trace of what the
   * head unit asked for and what it was handed has to be there already when
   * somebody finally plugs a cable in.
   */
  var verbose: Boolean = BuildConfig.DEBUG

  fun d(msg: String) {
    keep('D', msg)
    if (verbose) Log.d(TAG, msg)
  }

  /**
   * Always on, for the handful of steps between a car with no JavaScript
   * behind it and the song it asked for: a release build in a real car is the
   * only place that path is ever walked, and the one line per step it costs
   * is what makes a report from there readable.
   */
  fun i(msg: String) {
    keep('I', msg)
    Log.i(TAG, msg)
  }

  fun w(msg: String, t: Throwable? = null) {
    keep('W', if (t != null) "$msg (${t.javaClass.simpleName}: ${t.message})" else msg)
    if (t != null) Log.w(TAG, msg, t) else Log.w(TAG, msg)
  }
}
