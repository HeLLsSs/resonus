package expo.modules.alarm

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * The ring, from the app's own PendingIntent, and the system's reasons to work
 * the next ring out again (see the manifest).
 */
class AlarmReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val app = context.applicationContext
    if (intent.action == AlarmScheduler.ACTION_RING) AlarmScheduler.ring(app) else AlarmScheduler.schedule(app)
  }
}
