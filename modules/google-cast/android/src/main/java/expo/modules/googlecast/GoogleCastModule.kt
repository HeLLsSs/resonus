package expo.modules.googlecast

import android.content.Context
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.mediarouter.media.MediaRouteSelector
import androidx.mediarouter.media.MediaRouter
import com.google.android.gms.cast.CastDevice
import com.google.android.gms.cast.CastMediaControlIntent
import com.google.android.gms.cast.MediaError
import com.google.android.gms.cast.MediaInfo
import com.google.android.gms.cast.MediaLoadRequestData
import com.google.android.gms.cast.MediaMetadata
import com.google.android.gms.cast.MediaQueueItem
import com.google.android.gms.cast.MediaSeekOptions
import com.google.android.gms.cast.MediaStatus
import com.google.android.gms.cast.framework.CastContext
import com.google.android.gms.cast.framework.CastSession
import com.google.android.gms.cast.framework.SessionManagerListener
import com.google.android.gms.cast.framework.media.RemoteMediaClient
import com.google.android.gms.common.ConnectionResult
import com.google.android.gms.common.GoogleApiAvailability
import com.google.android.gms.common.images.WebImage
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import org.json.JSONObject

/**
 * What the receiver is told about a track: where to fetch it, what it is and
 * what to show. `songId` and `key` travel back in every status as the item's
 * custom data, which is how JS knows which of the tracks it handed over is
 * the one sounding now.
 */
private data class TrackSpec(
  val url: String,
  val mime: String,
  val title: String,
  val artist: String?,
  val album: String?,
  val artworkUrl: String?,
  val durationSec: Double,
  val songId: String,
  val key: String,
) {
  companion object {
    fun fromJson(o: JSONObject): TrackSpec? {
      val url = o.optString("url")
      if (url.isEmpty()) return null
      return TrackSpec(
        url = url,
        mime = o.optString("mime").ifEmpty { "audio/mpeg" },
        title = o.optString("title"),
        artist = o.optString("artist").ifEmpty { null },
        album = o.optString("album").ifEmpty { null },
        artworkUrl = o.optString("artworkUrl").ifEmpty { null },
        durationSec = o.optDouble("durationSec", 0.0),
        songId = o.optString("songId"),
        key = o.optString("key"),
      )
    }
  }
}

/**
 * Expo bridge to Google Cast (Chromecast, Nest speakers, Android TV, anything
 * running the Cast receiver). Devices are found through MediaRouter and driven
 * through the Cast framework's RemoteMediaClient.
 *
 * The receiver keeps a short queue of its own: the track playing and the few
 * that follow it, so the change from one to the next happens on the receiver
 * without a gap and without needing this app to be awake for it. JS keeps the
 * real queue and refreshes the receiver's copy of what follows whenever it
 * changes (`setNextItems`); a receiver that turns out not to take a queue at
 * all still gets one track at a time (`load`).
 *
 * Both MediaRouter and CastContext insist on the main thread, and Expo calls
 * module functions from a thread of its own, so every entry point hops to the
 * main looper first and everything below `definition` assumes it is there.
 */
class GoogleCastModule : Module() {
  private val mainHandler = Handler(Looper.getMainLooper())

  private val selector: MediaRouteSelector = MediaRouteSelector.Builder()
    .addControlCategory(
      CastMediaControlIntent.categoryForCast(CastMediaControlIntent.DEFAULT_MEDIA_RECEIVER_APPLICATION_ID)
    )
    .build()

  // Main thread only, from here down.
  private var castContext: CastContext? = null
  private var router: MediaRouter? = null
  private var attachedClient: RemoteMediaClient? = null
  private var pendingConnect: Promise? = null
  private var connectTimeout: Runnable? = null

  private val routerCallback = object : MediaRouter.Callback() {}

  private val sessionListener = object : SessionManagerListener<CastSession> {
    override fun onSessionStarting(session: CastSession) {}

    override fun onSessionStarted(session: CastSession, sessionId: String) {
      attach(session)
      rememberSession(true)
      settleConnect(true)
      emitSession(true, false, session, 0)
      emitState()
    }

    override fun onSessionStartFailed(session: CastSession, error: Int) {
      Log.w(TAG, "Cast session failed to start: $error")
      settleConnect(false)
    }

    override fun onSessionEnding(session: CastSession) {}

    // Ended from either side: our `disconnect`, the receiver being stopped
    // from the TV or another phone, or the framework giving up on a resume.
    override fun onSessionEnded(session: CastSession, error: Int) {
      detach()
      rememberSession(false)
      settleConnect(false)
      emitSession(false, false, null, error)
    }

    override fun onSessionResuming(session: CastSession, sessionId: String) {}

    // The framework found the session this app left on the receiver: after a
    // network drop, or because the app was closed and opened again while the
    // receiver kept playing what it had been handed.
    override fun onSessionResumed(session: CastSession, wasSuspended: Boolean) {
      attach(session)
      rememberSession(true)
      settleConnect(true)
      emitSession(true, true, session, 0)
      emitState()
    }

    override fun onSessionResumeFailed(session: CastSession, error: Int) {
      settleConnect(false)
    }

    // A dropped network: the framework tries to resume on its own, and either
    // `onSessionResumed` or `onSessionEnded` follows.
    override fun onSessionSuspended(session: CastSession, reason: Int) {
      detach()
    }
  }

  private val mediaCallback = object : RemoteMediaClient.Callback() {
    override fun onStatusUpdated() {
      emitState()
    }

    override fun onQueueStatusUpdated() {
      emitState()
    }

    // A load the receiver accepted and then could not play (a codec it lacks,
    // a URL it could not reach) comes back here, with the reason.
    override fun onMediaError(error: MediaError) {
      sendEvent(
        "error",
        mapOf(
          "reason" to error.reason,
          "detail" to error.detailedErrorCode,
        ),
      )
    }
  }

  private val progressListener = RemoteMediaClient.ProgressListener { _, _ -> emitState() }

  override fun definition() = ModuleDefinition {
    Name("GoogleCast")

    Events("state", "session", "error")

    // Creating the framework is what lets it find the session this app left
    // behind, and that only happens when there is one to find: the flag is
    // written on every session start and cleared on every end, so an app
    // that never cast pays nothing here.
    OnCreate {
      mainHandler.post { if (hadSession()) ensureRouter() }
    }

    OnActivityEntersForeground {
      mainHandler.post { if (hadSession()) ensureRouter() }
    }

    OnDestroy {
      mainHandler.post {
        detach()
        settleConnect(false)
        castContext?.sessionManager?.removeSessionManagerListener(sessionListener, CastSession::class.java)
        router?.removeCallback(routerCallback)
      }
    }

    /**
     * Finds the Cast devices on the network, resolving with the list once the
     * timeout is up. An active scan is what makes devices answer promptly, and
     * it is also what costs battery, so it lasts the search and no longer:
     * afterwards the callback stays registered passively, which keeps the
     * routes it found alive for `connect` to pick from.
     *
     * Without Google Play services there is no Cast at all: the list is
     * empty, and nothing else in the app changes.
     */
    AsyncFunction("search") { timeoutMs: Double, promise: Promise ->
      mainHandler.post {
        val current = ensureRouter()
        if (current == null) {
          promise.resolve(emptyList<Map<String, String>>())
          return@post
        }
        current.addCallback(
          selector,
          routerCallback,
          MediaRouter.CALLBACK_FLAG_REQUEST_DISCOVERY or MediaRouter.CALLBACK_FLAG_PERFORM_ACTIVE_SCAN
        )
        mainHandler.postDelayed({
          current.addCallback(selector, routerCallback, MediaRouter.CALLBACK_FLAG_REQUEST_DISCOVERY)
          promise.resolve(castRoutes(current).map { routeRecord(it) })
        }, timeoutMs.toLong().coerceAtLeast(0L))
      }
    }

    /**
     * Selects the route; the framework answers a selection by launching the
     * receiver and opening a session, which comes back through the session
     * listener. True once the session is up, false if it failed or nothing
     * happened within the timeout.
     */
    AsyncFunction("connect") { routeId: String, promise: Promise ->
      mainHandler.post {
        val current = ensureRouter()
        val route = current?.routes?.firstOrNull { it.id == routeId }
        if (current == null || route == null) {
          promise.resolve(false)
          return@post
        }
        val session = castContext?.sessionManager?.currentCastSession
        if (route.isSelected && session != null && session.isConnected) {
          attach(session)
          promise.resolve(true)
          return@post
        }
        // An older wait still open answers now: only one can be in flight.
        settleConnect(false)
        pendingConnect = promise
        val timeout = Runnable { settleConnect(false) }
        connectTimeout = timeout
        mainHandler.postDelayed(timeout, CONNECT_TIMEOUT_MS)
        current.selectRoute(route)
      }
    }

    /**
     * The session this app already has on a receiver, if the framework found
     * one: the device it is on, or null. Asked at startup and on every return
     * to the foreground, because the framework's own announcement of a resume
     * can arrive before JS is listening for it, and a status follows so JS
     * learns what the receiver is playing.
     */
    AsyncFunction("resumeSession") { promise: Promise ->
      mainHandler.post {
        if (!hadSession()) {
          promise.resolve(null)
          return@post
        }
        ensureRouter()
        val session = castContext?.sessionManager?.currentCastSession
        if (session == null || !session.isConnected) {
          promise.resolve(null)
          return@post
        }
        attach(session)
        promise.resolve(deviceRecord(session))
        emitState()
      }
    }

    /**
     * Hands the receiver one URL, with no queue behind it. It fetches for
     * itself, so the URL has to be one it can reach from the network (the
     * server's, or the phone's own server for local files). Resolves with the
     * receiver's answer, and the reason when it is no.
     */
    AsyncFunction("load") { json: String, autoplay: Boolean, positionMs: Double, promise: Promise ->
      mainHandler.post {
        val client = currentClient()
        val spec = runCatching { TrackSpec.fromJson(JSONObject(json)) }.getOrNull()
        if (client == null || spec == null) {
          promise.resolve(failure("no session"))
          return@post
        }
        val request = MediaLoadRequestData.Builder()
          .setMediaInfo(mediaInfoFor(spec))
          .setAutoplay(autoplay)
          .setCurrentTime(positionMs.toLong().coerceAtLeast(0L))
          .build()
        try {
          client.load(request).setResultCallback { result -> promise.resolve(loadResult(result)) }
        } catch (e: Exception) {
          Log.w(TAG, "Cast load failed", e)
          promise.resolve(failure(e.message ?: "load"))
        }
      }
    }

    /**
     * Replaces whatever the receiver holds with a queue: the track to play
     * first and the ones that follow it, which it moves through on its own.
     * `{ items, startIndex, autoplay, positionMs, repeatMode }`, the repeat
     * mode being the receiver's own (0 off, 2 the one track over again).
     */
    AsyncFunction("loadQueue") { json: String, promise: Promise ->
      mainHandler.post {
        val client = currentClient()
        val request = runCatching { JSONObject(json) }.getOrNull()
        val items = request?.let { queueItemsFrom(it) }
        if (client == null || request == null || items.isNullOrEmpty()) {
          promise.resolve(failure("no session"))
          return@post
        }
        try {
          client.queueLoad(
            items.toTypedArray(),
            request.optInt("startIndex", 0).coerceIn(0, items.size - 1),
            request.optInt("repeatMode", MediaStatus.REPEAT_MODE_REPEAT_OFF),
            request.optDouble("positionMs", 0.0).toLong().coerceAtLeast(0L),
            null,
          ).setResultCallback { result -> promise.resolve(loadResult(result)) }
        } catch (e: Exception) {
          Log.w(TAG, "Cast queue load failed", e)
          promise.resolve(failure(e.message ?: "queueLoad"))
        }
      }
    }

    /**
     * Makes what follows the playing item on the receiver into `items`, and
     * the repeat mode into `repeatMode`. Items already there in the right
     * order are left alone, so the one the receiver is preloading is not
     * thrown away and fetched again for nothing: only from the first
     * difference on is the tail removed and the new one appended.
     */
    AsyncFunction("setNextItems") { json: String, promise: Promise ->
      mainHandler.post {
        val client = currentClient()
        val status = client?.mediaStatus
        val request = runCatching { JSONObject(json) }.getOrNull()
        val wanted = request?.let { queueItemsFrom(it) }
        if (client == null || status == null || request == null || wanted == null) {
          promise.resolve(false)
          return@post
        }
        val repeatMode = request.optInt("repeatMode", MediaStatus.REPEAT_MODE_REPEAT_OFF)
        if (status.queueRepeatMode != repeatMode) {
          runCatching { client.queueSetRepeatMode(repeatMode, null) }
        }
        val following = followingItemIds(client, status)
        val wantedKeys = wanted.map { it.customData?.optString("key") ?: "" }
        var prefix = 0
        while (prefix < following.size && prefix < wantedKeys.size &&
          wantedKeys[prefix].isNotEmpty() && itemKey(client, status, following[prefix]) == wantedKeys[prefix]
        ) {
          prefix++
        }
        val toRemove = following.drop(prefix)
        val toInsert = wanted.drop(prefix)
        val insert = {
          if (toInsert.isEmpty()) {
            promise.resolve(true)
          } else {
            try {
              client.queueInsertItems(toInsert.toTypedArray(), MediaQueueItem.INVALID_ITEM_ID, null)
                .setResultCallback { result -> promise.resolve(result.status.isSuccess) }
            } catch (e: Exception) {
              Log.w(TAG, "Cast queue insert failed", e)
              promise.resolve(false)
            }
          }
        }
        if (toRemove.isEmpty()) {
          insert()
        } else {
          try {
            client.queueRemoveItems(toRemove.toIntArray(), null).setResultCallback { result ->
              if (result.status.isSuccess) insert() else promise.resolve(false)
            }
          } catch (e: Exception) {
            Log.w(TAG, "Cast queue remove failed", e)
            promise.resolve(false)
          }
        }
      }
    }

    /**
     * Sends the current status again. For JS after it has taken a session
     * over: the status that came with the resume may have gone out before
     * anything was listening, and a receiver sitting paused sends no other.
     */
    AsyncFunction("requestState") { promise: Promise ->
      mainHandler.post {
        emitState()
        promise.resolve(null)
      }
    }

    AsyncFunction("play") { promise: Promise ->
      mainHandler.post { promise.resolve(withClient { it.play() }) }
    }

    AsyncFunction("pause") { promise: Promise ->
      mainHandler.post { promise.resolve(withClient { it.pause() }) }
    }

    AsyncFunction("seek") { positionMs: Double, promise: Promise ->
      mainHandler.post {
        promise.resolve(withClient {
          it.seek(MediaSeekOptions.Builder().setPosition(positionMs.toLong().coerceAtLeast(0L)).build())
        })
      }
    }

    /** Volume of the session (the device's own), 0..100. */
    AsyncFunction("setVolume") { volume: Int, promise: Promise ->
      mainHandler.post {
        val session = castContext?.sessionManager?.currentCastSession
        if (session == null || !session.isConnected) {
          promise.resolve(false)
          return@post
        }
        val ok = runCatching { session.volume = volume.coerceIn(0, 100) / 100.0 }.isSuccess
        promise.resolve(ok)
      }
    }

    /** Ends the session and stops the receiver app with it. */
    AsyncFunction("disconnect") { promise: Promise ->
      mainHandler.post {
        settleConnect(false)
        detach()
        rememberSession(false)
        runCatching { castContext?.sessionManager?.endCurrentSession(true) }
        promise.resolve(true)
      }
    }
  }

  /**
   * The framework and the router, made on first use. Lazily because asking for
   * CastContext is what makes Play services load the Cast module, which is a
   * cost nobody who never opens the output sheet should pay.
   */
  private fun ensureRouter(): MediaRouter? {
    router?.let { return it }
    val context = appContext.reactContext?.applicationContext ?: return null
    val availability = GoogleApiAvailability.getInstance().isGooglePlayServicesAvailable(context)
    if (availability != ConnectionResult.SUCCESS) {
      Log.i(TAG, "Google Play services unavailable ($availability): no Cast")
      return null
    }
    if (castContext == null) {
      val cast = try {
        CastContext.getSharedInstance(context)
      } catch (e: Exception) {
        Log.w(TAG, "CastContext unavailable", e)
        return null
      }
      cast.sessionManager.addSessionManagerListener(sessionListener, CastSession::class.java)
      castContext = cast
    }
    val created = MediaRouter.getInstance(context)
    router = created
    return created
  }

  private fun prefs() =
    appContext.reactContext?.applicationContext?.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

  /** Whether a session was still open the last time this app ran. */
  private fun hadSession(): Boolean = prefs()?.getBoolean(PREF_SESSION, false) ?: false

  private fun rememberSession(active: Boolean) {
    prefs()?.edit()?.putBoolean(PREF_SESSION, active)?.apply()
  }

  /** Cast receivers only: the phone's own route matches nothing above. */
  private fun castRoutes(current: MediaRouter): List<MediaRouter.RouteInfo> =
    current.routes.filter { !it.isDefault && it.matchesSelector(selector) }

  private fun routeRecord(route: MediaRouter.RouteInfo): Map<String, String> {
    val device = route.extras?.let { CastDevice.getFromBundle(it) }
    return mapOf(
      "id" to route.id,
      "name" to (device?.friendlyName ?: route.name),
      "model" to (device?.modelName ?: route.description ?: ""),
    )
  }

  /**
   * The device a session is on, named the way `search` names it so JS can
   * put it in the same list: by the route the framework selected for it, or
   * failing that by the route that carries the same device.
   */
  private fun deviceRecord(session: CastSession): Map<String, String>? {
    val device = session.castDevice ?: return null
    val current = router
    val selected = current?.selectedRoute?.takeIf { !it.isDefault }
    val route = selected ?: current?.let { r ->
      castRoutes(r).firstOrNull { route ->
        route.extras?.let { CastDevice.getFromBundle(it) }?.deviceId == device.deviceId
      }
    }
    return mapOf(
      "id" to (route?.id ?: device.deviceId),
      "name" to (device.friendlyName ?: route?.name ?: ""),
      "model" to (device.modelName ?: ""),
    )
  }

  private fun currentClient(): RemoteMediaClient? {
    val session = castContext?.sessionManager?.currentCastSession ?: return null
    if (!session.isConnected) return null
    return session.remoteMediaClient
  }

  private fun withClient(block: (RemoteMediaClient) -> Unit): Boolean {
    val client = currentClient() ?: return false
    return runCatching { block(client) }.isSuccess
  }

  private fun attach(session: CastSession) {
    val client = session.remoteMediaClient ?: return
    if (attachedClient === client) return
    detach()
    client.registerCallback(mediaCallback)
    client.addProgressListener(progressListener, PROGRESS_PERIOD_MS)
    attachedClient = client
  }

  private fun detach() {
    val client = attachedClient ?: return
    client.unregisterCallback(mediaCallback)
    client.removeProgressListener(progressListener)
    attachedClient = null
  }

  private fun settleConnect(ok: Boolean) {
    connectTimeout?.let { mainHandler.removeCallbacks(it) }
    connectTimeout = null
    pendingConnect?.resolve(ok)
    pendingConnect = null
  }

  private fun customDataFor(spec: TrackSpec): JSONObject =
    JSONObject().put("songId", spec.songId).put("key", spec.key)

  private fun mediaInfoFor(spec: TrackSpec): MediaInfo {
    val metadata = MediaMetadata(MediaMetadata.MEDIA_TYPE_MUSIC_TRACK)
    metadata.putString(MediaMetadata.KEY_TITLE, spec.title)
    spec.artist?.let { metadata.putString(MediaMetadata.KEY_ARTIST, it) }
    spec.album?.let { metadata.putString(MediaMetadata.KEY_ALBUM_TITLE, it) }
    spec.artworkUrl?.let { metadata.addImage(WebImage(Uri.parse(it))) }
    val builder = MediaInfo.Builder(spec.url)
      .setStreamType(MediaInfo.STREAM_TYPE_BUFFERED)
      .setContentType(spec.mime)
      .setMetadata(metadata)
      // On the media as well as on the queue item: the status always carries
      // the media playing, while the item list it carries can be partial.
      .setCustomData(customDataFor(spec))
    val durationMs = (spec.durationSec * 1000).toLong()
    if (durationMs > 0) builder.setStreamDuration(durationMs)
    return builder.build()
  }

  private fun queueItemFor(spec: TrackSpec): MediaQueueItem =
    MediaQueueItem.Builder(mediaInfoFor(spec))
      .setAutoplay(true)
      .setPreloadTime(PRELOAD_SEC)
      .setCustomData(customDataFor(spec))
      .build()

  private fun queueItemsFrom(request: JSONObject): List<MediaQueueItem> {
    val array = request.optJSONArray("items") ?: return emptyList()
    val items = ArrayList<MediaQueueItem>(array.length())
    for (i in 0 until array.length()) {
      val spec = array.optJSONObject(i)?.let { TrackSpec.fromJson(it) } ?: continue
      items.add(queueItemFor(spec))
    }
    return items
  }

  /** Ids of the items after the one playing, in the receiver's order. */
  private fun followingItemIds(client: RemoteMediaClient, status: MediaStatus): List<Int> {
    val ids = client.mediaQueue.itemIds.toList().ifEmpty { status.queueItems.map { it.itemId } }
    val at = ids.indexOf(status.currentItemId)
    return if (at < 0) ids else ids.drop(at + 1)
  }

  /**
   * The key of an item on the receiver, from whichever copy of it the SDK
   * holds; empty when neither does, which counts as different from anything.
   */
  private fun itemKey(client: RemoteMediaClient, status: MediaStatus, itemId: Int): String {
    val fromStatus = status.getItemById(itemId)
    val item = fromStatus ?: client.mediaQueue.let { queue ->
      val index = queue.indexOfItemWithId(itemId)
      if (index >= 0) queue.getItemAtIndex(index, false) else null
    }
    return item?.customData?.optString("key") ?: ""
  }

  private fun failure(message: String): Map<String, Any?> =
    mapOf("ok" to false, "code" to -1, "message" to message, "reason" to null, "detail" to null)

  /** The receiver's answer to a load, with whatever reason it gave for a no. */
  private fun loadResult(result: RemoteMediaClient.MediaChannelResult): Map<String, Any?> {
    val status = result.status
    val error = result.mediaError
    return mapOf(
      "ok" to status.isSuccess,
      "code" to status.statusCode,
      "message" to status.statusMessage,
      "reason" to error?.reason,
      "detail" to error?.detailedErrorCode,
    )
  }

  /**
   * What the receiver says it is doing, sent as one flat event whether it came
   * from a status change or from the progress tick. `finished` is the idle
   * that ends a track for good, as opposed to one we stopped or one that
   * failed; with a queue on the receiver it only means the end of the queue,
   * which `hasNextItem` says.
   */
  private fun emitState() {
    val session = castContext?.sessionManager?.currentCastSession ?: return
    val client = session.remoteMediaClient ?: return
    val status = client.mediaStatus
    val playerState = client.playerState
    val idleReason = client.idleReason
    val volume = runCatching { session.volume }.getOrDefault(-1.0)
    val custom = client.mediaInfo?.customData
    val currentItemId = status?.currentItemId ?: MediaQueueItem.INVALID_ITEM_ID
    val queue = client.mediaQueue
    val at = if (currentItemId == MediaQueueItem.INVALID_ITEM_ID) -1 else queue.indexOfItemWithId(currentItemId)
    val hasNextItem = client.isLoadingNextItem || (at >= 0 && at < queue.itemCount - 1)
    sendEvent(
      "state",
      mapOf(
        "connected" to session.isConnected,
        "isPlaying" to (playerState == MediaStatus.PLAYER_STATE_PLAYING),
        "isBuffering" to (
          playerState == MediaStatus.PLAYER_STATE_BUFFERING ||
            playerState == MediaStatus.PLAYER_STATE_LOADING
          ),
        "isIdle" to (playerState == MediaStatus.PLAYER_STATE_IDLE),
        "finished" to (
          playerState == MediaStatus.PLAYER_STATE_IDLE &&
            idleReason == MediaStatus.IDLE_REASON_FINISHED
          ),
        "idleReason" to idleReasonName(idleReason),
        "positionMs" to client.approximateStreamPosition.toDouble(),
        "durationMs" to client.streamDuration.toDouble(),
        "volume" to (if (volume < 0) -1 else (volume * 100).toInt()),
        "songId" to (custom?.optString("songId") ?: ""),
        "itemKey" to (custom?.optString("key") ?: ""),
        "hasNextItem" to hasNextItem,
      ),
    )
  }

  private fun emitSession(connected: Boolean, resumed: Boolean, session: CastSession?, error: Int) {
    sendEvent(
      "session",
      mapOf(
        "connected" to connected,
        "resumed" to resumed,
        "device" to session?.let { deviceRecord(it) },
        "error" to error,
      ),
    )
  }

  /** Named rather than numbered, so JS does not have to know the SDK's constants. */
  private fun idleReasonName(reason: Int): String = when (reason) {
    MediaStatus.IDLE_REASON_FINISHED -> "finished"
    MediaStatus.IDLE_REASON_CANCELED -> "cancelled"
    MediaStatus.IDLE_REASON_INTERRUPTED -> "interrupted"
    MediaStatus.IDLE_REASON_ERROR -> "error"
    else -> "none"
  }

  companion object {
    private const val TAG = "GoogleCast"
    private const val PREFS = "expo.modules.googlecast"
    private const val PREF_SESSION = "sessionActive"
    private const val PROGRESS_PERIOD_MS = 1_000L
    /** How long before the end of a track the receiver starts fetching the next. */
    private const val PRELOAD_SEC = 15.0
    /** Launching the receiver app on a cold TV can take a while. */
    private const val CONNECT_TIMEOUT_MS = 30_000L
  }
}
