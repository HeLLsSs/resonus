package expo.modules.materialyou

import android.os.Build
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * The accent Android 12 and up derives from the wallpaper (Material You).
 *
 * The system publishes it as a set of colour resources that change with the
 * wallpaper, and only a resource read from a context sees the current ones,
 * hence this module. It is read rather than listened to: the app asks again
 * when it comes to the foreground, which is when a new wallpaper could have
 * been chosen.
 */
class MaterialYouModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("MaterialYou")

    /**
     * The accent pair, one per appearance, as `#RRGGBB`. `light` is the tone
     * the system uses on white and `dark` the pale one it uses on black,
     * which is the same way round the app keeps its own two accents. Null
     * below Android 12, where there is no such thing.
     */
    Function("getSystemAccent") {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return@Function null
      val context = appContext.reactContext ?: return@Function null
      runCatching {
        mapOf(
          "light" to hex(context.getColor(android.R.color.system_accent1_600)),
          "dark" to hex(context.getColor(android.R.color.system_accent1_200)),
        )
      }.getOrNull()
    }
  }

  private fun hex(argb: Int): String = String.format("#%06X", argb and 0xFFFFFF)
}
