package expo.modules.ridemode

import android.content.Context
import android.os.SystemClock
import android.util.Log

/**
 * Where a connection of the intercom goes once the receiver has matched it:
 * straight to JS through the module when the runtime is up and listening,
 * and otherwise kept as a note for the runtime to read as it starts, with
 * the runtime started so that it does. A disconnection with no JS to tell
 * is nothing: there is no ride mode running to stop.
 *
 * The note lives in the process, not on disk, like the intents API's queue:
 * a connection is the helmet going on now, and one found on disk after a
 * reboot would open ride mode on a phone lying on a table.
 */
internal object Intercom {
  const val TAG = "RideMode"

  /** How long a note stays worth acting on: long enough for JS to start and read it. */
  private const val MAX_WAIT_MS = 60_000L

  @Volatile private var pending: Pair<Long, String>? = null

  /**
   * [source] is "intercom" for the receiver and "tile" for the quick settings
   * tile, which asks for the same start and a stop with no grace period.
   */
  @Synchronized
  fun deliver(context: Context, connected: Boolean, name: String, source: String = "intercom") {
    Log.i(TAG, "$source ${if (connected) "on" else "off"}: $name")
    if (RideModeModule.instance?.emitIntercom(connected, name, source) == true) return
    if (!connected) return
    pending = SystemClock.elapsedRealtime() to name
    JsRuntime.start(context, TAG)
  }

  /** The intercom that connected while JS was not listening, if it is recent; cleared as it is read. */
  @Synchronized
  fun take(): String? {
    val (at, name) = pending ?: return null
    pending = null
    return name.takeIf { SystemClock.elapsedRealtime() - at <= MAX_WAIT_MS }
  }
}
