package expo.modules.audioeq

import android.content.Context
import android.media.AudioManager
import android.media.audiofx.BassBoost
import android.media.audiofx.LoudnessEnhancer
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * The two boosts the framework gives us: a bass boost
 * (android.media.audiofx.BassBoost, strength 0..1000) and a volume boost
 * (android.media.audiofx.LoudnessEnhancer, a gain in millibels).
 *
 * One effect per audio SESSION: the player alternates between two ExoPlayers
 * for the crossfade, so two sessions are alive at once and both have to be
 * treated the same. The state lives here and is applied to every session that
 * attaches, including the ones that turn up later when a player is rebuilt.
 * Each effect exists only while its value is above zero — an attached effect is
 * not free even when bypassed, since Android takes that session off the path
 * that offloads to the DSP and mixes it on the CPU instead.
 *
 * **The equaliser is not here any more.** It was `android.media.audiofx
 * .Equalizer`, which gives you the bands the device feels like offering: five
 * on most phones, at frequencies nobody chose. The app now filters inside the
 * player instead (`modules/audio-dsp`), where the bands are its own and the
 * same everywhere. What is left here is the two effects that are not
 * equalisation and that the framework still does better than we would.
 */
class AudioEqModule : Module() {
  /** Bass boost by session id, only while `bassStrength` is above zero. */
  private val boosts = mutableMapOf<Int, BassBoost>()
  /** Volume boost by session id, only while `loudnessMb` is above zero. */
  private val loudeners = mutableMapOf<Int, LoudnessEnhancer>()
  /** The player's live sessions, with an effect on them or not. */
  private val sessions = linkedSetOf<Int>()
  /** Bass boost strength, 0..1000 as the framework counts it. */
  private var bassStrength = 0
  /** Volume boost, in millibels of gain on top of the signal. */
  private var loudnessMb = 0


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

  override fun definition() = ModuleDefinition {
    Name("AudioEq")

    OnDestroy {
      closeBoosts()
      closeLoudeners()
      sessions.clear()
    }

    /**
     * Which of the two boosts this device has. Each is asked on a throwaway
     * effect of its own, on a spare session: a device may have one and not the
     * other, and the answer belongs to the device rather than to anything
     * playing.
     */
    Function("getInfo") {
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
      mapOf("bassBoost" to bassBoost, "loudness" to loudness)
    }

    /**
     * Takes note of a player session, called as each player is created. An
     * effect is only created for a boost that is actually turned up; turning
     * one up later attaches it to whatever is playing then.
     */
    Function("attach") { sessionId: Int ->
      if (sessionId == 0) return@Function
      sessions.add(sessionId)
      if (bassStrength > 0) openBoost(sessionId)
      if (loudnessMb > 0) openLoudener(sessionId)
    }

    /** Lets a session go, as its player is destroyed. */
    Function("detach") { sessionId: Int ->
      sessions.remove(sessionId)
      boosts.remove(sessionId)?.let { runCatching { it.release() } }
      loudeners.remove(sessionId)?.let { runCatching { it.release() } }
    }

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
