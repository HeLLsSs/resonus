package expo.modules.audiooutput

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.media.AudioAttributes
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * The phone's own audio outputs (speaker, wired, Bluetooth, USB, hearing aids)
 * and the media stream's volume, straight from android.media.AudioManager.
 *
 * What this cannot do is move the music to one of them. Android routes an
 * app's media by policy (the last plugged or connected output wins) and the
 * only public way for an app to choose is on its own player, media3's
 * `setPreferredAudioDevice`, and that player lives inside expo-audio and is
 * out of reach from here. The other roads are closed to ordinary apps:
 * `MediaRouter2.transferTo` on a system route is refused without
 * MODIFY_AUDIO_ROUTING, and `setCommunicationDevice` is for calls. So
 * `select` answers false, and the way to change the output is the system's
 * own media output dialog, which `openSystemPicker` brings up.
 */
class AudioOutputModule : Module() {
  private val mainHandler = Handler(Looper.getMainLooper())
  private var deviceCallback: AudioDeviceCallback? = null
  private var volumeReceiver: BroadcastReceiver? = null

  private val audioManager: AudioManager?
    get() = appContext.reactContext?.getSystemService(Context.AUDIO_SERVICE) as? AudioManager

  /** The outputs worth listing, deduped: some phones report the speaker twice. */
  private fun outputs(): List<AudioDeviceInfo> {
    val am = audioManager ?: return emptyList()
    val seenTypes = mutableSetOf<Int>()
    return am.getDevices(AudioManager.GET_DEVICES_OUTPUTS).filter { device ->
      val kind = kindOf(device.type) ?: return@filter false
      kind != "speaker" || seenTypes.add(device.type)
    }
  }

  /** What an output is, in the words the sheet uses; null for the ones it does not show. */
  private fun kindOf(type: Int): String? = when (type) {
    AudioDeviceInfo.TYPE_BUILTIN_SPEAKER -> "speaker"
    AudioDeviceInfo.TYPE_WIRED_HEADSET, AudioDeviceInfo.TYPE_WIRED_HEADPHONES -> "wired"
    AudioDeviceInfo.TYPE_BLUETOOTH_A2DP -> "bluetooth"
    AudioDeviceInfo.TYPE_USB_DEVICE, AudioDeviceInfo.TYPE_USB_HEADSET -> "usb"
    else -> when {
      Build.VERSION.SDK_INT >= 28 && type == AudioDeviceInfo.TYPE_HEARING_AID -> "hearingAid"
      Build.VERSION.SDK_INT >= 31 &&
        (type == AudioDeviceInfo.TYPE_BLE_HEADSET || type == AudioDeviceInfo.TYPE_BLE_SPEAKER) -> "bluetooth"
      Build.VERSION.SDK_INT >= 33 && type == AudioDeviceInfo.TYPE_BLE_BROADCAST -> "bluetooth"
      else -> null
    }
  }

  /**
   * Where the policy takes media right now. Android 13 can be asked outright;
   * before that it is inferred the way the policy decides: a hearing aid or
   * Bluetooth first, then wired, then USB, and the speaker only when nothing
   * else is there.
   */
  private fun activeDeviceId(devices: List<AudioDeviceInfo>): Int {
    val am = audioManager ?: return -1
    if (Build.VERSION.SDK_INT >= 33) {
      val attributes = AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).build()
      val routed = runCatching { am.getAudioDevicesForAttributes(attributes) }.getOrNull().orEmpty()
      for (target in routed) {
        devices.firstOrNull { it.id == target.id }?.let { return it.id }
        devices.firstOrNull { it.type == target.type }?.let { return it.id }
      }
    }
    val rank = listOf("hearingAid", "bluetooth", "wired", "usb", "speaker")
    return devices.minByOrNull { rank.indexOf(kindOf(it.type)) }?.id ?: -1
  }

  private fun describe(device: AudioDeviceInfo): Map<String, Any> = mapOf(
    "id" to device.id,
    "kind" to (kindOf(device.type) ?: ""),
    "name" to device.productName.toString(),
  )

  private fun snapshot(): Map<String, Any> {
    val devices = outputs()
    return mapOf(
      "devices" to devices.map(::describe),
      "activeId" to activeDeviceId(devices),
    )
  }

  private fun volume(): Map<String, Any> {
    val am = audioManager
    return mapOf(
      "value" to (am?.getStreamVolume(AudioManager.STREAM_MUSIC) ?: 0),
      "max" to (am?.getStreamMaxVolume(AudioManager.STREAM_MUSIC) ?: 0),
    )
  }

  private fun startObserving() {
    val context = appContext.reactContext ?: return
    val am = audioManager ?: return
    if (deviceCallback == null) {
      val callback = object : AudioDeviceCallback() {
        override fun onAudioDevicesAdded(addedDevices: Array<out AudioDeviceInfo>) = sendEvent("devicesChanged", snapshot())
        override fun onAudioDevicesRemoved(removedDevices: Array<out AudioDeviceInfo>) = sendEvent("devicesChanged", snapshot())
      }
      deviceCallback = callback
      am.registerAudioDeviceCallback(callback, mainHandler)
    }
    if (volumeReceiver == null) {
      // The broadcast the system sends for every volume change, hardware keys
      // included. It has no public constant but has been the same since Gingerbread.
      val receiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
          if (intent.getIntExtra("android.media.EXTRA_VOLUME_STREAM_TYPE", -1) != AudioManager.STREAM_MUSIC) return
          sendEvent("volumeChanged", volume())
        }
      }
      val filter = IntentFilter("android.media.VOLUME_CHANGED_ACTION")
      if (Build.VERSION.SDK_INT >= 33) {
        context.registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED)
      } else {
        context.registerReceiver(receiver, filter)
      }
      volumeReceiver = receiver
    }
  }

  private fun stopObserving() {
    deviceCallback?.let { callback -> audioManager?.unregisterAudioDeviceCallback(callback) }
    deviceCallback = null
    volumeReceiver?.let { receiver -> runCatching { appContext.reactContext?.unregisterReceiver(receiver) } }
    volumeReceiver = null
  }

  override fun definition() = ModuleDefinition {
    Name("AudioOutput")

    Events("devicesChanged", "volumeChanged")

    OnStartObserving { startObserving() }

    OnStopObserving { stopObserving() }

    OnDestroy { stopObserving() }

    /** The outputs present, each `{id, kind, name}`, and the id of the one media goes to. */
    Function("getDevices") { snapshot() }

    /**
     * Always false: see the class comment. Kept as the seam a future patch of
     * expo-audio would fill with `setPreferredAudioDevice` on its players.
     */
    Function("select") { _: Int -> false }

    /** The media stream's volume as `{value, max}`, in the system's own steps. */
    Function("getVolume") { volume() }

    Function("setVolume") { value: Int ->
      val am = audioManager ?: return@Function
      val max = am.getStreamMaxVolume(AudioManager.STREAM_MUSIC)
      runCatching { am.setStreamVolume(AudioManager.STREAM_MUSIC, value.coerceIn(0, max), 0) }
    }

    /**
     * Brings up the system's media output dialog for this app, the one behind
     * the volume panel's output button: SystemUI answers a broadcast for it on
     * Android 12+ and Settings had a panel for it before. When neither is there
     * (a manufacturer that dropped it), the Bluetooth settings are the nearest
     * thing. Answers which one opened: "picker", "bluetooth" or "" for none.
     */
    Function("openSystemPicker") {
      val context = appContext.reactContext ?: return@Function ""
      val pm = context.packageManager
      if (Build.VERSION.SDK_INT >= 31) {
        val intent = Intent("com.android.systemui.action.LAUNCH_MEDIA_OUTPUT_DIALOG")
          .setPackage("com.android.systemui")
          .putExtra("package_name", context.packageName)
        if (pm.queryBroadcastReceivers(intent, 0).isNotEmpty()) {
          context.sendBroadcast(intent)
          return@Function "picker"
        }
      } else {
        val intent = Intent("com.android.settings.panel.action.MEDIA_OUTPUT")
          .putExtra("com.android.settings.panel.extra.PACKAGE_NAME", context.packageName)
          .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        if (intent.resolveActivity(pm) != null && runCatching { context.startActivity(intent) }.isSuccess) {
          return@Function "picker"
        }
      }
      val settings = Intent(Settings.ACTION_BLUETOOTH_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      if (runCatching { context.startActivity(settings) }.isSuccess) "bluetooth" else ""
    }
  }
}
