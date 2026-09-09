package expo.modules.localhttp

import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Expo bridge to `FileServer`: the phone serving its own music to a renderer on
 * the network, so what is on the phone can be cast like what is on a server.
 *
 * It is only ever up while casting. The JS API lives in `src/lib/localHttp.ts`,
 * and what keeps the process alive while the screen is off is the foreground
 * service the cast already runs (`modules/cast-media`), not anything here.
 */
class LocalHttpModule : Module() {
  private var server: FileServer? = null

  override fun definition() = ModuleDefinition {
    Name("LocalHttp")

    OnDestroy {
      server?.stop()
      server = null
    }

    /**
     * Starts the server if it is not up and answers where it can be reached,
     * or null when this phone has no address on the network to be reached at.
     */
    AsyncFunction("start") { promise: Promise ->
      try {
        val ctx =
          appContext.reactContext?.applicationContext
            ?: return@AsyncFunction promise.resolve(null)
        val running = server ?: FileServer(ctx).also { it.start() }
        server = running
        promise.resolve(running.origin())
      } catch (e: Exception) {
        promise.reject("ERR_LOCAL_HTTP", e.message ?: "could not start the server", e)
      }
    }

    /** Publishes what may be asked for: `[{ key, uri, mime }]` for a file on the
     *  phone, `[{ key, url, headers }]` for a server URL relayed from here. */
    Function("setEntries") { json: String ->
      server?.setEntries(json)
    }

    AsyncFunction("stop") { promise: Promise ->
      server?.stop()
      server = null
      promise.resolve(null)
    }
  }
}
