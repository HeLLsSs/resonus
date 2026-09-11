package expo.modules.homewidget

import android.content.Context
import android.util.Log
import com.facebook.react.ReactApplication

/**
 * Starts the JavaScript side with no screen. The same as the car module's:
 * the React host lives in the Application and needs no Activity to run,
 * `ReactHost.start()` is idempotent, and an Activity that comes later draws
 * its surface on the instance already up.
 *
 * Why the widget needs it: its play button with the app closed used to open
 * the app on the player so that JS could start the music, which put a screen
 * in front of somebody who had pressed a button on their home screen. Now
 * JS is started where it is, and the music starts with nothing opening.
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
