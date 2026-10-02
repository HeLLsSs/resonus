package expo.modules.ridemode

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.util.Log
import java.util.Locale

/**
 * Reads a line out through the phone's text-to-speech engine, in the
 * helmet: the same audio usage a navigation app's prompts have, so it goes
 * where they go, and with the same passing claim on audio focus, so the
 * music dips under it the way it dips under them and comes back when the
 * line is done.
 *
 * The engine takes a moment to come up. A line asked for before that is
 * kept, one at a time (the last asked for wins: a song announced after the
 * next one has started is noise), and said as soon as it is.
 */
internal class Speaker(context: Context) {
  private val app = context.applicationContext
  private val main = Handler(Looper.getMainLooper())
  private val audio = app.getSystemService(Context.AUDIO_SERVICE) as? AudioManager
  private val attributes = AudioAttributes.Builder()
    .setUsage(AudioAttributes.USAGE_ASSISTANCE_NAVIGATION_GUIDANCE)
    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
    .build()
  private var focus: AudioFocusRequest? = null
  @Volatile private var ready = false
  @Volatile private var waiting: String? = null
  private var utterances = 0

  private val tts: TextToSpeech = TextToSpeech(app) { status ->
    if (status != TextToSpeech.SUCCESS) {
      Log.w(Intercom.TAG, "no text-to-speech engine")
      return@TextToSpeech
    }
    main.post {
      tts.setAudioAttributes(attributes)
      // The phone's language, not the app's: the engine may not have the
      // app's, and a title is read in whatever accent the phone has anyway.
      tts.language = Locale.getDefault()
      tts.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
        override fun onStart(utteranceId: String?) {}
        override fun onDone(utteranceId: String?) {
          main.post { release() }
        }
        @Deprecated("Deprecated in Java")
        override fun onError(utteranceId: String?) {
          main.post { release() }
        }
        override fun onError(utteranceId: String?, errorCode: Int) {
          main.post { release() }
        }
      })
      ready = true
      waiting?.let { speak(it) }
      waiting = null
    }
  }

  /**
   * Says [text], cutting short whatever was still being said, or after it
   * when [queue] is set: the first song of a ride waits for the greeting.
   */
  fun speak(text: String, queue: Boolean = false) {
    if (!ready) {
      waiting = text
      return
    }
    main.post {
      claim()
      utterances += 1
      val mode = if (queue) TextToSpeech.QUEUE_ADD else TextToSpeech.QUEUE_FLUSH
      tts.speak(text, mode, null, "ride-$utterances")
    }
  }

  fun stop() {
    waiting = null
    main.post {
      if (ready) tts.stop()
      release()
    }
  }

  fun shutdown() {
    stop()
    main.post { tts.shutdown() }
  }

  private fun claim() {
    val am = audio ?: return
    if (Build.VERSION.SDK_INT >= 26) {
      val request = focus ?: AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
        .setAudioAttributes(attributes)
        .setWillPauseWhenDucked(false)
        .build()
        .also { focus = it }
      am.requestAudioFocus(request)
    } else {
      @Suppress("DEPRECATION")
      am.requestAudioFocus(null, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
    }
  }

  private fun release() {
    val am = audio ?: return
    if (Build.VERSION.SDK_INT >= 26) {
      focus?.let { am.abandonAudioFocusRequest(it) }
    } else {
      @Suppress("DEPRECATION")
      am.abandonAudioFocus(null)
    }
  }
}
