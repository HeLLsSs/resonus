package expo.modules.homewidget

import android.content.Context

/**
 * A queue row tapped while JS was not running. The provider cannot change
 * the queue itself, so it notes which song was asked for, starts JS with no
 * screen, and JS picks the note up once the queue is back
 * (`src/lib/widgetSync.ts`). The note goes stale quickly: a song asked for
 * and never reached must not start on its own an hour later.
 */
internal object PendingJump {
  private const val KEY_INDEX = "jumpIndex"
  private const val KEY_ID = "jumpId"
  private const val KEY_AT = "jumpAt"
  private const val MAX_AGE_MS = 60_000L

  fun save(context: Context, index: Int, id: String) {
    context.getSharedPreferences(WidgetState.PREFS, Context.MODE_PRIVATE)
      .edit()
      .putInt(KEY_INDEX, index)
      .putString(KEY_ID, id)
      .putLong(KEY_AT, System.currentTimeMillis())
      .apply()
  }

  /** The note, cleared as it is read; null when there is none or it is old. */
  fun take(context: Context): Map<String, Any>? {
    val prefs = context.getSharedPreferences(WidgetState.PREFS, Context.MODE_PRIVATE)
    val id = prefs.getString(KEY_ID, null) ?: return null
    val index = prefs.getInt(KEY_INDEX, -1)
    val at = prefs.getLong(KEY_AT, 0L)
    prefs.edit().remove(KEY_INDEX).remove(KEY_ID).remove(KEY_AT).apply()
    if (index < 0 || System.currentTimeMillis() - at > MAX_AGE_MS) return null
    return mapOf("index" to index, "id" to id)
  }
}

/**
 * Play pressed while nothing could hear the key: no session, because JS was
 * not running or had played nothing yet. The same note as a row, with no
 * song in it: JS starts whatever the queue holds once it is back, and a
 * press left for more than a minute is not honoured.
 */
internal object PendingPlay {
  private const val KEY_AT = "playAt"
  private const val MAX_AGE_MS = 60_000L

  fun save(context: Context) {
    context.getSharedPreferences(WidgetState.PREFS, Context.MODE_PRIVATE)
      .edit()
      .putLong(KEY_AT, System.currentTimeMillis())
      .apply()
  }

  /** Whether there is a fresh note; it is cleared as it is read. */
  fun take(context: Context): Boolean {
    val prefs = context.getSharedPreferences(WidgetState.PREFS, Context.MODE_PRIVATE)
    val at = prefs.getLong(KEY_AT, 0L)
    if (at == 0L) return false
    prefs.edit().remove(KEY_AT).apply()
    return System.currentTimeMillis() - at <= MAX_AGE_MS
  }
}
