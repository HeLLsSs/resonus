package expo.modules.ticker

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.util.concurrent.ConcurrentHashMap

/**
 * A clock for JavaScript that goes on ticking with the app in the background.
 *
 * React Native stops its own timers the moment the app leaves the foreground
 * (`JavaTimerManager.onHostPause`), screen locked among other things, and
 * anything that asked a speaker or a server where it is every couple of
 * seconds stops asking: a track ends on a Home Assistant player or on the
 * server's jukebox and nobody hears it end until the screen comes back.
 * Events from native code are not timers, and arrive regardless; this
 * module turns a coroutine into "tick" events, one clock per caller, which
 * `src/lib/ticker.ts` hands back as the interval they asked for.
 */
class TickerModule : Module() {
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
  private val jobs = ConcurrentHashMap<String, Job>()

  override fun definition() = ModuleDefinition {
    Name("Ticker")

    Events("tick")

    Function("start") { id: String, intervalMs: Double ->
      jobs.remove(id)?.cancel()
      jobs[id] = scope.launch {
        while (isActive) {
          delay(intervalMs.toLong())
          if (isActive) sendEvent("tick", mapOf("id" to id))
        }
      }
    }

    Function("stop") { id: String ->
      jobs.remove(id)?.cancel()
    }

    OnDestroy {
      jobs.values.forEach { it.cancel() }
      jobs.clear()
    }
  }
}
