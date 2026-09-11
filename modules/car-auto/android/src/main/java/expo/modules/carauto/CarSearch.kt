package expo.modules.carauto

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import java.util.concurrent.atomic.AtomicBoolean

/**
 * The round trip that lets the car's search box reach the whole library.
 *
 * `BrowseTreeCache` only holds what the phone last pushed: the shelves, the
 * pinned playlists, the songs of the albums that were prefetched. Anything
 * else was simply not found, however plainly it was typed. The library itself
 * is only reachable from JavaScript, so the query goes there as an event and
 * the answer comes back through `CarAutoModule.setSearchResults`.
 *
 * That is a hop over the bridge and a request to a server, and the driver is
 * looking at an empty screen while it happens, so nothing waits on it for
 * long. Past [TIMEOUT_MS] the car is answered from the tree alone, which is
 * exactly what it was answered with before any of this existed. It is not a
 * rare path either: the car searches with the screen off and the phone locked,
 * and that is when React Native stops running timers and its requests stop
 * coming back (#103).
 *
 * A late answer is not thrown away: it is kept for a moment, so the same thing
 * typed again is answered in full and at once. The car cannot be told a second
 * time about a search it has already been answered — the browser's callback is
 * spent — so this is what makes a second try worth anything.
 */
internal object CarSearch {
  /** How long the car waits for the library before the tree answers alone. */
  private const val TIMEOUT_MS = 4_000L

  /** How long an answer stands for a query typed again. Long enough to cover a
   *  driver's second try, short enough that a library that has changed since is
   *  not what the car is shown. */
  private const val ANSWER_TTL_MS = 60_000L

  private class Ask(val query: String, val onDone: (List<BrowseNode>) -> Unit) {
    val settled = AtomicBoolean(false)
  }

  private val handler = Handler(Looper.getMainLooper())
  private val lock = Any()
  private var waiting: Ask? = null
  private var lastAnswer: Triple<String, List<BrowseNode>, Long>? = null

  /**
   * Asks JS what the library holds for `query` and calls `onDone` exactly once
   * with what came back, or with `local` when nothing did in time.
   *
   * With no JavaScript running there is nothing to wait for: loading the
   * bundle is far longer than a search box should sit there, so the tree
   * answers straight away. The event goes out all the same, because that is
   * what starts the runtime (`CarAutoModule.deliver`), and the next thing
   * typed reaches the library.
   */
  fun ask(context: Context, query: String, local: List<BrowseNode>, onDone: (List<BrowseNode>) -> Unit) {
    // Nothing was typed, so there is nothing to ask a server for: the tree
    // answers that with nothing too, and quicker.
    if (query.isBlank()) {
      onDone(local)
      return
    }
    fresh(query)?.let {
      CarAutoLog.d("search q=$query answered from the last answer")
      onDone(it)
      return
    }
    val up = JsRuntime.isUp(context)
    CarAutoModule.search(context, query, local)
    if (!up) {
      CarAutoLog.i("search q=$query: no JS to ask, the tree answers alone")
      onDone(local)
      return
    }
    val ask = Ask(query, onDone)
    synchronized(lock) { waiting = ask }
    handler.postDelayed({ settle(ask, local, timedOut = true) }, TIMEOUT_MS)
  }

  /** What JS made of a query, whether or not the car is still waiting for it. */
  fun answer(query: String, nodes: List<BrowseNode>) {
    val ask = synchronized(lock) {
      lastAnswer = Triple(query, nodes, SystemClock.elapsedRealtime())
      waiting?.takeIf { it.query == query }
    }
    if (ask == null) CarAutoLog.d("search q=$query answered too late, kept for the next try")
    else settle(ask, nodes, timedOut = false)
  }

  private fun fresh(query: String): List<BrowseNode>? = synchronized(lock) {
    val (q, nodes, at) = lastAnswer ?: return null
    if (q == query && SystemClock.elapsedRealtime() - at < ANSWER_TTL_MS) nodes else null
  }

  /**
   * The answer, once. Handed over on the main thread, which is the one the
   * session was built on and the only one media3 takes its calls from: JS
   * answers from its own.
   */
  private fun settle(ask: Ask, results: List<BrowseNode>, timedOut: Boolean) {
    if (!ask.settled.compareAndSet(false, true)) return
    synchronized(lock) { if (waiting === ask) waiting = null }
    if (timedOut) CarAutoLog.i("search q=${ask.query} timed out, the tree's own hits stand")
    handler.post { ask.onDone(results) }
  }
}
