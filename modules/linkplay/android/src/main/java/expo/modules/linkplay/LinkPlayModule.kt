package expo.modules.linkplay

import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/**
 * Expo bridge to LinkPlay speakers (WiiM among them): finding them on the
 * network, one call of their HTTP API, and asking one where it is over and
 * over. Everything else, what to ask and what to make of the answer, is in
 * `src/lib/linkplay.ts` and `src/store/linkplay.ts`, where it can be tested
 * without a speaker.
 *
 * The asking is done here and not with a JavaScript timer because React
 * Native stops its timers while the app is in the background, screen locked
 * among other things, and a speaker whose track has ended is then never
 * heard ending: the next track was only ever handed over once the screen
 * came back. A coroutine is not a timer; what it hears is sent to JS as a
 * "status" event, which arrives whatever the screen is doing.
 */
class LinkPlayModule : Module() {
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
  @Volatile private var pollJob: Job? = null

  override fun definition() = ModuleDefinition {
    Name("LinkPlay")

    Events("status")

    /** Asks `host` where it is every `intervalMs`, as "status" events, until told to stop. */
    AsyncFunction("startPolling") { host: String, intervalMs: Double ->
      pollJob?.cancel()
      pollJob = scope.launch {
        while (isActive) {
          val result = runCatching { LinkPlayHttp.call(host, "getPlayerStatus") }
          if (!isActive) break
          sendEvent(
            "status",
            result.fold(
              { mapOf("host" to host, "body" to it) },
              { mapOf("host" to host, "error" to (it.message ?: "LinkPlay call failed")) },
            ),
          )
          delay(intervalMs.toLong())
        }
      }
    }

    AsyncFunction("stopPolling") {
      pollJob?.cancel()
      pollJob = null
    }

    OnDestroy {
      pollJob?.cancel()
      pollJob = null
    }

    /** The LinkPlay devices announcing themselves, after `timeoutMs` of listening. */
    AsyncFunction("discover") { timeoutMs: Double, promise: Promise ->
      val context = appContext.reactContext ?: run {
        promise.resolve(emptyList<Map<String, Any>>())
        return@AsyncFunction
      }
      scope.launch {
        val found = runCatching { Mdns(context).discover("_linkplay._tcp.", timeoutMs.toLong()) }
          .getOrDefault(emptyList())
        promise.resolve(found.map { mapOf("name" to it.name, "host" to it.host, "port" to it.port) })
      }
    }

    /** One command of the HTTP API to one device, its answer as text. */
    AsyncFunction("call") { host: String, command: String, promise: Promise ->
      scope.launch {
        try {
          promise.resolve(LinkPlayHttp.call(host, command))
        } catch (e: Exception) {
          promise.reject(CodedException("ERR_LINKPLAY", e.message ?: "LinkPlay call failed", e))
        }
      }
    }
  }
}
