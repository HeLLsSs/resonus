package expo.modules.homewidget

import android.content.Context

/**
 * A queue row tapped while the app was not running. The provider cannot
 * change the queue itself, so it notes which song was asked for, opens the
 * app, and JS picks the note up once the queue is back
 * (`src/components/WidgetSync.tsx`). The note goes stale quickly: a song
 * asked for and never reached must not start on its own an hour later.
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
