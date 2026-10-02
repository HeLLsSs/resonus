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
 * The engine takes a moment to come up. Lines asked for before that are
 * kept and said as soon as it is, in the order they would have been said: a
 * line that cuts short replaces what was waiting (a song announced after the
 * next one has started is noise), a line that queues joins it, so the
 * greeting and the first song of a ride both come out of a cold engine.
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
  /** The lines asked for before the engine was ready, in order; only under its own lock. */
  private val waiting = mutableListOf<String>()
  private var utterances = 0
  /**
   * How many lines the engine still has to finish. The audio focus is held
   * for all of them together, since giving it back between a greeting and
   * the song queued after it brings the music up under the second line.
   */
  private var pending = 0

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
          main.post { finished() }
        }
        @Deprecated("Deprecated in Java")
        override fun onError(utteranceId: String?) {
          main.post { finished() }
        }
        override fun onError(utteranceId: String?, errorCode: Int) {
          main.post { finished() }
        }
        // A line cut short by the next one ends here, not in onDone.
        override fun onStop(utteranceId: String?, interrupted: Boolean) {
          main.post { finished() }
        }
      })
      ready = true
      val lines = synchronized(waiting) { waiting.toList().also { waiting.clear() } }
      lines.forEachIndexed { i, line -> speak(line, queue = i > 0) }
    }
  }

  /**
   * Says [text], cutting short whatever was still being said, or after it
   * when [queue] is set: the first song of a ride waits for the greeting.
   */
  fun speak(text: String, queue: Boolean = false) {
    if (!ready) {
      synchronized(waiting) {
        if (!queue) waiting.clear()
        waiting += text
      }
      return
    }
    main.post {
      claim()
      utterances += 1
      pending += 1
      val mode = if (queue) TextToSpeech.QUEUE_ADD else TextToSpeech.QUEUE_FLUSH
      // A line the engine would not take gets no callback, so it is counted off here.
      if (tts.speak(text, mode, null, "ride-$utterances") != TextToSpeech.SUCCESS) finished()
    }
  }

  fun stop() {
    synchronized(waiting) { waiting.clear() }
    main.post {
      if (ready) tts.stop()
      pending = 0
      release()
    }
  }

  /** One line over; the focus goes back with the last of them. Main thread. */
  private fun finished() {
    if (pending > 0) pending -= 1
    if (pending == 0) release()
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
