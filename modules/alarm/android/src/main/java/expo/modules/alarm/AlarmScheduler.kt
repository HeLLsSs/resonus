package expo.modules.alarm

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.util.Log
import java.util.Calendar

/**
 * The alarm's time and days, kept where the system can find them with the
 * app closed, and the next ring put in `AlarmManager`.
 *
 * Only the time travels here (`src/lib/alarm.ts`, `syncAlarm`): what plays
 * and where is read from the settings in JS once the ring has started it.
 */
object AlarmScheduler {
  const val TAG = "Alarm"
  const val ACTION_RING = "com.hellsss.resonuls.ALARM_RING"

  /** The intents API's (modules/intents-api, Commands.kt), which starts JS and runs the command. */
  private const val ACTION_COMMAND = "com.hellsss.resonuls.COMMAND"
  private const val PREFS = "resonus_alarm"

  fun save(context: Context, enabled: Boolean, hour: Int, minute: Int, days: List<Int>) {
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
      .putBoolean("enabled", enabled)
      .putInt("hour", hour)
      .putInt("minute", minute)
      .putString("days", days.joinToString(","))
      .apply()
  }

  /**
   * When it next rings after `now`, or null for never. The same computation as
   * `nextAlarm` in `src/lib/alarm.ts`; keep the two in step. `days` counts as
   * JS does, 0 for Sunday, which is `DAY_OF_WEEK` less one.
   */
  fun next(enabled: Boolean, hour: Int, minute: Int, days: Set<Int>, now: Long): Long? {
    if (!enabled || days.isEmpty()) return null
    val at = Calendar.getInstance()
    for (i in 0..7) {
      at.timeInMillis = now
      at.add(Calendar.DAY_OF_MONTH, i)
      at.set(Calendar.HOUR_OF_DAY, hour)
      at.set(Calendar.MINUTE, minute)
      at.set(Calendar.SECOND, 0)
      at.set(Calendar.MILLISECOND, 0)
      if (at.timeInMillis > now && (at.get(Calendar.DAY_OF_WEEK) - 1) in days) return at.timeInMillis
    }
    return null
  }

  /**
   * Puts the next ring in `AlarmManager` in place of the one there, from what
   * was saved. Returns when, or null when there is none to put.
   *
   * `setAlarmClock` and not `setExactAndAllowWhileIdle`: it rings through Doze
   * at the minute, shows the alarm icon in the status bar and the time on the
   * lock screen, and lets the app start its playback from the background.
   */
  fun schedule(context: Context): Long? {
    val manager = context.getSystemService(AlarmManager::class.java) ?: return null
    val ring = ringIntent(context)
    manager.cancel(ring)
    val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    val days = prefs.getString("days", "").orEmpty().split(",").mapNotNull { it.toIntOrNull() }.toSet()
    val at = next(
      prefs.getBoolean("enabled", false),
      prefs.getInt("hour", 7),
      prefs.getInt("minute", 0),
      days,
      System.currentTimeMillis(),
    ) ?: return null
    try {
      manager.setAlarmClock(AlarmManager.AlarmClockInfo(at, showIntent(context)), ring)
    } catch (e: SecurityException) {
      // Exact alarms taken away (an Android 12 user who revoked them): a few
      // minutes late is still a ring.
      Log.w(TAG, "no exact alarm: ${e.message}")
      manager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, ring)
    }
    Log.i(TAG, "next ring at $at")
    return at
  }

  /**
   * The ring: the next one put in first, so a JS that never comes up still
   * leaves tomorrow's in place, then the intents API's `alarm` command, which
   * is what starts JS with no screen and plays.
   */
  fun ring(context: Context) {
    schedule(context)
    context.sendBroadcast(
      Intent(ACTION_COMMAND).setPackage(context.packageName).putExtra("command", "alarm"),
    )
  }

  private fun ringIntent(context: Context): PendingIntent = PendingIntent.getBroadcast(
    context,
    0,
    Intent(context, AlarmReceiver::class.java).setAction(ACTION_RING),
    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
  )

  /** What tapping the alarm on the lock screen or in the shade opens: the app. */
  private fun showIntent(context: Context): PendingIntent? {
    val launch = context.packageManager.getLaunchIntentForPackage(context.packageName) ?: return null
    return PendingIntent.getActivity(
      context,
      1,
      launch,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
  }
}
