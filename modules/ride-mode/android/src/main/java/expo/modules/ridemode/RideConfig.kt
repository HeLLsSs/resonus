package expo.modules.ridemode

import android.content.Context

/**
 * What ride mode has been told, kept in SharedPreferences so the receiver
 * can read it with no JS running: which Bluetooth device is the intercom,
 * and what starting ride mode does. JS keeps a copy in memory
 * (`src/store/rideMode.ts`), read from here at start and written back here
 * on every change, so this is the one copy on disk.
 */
internal data class RideConfig(
  /** The intercom as the phone names it; empty for none, which turns the automatic start off. */
  val intercomName: String,
  /** Its address, to match a device whose name the system will not give. */
  val intercomAddress: String,
  /** The floating player over other apps. */
  val overlay: Boolean,
  /** Every new song read out through text to speech. */
  val announce: Boolean,
  /** The queue starts again when the intercom connects. */
  val resume: Boolean,
  /** What plays when the queue is empty at that point: "nothing", "foryou", "favorites" or "random". */
  val emptyQueue: String,
  /** The package of the navigation app to bring up after the ride screen; empty for none. */
  val navigationApp: String,
  /** The media volume set when ride mode starts by itself, 0 to 1; 0 leaves it alone. */
  val startVolume: Double,
  /** The floating player's buttons: "normal" or "large". */
  val overlaySize: String,
  /** The station the ride screen's radio button plays; empty for no button. */
  val radioStationId: String,
  val radioStationName: String,
  /** The battery, the output and what is left of the queue said when the intercom connects. */
  val status: Boolean,
  /** How many songs of the queue "Prepare the ride" downloads; 0 for the whole queue. */
  val prepareCount: Int,
) {
  /** Whether a connection is worth looking at: an intercom has been chosen. */
  val autoStart: Boolean
    get() = intercomName.isNotEmpty() || intercomAddress.isNotEmpty()

  /** Whether a device that just connected is the intercom, by address or by name. */
  fun matches(name: String?, address: String?): Boolean =
    (intercomAddress.isNotEmpty() && intercomAddress.equals(address, ignoreCase = true)) ||
      (intercomName.isNotEmpty() && intercomName == name)

  fun save(context: Context) {
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
      .edit()
      .putString(KEY_NAME, intercomName)
      .putString(KEY_ADDRESS, intercomAddress)
      .putBoolean(KEY_OVERLAY, overlay)
      .putBoolean(KEY_ANNOUNCE, announce)
      .putBoolean(KEY_RESUME, resume)
      .putString(KEY_EMPTY_QUEUE, emptyQueue)
      .putString(KEY_NAVIGATION_APP, navigationApp)
      .putFloat(KEY_START_VOLUME, startVolume.toFloat())
      .putString(KEY_OVERLAY_SIZE, overlaySize)
      .putString(KEY_RADIO_ID, radioStationId)
      .putString(KEY_RADIO_NAME, radioStationName)
      .putBoolean(KEY_STATUS, status)
      .putInt(KEY_PREPARE_COUNT, prepareCount)
      .apply()
  }

  fun toMap(): Map<String, Any> = mapOf(
    "intercomName" to intercomName,
    "intercomAddress" to intercomAddress,
    "overlay" to overlay,
    "announce" to announce,
    "resume" to resume,
    "emptyQueue" to emptyQueue,
    "navigationApp" to navigationApp,
    "startVolume" to startVolume,
    "overlaySize" to overlaySize,
    "radioStationId" to radioStationId,
    "radioStationName" to radioStationName,
    "status" to status,
    "prepareCount" to prepareCount,
  )

  companion object {
    const val PREFS = "ride_mode"
    private const val KEY_NAME = "intercomName"
    private const val KEY_ADDRESS = "intercomAddress"
    private const val KEY_OVERLAY = "overlay"
    private const val KEY_ANNOUNCE = "announce"
    private const val KEY_RESUME = "resume"
    private const val KEY_EMPTY_QUEUE = "emptyQueue"
    private const val KEY_NAVIGATION_APP = "navigationApp"
    private const val KEY_START_VOLUME = "startVolume"
    private const val KEY_OVERLAY_SIZE = "overlaySize"
    private const val KEY_RADIO_ID = "radioStationId"
    private const val KEY_RADIO_NAME = "radioStationName"
    private const val KEY_STATUS = "status"
    private const val KEY_PREPARE_COUNT = "prepareCount"
    /** Whether ride mode is on, as JS last said; what the quick settings tile shows. */
    private const val KEY_ACTIVE = "active"

    fun load(context: Context): RideConfig {
      val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
      return RideConfig(
        intercomName = prefs.getString(KEY_NAME, null).orEmpty(),
        intercomAddress = prefs.getString(KEY_ADDRESS, null).orEmpty(),
        overlay = prefs.getBoolean(KEY_OVERLAY, false),
        announce = prefs.getBoolean(KEY_ANNOUNCE, false),
        resume = prefs.getBoolean(KEY_RESUME, false),
        emptyQueue = prefs.getString(KEY_EMPTY_QUEUE, null).orEmpty().ifEmpty { "nothing" },
        navigationApp = prefs.getString(KEY_NAVIGATION_APP, null).orEmpty(),
        startVolume = prefs.getFloat(KEY_START_VOLUME, 0f).toDouble(),
        overlaySize = prefs.getString(KEY_OVERLAY_SIZE, null).orEmpty().ifEmpty { "normal" },
        radioStationId = prefs.getString(KEY_RADIO_ID, null).orEmpty(),
        radioStationName = prefs.getString(KEY_RADIO_NAME, null).orEmpty(),
        status = prefs.getBoolean(KEY_STATUS, true),
        prepareCount = prefs.getInt(KEY_PREPARE_COUNT, 30),
      )
    }

    fun isActive(context: Context): Boolean =
      context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(KEY_ACTIVE, false)

    fun saveActive(context: Context, active: Boolean) {
      context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean(KEY_ACTIVE, active).apply()
    }
  }
}
