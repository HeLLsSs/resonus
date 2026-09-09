package expo.modules.googlecast

import android.content.Context
import com.google.android.gms.cast.CastMediaControlIntent
import com.google.android.gms.cast.framework.CastOptions
import com.google.android.gms.cast.framework.OptionsProvider
import com.google.android.gms.cast.framework.SessionProvider
import com.google.android.gms.cast.framework.media.CastMediaOptions

/**
 * Named in the manifest; the framework instantiates it by reflection.
 *
 * The receiver is Google's Default Media Receiver: it plays whatever URL it is
 * handed with an HTML5 audio element, moves through a queue of them on its
 * own and shows the metadata that comes with them, which is everything this
 * module needs. A receiver of our own would need a registered Cast application
 * id and a hosted page, for no feature this module uses.
 */
class CastOptionsProvider : OptionsProvider {
  override fun getCastOptions(context: Context): CastOptions =
    CastOptions.Builder()
      .setReceiverApplicationId(CastMediaControlIntent.DEFAULT_MEDIA_RECEIVER_APPLICATION_ID)
      // The framework would open a media session of its own for the volume
      // keys and the lock screen. The app already runs one for every remote
      // output (modules/cast-media), fed with the same track and state it
      // shows in its screens; two sessions would take turns owning the keys.
      .setCastMediaOptions(CastMediaOptions.Builder().setMediaSessionEnabled(false).build())
      // Found again when the app is opened while the receiver still plays
      // what it was handed: see `resumeSession` in GoogleCastModule.
      .setResumeSavedSession(true)
      .build()

  override fun getAdditionalSessionProviders(context: Context): List<SessionProvider>? = null
}
