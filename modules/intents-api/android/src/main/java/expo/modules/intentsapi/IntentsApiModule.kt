package expo.modules.intentsapi

import android.content.Intent
import android.util.Log
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record

/** What JS broadcasts after every change of track or of play/pause (`sendState`). */
class PlayerStateRecord : Record {
  @Field val playing: Boolean = false
  @Field val id: String = ""
  @Field val title: String = ""
  @Field val artist: String = ""
  @Field val album: String = ""
  @Field val duration: Double = 0.0
  @Field val position: Double = 0.0
}

/**
 * The JS end of the intents API (`src/lib/intentsApi.ts`): commands come up
 * as `command` events while JS listens, and are read out of the queue with
 * `takePending` when it starts. `sendState` is the broadcast going the other
 * way, for whatever wants to know what is playing.
 */
class IntentsApiModule : Module() {
  private var observing = false

  /** True when JS was listening and got it. */
  fun deliver(command: Map<String, Any>): Boolean {
    if (!observing) return false
    sendEvent(EVENT_COMMAND, command)
    return true
  }

  override fun definition() = ModuleDefinition {
    Name("IntentsApi")

    Events(EVENT_COMMAND)

    OnCreate { Commands.attach(this@IntentsApiModule) }

    OnDestroy {
      observing = false
      Commands.detach(this@IntentsApiModule)
    }

    OnStartObserving { observing = true }

    OnStopObserving { observing = false }

    // The other road in: the main activity started with the command as its
    // extras (`am start`, or Tasker's Send Intent aimed at an activity), which
    // is the road the system never blocks. The app already running gets it
    // here; a cold start finds it on the activity's intent in `takePending`.
    OnNewIntent { intent ->
      val context = appContext.reactContext ?: return@OnNewIntent
      val command = Commands.read(intent) ?: return@OnNewIntent
      intent.removeExtra(Commands.EXTRA_COMMAND)
      Commands.deliver(context, command)
    }

    /**
     * What arrived before JS was listening: the queue, then whatever the
     * activity was started with. The activity keeps its intent for as long as
     * it lives, so the command is taken off it once read, or a reload of the
     * JS bundle would run it a second time.
     */
    Function("takePending") {
      val queued = Commands.take()
      val activityIntent = appContext.currentActivity?.intent
      val started = Commands.read(activityIntent)
      if (started != null) activityIntent?.removeExtra(Commands.EXTRA_COMMAND)
      if (started == null) queued else queued + listOf(started)
    }

    // Asynchronous like the widget's push: a broadcast is a trip through the
    // system, and the player's thread has better things to do at a track change.
    AsyncFunction("sendState") { state: PlayerStateRecord ->
      val context = appContext.reactContext ?: return@AsyncFunction
      val intent = Intent(Commands.ACTION_STATE)
        .putExtra("playing", state.playing)
        .putExtra("id", state.id)
        .putExtra("title", state.title)
        .putExtra("artist", state.artist)
        .putExtra("album", state.album)
        .putExtra("duration", state.duration)
        .putExtra("position", state.position)
      Log.i(Commands.TAG, "state: playing=${state.playing} id=${state.id}")
      context.sendBroadcast(intent)
    }
  }

  companion object {
    const val EVENT_COMMAND = "command"
  }
}
