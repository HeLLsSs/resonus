package expo.modules.intentsapi

import android.content.Context
import android.util.Log
import com.facebook.react.ReactApplication

/**
 * Starts the JavaScript side with no screen. The same as the car module's:
 * the React host lives in the Application and needs no Activity to run,
 * `ReactHost.start()` is idempotent, and an Activity that comes later draws
 * its surface on the instance already up.
 *
 * Why the intents need it: a command sent to an app that is not running used
 * to start the main activity so that JS would come up, and from Android 10
 * the system refuses that to an app with nothing on screen unless it may
 * draw over other apps. A runtime with no screen asks no such permission.
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
