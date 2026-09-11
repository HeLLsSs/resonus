// Adapted from wavio (github.com/Joel-Mercier/wavio, MIT) for Resonus.
package expo.modules.carauto

import android.util.Log

/**
 * The one way into logcat for the Android Auto module. Everything goes through
 * here so the verbose trace can be turned on and off in one place instead of at
 * every call site. Set `verbose = true` while debugging the browse/play flow.
 */
object CarAutoLog {
  private const val TAG = "CarAuto"

  /**
   * On for debug builds. What goes wrong here goes wrong inside a car, where
   * there is nothing to look at and no way to ask, so the trace of what the
   * head unit asked for and what it was handed has to be there already when
   * somebody finally plugs a cable in.
   */
  var verbose: Boolean = BuildConfig.DEBUG

  fun d(msg: String) {
    if (verbose) Log.d(TAG, msg)
  }

  /**
   * Always on, for the handful of steps between a car with no JavaScript
   * behind it and the song it asked for: a release build in a real car is the
   * only place that path is ever walked, and the one line per step it costs
   * is what makes a report from there readable.
   */
  fun i(msg: String) {
    Log.i(TAG, msg)
  }

  fun w(msg: String, t: Throwable? = null) {
    if (t != null) Log.w(TAG, msg, t) else Log.w(TAG, msg)
  }
}
