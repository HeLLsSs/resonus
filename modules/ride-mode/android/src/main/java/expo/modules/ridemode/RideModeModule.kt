package expo.modules.ridemode

import android.Manifest
import android.app.Activity
import android.bluetooth.BluetoothManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.media.AudioManager
import android.os.BatteryManager
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.speech.RecognizerIntent
import android.util.Log
import android.view.WindowManager
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record

/** The configuration as JS writes it (`src/store/rideMode.ts`). */
class RideConfigRecord : Record {
  @Field val intercomName: String = ""
  @Field val intercomAddress: String = ""
  @Field val overlay: Boolean = false
  @Field val announce: Boolean = false
  @Field val resume: Boolean = false
  @Field val emptyQueue: String = "nothing"
  @Field val navigationApp: String = ""
  @Field val startVolume: Double = 0.0
  @Field val overlaySize: String = "normal"
  @Field val radioStationId: String = ""
  @Field val radioStationName: String = ""
}

/** What the floating player shows, as JS pushes it. */
class OverlayStateRecord : Record {
  @Field val title: String = ""
  @Field val isPlaying: Boolean = false
}

/**
 * The JS end of ride mode (`src/lib/rideMode.ts`): the intercom's
 * connections come up as `intercom` events while JS listens, and the one
 * that started the runtime is read with `takePendingIntercom`; the floating
 * player's buttons come up as `action` events. The rest is what JS asks
 * for: the paired devices to choose the intercom from, the overlay, a line
 * read out loud, and the app brought to the front.
 */
class RideModeModule : Module() {
  /** True while JS has a listener here; an event sent before that is dropped, not held. */
  @Volatile private var observing = false
  private val main = Handler(Looper.getMainLooper())
  /** Made on the main thread, whose looper the engine's service connection wants; only ever touched there. */
  private var speaker: Speaker? = null
  /**
   * Whether the app shows over the lock screen: on while ride mode is, so
   * the ride screen brought up by the intercom is seen on a phone that was
   * locked in a pocket, and off after. Kept here as well as set, because
   * the flag is the Activity's and the Activity the intercom brings up may
   * not exist yet when JS asks.
   */
  @Volatile private var showWhenLocked = false
  /** The `listen` call waiting for the speech dialog to come back, if any. */
  private var listening: Promise? = null
  private var modeListener: AudioManager.OnModeChangedListener? = null
  private var batteryReceiver: BroadcastReceiver? = null

  private val context: Context
    get() = appContext.reactContext ?: throw IllegalStateException("React context is not available")

  override fun definition() = ModuleDefinition {
    Name("RideMode")

    Events("intercom", "action", "call", "battery")

    OnCreate { instance = this@RideModeModule }

    OnDestroy {
      observing = false
      unwatch()
      main.post {
        speaker?.shutdown()
        speaker = null
      }
      RideOverlay.hide()
      if (instance === this@RideModeModule) instance = null
    }

    OnStartObserving {
      observing = true
      watchCalls()
      watchBattery()
    }

    OnStopObserving {
      observing = false
      unwatch()
    }

    // The speech dialog closing, with what was said or nothing.
    OnActivityResult { _, payload ->
      if (payload.requestCode != REQUEST_SPEECH) return@OnActivityResult
      val heard = if (payload.resultCode == Activity.RESULT_OK) {
        payload.data?.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS)?.firstOrNull().orEmpty()
      } else {
        ""
      }
      listening?.resolve(heard)
      listening = null
    }

    OnActivityEntersForeground { main.post { applyShowWhenLocked() } }

    Function("getConfig") { RideConfig.load(context).toMap() }

    Function("setConfig") { record: RideConfigRecord ->
      RideConfig(
        intercomName = record.intercomName,
        intercomAddress = record.intercomAddress,
        overlay = record.overlay,
        announce = record.announce,
        resume = record.resume,
        emptyQueue = record.emptyQueue,
        navigationApp = record.navigationApp,
        startVolume = record.startVolume,
        overlaySize = record.overlaySize,
        radioStationId = record.radioStationId,
        radioStationName = record.radioStationName,
      ).save(context)
    }

    /** Whether the phone has something to turn speech into text: Google's app, on most phones. */
    Function("canListen") {
      speechIntent().resolveActivity(context.packageManager) != null
    }

    /**
     * Brings up the phone's own speech dialog and answers with what was
     * said, or an empty string for nothing, a dismissal, or no dialog to
     * bring up. The phone's app records, not this one, which is what keeps
     * the microphone permission out of the manifest.
     */
    AsyncFunction("listen") { promise: Promise ->
      val activity = appContext.currentActivity
      if (activity == null || speechIntent().resolveActivity(context.packageManager) == null) {
        promise.resolve("")
        return@AsyncFunction
      }
      listening?.resolve("")
      listening = promise
      runCatching { activity.startActivityForResult(speechIntent(), REQUEST_SPEECH) }
        .onFailure {
          Log.w(Intercom.TAG, "could not open the speech dialog: ${it.message}")
          listening = null
          promise.resolve("")
        }
    }

    /** Whether ride mode is on, for the quick settings tile to show. */
    Function("setActive") { on: Boolean ->
      RideConfig.saveActive(context, on)
      RideTileService.refresh(context)
    }

    /** The navigation apps on the phone, each `{package, name}`, from the ones the manifest may look for. */
    Function("getNavigationApps") {
      val pm = context.packageManager
      NAVIGATION_APPS.mapNotNull { pkg ->
        pm.getLaunchIntentForPackage(pkg) ?: return@mapNotNull null
        val name = runCatching { pm.getApplicationInfo(pkg, 0).loadLabel(pm).toString() }.getOrDefault(pkg)
        mapOf("package" to pkg, "name" to name)
      }
    }

    /** Brings that app to the front, the way its launcher icon would. */
    Function("openNavigationApp") { pkg: String ->
      val launch = context.packageManager.getLaunchIntentForPackage(pkg) ?: return@Function false
      launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      runCatching { context.startActivity(launch) }
        .onFailure { Log.w(Intercom.TAG, "could not open $pkg: ${it.message}") }
        .isSuccess
    }

    /** The app over the lock screen, or not; see `showWhenLocked`. */
    Function("setShowWhenLocked") { on: Boolean ->
      showWhenLocked = on
      main.post { applyShowWhenLocked() }
    }

    /**
     * The screen's brightness while the app is in front, 0 to 1, or -1 for
     * the phone's own setting. The ride screen goes to full in the sun and
     * to nearly nothing after a minute untouched.
     */
    Function("setScreenBrightness") { level: Double ->
      main.post {
        val window = appContext.currentActivity?.window ?: return@post
        val attributes = window.attributes
        attributes.screenBrightness =
          if (level < 0) WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE else level.toFloat().coerceIn(0f, 1f)
        window.attributes = attributes
      }
    }

    /** Whether the system will say which device connects; granted with the install before Android 12. */
    Function("hasBluetoothPermission") { hasBluetoothPermission() }

    /** The devices paired with the phone, each `{name, address}`; empty without the permission. */
    Function("getBondedDevices") {
      if (!hasBluetoothPermission()) return@Function emptyList<Map<String, String>>()
      val manager = context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
      val bonded = runCatching { manager?.adapter?.bondedDevices }.getOrNull().orEmpty()
      bonded.map { device ->
        mapOf(
          "name" to (runCatching { device.name }.getOrNull() ?: device.address),
          "address" to device.address,
        )
      }.sortedBy { it["name"] }
    }

    Function("canDrawOverlays") { RideOverlay.canDraw(context) }

    Function("requestOverlayPermission") { RideOverlay.requestPermission(context) }

    Function("showOverlay") { state: OverlayStateRecord ->
      RideOverlay.show(context, OverlayState(state.title, state.isPlaying), RideConfig.load(context).overlaySize == "large")
    }

    Function("updateOverlay") { state: OverlayStateRecord ->
      RideOverlay.update(OverlayState(state.title, state.isPlaying))
    }

    Function("hideOverlay") { RideOverlay.hide() }

    /**
     * Opens the app on a deep link from wherever it is, including from
     * behind another app: from Android 10 the system only allows that to
     * an app that may draw over others, which ride mode asks for anyway.
     */
    Function("openApp") { link: String ->
      val intent = Intent(Intent.ACTION_VIEW, Uri.parse(link))
        .setPackage(context.packageName)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      runCatching { context.startActivity(intent) }
        .onFailure { Log.w(Intercom.TAG, "could not open the app: ${it.message}") }
    }

    Function("speak") { text: String ->
      val context = this@RideModeModule.context
      main.post { (speaker ?: Speaker(context).also { speaker = it }).speak(text) }
    }

    Function("stopSpeaking") { main.post { speaker?.stop() } }

    /** The intercom that connected while JS was not running, if any; read once and cleared. */
    Function("takePendingIntercom") { Intercom.take() }
  }

  private fun speechIntent(): Intent =
    Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
      .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
      .putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)

  /**
   * A phone call starting and ending, read off the audio mode, which needs
   * no permission and covers calls through any app. Android 12 and later;
   * before that there is no listener and calls are not reported.
   */
  private fun watchCalls() {
    if (Build.VERSION.SDK_INT < 31 || modeListener != null) return
    val audio = context.getSystemService(Context.AUDIO_SERVICE) as? AudioManager ?: return
    val listener = AudioManager.OnModeChangedListener { mode ->
      val inCall = mode == AudioManager.MODE_IN_CALL || mode == AudioManager.MODE_IN_COMMUNICATION
      sendEvent("call", mapOf("inCall" to inCall))
    }
    modeListener = listener
    audio.addOnModeChangedListener({ main.post(it) }, listener)
  }

  /** The battery's level and whether it is charging, at every change the system reports. */
  private fun watchBattery() {
    if (batteryReceiver != null) return
    val receiver = object : BroadcastReceiver() {
      override fun onReceive(context: Context, intent: Intent) {
        val level = intent.getIntExtra(BatteryManager.EXTRA_LEVEL, -1)
        val scale = intent.getIntExtra(BatteryManager.EXTRA_SCALE, 100)
        val plugged = intent.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0)
        if (level < 0 || scale <= 0) return
        sendEvent("battery", mapOf("level" to level * 100 / scale, "charging" to (plugged != 0)))
      }
    }
    val filter = IntentFilter(Intent.ACTION_BATTERY_CHANGED)
    if (Build.VERSION.SDK_INT >= 33) {
      context.registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED)
    } else {
      context.registerReceiver(receiver, filter)
    }
    batteryReceiver = receiver
  }

  private fun unwatch() {
    val audio = appContext.reactContext?.getSystemService(Context.AUDIO_SERVICE) as? AudioManager
    modeListener?.let { listener -> if (Build.VERSION.SDK_INT >= 31) audio?.removeOnModeChangedListener(listener) }
    modeListener = null
    batteryReceiver?.let { receiver -> runCatching { appContext.reactContext?.unregisterReceiver(receiver) } }
    batteryReceiver = null
  }

  private fun applyShowWhenLocked() {
    val activity: Activity = appContext.currentActivity ?: return
    if (Build.VERSION.SDK_INT >= 27) {
      activity.setShowWhenLocked(showWhenLocked)
      activity.setTurnScreenOn(showWhenLocked)
    } else {
      @Suppress("DEPRECATION")
      val flags = WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON
      if (showWhenLocked) activity.window.addFlags(flags) else activity.window.clearFlags(flags)
    }
  }

  private fun hasBluetoothPermission(): Boolean =
    Build.VERSION.SDK_INT < 31 ||
      context.checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED

  /** True when JS was listening and got it. */
  fun emitIntercom(connected: Boolean, name: String, source: String): Boolean {
    if (!observing) return false
    sendEvent("intercom", mapOf("connected" to connected, "name" to name, "source" to source))
    return true
  }

  /** True when JS was listening and got it. */
  fun emitAction(action: String): Boolean {
    if (!observing) return false
    sendEvent("action", mapOf("action" to action))
    return true
  }

  companion object {
    private const val REQUEST_SPEECH = 0x51DE

    /**
     * The navigation apps offered, by package. The manifest declares each
     * under `<queries>`, which is what lets the app see whether one is
     * installed from Android 11 on; one missing here is invisible.
     */
    private val NAVIGATION_APPS = listOf(
      "com.waze",
      "com.google.android.apps.maps",
      "com.calimoto.calimoto",
      "gr.talent.kurviger",
      "net.osmand",
      "net.osmand.plus",
      "com.sygic.aura",
      "com.here.app.maps",
      "com.tomtom.gplay.navapp",
    )

    /** The live module while JS is up, for the receiver and the overlay to reach it. */
    @Volatile var instance: RideModeModule? = null
      private set
  }
}
