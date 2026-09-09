package expo.modules.homewidget

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * JS pushes the player's state here (`src/components/WidgetSync.tsx`) and
 * the widget is redrawn from it. The state is saved whether or not a widget
 * is placed: the launcher asks the provider to draw one the moment it is
 * added, and what it gets then is whatever was pushed last.
 *
 * The one thing that comes back the other way is a tap on a queue row of the
 * tall widget: the media keys the buttons press know nothing about the queue,
 * so the row is handed to JS as a `jump` event while the app is alive, and
 * left as a note ([PendingJump]) for it to collect when it is not.
 */
class HomeWidgetModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("HomeWidget")

    Events("jump")

    OnCreate {
      instance = this@HomeWidgetModule
    }

    OnDestroy {
      if (instance === this@HomeWidgetModule) instance = null
    }

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
  }

  fun emitJump(index: Int, id: String) {
    sendEvent("jump", mapOf("index" to index, "id" to id))
  }

  companion object {
    /** The live module while JS is up, for the provider to reach it. */
    @Volatile var instance: HomeWidgetModule? = null
      private set
  }
}
