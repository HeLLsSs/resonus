package expo.modules.batteryopt

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.PowerManager
import android.provider.Settings
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Where this app stands with Android's battery optimisation.
 *
 * With it on, which is the normal state and the one the system puts back by
 * itself after a while without opening the app, Android is free to kill the
 * playback service in the background, cut a download short or hold the sleep
 * timer back. There is no way to ask from JS, hence this module.
 *
 * It only asks and opens settings: it does NOT request the exemption itself
 * (`ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`), which needs the
 * `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` permission that Google Play restricts.
 * Taking someone to the system screen needs no permission at all.
 */
class BatteryOptModule : Module() {
  private val context: Context
    get() = requireNotNull(appContext.reactContext)

  override fun definition() = ModuleDefinition {
    Name("BatteryOpt")

    /**
     * Is the app exempt from battery optimisation? `true` means exempt, with no
     * restrictions on it. When in doubt it answers `true`: better to say nothing
     * than to warn about something that isn't happening.
     */
    Function("isIgnoringOptimizations") {
      runCatching {
        val pm = context.getSystemService(Context.POWER_SERVICE) as PowerManager
        pm.isIgnoringBatteryOptimizations(context.packageName)
      }.getOrDefault(true)
    }

    /**
     * Opens the system's battery optimisation list. On a device that does not
     * have it (some manufacturers take it out) it falls back to the app's own
     * details screen, which leads to the same place. Returns whether anything
     * could be opened.
     */
    Function("openSettings") {
      val context = appContext.reactContext ?: return@Function false
      val screens = listOf(
        Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS),
        Intent(
          Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
          Uri.fromParts("package", context.packageName, null),
        ),
      )
      screens.any { intent ->
        runCatching {
          intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
          context.startActivity(intent)
        }.isSuccess
      }
    }
  }
}
