package expo.modules.ridemode

import android.Manifest
import android.app.Activity
import android.bluetooth.BluetoothManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.media.AudioManager
import android.os.BatteryManager
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
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
  @Field val status: Boolean = true
  @Field val prepareCount: Int = 30
  @Field val autoPrepare: Boolean = false
  @Field val speedVolume: Boolean = false
  @Field val speedStrength: String = "medium"
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
  private var screenReceiver: BroadcastReceiver? = null
  /** The GPS listener while the speed is read; only ever touched on the main thread. */
  private var speedListener: LocationListener? = null

  /** Null once React has torn its context down, which is a call to do nothing with, not to throw over. */
  private val context: Context?
    get() = appContext.reactContext

  override fun definition() = ModuleDefinition {
    Name("RideMode")

    Events("intercom", "action", "call", "battery", "screen", "speed")

    OnCreate { instance = this@RideModeModule }

    OnDestroy {
      observing = false
      unwatch()
      main.post {
        stopSpeed()
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
      watchScreen()
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

    Function("getConfig") { context?.let { RideConfig.load(it).toMap() } }

    Function("setConfig") { record: RideConfigRecord ->
      val ctx = context ?: return@Function
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
        status = record.status,
        prepareCount = record.prepareCount,
        autoPrepare = record.autoPrepare,
        speedVolume = record.speedVolume,
        speedStrength = record.speedStrength,
      ).save(ctx)
    }

    /** Whether the phone has something to turn speech into text: Google's app, on most phones. */
    Function("canListen") {
      context?.let { speechIntent().resolveActivity(it.packageManager) != null } ?: false
    }

    /**
     * Brings up the phone's own speech dialog and answers with what was
     * said, or an empty string for nothing, a dismissal, or no dialog to
     * bring up. The phone's app records, not this one, which is what keeps
     * the microphone permission out of the manifest.
     */
    AsyncFunction("listen") { promise: Promise ->
      val activity = appContext.currentActivity
      val ctx = context
      if (activity == null || ctx == null || speechIntent().resolveActivity(ctx.packageManager) == null) {
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
      val ctx = context ?: return@Function
      RideConfig.saveActive(ctx, on)
      RideTileService.refresh(ctx)
    }

    /** The navigation apps on the phone, each `{package, name}`, from the ones the manifest may look for. */
    Function("getNavigationApps") {
      val pm = context?.packageManager ?: return@Function emptyList<Map<String, String>>()
      NAVIGATION_APPS.mapNotNull { pkg ->
        pm.getLaunchIntentForPackage(pkg) ?: return@mapNotNull null
        val name = runCatching { pm.getApplicationInfo(pkg, 0).loadLabel(pm).toString() }.getOrDefault(pkg)
        mapOf("package" to pkg, "name" to name)
      }
    }

    /** Brings that app to the front, the way its launcher icon would. */
    Function("openNavigationApp") { pkg: String ->
      val ctx = context ?: return@Function false
      val launch = ctx.packageManager.getLaunchIntentForPackage(pkg) ?: return@Function false
      launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      runCatching { ctx.startActivity(launch) }
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
      val manager = context?.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
      val bonded = runCatching { manager?.adapter?.bondedDevices }.getOrNull().orEmpty()
      bonded.map { device ->
        mapOf(
          "name" to (runCatching { device.name }.getOrNull() ?: device.address),
          "address" to device.address,
        )
      }.sortedBy { it["name"] }
    }

    Function("canDrawOverlays") { context?.let { RideOverlay.canDraw(it) } ?: false }

    Function("requestOverlayPermission") { context?.let { RideOverlay.requestPermission(it) } }

    Function("showOverlay") { state: OverlayStateRecord ->
      val ctx = context ?: return@Function
      RideOverlay.show(ctx, OverlayState(state.title, state.isPlaying), RideConfig.load(ctx).overlaySize == "large")
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
      val ctx = context ?: return@Function
      val intent = Intent(Intent.ACTION_VIEW, Uri.parse(link))
        .setPackage(ctx.packageName)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      runCatching { ctx.startActivity(intent) }
        .onFailure { Log.w(Intercom.TAG, "could not open the app: ${it.message}") }
    }

    Function("speak") { text: String, queue: Boolean ->
      val context = this@RideModeModule.context ?: return@Function
      main.post { (speaker ?: Speaker(context).also { speaker = it }).speak(text, queue) }
    }

    Function("stopSpeaking") { main.post { speaker?.stop() } }

    /** The intercom that connected while JS was not running, if any; read once and cleared. */
    Function("takePendingIntercom") { Intercom.take() }

    /** Whether the screen is lit, the lock screen included. */
    Function("isScreenOn") {
      (context?.getSystemService(Context.POWER_SERVICE) as? PowerManager)?.isInteractive ?: true
    }

    /**
     * Starts or stops reading the speed off the GPS, for the volume that
     * follows it: a fix every two seconds, each sent up as a `speed` event
     * in m/s. Nothing without the location permission, which the settings
     * screen asks for when the switch is turned on.
     */
    Function("watchSpeed") { on: Boolean ->
      main.post { if (on) startSpeed() else stopSpeed() }
    }
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
    val audio = context?.getSystemService(Context.AUDIO_SERVICE) as? AudioManager ?: return
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
    val ctx = context ?: return
    if (Build.VERSION.SDK_INT >= 33) {
      ctx.registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED)
    } else {
      ctx.registerReceiver(receiver, filter)
    }
    batteryReceiver = receiver
  }

  /** The screen going on and off; only registered at runtime, the system sends it to no manifest. */
  private fun watchScreen() {
    if (screenReceiver != null) return
    val receiver = object : BroadcastReceiver() {
      override fun onReceive(context: Context, intent: Intent) {
        sendEvent("screen", mapOf("on" to (intent.action == Intent.ACTION_SCREEN_ON)))
      }
    }
    val filter = IntentFilter(Intent.ACTION_SCREEN_ON).apply { addAction(Intent.ACTION_SCREEN_OFF) }
    val ctx = context ?: return
    if (Build.VERSION.SDK_INT >= 33) {
      ctx.registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED)
    } else {
      ctx.registerReceiver(receiver, filter)
    }
    screenReceiver = receiver
  }

  private fun startSpeed() {
    if (speedListener != null) return
    val ctx = context ?: return
    if (ctx.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) return
    val manager = ctx.getSystemService(Context.LOCATION_SERVICE) as? LocationManager ?: return
    // Every method spelled out: before Android 11 the last three have no
    // default, and a phone that calls one of them would crash the app.
    val listener = object : LocationListener {
      override fun onLocationChanged(location: Location) {
        if (observing && location.hasSpeed()) sendEvent("speed", mapOf("speed" to location.speed.toDouble()))
      }

      override fun onProviderEnabled(provider: String) {}

      override fun onProviderDisabled(provider: String) {}

      @Deprecated("Never called from Android 10 on")
      override fun onStatusChanged(provider: String?, status: Int, extras: android.os.Bundle?) {}
    }
    runCatching { manager.requestLocationUpdates(LocationManager.GPS_PROVIDER, 2000L, 0f, listener, Looper.getMainLooper()) }
      .onSuccess { speedListener = listener }
      .onFailure { Log.w(Intercom.TAG, "could not read the speed: ${it.message}") }
  }

  private fun stopSpeed() {
    val listener = speedListener ?: return
    speedListener = null
    val manager = appContext.reactContext?.getSystemService(Context.LOCATION_SERVICE) as? LocationManager
    runCatching { manager?.removeUpdates(listener) }
  }

  private fun unwatch() {
    val audio = appContext.reactContext?.getSystemService(Context.AUDIO_SERVICE) as? AudioManager
    modeListener?.let { listener -> if (Build.VERSION.SDK_INT >= 31) audio?.removeOnModeChangedListener(listener) }
    modeListener = null
    batteryReceiver?.let { receiver -> runCatching { appContext.reactContext?.unregisterReceiver(receiver) } }
    batteryReceiver = null
    screenReceiver?.let { receiver -> runCatching { appContext.reactContext?.unregisterReceiver(receiver) } }
    screenReceiver = null
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
      context?.checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED

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
