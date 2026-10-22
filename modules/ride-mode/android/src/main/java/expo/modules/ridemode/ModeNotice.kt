package expo.modules.ridemode

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import expo.modules.crashlog.DriveLog

/**
 * A quiet notification while car mode or ride mode is on, with a button
 * that stops it. Car mode has no screen of its own, and ride mode started
 * from the tile stays on in a car where nothing turns it off: without this,
 * a mode that is on looks exactly like one that is off. The words are JS's,
 * in the app's language.
 */
internal object ModeNotice {
  private const val CHANNEL = "drive_mode"
  private const val ID = 0x51DF

  fun show(context: Context, channelName: String, title: String, text: String, stopLabel: String) {
    val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager ?: return
    if (Build.VERSION.SDK_INT >= 26 && nm.getNotificationChannel(CHANNEL) == null) {
      nm.createNotificationChannel(
        NotificationChannel(CHANNEL, channelName, NotificationManager.IMPORTANCE_LOW).apply { setShowBadge(false) },
      )
    }
    val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    val stop = PendingIntent.getBroadcast(
      context,
      0,
      Intent(context, ModeStopReceiver::class.java).setPackage(context.packageName),
      flags,
    )
    val open = context.packageManager.getLaunchIntentForPackage(context.packageName)
      ?.let { PendingIntent.getActivity(context, 0, it, flags) }
    @Suppress("DEPRECATION")
    val builder = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(context, CHANNEL) else Notification.Builder(context)
    val notification = builder
      .setSmallIcon(R.drawable.ic_ride_tile)
      .setContentTitle(title)
      .setContentText(text)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setContentIntent(open)
      .addAction(Notification.Action.Builder(null, stopLabel, stop).build())
      .build()
    // Without the notification permission this shows nothing, and the
    // settings screens still say the mode is on.
    runCatching { nm.notify(ID, notification) }
  }

  fun hide(context: Context) {
    (context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager)?.cancel(ID)
  }
}

/** The notification's Stop button: both modes off at once, with no grace period. */
class ModeStopReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    DriveLog.add(context, "stop pressed in the notification")
    ModeNotice.hide(context)
    Intercom.deliver(context.applicationContext, false, "notification", source = "stop", kind = "all")
  }
}
