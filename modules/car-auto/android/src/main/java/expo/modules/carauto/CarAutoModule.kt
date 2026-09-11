// Adapted from wavio (github.com/Joel-Mercier/wavio, MIT) for Resonus.
package expo.modules.carauto

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import androidx.annotation.OptIn
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import org.json.JSONObject

@OptIn(UnstableApi::class)
class CarAutoModule : Module() {
  /**
   * True while JS has a listener on this module. An event sent before that
   * is dropped by the emitter, not held, so until then everything is kept in
   * [pending] instead.
   */
  @Volatile private var observing = false

  override fun definition() = ModuleDefinition {
    Name("CarAuto")

    Events("play", "transport", "connect", "search")

    OnCreate {
      instance = this@CarAutoModule
      CarAutoLog.d("module created, JS is up")
    }

    OnDestroy {
      observing = false
      if (instance === this@CarAutoModule) instance = null
    }

    // The moment the car's events can be handed over: the module is created
    // with the React context, but JS only subscribes once its own start-up
    // code runs, and what was kept while it started goes out here.
    OnStartObserving {
      observing = true
      flushPending()
    }

    OnStopObserving { observing = false }

    Function("setNodes") { json: String ->
      val context = appContext.reactContext ?: return@Function
      BrowseTreeCache.setFromJson(context, json)
      CarAutoLog.d("setNodes ${BrowseTreeCache.debugSummary()}")
    }

    // What the library holds for something typed in the car, whether or not
    // the car is still waiting for it (`CarSearch`).
    Function("setSearchResults") { json: String ->
      val o = runCatching { JSONObject(json) }.getOrNull() ?: return@Function
      CarSearch.answer(o.optString("query"), BrowseTreeCache.parseNodes(o.optJSONArray("nodes")))
    }

    Function("setNowPlaying") { json: String? ->
      val player = ResonusCarBrowserService.activePlayer ?: return@Function
      if (json.isNullOrEmpty() || json == "null") {
        player.applyNowPlaying(null)
        return@Function
      }
      val np = runCatching { parseNowPlaying(json) }.getOrNull() ?: return@Function
      player.applyNowPlaying(np)
    }

    Function("setQueue") { json: String ->
      val player = ResonusCarBrowserService.activePlayer ?: return@Function
      val o = runCatching { JSONObject(json) }.getOrNull() ?: return@Function
      val arr = o.optJSONArray("tracks") ?: return@Function
      val items = ArrayList<JsProxyPlayer.NowPlaying>(arr.length())
      for (i in 0 until arr.length()) {
        val t = arr.optJSONObject(i) ?: continue
        items.add(
          JsProxyPlayer.NowPlaying(
            id = t.optString("id"),
            title = t.optString("title").takeIf { it.isNotEmpty() },
            artist = t.optString("artist").takeIf { it.isNotEmpty() },
            album = t.optString("album").takeIf { it.isNotEmpty() },
            artworkUrl = t.optString("artworkUrl").takeIf { it.isNotEmpty() },
            durationMs = t.optLong("durationMs", 0L),
            favorite = t.optBoolean("favorite", false),
          ),
        )
      }
      player.applyQueue(items, o.optInt("currentIndex", 0))
    }

    Function("setQueueIndex") { index: Int ->
      val player = ResonusCarBrowserService.activePlayer ?: return@Function
      player.applyQueueIndex(index)
    }

    Function("setPlaybackState") { json: String ->
      val player = ResonusCarBrowserService.activePlayer ?: return@Function
      val o = runCatching { JSONObject(json) }.getOrNull() ?: return@Function
      val isPlaying = o.optBoolean("isPlaying", false)
      val posMs = o.optLong("positionMs", 0L)
      val shuf = o.optBoolean("shuffle", false)
      val repeat = when (o.optString("repeatMode")) {
        "one" -> Player.REPEAT_MODE_ONE
        "all" -> Player.REPEAT_MODE_ALL
        else -> Player.REPEAT_MODE_OFF
      }
      // Empty and absent mean the same thing here: nothing is wrong.
      val error = o.optString("error").takeIf { it.isNotEmpty() }
      player.applyPlaybackState(isPlaying, posMs, shuf, repeat, error)
    }
  }

  /**
   * Posted rather than sent from inside the subscription: JS adds its three
   * listeners in one go, and an event sent between the first and the third
   * would find no listener for itself yet.
   */
  private fun flushPending() {
    Handler(Looper.getMainLooper()).post {
      val events = takePending()
      if (events.isEmpty()) return@post
      CarAutoLog.i("handing JS ${events.size} event(s) kept while it started")
      for ((name, payload) in events) sendEvent(name, payload)
    }
  }

  companion object {
    @Volatile var instance: CarAutoModule? = null
      private set

    /**
     * How long a kept event stays worth handing over. Long enough for JS to
     * start and subscribe; short enough that a process the system kept
     * around with JS never coming up does not act on a tap from an hour ago.
     */
    private const val MAX_WAIT_MS = 60_000L

    /**
     * How many events wait at most. A driver pressing buttons while JS starts
     * sends a handful; the oldest are the ones least worth acting on.
     */
    private const val MAX_PENDING = 20

    private val pending = ArrayDeque<Pair<Long, Pair<String, Map<String, Any>>>>()

    fun play(context: Context, mediaId: String, parentId: String? = null) {
      val payload = HashMap<String, Any>(2)
      payload["mediaId"] = mediaId
      if (parentId != null) payload["parentId"] = parentId
      deliver(context, "play", payload)
    }

    /** A browser asked for the root, which is a car opening the app. JS answers
     *  by filling the tree in, so what it holds is not whatever was left there
     *  the last time somebody had the phone in their hand. */
    fun connected(context: Context) {
      deliver(context, "connect", emptyMap())
    }

    /** The same, for a caller that must not start JS: the system's own media
     *  resumption binds this service after a reboot to see what is there, and
     *  the news is only worth anything to a runtime that is already up. */
    @Synchronized
    fun connectedIfUp() {
      val module = instance ?: return
      if (module.observing && pending.isEmpty()) module.sendEvent("connect", emptyMap<String, Any>())
    }

    /**
     * Something typed in the car's search box, with what the tree already
     * answers it: JS lays the library's hits behind those and hands the two
     * back as one list (`CarSearch`, `carAutoTree.carSearch`).
     */
    fun search(context: Context, query: String, local: List<BrowseNode>) {
      deliver(context, "search", mapOf("query" to query, "local" to BrowseTreeCache.nodesToJson(local)))
    }

    fun transport(context: Context, action: String, value: Double?) {
      val payload = HashMap<String, Any>(2)
      payload["action"] = action
      if (value != null) payload["value"] = value
      deliver(context, "transport", payload)
    }

    fun transport(context: Context, action: String, value: String) {
      deliver(context, "transport", mapOf("action" to action, "value" to value))
    }

    /**
     * Hands the event to JS, or keeps it and starts JS when there is nobody
     * to hand it to: the phone asleep in a pocket has had its process killed,
     * or the car bound the service into a process of its own, and either way
     * the tree the car browses came off the disk with no JavaScript behind
     * it. The event goes out from [flushPending] once JS is listening.
     */
    @Synchronized
    private fun deliver(context: Context, name: String, payload: Map<String, Any>) {
      val module = instance
      // Not while others are waiting: the flush is posted to the main looper,
      // and an event sent live in between would reach JS ahead of the ones
      // that were asked for first. A pause overtaking the play it was meant
      // to stop is the one that shows.
      if (module != null && module.observing && pending.isEmpty()) {
        module.sendEvent(name, payload)
        return
      }
      val now = SystemClock.elapsedRealtime()
      dropStale(now)
      while (pending.size >= MAX_PENDING) pending.removeFirst()
      pending.addLast(now to (name to payload))
      CarAutoLog.i("no JS listening for $name: kept (${pending.size} waiting)")
      if (!JsRuntime.start(context)) CarAutoLog.w("no React host to start for $name")
    }

    /** Everything kept and still fresh, in the order it arrived; the queue is emptied. */
    @Synchronized
    private fun takePending(): List<Pair<String, Map<String, Any>>> {
      dropStale(SystemClock.elapsedRealtime())
      val fresh = pending.map { it.second }
      pending.clear()
      return fresh
    }

    private fun dropStale(now: Long) {
      pending.removeAll { now - it.first > MAX_WAIT_MS }
    }
  }
}

@OptIn(UnstableApi::class)
private fun parseNowPlaying(json: String): JsProxyPlayer.NowPlaying {
  val o = JSONObject(json)
  return JsProxyPlayer.NowPlaying(
    id = o.optString("id"),
    title = o.optString("title").takeIf { it.isNotEmpty() },
    artist = o.optString("artist").takeIf { it.isNotEmpty() },
    album = o.optString("album").takeIf { it.isNotEmpty() },
    artworkUrl = o.optString("artworkUrl").takeIf { it.isNotEmpty() },
    durationMs = o.optLong("durationMs", 0L),
    favorite = o.optBoolean("favorite", false),
  )
}
