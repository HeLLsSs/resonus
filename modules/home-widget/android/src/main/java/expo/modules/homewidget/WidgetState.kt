package expo.modules.homewidget

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

/** One of the songs after the current one, as far as the widget knows it. */
internal data class UpcomingSong(val id: String, val title: String, val artist: String?)

/**
 * What the widget shows. Kept in SharedPreferences, not only in memory,
 * because the launcher redraws the widget on its own (a reboot, a launcher
 * restart, a widget just placed or resized) and asks the provider, which has
 * no JS to ask at that point: it shows what was saved last.
 */
internal data class WidgetState(
  val title: String?,
  val artist: String?,
  val artworkUrl: String?,
  val isPlaying: Boolean,
  /** Where the current song sits in the queue; the rows count up from it. */
  val index: Int = 0,
  /** The next few songs of the queue, at most [MAX_UPCOMING]. */
  val upcoming: List<UpcomingSong> = emptyList(),
) {
  /** Nothing has been played since the state was last cleared. */
  val isEmpty: Boolean
    get() = title.isNullOrEmpty() && artist.isNullOrEmpty()

  fun save(context: Context) {
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
      .edit()
      .putString(KEY_TITLE, title)
      .putString(KEY_ARTIST, artist)
      .putString(KEY_ARTWORK, artworkUrl)
      .putBoolean(KEY_PLAYING, isPlaying)
      .putInt(KEY_INDEX, index)
      .putString(KEY_UPCOMING, upcomingJson(upcoming).toString())
      .apply()
  }

  companion object {
    const val PREFS = "home_widget"
    const val MAX_UPCOMING = 3
    private const val KEY_TITLE = "title"
    private const val KEY_ARTIST = "artist"
    private const val KEY_ARTWORK = "artworkUrl"
    private const val KEY_PLAYING = "isPlaying"
    private const val KEY_INDEX = "index"
    private const val KEY_UPCOMING = "upcoming"

    val EMPTY = WidgetState(title = null, artist = null, artworkUrl = null, isPlaying = false)

    fun load(context: Context): WidgetState {
      val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
      return WidgetState(
        title = prefs.getString(KEY_TITLE, null)?.takeIf { it.isNotEmpty() },
        artist = prefs.getString(KEY_ARTIST, null)?.takeIf { it.isNotEmpty() },
        artworkUrl = prefs.getString(KEY_ARTWORK, null)?.takeIf { it.isNotEmpty() },
        isPlaying = prefs.getBoolean(KEY_PLAYING, false),
        index = prefs.getInt(KEY_INDEX, 0),
        upcoming = parseUpcoming(prefs.getString(KEY_UPCOMING, null)),
      )
    }

    /** What JS sends (`src/lib/homeWidget.ts`). Anything unreadable is empty. */
    fun fromJson(json: String): WidgetState {
      val o = runCatching { JSONObject(json) }.getOrNull() ?: return EMPTY
      return WidgetState(
        title = o.optString("title").takeIf { it.isNotEmpty() },
        artist = o.optString("artist").takeIf { it.isNotEmpty() },
        artworkUrl = o.optString("artworkUrl").takeIf { it.isNotEmpty() },
        isPlaying = o.optBoolean("isPlaying", false),
        index = o.optInt("index", 0),
        upcoming = parseUpcoming(o.optJSONArray("upcoming")),
      )
    }

    private fun parseUpcoming(json: String?): List<UpcomingSong> =
      parseUpcoming(json?.let { runCatching { JSONArray(it) }.getOrNull() })

    // A row without an id or a title cannot be shown or jumped to, so it is
    // dropped rather than drawn blank.
    private fun parseUpcoming(array: JSONArray?): List<UpcomingSong> {
      if (array == null) return emptyList()
      val songs = ArrayList<UpcomingSong>(MAX_UPCOMING)
      for (i in 0 until array.length()) {
        if (songs.size == MAX_UPCOMING) break
        val o = array.optJSONObject(i) ?: continue
        val id = o.optString("id").takeIf { it.isNotEmpty() } ?: continue
        val title = o.optString("title").takeIf { it.isNotEmpty() } ?: continue
        songs.add(UpcomingSong(id, title, o.optString("artist").takeIf { it.isNotEmpty() }))
      }
      return songs
    }

    private fun upcomingJson(songs: List<UpcomingSong>): JSONArray {
      val array = JSONArray()
      for (song in songs) {
        array.put(
          JSONObject()
            .put("id", song.id)
            .put("title", song.title)
            .put("artist", song.artist ?: ""),
        )
      }
      return array
    }
  }
}
