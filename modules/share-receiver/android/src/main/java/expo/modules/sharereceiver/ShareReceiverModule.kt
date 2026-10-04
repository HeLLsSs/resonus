package expo.modules.sharereceiver

import android.content.Intent
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * The text another app shared with this one: the main activity answers
 * `ACTION_SEND` with `text/plain` (the intent filter is in app.json), which is
 * what the YouTube and SoundCloud apps send from their Share button.
 *
 * A share to the running app comes through `OnNewIntent` and goes up as a
 * `shared` event; one that started the app sits on the activity's intent until
 * JS asks for it with `takeSharedText`. Either way the text is taken off the
 * intent once read, or a reload of the JS bundle would open it a second time.
 */
class ShareReceiverModule : Module() {
  private var observing = false

  /** A share that arrived while nothing was listening. */
  private var pending: String? = null

  override fun definition() = ModuleDefinition {
    Name("ShareReceiver")

    Events(EVENT_SHARED)

    OnStartObserving { observing = true }

    OnStopObserving { observing = false }

    OnNewIntent { intent ->
      val text = take(intent) ?: return@OnNewIntent
      if (observing) sendEvent(EVENT_SHARED, mapOf("text" to text)) else pending = text
    }

    Function("takeSharedText") {
      val queued = pending
      pending = null
      queued ?: take(appContext.currentActivity?.intent)
    }
  }

  private fun take(intent: Intent?): String? {
    if (intent?.action != Intent.ACTION_SEND || intent.type?.startsWith("text/") != true) return null
    val text = intent.getStringExtra(Intent.EXTRA_TEXT)?.takeIf { it.isNotBlank() } ?: return null
    intent.removeExtra(Intent.EXTRA_TEXT)
    return text
  }

  companion object {
    const val EVENT_SHARED = "shared"
  }
}
