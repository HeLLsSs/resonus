package expo.modules.intentsapi

import android.content.Context
import android.content.Intent
import android.os.SystemClock
import android.util.Log
import java.lang.ref.WeakReference

/**
 * Where a command goes once an intent has been read: straight to JS through
 * the module when the runtime is up and listening, and otherwise into a queue
 * the runtime empties as it starts, with the app started so that it does.
 *
 * The queue lives in the process and not on disk on purpose. A command is
 * somebody pressing a button now; one found on disk after a reboot would be
 * the app starting to play on its own an hour later.
 */
object Commands {
  const val TAG = "IntentsApi"
  const val ACTION_COMMAND = "com.juananzzz.resonus.COMMAND"
  const val ACTION_STATE = "com.juananzzz.resonus.STATE"
  const val EXTRA_COMMAND = "command"

  /**
   * How long a queued command stays worth running. Long enough for the app to
   * start and read it, short enough that a process kept around by the system
   * without JS ever starting does not act on a stale one when it finally does.
   */
  private const val MAX_WAIT_MS = 60_000L

  /**
   * How many commands wait at most. Somebody pressing buttons before the app
   * is up sends a handful; a sender in a loop while JS never starts would
   * otherwise fill the process, and the oldest are the ones least worth
   * running when it does.
   */
  private const val MAX_PENDING = 20

  private var live = WeakReference<IntentsApiModule>(null)
  private val pending = ArrayDeque<Pair<Long, Map<String, Any>>>()

  fun attach(module: IntentsApiModule) {
    live = WeakReference(module)
  }

  fun detach(module: IntentsApiModule) {
    if (live.get() === module) live.clear()
  }

  /**
   * The command an intent carries, as JS will read it: every extra keyed by
   * its name, `command` among them. Null when there is no command in it.
   * Numbers come out as doubles and anything exotic as text, which is what
   * survives the trip to JS unchanged.
   *
   * The extras are anybody's: an app may put a class of its own in them, and
   * unpacking that here throws. Such an intent carries no command.
   */
  fun read(intent: Intent?): Map<String, Any>? = runCatching {
    val extras = intent?.extras ?: return@runCatching null
    val name = extras.getString(EXTRA_COMMAND)?.trim().orEmpty()
    if (name.isEmpty()) return@runCatching null
    val out = LinkedHashMap<String, Any>()
    for (key in extras.keySet()) {
      @Suppress("DEPRECATION")
      val value = extras.get(key) ?: continue
      out[key] = when (value) {
        is String, is Boolean, is Double -> value
        is Number -> value.toDouble()
        else -> value.toString()
      }
    }
    out[EXTRA_COMMAND] = name
    out
  }.onFailure { Log.w(TAG, "unreadable extras: ${it.message}") }.getOrNull()

  /** Hands the command to JS, or queues it and wakes the app when JS is not there. */
  @Synchronized
  fun deliver(context: Context, command: Map<String, Any>) {
    Log.i(TAG, "command: ${command[EXTRA_COMMAND]}")
    if (live.get()?.deliver(command) == true) return
    val now = SystemClock.elapsedRealtime()
    dropStale(now)
    while (pending.size >= MAX_PENDING) pending.removeFirst()
    pending.addLast(now to command)
    wake(context)
  }

  /** Everything queued and still fresh, in the order it arrived; the queue is emptied. */
  @Synchronized
  fun take(): List<Map<String, Any>> {
    dropStale(SystemClock.elapsedRealtime())
    val fresh = pending.map { it.second }
    pending.clear()
    return fresh
  }

  private fun dropStale(now: Long) {
    pending.removeAll { now - it.first > MAX_WAIT_MS }
  }

  /**
   * Starts the app where it was left, the way the launcher would. From
   * Android 10 the system refuses this to an app with nothing on screen unless
   * it may draw over other apps, and then the command waits in the queue for
   * whoever opens the app next, within `MAX_WAIT_MS`.
   */
  private fun wake(context: Context) {
    val launch = context.packageManager.getLaunchIntentForPackage(context.packageName)
    if (launch == null) {
      Log.w(TAG, "no launch intent for ${context.packageName}")
      return
    }
    launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    runCatching { context.startActivity(launch) }
      .onFailure { Log.w(TAG, "could not start the app: ${it.message}") }
  }
}
