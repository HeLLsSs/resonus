package expo.modules.audioeq

import android.content.Context
import android.media.AudioManager
import android.media.audiofx.BassBoost
import android.media.audiofx.Equalizer
import android.media.audiofx.LoudnessEnhancer
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * The system equaliser (android.media.audiofx.Equalizer) over the app's audio.
 * Android's framework does the processing; all that happens here is creating
 * the effect and handing it the gains.
 *
 * One effect per audio SESSION: the player alternates between two ExoPlayers
 * for the crossfade, so two sessions are alive at once and both have to be
 * equalised the same. The state, meaning whether it is on and what the gains
 * are, lives here and is applied to every session that attaches, including the
 * ones that turn up later when a player is recreated.
 *
 * Two more effects of the same family ride along on the same sessions: a bass
 * boost (android.media.audiofx.BassBoost, strength 0..1000) and a volume boost
 * (android.media.audiofx.LoudnessEnhancer, gain in millibels). Each exists only
 * while its value is above zero, for the same reason the equaliser only exists
 * while it is on (see `sessions`).
 */
class AudioEqModule : Module() {
  /** Effect by session id. They only exist while the equaliser is on. */
  private val effects = mutableMapOf<Int, Equalizer>()
  /** Bass boost by session id, only while `bassStrength` is above zero. */
  private val boosts = mutableMapOf<Int, BassBoost>()
  /** Volume boost by session id, only while `loudnessMb` is above zero. */
  private val loudeners = mutableMapOf<Int, LoudnessEnhancer>()
  /**
   * The player's live sessions, with an effect on them or not.
   *
   * Kept apart because an attached effect is not free even when it is bypassed:
   * while one is there, Android takes that session off the path that offloads
   * to the DSP and mixes it on the CPU instead. Everyone was paying for that,
   * and the equaliser ships off, so almost nobody was getting anything back.
   */
  private val sessions = linkedSetOf<Int>()
  private var enabled = false

  /** Gain per band in millibels; null means not set up yet, so flat. */
  private var levels: ShortArray? = null
  /** Bass boost strength, 0..1000 as the framework counts it. */
  private var bassStrength = 0
  /** Volume boost, in millibels of gain on top of the signal. */
  private var loudnessMb = 0

  /** Pours the current state onto one effect. */
  private fun applyTo(eq: Equalizer) {
    runCatching {
      levels?.forEachIndexed { i, mb ->
        if (i < eq.numberOfBands) eq.setBandLevel(i.toShort(), mb)
      }
      eq.enabled = enabled
    }
  }

  private fun applyAll() = effects.values.forEach(::applyTo)

  /** Creates a session's effect, unless it already had one. */
  private fun openEffect(sessionId: Int) {
    if (sessionId == 0 || effects.containsKey(sessionId)) return
    runCatching {
      val eq = Equalizer(0, sessionId)
      effects[sessionId] = eq
      applyTo(eq)
    }
  }

  /** Releases every effect; the sessions stay on the books. */
  private fun closeEffects() {
    effects.values.forEach { runCatching { it.release() } }
    effects.clear()
  }

  /**
   * Creates a session's bass boost, unless it already had one. Some devices
   * throw on construction, so a session that refuses simply goes without.
   */
  private fun openBoost(sessionId: Int) {
    if (sessionId == 0 || boosts.containsKey(sessionId)) return
    runCatching {
      val boost = BassBoost(0, sessionId)
      boosts[sessionId] = boost
      applyTo(boost)
    }
  }

  private fun applyTo(boost: BassBoost) {
    runCatching {
      boost.setStrength(bassStrength.toShort())
      boost.enabled = bassStrength > 0
    }
  }

  private fun closeBoosts() {
    boosts.values.forEach { runCatching { it.release() } }
    boosts.clear()
  }

  /** The same for the volume boost. */
  private fun openLoudener(sessionId: Int) {
    if (sessionId == 0 || loudeners.containsKey(sessionId)) return
    runCatching {
      val loudener = LoudnessEnhancer(sessionId)
      loudeners[sessionId] = loudener
      applyTo(loudener)
    }
  }

  private fun applyTo(loudener: LoudnessEnhancer) {
    runCatching {
      loudener.setTargetGain(loudnessMb)
      loudener.enabled = loudnessMb > 0
    }
  }

  private fun closeLoudeners() {
    loudeners.values.forEach { runCatching { it.release() } }
    loudeners.clear()
  }

  /**
   * A loose effect on a made-up session, for asking the device about things that
   * are the device's own (its bands, ranges and presets) and not any one piece
   * of playback. It works with the equaliser off too, which is exactly when
   * there is no live effect to ask.
   */
  private fun <T> withScratchEffect(block: (Equalizer) -> T): T? = runCatching {
    val am = appContext.reactContext?.getSystemService(Context.AUDIO_SERVICE) as? AudioManager
      ?: return@runCatching null
    val eq = Equalizer(0, am.generateAudioSessionId())
    try {
      block(eq)
    } finally {
      runCatching { eq.release() }
    }
  }.getOrNull()

  /** The real gains off the first effect, for after a preset is applied. */
  private fun readLevels(): List<Int> {
    val eq = effects.values.firstOrNull() ?: return levels?.map { it.toInt() } ?: emptyList()
    return runCatching {
      (0 until eq.numberOfBands.toInt()).map { eq.getBandLevel(it.toShort()).toInt() }
    }.getOrElse { levels?.map { it.toInt() } ?: emptyList() }
  }

  override fun definition() = ModuleDefinition {
    Name("AudioEq")

    OnDestroy {
      closeEffects()
      closeBoosts()
      closeLoudeners()
      sessions.clear()
    }

    /**
     * What the device's equaliser can do: its bands, their frequencies, the gain
     * range and the presets. Asked through a temporary effect on a spare
     * session, since the answers belong to the device and not to anything
     * playing.
     */
    Function("getInfo") {
      // The two boosts are asked the same way, each on a throwaway effect of
      // its own: a device may have one and not the other.
      val am = appContext.reactContext?.getSystemService(Context.AUDIO_SERVICE) as? AudioManager
      val bassBoost = am != null && runCatching {
        val boost = BassBoost(0, am.generateAudioSessionId())
        try {
          boost.strengthSupported
        } finally {
          runCatching { boost.release() }
        }
      }.getOrDefault(false)
      val loudness = am != null && runCatching {
        LoudnessEnhancer(am.generateAudioSessionId()).release()
        true
      }.getOrDefault(false)
      withScratchEffect { eq ->
        val range = eq.bandLevelRange // [min, max] in millibels
        mapOf(
          "supported" to true,
          "bassBoost" to bassBoost,
          "loudness" to loudness,
          "bands" to (0 until eq.numberOfBands.toInt()).map { i ->
            mapOf(
              "index" to i,
              // getCenterFreq answers in millihertz.
              "centerFreq" to eq.getCenterFreq(i.toShort()) / 1000,
            )
          },
          "minLevel" to range[0].toInt(),
          "maxLevel" to range[1].toInt(),
          "presets" to (0 until eq.numberOfPresets.toInt()).map { eq.getPresetName(it.toShort()) },
        )
      } ?: mapOf("supported" to false, "bassBoost" to bassBoost, "loudness" to loudness)
    }

    /**
     * Takes note of a player session, called as each player is created. The
     * effect is only created if the equaliser is on; turning it on later
     * attaches it to whatever is playing then.
     */
    Function("attach") { sessionId: Int ->
      if (sessionId == 0) return@Function
      sessions.add(sessionId)
      if (enabled) openEffect(sessionId)
      if (bassStrength > 0) openBoost(sessionId)
      if (loudnessMb > 0) openLoudener(sessionId)
    }

    /** Lets a session go, as its player is destroyed. */
    Function("detach") { sessionId: Int ->
      sessions.remove(sessionId)
      effects.remove(sessionId)?.let { runCatching { it.release() } }
      boosts.remove(sessionId)?.let { runCatching { it.release() } }
      loudeners.remove(sessionId)?.let { runCatching { it.release() } }
    }

    Function("setEnabled") { on: Boolean ->
      enabled = on
      if (on) sessions.forEach(::openEffect) else closeEffects()
      applyAll()
    }

    /** Sets every gain (in millibels), as when restoring what was saved. */
    Function("setBandLevels") { millibels: List<Int> ->
      levels = ShortArray(millibels.size) { millibels[it].toShort() }
      applyAll()
    }

    /** Sets one band, which is a slider being moved. */
    Function("setBandLevel") { band: Int, millibels: Int ->
      val cur = levels
      if (cur != null && band < cur.size) {
        cur[band] = millibels.toShort()
      }
      effects.values.forEach { eq ->
        runCatching { eq.setBandLevel(band.toShort(), millibels.toShort()) }
      }
    }

    /** Applies one of the device's presets and answers with the gains it left. */
    Function("usePreset") { preset: Int ->
      effects.values.forEach { eq -> runCatching { eq.usePreset(preset.toShort()) } }
      // With it off there is no effect to ask how it turned out, but a preset's
      // gains belong to the device, so a loose effect's answer is as good.
      val next = if (effects.isNotEmpty()) {
        readLevels()
      } else {
        withScratchEffect { eq ->
          eq.usePreset(preset.toShort())
          (0 until eq.numberOfBands.toInt()).map { eq.getBandLevel(it.toShort()).toInt() }
        } ?: readLevels()
      }
      levels = ShortArray(next.size) { next[it].toShort() }
      next
    }

    /** The gains as they are now, in millibels. */
    Function("getBandLevels") { readLevels() }

    /**
     * Bass boost strength, 0 (off) to 1000. At zero the effects are released
     * rather than bypassed, for the reason given at `sessions`.
     */
    Function("setBassBoost") { strength: Int ->
      bassStrength = strength.coerceIn(0, 1000)
      if (bassStrength == 0) closeBoosts() else sessions.forEach(::openBoost)
      boosts.values.forEach(::applyTo)
    }

    /** The strength as the effect rounded it, or as asked for when it is off. */
    Function("getBassBoost") {
      boosts.values.firstOrNull()?.let { boost ->
        runCatching { boost.roundedStrength.toInt() }.getOrNull()
      } ?: bassStrength
    }

    /**
     * Volume boost as a gain in millibels, 0 (off) to 1500. Nothing here keeps
     * the signal from clipping: that is for whoever sets it to hear.
     */
    Function("setLoudness") { gainMb: Int ->
      loudnessMb = gainMb.coerceIn(0, 1500)
      if (loudnessMb == 0) closeLoudeners() else sessions.forEach(::openLoudener)
      loudeners.values.forEach(::applyTo)
    }

    Function("getLoudness") { loudnessMb }
  }
}
