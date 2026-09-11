package expo.modules.carauto

import android.content.Context
import com.facebook.react.ReactApplication

/**
 * Starts the JavaScript side with no screen.
 *
 * The React host lives in the Application and needs no Activity to run:
 * `ReactHost.start()` loads the bundle and gives the modules their context,
 * and an Activity that comes later draws its surface on that same instance.
 * It is the call React Native's own `HeadlessJsTaskService` makes, and it is
 * idempotent (`ReactHostImpl` keeps the one start task), so asking while a
 * start is already under way costs nothing.
 *
 * Why it is needed: the car binds the browser service on its own, and the
 * system kills the process behind a phone left asleep in a pocket. Either way
 * the service is up with a tree read from disk and no JavaScript behind it,
 * and a tap on a song used to be handed to nobody.
 */
internal object JsRuntime {
  /** True while the React context is up: the modules exist and can be handed events. */
  fun isUp(context: Context): Boolean = host(context)?.currentReactContext != null

  /**
   * Starts JS with no Activity. False when there is no React host to start,
   * which is a process that is not the app's own and never happens here.
   */
  fun start(context: Context): Boolean {
    val host = host(context) ?: return false
    if (host.currentReactContext != null) return true
    CarAutoLog.i("starting JS with no screen")
    host.start()
    return true
  }

  private fun host(context: Context) = (context.applicationContext as? ReactApplication)?.reactHost
}
