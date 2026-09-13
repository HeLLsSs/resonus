package expo.modules.audiodsp

import android.content.Context
import androidx.media3.exoplayer.DefaultRenderersFactory
import androidx.media3.exoplayer.audio.AudioSink
import androidx.media3.exoplayer.audio.DefaultAudioSink

/**
 * The player's renderers, with the equaliser in the audio path.
 *
 * media3 builds a chain of processors between the decoder and the device, and
 * this is where one is added to it. Everything that was already there stays:
 * the chain built by `setAudioProcessors` keeps media3's own speed changer and
 * its silence skipper, so playback speed and the skip-silence setting go on
 * working — replacing the whole chain is how both of those get lost quietly.
 *
 * **Float output** is asked for as well. Where the device takes thirty-two-bit
 * floats, the samples reach it as the filters left them rather than being
 * squeezed back into sixteen bits on the way out; where it does not, media3
 * falls back by itself. It costs nothing and it is the difference between an
 * equaliser that is transparent and one that adds a little noise every time it
 * boosts.
 *
 * The extension renderers stay on, which is what lets the bundled FFmpeg
 * decoder answer for ALAC on the phones whose own codec list has none.
 */
class DspRenderersFactory(context: Context) : DefaultRenderersFactory(context) {
  init {
    setExtensionRendererMode(EXTENSION_RENDERER_MODE_ON)
  }

  override fun buildAudioSink(
    context: Context,
    enableFloatOutput: Boolean,
    enableAudioTrackPlaybackParams: Boolean,
  ): AudioSink =
    DefaultAudioSink.Builder(context)
      .setAudioProcessors(arrayOf(Dsp.processor()))
      .setEnableFloatOutput(true)
      .setEnableAudioTrackPlaybackParams(enableAudioTrackPlaybackParams)
      .build()
}
