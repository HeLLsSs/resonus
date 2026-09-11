package expo.modules.homewidget

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * JS pushes the player's state here (`src/lib/widgetSync.ts`) and the widget
 * is redrawn from it. The state is saved whether or not a widget is placed:
 * the launcher asks the provider to draw one the moment it is added, and
 * what it gets then is whatever was pushed last.
 *
 * Two things come back the other way, both because the media keys the
 * buttons press cannot carry them: a tap on a queue row of the tall widget,
 * and play with no session to hear the key. Each is handed to JS as an event
 * while it is listening, and left as a note ([PendingJump], [PendingPlay])
 * for it to collect when it is not.
 */
class HomeWidgetModule : Module() {
  /** True while JS has a listener here; an event sent before that is dropped, not held. */
  @Volatile private var observing = false

  override fun definition() = ModuleDefinition {
    Name("HomeWidget")

    Events("jump", "play")

    OnCreate {
      instance = this@HomeWidgetModule
    }

    OnDestroy {
      observing = false
      if (instance === this@HomeWidgetModule) instance = null
    }

    OnStartObserving { observing = true }

    OnStopObserving { observing = false }

    // Asynchronous, and it matters: a push saves the preferences and then
    // talks to the system several times over (the widget ids, a pending
    // intent per button, the update itself). On the JS thread that is a pause
    // in whatever is being drawn, and a station that renames its song every
    // few seconds pushes that often.
    AsyncFunction("update") { json: String ->
      val context = appContext.reactContext ?: return@AsyncFunction
      val state = WidgetState.fromJson(json)
      state.save(context)
      HomeWidgetRenderer.refresh(context, state)
    }

    Function("takePendingJump") {
      val context = appContext.reactContext ?: return@Function null
      PendingJump.take(context)
    }

    Function("takePendingPlay") {
      val context = appContext.reactContext ?: return@Function false
      PendingPlay.take(context)
    }
  }

  /** True when JS was listening and got it. */
  fun emitJump(index: Int, id: String): Boolean {
    if (!observing) return false
    sendEvent("jump", mapOf("index" to index, "id" to id))
    return true
  }

  /** True when JS was listening and got it. */
  fun emitPlay(): Boolean {
    if (!observing) return false
    sendEvent("play", emptyMap<String, Any>())
    return true
  }

  companion object {
    /** The live module while JS is up, for the provider to reach it. */
    @Volatile var instance: HomeWidgetModule? = null
      private set
  }
}
