package expo.modules.crashlog

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Build
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * What happened to the sound on the road: which Bluetooth device came and
 * went and what it started, car mode and ride mode turning on and off, the
 * audio focus the player asked for and what it was told, and where Android
 * sent the music each time it started.
 *
 * A car is where the sound goes wrong and nowhere a cable reaches, and a
 * report is written at home, after the process that saw it has long gone.
 * So the lines go to a file, `drive.log` in the app's files, written by
 * whoever has something to say: the Bluetooth receiver with no JavaScript
 * running, the player inside expo-audio (its patch depends on this module),
 * and JS through the module. Settings › Diagnostics reads it back and the
 * problem report carries it. Capped at [MAX_LINES], the oldest going first.
 */
object DriveLog {
  private const val FILE_NAME = "drive.log"
  private const val MAX_LINES = 300

  private val clock = SimpleDateFormat("dd/MM HH:mm:ss", Locale.US)

  private fun file(context: Context) = File(context.applicationContext.filesDir, FILE_NAME)

  /** One line, stamped. Never throws: a log is not worth a crash in a car. */
  @Synchronized
  fun add(context: Context, message: String) {
    try {
      val f = file(context)
      val lines = if (f.exists()) f.readLines() else emptyList()
      val kept = (lines + "${clock.format(Date())} $message").takeLast(MAX_LINES)
      f.writeText(kept.joinToString("\n", postfix = "\n"))
    } catch (_: Throwable) {
    }
  }

  /** The lines, oldest first, one per line; empty with none. */
  @Synchronized
  fun read(context: Context): String =
    try {
      file(context).takeIf { it.exists() }?.readText()?.trimEnd().orEmpty()
    } catch (_: Throwable) {
      ""
    }

  @Synchronized
  fun clear(context: Context) {
    runCatching { file(context).delete() }
  }

  /**
   * Where the sound is going right now, in one line: the phone's audio mode
   * (anything but normal is a call's), the outputs media is routed to, the
   * device claimed for calls if any, and every player sounding with what it
   * says it plays and where it ends up. With Android Auto, a player on the
   * media mix and one on the call route read differently here, which is the
   * whole question when the music sounds like a phone line.
   */
  fun audioState(context: Context): String {
    val am = context.getSystemService(Context.AUDIO_SERVICE) as? AudioManager ?: return "no audio service"
    val mode = when (am.mode) {
      AudioManager.MODE_NORMAL -> "normal"
      AudioManager.MODE_RINGTONE -> "ringtone"
      AudioManager.MODE_IN_CALL -> "call"
      AudioManager.MODE_IN_COMMUNICATION -> "communication"
      else -> am.mode.toString()
    }
    val media = if (Build.VERSION.SDK_INT >= 33) {
      val attributes = AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).build()
      runCatching { am.getAudioDevicesForAttributes(attributes) }.getOrNull()
        ?.joinToString(",") { deviceName(it.type) }?.ifEmpty { "none" } ?: "?"
    } else {
      "?"
    }
    val calls = if (Build.VERSION.SDK_INT >= 31) am.communicationDevice?.let { deviceName(it.type) } ?: "none" else "?"
    val players = runCatching { am.activePlaybackConfigurations }.getOrNull().orEmpty().joinToString(" ") { config ->
      val where = if (Build.VERSION.SDK_INT >= 30) config.audioDeviceInfo?.let { "→${deviceName(it.type)}" }.orEmpty() else ""
      "${usageName(config.audioAttributes.usage)}$where"
    }
    return "mode=$mode media→$media calls→$calls players=[${players}]"
  }

  fun deviceName(type: Int): String = when (type) {
    AudioDeviceInfo.TYPE_BUILTIN_SPEAKER -> "speaker"
    AudioDeviceInfo.TYPE_BUILTIN_EARPIECE -> "earpiece"
    AudioDeviceInfo.TYPE_WIRED_HEADSET, AudioDeviceInfo.TYPE_WIRED_HEADPHONES -> "wired"
    AudioDeviceInfo.TYPE_BLUETOOTH_A2DP -> "bt-a2dp"
    AudioDeviceInfo.TYPE_BLUETOOTH_SCO -> "bt-sco(call)"
    AudioDeviceInfo.TYPE_USB_DEVICE, AudioDeviceInfo.TYPE_USB_HEADSET, AudioDeviceInfo.TYPE_USB_ACCESSORY -> "usb"
    AudioDeviceInfo.TYPE_REMOTE_SUBMIX -> "remote-submix"
    AudioDeviceInfo.TYPE_BUS -> "bus"
    AudioDeviceInfo.TYPE_TELEPHONY -> "telephony"
    else -> when {
      Build.VERSION.SDK_INT >= 31 && type == AudioDeviceInfo.TYPE_BLE_HEADSET -> "ble-headset"
      Build.VERSION.SDK_INT >= 31 && type == AudioDeviceInfo.TYPE_BLE_SPEAKER -> "ble-speaker"
      else -> "type$type"
    }
  }

  fun usageName(usage: Int): String = when (usage) {
    AudioAttributes.USAGE_MEDIA -> "media"
    AudioAttributes.USAGE_GAME -> "game"
    AudioAttributes.USAGE_VOICE_COMMUNICATION -> "voice-call"
    AudioAttributes.USAGE_VOICE_COMMUNICATION_SIGNALLING -> "call-signal"
    AudioAttributes.USAGE_ASSISTANCE_NAVIGATION_GUIDANCE -> "guidance"
    AudioAttributes.USAGE_ASSISTANT -> "assistant"
    AudioAttributes.USAGE_ASSISTANCE_SONIFICATION -> "sonification"
    AudioAttributes.USAGE_NOTIFICATION -> "notification"
    AudioAttributes.USAGE_NOTIFICATION_RINGTONE -> "ringtone"
    AudioAttributes.USAGE_ALARM -> "alarm"
    AudioAttributes.USAGE_UNKNOWN -> "unknown"
    else -> "usage$usage"
  }

  /** What Android answered a request for audio focus. */
  fun resultName(result: Int): String = when (result) {
    AudioManager.AUDIOFOCUS_REQUEST_GRANTED -> "granted"
    AudioManager.AUDIOFOCUS_REQUEST_FAILED -> "refused"
    AudioManager.AUDIOFOCUS_REQUEST_DELAYED -> "delayed"
    else -> result.toString()
  }

  /** What an audio focus change is called in the log. */
  fun focusName(value: Int): String = when (value) {
    AudioManager.AUDIOFOCUS_GAIN -> "gain"
    AudioManager.AUDIOFOCUS_GAIN_TRANSIENT -> "gain-transient"
    AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK -> "gain-transient-duck"
    AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_EXCLUSIVE -> "gain-transient-exclusive"
    AudioManager.AUDIOFOCUS_LOSS -> "loss"
    AudioManager.AUDIOFOCUS_LOSS_TRANSIENT -> "loss-transient"
    AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK -> "loss-transient-can-duck"
    else -> value.toString()
  }
}
