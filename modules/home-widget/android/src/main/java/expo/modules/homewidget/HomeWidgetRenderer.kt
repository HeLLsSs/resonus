package expo.modules.homewidget

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.os.Bundle
import android.view.View
import android.widget.RemoteViews
import java.util.concurrent.Executors

/**
 * Turns a [WidgetState] into the RemoteViews every placed widget shows.
 *
 * Each widget is drawn for the cells the launcher gave it (see [Shape]): a
 * square one is the cover with the title and play over it, a wide one the
 * cover beside the title, artist and buttons, and a tall one that plus the
 * next songs of the queue, as many as fit.
 *
 * The cover is the slow part, so a refresh draws twice when it has to: at once
 * with the cover already in hand (or the placeholder), and again when the
 * download lands, unless the track has moved on meanwhile. The text and the
 * play/pause button are never kept waiting on the network.
 */
internal object HomeWidgetRenderer {
  /** The deep link the cover opens. `resonus` is the app's scheme (app.json). */
  private const val PLAYER_LINK = "resonus://player"

  /**
   * Opens the app on the player, which is a route it already has. With [play]
   * the player starts the current song: that is the widget's own play button
   * with no session to talk to, and a queue brought back from the last run has
   * none until something starts it. Opening the player and leaving it paused
   * was not what the button said. A tap on the cover asks for no such thing.
   */
  fun playerIntent(context: Context, play: Boolean): Intent {
    val link = if (play) "$PLAYER_LINK?play=1" else PLAYER_LINK
    return Intent(Intent.ACTION_VIEW, Uri.parse(link)).setPackage(context.packageName)
  }

  private val executor = Executors.newSingleThreadExecutor()


  /** Redraws [ids], or every placed widget when none are named. */
  fun refresh(context: Context, state: WidgetState, ids: IntArray? = null) {
    val app = context.applicationContext
    val targets = ids ?: widgetIds(app)
    if (targets.isEmpty()) return
    val cached = WidgetArtwork.cached(state.artworkUrl)
    push(app, targets, state, cached)
    val url = state.artworkUrl ?: return
    if (cached != null) return
    executor.execute {
      val bitmap = WidgetArtwork.load(url) ?: return@execute
      // Stale by now if a skip happened while it downloaded: the saved state
      // is what JS pushed last, and it names the cover it wants.
      val current = WidgetState.load(app)
      if (current.artworkUrl != url) return@execute
      push(app, targets, current, bitmap)
    }
  }

  private fun widgetIds(context: Context): IntArray =
    AppWidgetManager.getInstance(context)
      .getAppWidgetIds(ComponentName(context, HomeWidgetProvider::class.java))

  private fun push(context: Context, ids: IntArray, state: WidgetState, artwork: Bitmap?) {
    val manager = AppWidgetManager.getInstance(context)
    for (id in ids) {
      val shape = Shape.of(manager.getAppWidgetOptions(id))
      manager.updateAppWidget(id, build(context, shape, state, artwork))
    }
  }

  /**
   * Which layout a widget gets, read off the cells the launcher gave it.
   * A widget narrower than three columns is the square one. A wider one gets
   * a queue row for each [ROW_DP] left under the head, up to
   * [WidgetState.MAX_UPCOMING]; none fitting is the plain wide one. The
   * launcher gives no options at all on some old ones: that is the wide one.
   */
  private data class Shape(val small: Boolean, val rows: Int) {
    companion object {
      private const val SMALL_MAX_WIDTH_DP = 180
      private const val HEAD_DP = 112
      private const val ROW_DP = 30

      fun of(options: Bundle): Shape {
        val width = options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, 0)
        val height = options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, 0)
        if (width in 1 until SMALL_MAX_WIDTH_DP) return Shape(small = true, rows = 0)
        val rows = ((height - HEAD_DP) / ROW_DP).coerceIn(0, WidgetState.MAX_UPCOMING)
        return Shape(small = false, rows = rows)
      }
    }
  }

  private fun build(context: Context, shape: Shape, state: WidgetState, artwork: Bitmap?): RemoteViews {
    val layout = when {
      shape.small -> R.layout.home_widget_small
      shape.rows > 0 -> R.layout.home_widget_large
      else -> R.layout.home_widget
    }
    val views = RemoteViews(context.packageName, layout)
    if (state.isEmpty) {
      buildEmpty(context, shape, views)
    } else {
      buildPlaying(context, shape, state, artwork, views)
    }
    if (!shape.small && shape.rows > 0) buildQueue(context, shape, state, views)
    return views
  }

  /**
   * Nothing to show: the app's icon where the cover goes, and a tap anywhere
   * opens the app the way the launcher would, since there is no player to
   * open on.
   */
  private fun buildEmpty(context: Context, shape: Shape, views: RemoteViews) {
    val icon = WidgetArtwork.appIcon(context)
    views.setTextViewText(R.id.widget_title, context.getString(R.string.widget_nothing_playing))
    if (shape.small) {
      views.setViewVisibility(R.id.widget_artwork, View.GONE)
      views.setViewVisibility(R.id.widget_app_icon, View.VISIBLE)
      views.setViewVisibility(R.id.widget_play_pause, View.GONE)
      if (icon != null) views.setImageViewBitmap(R.id.widget_app_icon, icon)
    } else {
      views.setTextViewText(R.id.widget_artist, context.getString(R.string.widget_open_app))
      if (icon != null) {
        views.setImageViewBitmap(R.id.widget_artwork, icon)
      } else {
        views.setImageViewResource(R.id.widget_artwork, R.drawable.ic_widget_artwork)
      }
      views.setViewVisibility(R.id.widget_controls, View.GONE)
    }
    val launch = context.packageManager.getLaunchIntentForPackage(context.packageName)
      ?: playerIntent(context, play = false)
    val openApp = PendingIntent.getActivity(
      context,
      REQUEST_OPEN_APP,
      launch,
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )
    views.setOnClickPendingIntent(R.id.widget_root, openApp)
  }

  private fun buildPlaying(
    context: Context,
    shape: Shape,
    state: WidgetState,
    artwork: Bitmap?,
    views: RemoteViews,
  ) {
    views.setTextViewText(R.id.widget_title, state.title ?: "")
    if (artwork != null) {
      views.setImageViewBitmap(R.id.widget_artwork, artwork)
    } else {
      views.setImageViewResource(R.id.widget_artwork, R.drawable.ic_widget_artwork)
    }
    views.setImageViewResource(
      R.id.widget_play_pause,
      if (state.isPlaying) R.drawable.ic_widget_pause else R.drawable.ic_widget_play,
    )
    views.setContentDescription(
      R.id.widget_play_pause,
      context.getString(if (state.isPlaying) R.string.widget_pause else R.string.widget_play),
    )
    views.setOnClickPendingIntent(R.id.widget_play_pause, transport(context, HomeWidgetProvider.ACTION_PLAY_PAUSE, REQUEST_PLAY_PAUSE))

    val openPlayer = PendingIntent.getActivity(
      context,
      REQUEST_OPEN_PLAYER,
      playerIntent(context, play = false),
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )
    if (shape.small) {
      // The cover is the whole widget; its one button sits on top of it.
      views.setViewVisibility(R.id.widget_artwork, View.VISIBLE)
      views.setViewVisibility(R.id.widget_app_icon, View.GONE)
      views.setViewVisibility(R.id.widget_play_pause, View.VISIBLE)
      views.setOnClickPendingIntent(R.id.widget_root, openPlayer)
      return
    }
    views.setTextViewText(R.id.widget_artist, state.artist ?: "")
    views.setViewVisibility(R.id.widget_controls, View.VISIBLE)
    views.setOnClickPendingIntent(R.id.widget_artwork, openPlayer)
    views.setOnClickPendingIntent(R.id.widget_body, openPlayer)
    views.setOnClickPendingIntent(R.id.widget_prev, transport(context, HomeWidgetProvider.ACTION_PREV, REQUEST_PREV))
    views.setOnClickPendingIntent(R.id.widget_next, transport(context, HomeWidgetProvider.ACTION_NEXT, REQUEST_NEXT))
  }

  /**
   * The rows under the head of the tall widget: one per upcoming song that
   * fits, the rest hidden. With no song known to come next the block goes
   * too, and the head sits centred in the widget as the wide one does.
   */
  private fun buildQueue(context: Context, shape: Shape, state: WidgetState, views: RemoteViews) {
    var shown = 0
    QUEUE_ROWS.forEachIndexed { row, (rowId, titleId, artistId) ->
      val song = state.upcoming.getOrNull(row)
      if (row >= shape.rows || song == null || state.isEmpty) {
        views.setViewVisibility(rowId, View.GONE)
        return@forEachIndexed
      }
      shown++
      views.setViewVisibility(rowId, View.VISIBLE)
      views.setTextViewText(titleId, song.title)
      views.setTextViewText(artistId, song.artist ?: "")
      views.setViewVisibility(artistId, if (song.artist.isNullOrEmpty()) View.GONE else View.VISIBLE)
      views.setContentDescription(rowId, context.getString(R.string.widget_play_song, song.title))
      views.setOnClickPendingIntent(rowId, jump(context, state.index + 1 + row, song.id, REQUEST_JUMP + row))
    }
    views.setViewVisibility(R.id.widget_queue, if (shown > 0) View.VISIBLE else View.GONE)
  }

  // Explicit intents to our own receiver: the launcher fires them on tap, and
  // the receiver is what talks to the media session (app process or not).
  private fun transport(context: Context, action: String, requestCode: Int): PendingIntent =
    PendingIntent.getBroadcast(
      context,
      requestCode,
      Intent(context, HomeWidgetProvider::class.java).setAction(action),
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )

  // One request code per row, so a redraw replaces the row's song rather than
  // piling up a pending intent per song ever shown.
  private fun jump(context: Context, index: Int, id: String, requestCode: Int): PendingIntent =
    PendingIntent.getBroadcast(
      context,
      requestCode,
      Intent(context, HomeWidgetProvider::class.java)
        .setAction(HomeWidgetProvider.ACTION_JUMP)
        .putExtra(HomeWidgetProvider.EXTRA_INDEX, index)
        .putExtra(HomeWidgetProvider.EXTRA_ID, id),
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )

  private const val REQUEST_OPEN_PLAYER = 0
  private const val REQUEST_PREV = 1
  private const val REQUEST_PLAY_PAUSE = 2
  private const val REQUEST_NEXT = 3
  private const val REQUEST_OPEN_APP = 4
  private const val REQUEST_JUMP = 10

  private val QUEUE_ROWS = listOf(
    Triple(R.id.widget_up1, R.id.widget_up1_title, R.id.widget_up1_artist),
    Triple(R.id.widget_up2, R.id.widget_up2_title, R.id.widget_up2_artist),
    Triple(R.id.widget_up3, R.id.widget_up3_title, R.id.widget_up3_artist),
  )
}
