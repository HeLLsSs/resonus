package expo.modules.audiodsp

/**
 * What the equaliser is set to, for everything that renders audio to read.
 *
 * Android's own equaliser (`android.media.audiofx.Equalizer`, the one this
 * replaces) hands the work to the device, and a device offers the bands it
 * feels like — five on most phones, sometimes three. You cannot ask it for a
 * band it does not have, which is why a five-band slider was the most the app
 * could show. Doing the filtering ourselves, inside the player, means the bands
 * are ours: as many as are wanted, at the frequencies that are wanted.
 *
 * The settings live here rather than in the processor because there is more
 * than one processor. The player keeps two ExoPlayers so one track can fade
 * into the next, each with its own audio path, and both have to sound the same;
 * a third appears whenever a player is rebuilt. They all read this.
 *
 * Read from the audio thread and written from whichever thread the app is on,
 * so what they share is one immutable object behind a `@Volatile` reference:
 * a processor picks up a whole new setting or the whole old one, never half of
 * each, and nothing has to be locked on the thread that must not block.
 */

/** One band: where it sits, how much it moves, and how wide it reaches. */
data class Band(
  /** Centre frequency in hertz. */
  val hz: Double,
  /** Gain in decibels; negative cuts. */
  val db: Double,
  /**
   * Q, the width. About 1.41 is one octave, which is what a graphic equaliser
   * with ten bands wants; a higher number is a narrower notch.
   */
  val q: Double,
)

/** Everything the filters are built from, as one value. */
data class EqSetting(
  val enabled: Boolean,
  /** Applied before the bands, in decibels: where you take back the headroom
   *  that boosting a band costs. */
  val preampDb: Double,
  val bands: List<Band>,
) {
  /** Nothing to do: every band flat and no preamp. Checked per buffer, so the
   *  cost of leaving the equaliser on with nothing set is one comparison. */
  val silent: Boolean
    get() = !enabled || (preampDb == 0.0 && bands.all { it.db == 0.0 })
}

object Dsp {
  @Volatile
  var setting: EqSetting = EqSetting(enabled = false, preampDb = 0.0, bands = emptyList())
    private set

  /**
   * Whether the equaliser is part of the audio path at all.
   *
   * Separate from `enabled` because media3 asks a processor whether it is
   * active when it builds the path for a track, and not again until the next
   * one. A band moved while a song plays is heard at once — that is read per
   * buffer. The master switch is read here, so turning the equaliser on or off
   * takes hold when the next track starts, which is the price of a processor
   * that costs nothing at all while it is off.
   */
  @Volatile
  var wanted: Boolean = false
    private set

  fun set(next: EqSetting) {
    setting = next
    wanted = next.enabled
  }

  /** A processor for one audio path. Each player gets its own; they all read
   *  the setting above. */
  fun processor(): EqProcessor = EqProcessor()
}
