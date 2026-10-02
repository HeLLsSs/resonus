package expo.modules.crashlog

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/**
 * A native crash written to the same `crash.log` the JavaScript side keeps
 * (`src/lib/crashLog.ts`, whose document directory is the app's `filesDir`),
 * in the same shape, before the process goes down the way it would have.
 * Settings › Diagnostics reads the file back and shares it.
 *
 * A module rather than a line in `MainApplication`, which `expo prebuild`
 * writes over: the handler goes in when the modules are created, which is
 * before any JavaScript runs. The file is capped as the JavaScript side caps
 * it: past 64 KB the oldest half is dropped, at an entry boundary.
 */
class CrashLogModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("CrashLog")

    OnCreate {
      val dir = appContext.reactContext?.filesDir ?: return@OnCreate
      install(File(dir, FILE_NAME))
    }
  }

  private fun install(file: File) {
    val previous = Thread.getDefaultUncaughtExceptionHandler()
    Thread.setDefaultUncaughtExceptionHandler { thread, throwable ->
      try {
        val stamp = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US)
          .apply { timeZone = TimeZone.getTimeZone("UTC") }
          .format(Date())
        val entry = "$stamp  NATIVE  ${throwable.stackTraceToString().trimEnd()}\n\n"
        val text = (if (file.exists()) file.readText() else "") + entry
        file.writeText(
          if (text.length <= MAX_CHARS) text
          else text.substring(text.indexOf("\n\n", text.length / 2).let { if (it < 0) text.length / 2 else it + 2 }),
        )
      } catch (_: Throwable) {
        // The log must never be what finishes a crashing process off.
      }
      previous?.uncaughtException(thread, throwable)
    }
  }

  private companion object {
    const val FILE_NAME = "crash.log"
    const val MAX_CHARS = 64 * 1024
  }
}
