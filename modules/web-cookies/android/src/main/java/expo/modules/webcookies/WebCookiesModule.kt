package expo.modules.webcookies

import android.os.Handler
import android.os.Looper
import android.webkit.CookieManager
import android.webkit.WebStorage
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * The cookie jar Android's WebView keeps, read and emptied from JS.
 *
 * A sign-in is only worth anything if what it leaves behind can be read, and
 * the cookies that matter — `SID`, `HSID`, `SSID`, `__Secure-1PSID` and above
 * all the `SAPISID` every signed request to Google is signed with — are
 * HttpOnly. Script running inside the page cannot see them: `document.cookie`
 * quietly answers with the handful that are not, which looks like a cookie and
 * is not one. The jar itself has no such rule, so this is the only place the
 * whole thing exists, and the only reason this module does.
 *
 * There is one jar per app rather than one per WebView, which is what makes
 * `clear` the way to start a sign-in from nothing: it is how signing in as
 * somebody else works at all, and how the sign-in stops depending on whatever
 * an earlier one left behind.
 */
class WebCookiesModule : Module() {
  /**
   * `WebStorage` is the WebView's, and everything of the WebView's belongs to
   * the main thread. `CookieManager` is the exception and would not need it,
   * but the two are cleared together and one queue is simpler than two.
   */
  private val mainHandler = Handler(Looper.getMainLooper())

  override fun definition() = ModuleDefinition {
    Name("WebCookies")

    /**
     * The whole `Cookie` header a browser would send to that address, HttpOnly
     * included, or null when there is nothing to send — which is also the
     * answer on a device whose WebView cannot be reached at all.
     */
    Function("read") { url: String ->
      runCatching { CookieManager.getInstance().getCookie(url) }.getOrNull()
    }

    /**
     * Empties the jar and the storage the pages wrote, so what comes next is a
     * session of its own. Flushed rather than left to Android's own timing:
     * the WebView that follows opens within the second.
     */
    AsyncFunction("clear") { promise: Promise ->
      mainHandler.post {
        runCatching {
          val cookies = CookieManager.getInstance()
          cookies.removeAllCookies(null)
          cookies.flush()
          WebStorage.getInstance().deleteAllData()
        }
        promise.resolve(null)
      }
    }
  }
}
