package expo.modules.audiodsp

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * The equaliser's controls, for the app.
 *
 * It sets what `Dsp` holds and nothing else: the filtering happens in the audio
 * path (`EqProcessor`), which every player reads from there. So there is no
 * session to attach to, nothing to release, and nothing to redo when a player
 * is rebuilt — the three things the system equaliser this replaces needed a
 * hundred lines for.
 *
 * Bands arrive as plain maps rather than a record type: the screen builds them
 * from a preset or from what somebody dragged, and the list's length is the
 * thing that changes. Ten is what the app ships; nothing here is limited to it.
 */
class AudioDspModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("AudioDsp")

    // Whether the app can use this at all. It is a local module, so the answer
    // is only ever false in a build that was not rebuilt after it was added.
    Constants { mapOf("available" to true) }

    /**
     * The whole setting at once, because it is one: turning the equaliser on
     * with yesterday's bands, or moving a band with the switch off, are both
     * a single state the audio path reads whole.
     */
    Function("apply") { enabled: Boolean, preampDb: Double, bands: List<Map<String, Any?>> ->
      Dsp.set(
        EqSetting(
          enabled = enabled,
          preampDb = preampDb,
          bands = bands.mapNotNull { band ->
            val hz = (band["hz"] as? Number)?.toDouble() ?: return@mapNotNull null
            Band(
              hz = hz,
              db = (band["db"] as? Number)?.toDouble() ?: 0.0,
              // One octave, which is what a ten-band equaliser's bands are.
              q = (band["q"] as? Number)?.toDouble() ?: 1.41,
            )
          },
        ),
      )
    }
  }
}
