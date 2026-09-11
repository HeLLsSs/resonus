package expo.modules.intentsapi

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * What other apps broadcast to (`com.hellsss.resonuls.COMMAND`, see
 * docs/INTENTS.md). Declared in the manifest, so the system starts the
 * process for it when the app is not running; the rest is `Commands`.
 */
class IntentsApiReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action != Commands.ACTION_COMMAND) return
    val command = Commands.read(intent) ?: return
    Commands.deliver(context.applicationContext, command)
  }
}
