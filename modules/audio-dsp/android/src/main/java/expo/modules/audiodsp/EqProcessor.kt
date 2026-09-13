package expo.modules.audiodsp

import android.util.Log
import androidx.media3.common.C
import androidx.media3.common.audio.AudioProcessor
import androidx.media3.common.audio.BaseAudioProcessor
import java.nio.ByteBuffer
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.pow
import kotlin.math.sin

/**
 * The equaliser itself: a cascade of peaking filters over the samples on their
 * way to the speaker.
 *
 * Each band is one biquad — a filter with two samples of memory on each side —
 * built from the cookbook formulas everybody uses for this, and run once per
 * channel so the stereo image is not disturbed. The bands are in series, which
 * is what makes their gains add up the way somebody moving two sliders next to
 * each other expects.
 *
 * Both shapes media3 can hand over are handled: sixteen-bit integers, which is
 * almost everything, and thirty-two-bit floats, which is what the sink uses
 * when the device can take them. The arithmetic is in double either way — the
 * filter's memory is where rounding accumulates, and an equaliser that quietly
 * adds noise is worse than none.
 *
 * **Never block.** This runs on the thread that feeds the audio device, where
 * being late means an audible gap. So there is no allocation per buffer, no
 * lock, and the settings arrive as one immutable object read through a volatile
 * reference (see `Dsp`).
 */
class EqProcessor : BaseAudioProcessor() {
  /** Coefficients per band, and the filter memory per band per channel. */
  private var coeffs: Array<DoubleArray> = emptyArray()
  private var state: Array<DoubleArray> = emptyArray()
  private var preampGain = 1.0
  /** The setting the coefficients were built from, to know when to rebuild. */
  private var builtFrom: EqSetting? = null
  private var channels = 0
  private var rate = 0

  /** Whether this track's samples are a shape the filters can work on. */
  private var supported = false

  override fun onConfigure(inputAudioFormat: AudioProcessor.AudioFormat): AudioProcessor.AudioFormat {
    supported = inputAudioFormat.encoding == C.ENCODING_PCM_16BIT ||
      inputAudioFormat.encoding == C.ENCODING_PCM_FLOAT
    // Anything else — a bitstream on its way to a receiver, say — is passed on
    // untouched rather than refused. media3 configures every processor in the
    // chain whether or not it will use it, so throwing here would stop the
    // track rather than the equaliser; `NOT_SET` is how a processor says it
    // has nothing to add.
    if (!supported) return AudioProcessor.AudioFormat.NOT_SET
    channels = inputAudioFormat.channelCount
    rate = inputAudioFormat.sampleRate
    builtFrom = null
    // Once per track, and the one line that answers "is the equaliser actually
    // in the path, and in what". Without it the only way to tell a working
    // equaliser from a silently bypassed one is to trust your ears.
    Log.i(
      TAG,
      "eq in path: ${rate} Hz, ${channels} ch, " +
        if (inputAudioFormat.encoding == C.ENCODING_PCM_FLOAT) "float" else "16-bit",
    )
    return inputAudioFormat
  }

  /**
   * Whether the equaliser is in the path for this track.
   *
   * Read once when media3 builds the path, so this is the master switch and not
   * the band values: off, the samples never reach this class and the device is
   * free to take the low-power route that an attached effect would close.
   */
  override fun isActive(): Boolean = supported && Dsp.wanted && super.isActive()

  override fun queueInput(input: ByteBuffer) {
    val setting = Dsp.setting
    val samples = input.remaining()
    if (samples == 0) return
    val out = replaceOutputBuffer(samples)
    if (setting.silent || channels == 0) {
      // On but flat: the samples go through as they are. One copy, which is
      // what the audio path costs anyway, and no filtering.
      out.put(input)
      out.flip()
      return
    }
    rebuildIfNeeded(setting)
    if (inputAudioFormat.encoding == C.ENCODING_PCM_FLOAT) {
      floats(input, out)
    } else {
      shorts(input, out)
    }
    out.flip()
  }

  /** The filters, from the current setting. Only when something changed: this
   *  is per buffer, and building them is trigonometry. */
  private fun rebuildIfNeeded(setting: EqSetting) {
    if (builtFrom == setting) return
    builtFrom = setting
    preampGain = 10.0.pow(setting.preampDb / 20.0)
    coeffs = Array(setting.bands.size) { peaking(setting.bands[it], rate) }
    // Four numbers of memory per band per channel: two samples in, two out.
    state = Array(setting.bands.size * channels) { DoubleArray(4) }
  }

  private fun shorts(input: ByteBuffer, out: ByteBuffer) {
    var channel = 0
    while (input.hasRemaining()) {
      val sample = input.short.toDouble() / SHORT_SCALE
      val done = run(sample, channel)
      // Clipped rather than wrapped: a boosted band can take a loud passage
      // past full scale, and wrapping turns that into a crack.
      val clamped = if (done > 1.0) 1.0 else if (done < -1.0) -1.0 else done
      out.putShort((clamped * SHORT_SCALE).toInt().toShort())
      channel = (channel + 1) % channels
    }
  }

  private fun floats(input: ByteBuffer, out: ByteBuffer) {
    var channel = 0
    while (input.hasRemaining()) {
      val done = run(input.float.toDouble(), channel)
      val clamped = if (done > 1.0) 1.0 else if (done < -1.0) -1.0 else done
      out.putFloat(clamped.toFloat())
      channel = (channel + 1) % channels
    }
  }

  /** One sample through the preamp and then every band in turn. */
  private fun run(sample: Double, channel: Int): Double {
    var x = sample * preampGain
    for (band in coeffs.indices) {
      val c = coeffs[band]
      val s = state[band * channels + channel]
      // Direct form 1: x1 x2 are the last two inputs, y1 y2 the last two
      // outputs. Cheap, and its rounding behaves at these gains.
      val y = c[0] * x + c[1] * s[0] + c[2] * s[1] - c[3] * s[2] - c[4] * s[3]
      s[1] = s[0]
      s[0] = x
      s[3] = s[2]
      s[2] = y
      x = y
    }
    return x
  }

  override fun onFlush() {
    // Seeking or a new track: the filter memory belongs to the audio that just
    // stopped, and carrying it over is a click at the start of the next.
    for (s in state) s.fill(0.0)
  }

  override fun onReset() {
    coeffs = emptyArray()
    state = emptyArray()
    builtFrom = null
    channels = 0
    rate = 0
  }

  private companion object {
    const val TAG = "ResonulsDsp"
    const val SHORT_SCALE = 32768.0

    /**
     * A peaking filter's five coefficients, normalised so the first denominator
     * term is one: `b0 b1 b2 a1 a2`.
     *
     * These are the Audio EQ Cookbook formulas (Robert Bristow-Johnson), the
     * same ones behind every graphic equaliser worth using.
     */
    fun peaking(band: Band, rate: Int): DoubleArray {
      // A band above the Nyquist frequency has nothing to act on, and the
      // formulas below would fold it back down to somewhere audible. Left flat.
      if (rate <= 0 || band.hz >= rate / 2.0 || abs(band.db) < 1e-6) {
        return doubleArrayOf(1.0, 0.0, 0.0, 0.0, 0.0)
      }
      val a = 10.0.pow(band.db / 40.0)
      val w0 = 2.0 * Math.PI * band.hz / rate
      val alpha = sin(w0) / (2.0 * band.q.coerceAtLeast(0.1))
      val cosW0 = cos(w0)
      val b0 = 1.0 + alpha * a
      val b1 = -2.0 * cosW0
      val b2 = 1.0 - alpha * a
      val a0 = 1.0 + alpha / a
      val a1 = -2.0 * cosW0
      val a2 = 1.0 - alpha / a
      return doubleArrayOf(b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0)
    }
  }
}
