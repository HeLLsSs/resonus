// Adapted from wavio (github.com/Joel-Mercier/wavio, MIT) for Resonus.
package expo.modules.carauto

import android.app.PendingIntent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.MediaStore
import androidx.annotation.OptIn
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.session.CommandButton
import androidx.media3.session.LibraryResult
import androidx.media3.session.MediaConstants
import androidx.media3.session.MediaLibraryService
import androidx.media3.session.MediaSession
import androidx.media3.session.SessionCommand
import androidx.media3.session.SessionResult
import com.google.common.collect.ImmutableList
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture

/**
 * The MediaLibraryService that shows Android Auto the BrowseTree built in JS.
 * The session's player is a `JsProxyPlayer` whose state is pushed from JS, so
 * the mini player and the car's "Now Playing" screen show what is really
 * playing. Tapping a browsable item goes through Media3's usual browse flow;
 * tapping a playable leaf hands the mediaId, along with the parent being
 * browsed at the time, to JS through `CarAutoModule.play`, so that JS can
 * queue the whole collection and start on the track that was tapped. With no
 * JS running, the same call keeps the tap and starts JS with no screen.
 */
@OptIn(UnstableApi::class)
class ResonusCarBrowserService : MediaLibraryService() {
  private var session: MediaLibrarySession? = null
  private var jsPlayer: JsProxyPlayer? = null

  override fun onCreate() {
    super.onCreate()
    CarArtwork.init(applicationContext)
    BrowseTreeCache.loadFromDiskIfNeeded(applicationContext)
    val player = JsProxyPlayer(applicationContext).also {
      jsPlayer = it
      activePlayer = it
    }
    val built = MediaLibrarySession.Builder(this, player, LibraryCallback())
      .setId("ResonusCarBrowserSession")
      .setMediaButtonPreferences(modeButtons(player))
      // What to open when the notification this session puts up is tapped, or
      // when the car offers to carry on where it left off on the phone.
      // Without it the session has no screen to name and the tap does nothing.
      .apply { appLaunchIntent()?.let { setSessionActivity(it) } }
      .build()
    session = built
    activeSession = built
    // Each of those two buttons carries the state it will put the player in,
    // so its icon has to be rebuilt whenever the state changes: shuffle turned
    // on from the phone has to come out lit in the car, and pressing it there
    // has to turn it off rather than on again.
    player.addListener(object : Player.Listener {
      override fun onShuffleModeEnabledChanged(shuffleModeEnabled: Boolean) = refreshModeButtons()
      override fun onRepeatModeChanged(repeatMode: Int) = refreshModeButtons()
    })
    // The heart is the third of those, and the only one no Player callback
    // announces: what it draws is the song being a favourite or not, which is
    // ours and reaches the player straight from JS.
    player.onFavoriteChanged = { refreshModeButtons() }
  }

  /** The app's own launch screen, or nothing on a build that has none. */
  private fun appLaunchIntent(): PendingIntent? {
    val intent = packageManager.getLaunchIntentForPackage(packageName) ?: return null
    return PendingIntent.getActivity(this, 0, intent, PendingIntent.FLAG_IMMUTABLE)
  }

  private fun refreshModeButtons() {
    val player = jsPlayer ?: return
    session?.setMediaButtonPreferences(modeButtons(player))
  }

  /**
   * Shuffle and repeat for the car's playback screen.
   *
   * Both are plain player commands rather than commands of our own, so the
   * host acts on the session directly and it lands in `JsProxyPlayer`, which
   * already forwards both to JS. Each carries the value to move to: without a
   * parameter media3 toggles shuffle by reading the player back, and cycling
   * repeat is ours to define anyway (off, all, one).
   */
  private fun modeButtons(player: Player): ImmutableList<CommandButton> {
    val shuffleOn = player.shuffleModeEnabled
    val nextRepeat = when (player.repeatMode) {
      Player.REPEAT_MODE_OFF -> Player.REPEAT_MODE_ALL
      Player.REPEAT_MODE_ALL -> Player.REPEAT_MODE_ONE
      else -> Player.REPEAT_MODE_OFF
    }
    val buttons = ImmutableList.builder<CommandButton>()
    // The heart takes the first of the two slots beside the transport keys,
    // which puts shuffle in the overflow menu. Deliberate: a setting is chosen
    // once a drive, whereas keeping a song you are hearing right now is worth
    // a glance and one press. It is only offered with something playing, since
    // there is nothing to keep otherwise.
    favoriteButton(player)?.let { buttons.add(it) }
    buttons.add(
      CommandButton.Builder(
        if (shuffleOn) CommandButton.ICON_SHUFFLE_ON else CommandButton.ICON_SHUFFLE_OFF,
      )
        .setPlayerCommand(Player.COMMAND_SET_SHUFFLE_MODE, !shuffleOn)
        .setDisplayName(getString(R.string.car_shuffle))
        .setSlots(CommandButton.SLOT_BACK_SECONDARY, CommandButton.SLOT_OVERFLOW)
        .build(),
      CommandButton.Builder(
        when (player.repeatMode) {
          Player.REPEAT_MODE_ONE -> CommandButton.ICON_REPEAT_ONE
          Player.REPEAT_MODE_ALL -> CommandButton.ICON_REPEAT_ALL
          else -> CommandButton.ICON_REPEAT_OFF
        },
      )
        .setPlayerCommand(Player.COMMAND_SET_REPEAT_MODE, nextRepeat)
        .setDisplayName(getString(R.string.car_repeat))
        .setSlots(CommandButton.SLOT_FORWARD_SECONDARY, CommandButton.SLOT_OVERFLOW)
        .build(),
    )
    return buttons.build()
  }

  /**
   * The heart, carrying the state it will move the song to.
   *
   * Like the two beside it this is a button that does one thing rather than a
   * toggle the host reads back, so pressing it while the song is a favourite
   * has to say "not a favourite" in so many words. What it says rides in the
   * command's own extras and comes back untouched in `onCustomCommand`.
   */
  private fun favoriteButton(player: Player): CommandButton? {
    val current = (player as? JsProxyPlayer) ?: return null
    if (!current.hasTrack()) return null
    val isFavorite = current.isFavorite()
    val extras = Bundle().apply { putBoolean(FAVORITE_TARGET, !isFavorite) }
    return CommandButton.Builder(
      if (isFavorite) CommandButton.ICON_HEART_FILLED else CommandButton.ICON_HEART_UNFILLED,
    )
      .setSessionCommand(SessionCommand(FAVORITE_ACTION, extras))
      .setDisplayName(getString(if (isFavorite) R.string.car_unfavorite else R.string.car_favorite))
      .setSlots(CommandButton.SLOT_BACK_SECONDARY, CommandButton.SLOT_OVERFLOW)
      .build()
  }

  override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaLibrarySession? = session

  override fun onDestroy() {
    if (activeSession === session) activeSession = null
    if (activePlayer === jsPlayer) activePlayer = null
    session?.run { player.release(); release() }
    session = null
    jsPlayer = null
    super.onDestroy()
  }

  private inner class LibraryCallback : MediaLibrarySession.Callback {
    /**
     * A command of ours has to be handed to whoever connects, or the button
     * carrying it is drawn and does nothing when pressed. Everything media3
     * would have allowed is kept; only the heart is added.
     */
    override fun onConnect(
      session: MediaSession,
      controller: MediaSession.ControllerInfo,
    ): MediaSession.ConnectionResult {
      val allowed = super.onConnect(session, controller)
      return MediaSession.ConnectionResult.AcceptedResultBuilder(session)
        .setAvailablePlayerCommands(allowed.availablePlayerCommands)
        .setAvailableSessionCommands(
          allowed.availableSessionCommands
            .buildUpon()
            .add(SessionCommand(FAVORITE_ACTION, Bundle.EMPTY))
            .build(),
        )
        .build()
    }

    /**
     * The heart, pressed. What it is asking for travels in the command's own
     * extras rather than being worked out here: the car may well be showing a
     * button built before the song changed, and acting on what was drawn is
     * how the press matches what the driver saw.
     */
    override fun onCustomCommand(
      session: MediaSession,
      controller: MediaSession.ControllerInfo,
      customCommand: SessionCommand,
      args: Bundle,
    ): ListenableFuture<SessionResult> {
      if (customCommand.customAction != FAVORITE_ACTION) {
        return super.onCustomCommand(session, controller, customCommand, args)
      }
      val target = customCommand.customExtras.getBoolean(FAVORITE_TARGET, true)
      CarAutoModule.transport(applicationContext, "favorite", if (target) 1.0 else 0.0)
      return Futures.immediateFuture(SessionResult(SessionResult.RESULT_SUCCESS))
    }

    override fun onGetLibraryRoot(
      session: MediaLibrarySession,
      browser: MediaSession.ControllerInfo,
      params: LibraryParams?,
    ): ListenableFuture<LibraryResult<MediaItem>> {
      // The car is opening the app: whatever songs the tree is missing, this
      // is the moment to go and get them, and the phone is awake for it. With
      // no JS behind the service this is also what starts it, so the first
      // tap does not have to.
      //
      // Except for a caller that is only looking: the system's own media
      // resumption binds this service and asks for the root after every
      // reboot, and answering that by starting JS and reading the whole
      // library was dozens of requests on a phone nobody had touched. It is
      // told what the tree already holds, and JS starts when something is
      // actually asked to play.
      val browsing = browser.packageName !in PASSIVE_BROWSERS
      CarAutoLog.d("root asked for by ${browser.packageName}, JS up=${JsRuntime.isUp(applicationContext)}")
      if (browsing) CarAutoModule.connected(applicationContext)
      else CarAutoModule.connectedIfUp()
      val rootExtras = Bundle().apply {
        // Hints for Android Auto: the root's children are drawn as tabs
        // (category list items), and anything browsable below that as a list.
        putInt(
          MediaConstants.EXTRAS_KEY_CONTENT_STYLE_BROWSABLE,
          MediaConstants.EXTRAS_VALUE_CONTENT_STYLE_CATEGORY_LIST_ITEM,
        )
        putInt(
          MediaConstants.EXTRAS_KEY_CONTENT_STYLE_PLAYABLE,
          MediaConstants.EXTRAS_VALUE_CONTENT_STYLE_LIST_ITEM,
        )
      }
      val root = MediaItem.Builder()
        .setMediaId(BrowseTreeCache.ROOT_ID)
        .setMediaMetadata(
          MediaMetadata.Builder()
            .setIsBrowsable(true)
            .setIsPlayable(false)
            .setMediaType(MediaMetadata.MEDIA_TYPE_FOLDER_MIXED)
            .build(),
        )
        .build()
      // The hints ride in the params, not in the item: what reaches the car is
      // the bundle media3 builds out of `result.params.extras`, and anything
      // left on the root's own metadata is dropped on the way
      // (`MediaLibraryServiceLegacyStub.onGetRoot`). Put there, the tabs were
      // being drawn however Android Auto felt like. The ones passed in are the
      // browser's own request hints and are not ours to echo back.
      val rootParams = LibraryParams.Builder().setExtras(rootExtras).build()
      return Futures.immediateFuture(LibraryResult.ofItem(root, rootParams))
    }

    override fun onGetItem(
      session: MediaLibrarySession,
      browser: MediaSession.ControllerInfo,
      mediaId: String,
    ): ListenableFuture<LibraryResult<MediaItem>> {
      val node = findNode(mediaId)
        ?: return Futures.immediateFuture(LibraryResult.ofError(LibraryResult.RESULT_ERROR_BAD_VALUE))
      return Futures.immediateFuture(LibraryResult.ofItem(node.toMediaItem(), null))
    }

    override fun onGetChildren(
      session: MediaLibrarySession,
      browser: MediaSession.ControllerInfo,
      parentId: String,
      page: Int,
      pageSize: Int,
      params: LibraryParams?,
    ): ListenableFuture<LibraryResult<ImmutableList<MediaItem>>> {
      val children = BrowseTreeCache.getChildren(parentId)
      CarAutoLog.d("children of=$parentId have=${children.size} page=$page pageSize=$pageSize")
      // Paged, like the search results and for the same reason (see `pageOf`).
      return Futures.immediateFuture(pageOf(children, page, pageSize, params))
    }

    /**
     * The tree's own hits at once, and the library's behind them.
     *
     * The count is not reported here but whenever the answer is in hand: media3
     * lets a search be announced late, and the browser only asks for the items
     * once it has been told how many there are, which is what keeps this and
     * `onGetSearchResult` showing the same list. `CarSearch` is where the wait
     * is bounded; with nothing to wait for, this is as immediate as it ever
     * was.
     */
    override fun onSearch(
      session: MediaLibrarySession,
      browser: MediaSession.ControllerInfo,
      query: String,
      params: LibraryParams?,
    ): ListenableFuture<LibraryResult<Void>> {
      searchFor(query) { results ->
        CarAutoLog.d("search q=$query hits=${results.size}")
        // The answer can arrive after the car has gone: this is the one call
        // here that outlives the method it was asked in.
        runCatching { session.notifySearchResultChanged(browser, query, results.size, params) }
          .onFailure { CarAutoLog.w("nobody left to hand the results of $query to", it) }
      }
      return Futures.immediateFuture(LibraryResult.ofVoid(params))
    }

    override fun onGetSearchResult(
      session: MediaLibrarySession,
      browser: MediaSession.ControllerInfo,
      query: String,
      page: Int,
      pageSize: Int,
      params: LibraryParams?,
    ): ListenableFuture<LibraryResult<ImmutableList<MediaItem>>> =
      Futures.immediateFuture(pageOf(resultsFor(query), page, pageSize, params))

    /**
     * The window the controller asked for, and nothing more.
     *
     * Local covers travel as bytes, because the host cannot read a `file://`
     * of ours, and a page of them adds up: a library kept offline has every
     * cover local, and twenty-odd of them at full size is most of the binder's
     * one megabyte. Over that limit the whole answer is dropped on the way and
     * the car draws an empty list, which is what it was doing for playlists,
     * starred albums and the results of a search (#140).
     *
     * So they go at tile size, and past a byte budget the rest fall back to
     * their uri: a local one the host cannot draw, but the item itself still
     * arrives. A list missing some covers beats a list missing everything.
     */
    private fun pageOf(
      all: List<BrowseNode>,
      page: Int,
      pageSize: Int,
      params: LibraryParams?,
    ): LibraryResult<ImmutableList<MediaItem>> {
      val from = page.toLong() * pageSize.toLong()
      if (from !in 0 until all.size.toLong()) {
        return LibraryResult.ofItemList(ImmutableList.of(), params)
      }
      val start = from.toInt()
      val end = minOf(from + pageSize.toLong(), all.size.toLong()).toInt()
      val items = ImmutableList.builder<MediaItem>()
      var budget = ART_BUDGET_BYTES
      var dropped = 0
      for (node in all.subList(start, end)) {
        val (item, used) = node.toMediaItemWithArt(embed = budget > 0)
        if (used == 0 && node.artworkUrl != null && budget <= 0) dropped++
        budget -= used
        items.add(item)
      }
      CarAutoLog.d("children n=${end - start} artBytes=${ART_BUDGET_BYTES - budget} noArt=$dropped")
      return LibraryResult.ofItemList(items.build(), params)
    }

    override fun onAddMediaItems(
      mediaSession: MediaSession,
      controller: MediaSession.ControllerInfo,
      mediaItems: MutableList<MediaItem>,
    ): ListenableFuture<MutableList<MediaItem>> {
      val first = mediaItems.firstOrNull()
      val id = first?.mediaId
      if (id.isNullOrEmpty()) {
        val spoken = spokenPick(first) ?: return Futures.immediateFuture(mediaItems)
        return Futures.immediateFuture(mutableListOf(spoken.toMediaItem()))
      }
      return resolvePlayable(id, mediaItems)
    }

    override fun onSetMediaItems(
      mediaSession: MediaSession,
      controller: MediaSession.ControllerInfo,
      mediaItems: MutableList<MediaItem>,
      startIndex: Int,
      startPositionMs: Long,
    ): ListenableFuture<MediaSession.MediaItemsWithStartPosition> {
      val first = mediaItems.firstOrNull()
      val id = first?.mediaId
      // "Play <something>" arrives with no id at all and what was said in the
      // request's `searchQuery`, so the tree is searched for it. Left alone,
      // every spoken request was dropped here (#103).
      if (id.isNullOrEmpty()) {
        val spoken = spokenPick(first)
        return Futures.immediateFuture(
          if (spoken == null) {
            MediaSession.MediaItemsWithStartPosition(mediaItems, startIndex, startPositionMs)
          } else {
            MediaSession.MediaItemsWithStartPosition(mutableListOf(spoken.toMediaItem()), 0, 0L)
          },
        )
      }
      val node = findNode(id)
      if (node != null && node.playable) {
        jsPlayer?.applyTappedItem(node)
        emitPlay(id)
        return Futures.immediateFuture(
          MediaSession.MediaItemsWithStartPosition(
            mutableListOf(node.toMediaItem()),
            0,
            0L,
          ),
        )
      }
      return Futures.immediateFuture(
        MediaSession.MediaItemsWithStartPosition(mediaItems, startIndex, startPositionMs),
      )
    }

    override fun onPlaybackResumption(
      mediaSession: MediaSession,
      controller: MediaSession.ControllerInfo,
    ): ListenableFuture<MediaSession.MediaItemsWithStartPosition> =
      Futures.immediateFailedFuture(UnsupportedOperationException("no resumption state"))

    /**
     * What to start playing for a spoken request, already handed to JS.
     *
     * A track gets the optimistic metadata the car shows while JS resolves it,
     * the same as a tap. A collection does not: what it puts on is its first
     * song, and naming the album where the song goes would be a worse answer
     * than the spinner that is already there.
     */
    private fun spokenPick(item: MediaItem?): BrowseNode? {
      val meta = item?.requestMetadata
      // What the assistant made of the words, when it made anything: media3
      // hands `playFromSearch`'s extras over as they came, and they carry the
      // kind of thing asked for and the names picked out of the sentence.
      val extras = meta?.extras
      val request = BrowseTreeCache.VoiceRequest(
        query = meta?.searchQuery?.toString(),
        focus = extras?.getString(MediaStore.EXTRA_MEDIA_FOCUS),
        artist = extras?.getString(MediaStore.EXTRA_MEDIA_ARTIST),
        album = extras?.getString(MediaStore.EXTRA_MEDIA_ALBUM),
        title = extras?.getString(MediaStore.EXTRA_MEDIA_TITLE),
        playlist = extras?.getString(MediaStore.EXTRA_MEDIA_PLAYLIST),
        genre = extras?.getString(MediaStore.EXTRA_MEDIA_GENRE),
      )
      val node = BrowseTreeCache.voicePick(request)
      CarAutoLog.d("voice q=${request.query} focus=${request.focus} pick=${node?.id}")
      if (node == null) return null
      if (node.playable) jsPlayer?.applyTappedItem(node)
      emitPlay(node.id)
      return node
    }

    private fun resolvePlayable(
      mediaId: String,
      original: MutableList<MediaItem>,
    ): ListenableFuture<MutableList<MediaItem>> {
      emitPlay(mediaId)
      val node = findNode(mediaId)
      if (node != null && node.playable) {
        jsPlayer?.applyTappedItem(node)
        return Futures.immediateFuture(mutableListOf(node.toMediaItem()))
      }
      return Futures.immediateFuture(original)
    }

    private fun emitPlay(mediaId: String) {
      val parentId = BrowseTreeCache.findParentOf(mediaId)
      CarAutoLog.d("emitPlay id=$mediaId parent=$parentId")
      CarAutoModule.play(applicationContext, mediaId, parentId)
    }
  }

  /** Callers that bind this service to see what is there rather than to play
   *  it. The system's media resumption asks every one of them after a reboot. */
  private val PASSIVE_BROWSERS = setOf("com.android.systemui", "android")

  /** The last query answered, kept so the count reported to the car and the
   *  items it then asks for cannot disagree. */
  @Volatile private var lastSearch: Pair<String, List<BrowseNode>>? = null

  /**
   * The rows for a query, once there are any: what the tree holds, and what
   * the library added to it if it answered in time.
   *
   * They are kept before the car is told anything, so that the items it comes
   * back for are the ones it was given a count of.
   */
  private fun searchFor(query: String, onReady: (List<BrowseNode>) -> Unit) {
    val local = BrowseTreeCache.search(query)
    CarSearch.ask(applicationContext, query, local) { results ->
      lastSearch = query to results
      onReady(results)
    }
  }

  /** What was answered for this query, or the tree alone for one that was
   *  never announced. */
  private fun resultsFor(query: String): List<BrowseNode> {
    lastSearch?.let { (q, results) -> if (q == query) return results }
    val results = BrowseTreeCache.search(query)
    lastSearch = query to results
    return results
  }

  private fun findNode(mediaId: String): BrowseNode? {
    // A row of the last search first: what it found is not in the tree, and
    // without this a song tapped there had no metadata to put on the car's
    // screen while JS fetched it.
    lastSearch?.second?.firstOrNull { it.id == mediaId }?.let { return it }
    BrowseTreeCache.getChildren(BrowseTreeCache.ROOT_ID).firstOrNull { it.id == mediaId }?.let { return it }
    val seen = HashSet<String>()
    val stack = ArrayDeque<String>()
    stack.addLast(BrowseTreeCache.ROOT_ID)
    while (stack.isNotEmpty()) {
      val pid = stack.removeLast()
      if (!seen.add(pid)) continue
      for (c in BrowseTreeCache.getChildren(pid)) {
        if (c.id == mediaId) return c
        if (!c.playable) stack.addLast(c.id)
      }
    }
    return null
  }

  companion object {
    @Volatile var activePlayer: JsProxyPlayer? = null
      private set

    @Volatile private var activeSession: MediaLibrarySession? = null

    /**
     * Tells the car that a shelf it is showing has changed underneath it.
     *
     * Android Auto asks for a folder's children once and keeps the answer. It
     * asks the moment the app is opened, which on this side is the moment the
     * service starts — before JavaScript has run, let alone fetched anything —
     * so what it gets first is whatever tree was written to disk last time.
     * With a tree on disk that was merely stale; on a fresh install there is
     * none, and the car settled on an empty app and stayed there. Nothing here
     * ever told it otherwise, which is the whole of that bug.
     *
     * On the main thread, which is where media3 wants its session touched, and
     * quietly when no session is up: a push can arrive from a runtime the
     * widget or an intent started, with no car anywhere.
     */
    fun treeChanged(parents: Collection<String>) {
      val session = activeSession ?: return
      Handler(Looper.getMainLooper()).post {
        for (parent in parents) {
          runCatching {
            session.notifyChildrenChanged(parent, BrowseTreeCache.getChildren(parent).size, null)
          }
        }
      }
    }

    /**
     * How much cover art one page of browse results may carry. Below the
     * binder's one megabyte with room to spare for the rest of the parcel:
     * the titles, the ids and the extras of every item ride in it too.
     */
    private const val ART_BUDGET_BYTES = 512 * 1024

    /** The heart's command, and the state it carries. */
    const val FAVORITE_ACTION = "expo.modules.carauto.FAVORITE"
    const val FAVORITE_TARGET = "favorite"
  }
}

@OptIn(UnstableApi::class)
private fun BrowseNode.toMediaItem(): MediaItem = toMediaItemWithArt(embed = true).first

/** The item, and how many bytes of cover art it ended up carrying. */
@OptIn(UnstableApi::class)
private fun BrowseNode.toMediaItemWithArt(embed: Boolean): Pair<MediaItem, Int> {
  val extras = Bundle()
  // contentStyle on a browsable node tells AA how to draw *its children*.
  if (!playable) {
    val styleValue = when (contentStyle) {
      "grid" -> MediaConstants.EXTRAS_VALUE_CONTENT_STYLE_GRID_ITEM
      "list" -> MediaConstants.EXTRAS_VALUE_CONTENT_STYLE_LIST_ITEM
      else -> MediaConstants.EXTRAS_VALUE_CONTENT_STYLE_LIST_ITEM
    }
    extras.putInt(MediaConstants.EXTRAS_KEY_CONTENT_STYLE_BROWSABLE, styleValue)
    extras.putInt(MediaConstants.EXTRAS_KEY_CONTENT_STYLE_PLAYABLE, styleValue)
  }
  // A row that resumes rather than starts carries how far through it already
  // is, which the car draws as a bar under the title. Only worth saying when
  // there is something to resume: without the status the car draws nothing,
  // which is right for every other row.
  if (progress != null) {
    extras.putInt(
      MediaConstants.EXTRAS_KEY_COMPLETION_STATUS,
      MediaConstants.EXTRAS_VALUE_COMPLETION_STATUS_PARTIALLY_PLAYED,
    )
    extras.putDouble(MediaConstants.EXTRAS_KEY_COMPLETION_PERCENTAGE, progress.coerceIn(0.0, 1.0))
  }
  // Neighbours carrying the same heading are drawn as one group under it, so a
  // tab can hold several shelves without spending a screen on each of them.
  if (group != null) {
    extras.putString(MediaConstants.EXTRAS_KEY_CONTENT_STYLE_GROUP_TITLE, group)
  }
  val builder = MediaMetadata.Builder()
    .setTitle(title)
    .setSubtitle(subtitle)
    .setIsBrowsable(!playable)
    .setIsPlayable(playable)
    // The kind matters to how the car draws it: an artist comes out as a
    // circle and an album as a square, and a folder is what it falls back to
    // for anything that does not say what it is.
    .setMediaType(
      when {
        playable -> MediaMetadata.MEDIA_TYPE_MUSIC
        mediaType == "artist" -> MediaMetadata.MEDIA_TYPE_ARTIST
        mediaType == "album" -> MediaMetadata.MEDIA_TYPE_ALBUM
        mediaType == "playlist" -> MediaMetadata.MEDIA_TYPE_PLAYLIST
        else -> MediaMetadata.MEDIA_TYPE_FOLDER_MIXED
      },
    )
    .setExtras(extras)
  val artBytes = CarArtwork.apply(builder, artworkUrl, embed, CarArtwork.THUMB_DIM)
  val item = MediaItem.Builder()
    .setMediaId(id)
    .setMediaMetadata(builder.build())
    .build()
  return item to artBytes
}
