package expo.modules.ridemode

import android.content.Context
import android.util.Log
import com.facebook.react.ReactApplication

/**
 * Starts the JavaScript side with no screen. The same as the car module's:
 * the React host lives in the Application and needs no Activity to run,
 * `ReactHost.start()` is idempotent, and an Activity that comes later draws
 * its surface on the instance already up.
 *
 * Why ride mode needs it: the intercom connects while the phone is asleep in
 * a pocket, and the app may well not be running. JS is started where it is,
 * finds the note the receiver left, and opens the ride screen itself.
 */
internal object JsRuntime {
  /**
   * Starts JS with no Activity. False when there is no React host to start,
   * which is a process that is not the app's own and never happens here.
   */
  fun start(context: Context, tag: String): Boolean {
    val host = (context.applicationContext as? ReactApplication)?.reactHost ?: return false
    if (host.currentReactContext != null) return true
    Log.i(tag, "starting JS with no screen")
    host.start()
    return true
  }
}
