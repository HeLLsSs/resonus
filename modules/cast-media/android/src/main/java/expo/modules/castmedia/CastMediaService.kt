package expo.modules.castmedia

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.SystemClock
import android.view.KeyEvent
import android.support.v4.media.MediaMetadataCompat
import android.support.v4.media.session.MediaSessionCompat
import android.support.v4.media.session.PlaybackStateCompat
import androidx.core.app.NotificationCompat
import androidx.media.VolumeProviderCompat
import androidx.media.app.NotificationCompat.MediaStyle
import java.net.URL

/**
 * A foreground service that keeps a MediaSessionCompat alive while casting over
 * UPnP. It provides the lock screen and notification controls (Issue 3) and, by
 * declaring the session as remote playback with a VolumeProviderCompat, puts the
 * phone's volume keys in charge of the stream (Issue 1). The commands (play,
 * pause, previous, next, seek, volume) go to JS through `CastMediaModule`, which
 * already knows how to route them to the renderer. It plays no audio itself.
 */
class CastMediaService : Service() {
  data class Info(
    val title: String?,
    val artist: String?,
    val album: String?,
    val artworkUrl: String?,
    val durationMs: Long,
    val positionMs: Long,
    val isPlaying: Boolean,
  )

  private var session: MediaSessionCompat? = null
  private var info: Info = Info(null, null, null, null, 0, 0, false)
  private val mainHandler = Handler(Looper.getMainLooper())

  private var lastArtUrl: String? = null
  private var artBitmap: Bitmap? = null

  private val volumeProvider =
    object : VolumeProviderCompat(
      VolumeProviderCompat.VOLUME_CONTROL_RELATIVE,
      MAX_VOLUME,
      MAX_VOLUME / 2,
    ) {
      override fun onAdjustVolume(direction: Int) {
        // direction: +1 up, -1 down; 0 is the mute toggle and is ignored.
        if (direction == 0) return
        // Optimistic: it moves the system overlay at once. It used to sit at
        // 50% forever because currentVolume was never touched. JS sends the
        // exact value back through setVolumeLevel once the renderer has it.
        currentVolume = (currentVolume + direction).coerceIn(0, MAX_VOLUME)
        CastMediaModule.instance?.emitCommand("volume", direction.toDouble())
      }
    }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    instance = this
    ensureChannel()
    val s = MediaSessionCompat(this, "ResonusCast")
    s.setFlags(
      MediaSessionCompat.FLAG_HANDLES_MEDIA_BUTTONS or
        MediaSessionCompat.FLAG_HANDLES_TRANSPORT_CONTROLS,
    )
    s.setCallback(SessionCallback())
    // Remote playback: it puts the volume keys through to the provider.
    s.setPlaybackToRemote(volumeProvider)
    s.isActive = true
    session = s
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    when (intent?.action) {
      ACTION_START -> {
        bootInfo?.let { info = it }
        bootInfo = null
        // Android 12+ can refuse the promotion once the service is already
        // running, and the refusal is an exception thrown in here, where the
        // module's own guard around `startForegroundService` cannot reach it.
        // A cast with no notification beats no app at all.
        if (startForegroundWithNotification().isFailure) {
          stopSelf(startId)
          return START_NOT_STICKY
        }
        applyMetadata()
        applyPlaybackState()
        loadArtwork()
      }
      ACTION_PLAY -> CastMediaModule.instance?.emitCommand("play", null)
      ACTION_PAUSE -> CastMediaModule.instance?.emitCommand("pause", null)
      ACTION_NEXT -> CastMediaModule.instance?.emitCommand("next", null)
      ACTION_PREV -> CastMediaModule.instance?.emitCommand("previous", null)
      ACTION_STOP -> {
        CastMediaModule.instance?.emitCommand("stop", null)
        stopEverything()
      }
      else -> {
        // Restarted by the system with nothing to go on: no zombie service.
        if (session == null) stopSelf(startId)
      }
    }
    return START_NOT_STICKY
  }

  override fun onDestroy() {
    if (instance === this) instance = null
    session?.run {
      isActive = false
      release()
    }
    session = null
    super.onDestroy()
  }

  /** Fresh metadata and state, for a track change. Runs on the main thread. */
  fun update(next: Info) = mainHandler.post {
    val artChanged = next.artworkUrl != info.artworkUrl
    info = next
    if (artChanged) {
      artBitmap = null
      lastArtUrl = null
    }
    applyMetadata()
    applyPlaybackState()
    renotify()
    if (artChanged) loadArtwork()
  }

  /** Playback state only: playing or paused, and how far in. */
  fun setState(isPlaying: Boolean, positionMs: Long) = mainHandler.post {
    val playingChanged = isPlaying != info.isPlaying
    info = info.copy(isPlaying = isPlaying, positionMs = positionMs)
    applyPlaybackState()
    // The lock screen reads its scrubber off the session's PlaybackState, so
    // the notification only has to be rebuilt when the play/pause button
    // changes, not once a second because the position moved.
    if (playingChanged) renotify()
  }

  /**
   * Sets the level the system's volume overlay shows, a 0..1 fraction from JS.
   * Without it the provider stayed pinned at 50% however much the real volume
   * moved on the renderer.
   */
  fun setVolumeLevel(fraction: Double) = mainHandler.post {
    volumeProvider.currentVolume = (fraction * MAX_VOLUME).toInt().coerceIn(0, MAX_VOLUME)
  }

  fun stopEverything() = mainHandler.post {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
      stopForeground(STOP_FOREGROUND_REMOVE)
    } else {
      @Suppress("DEPRECATION")
      stopForeground(true)
    }
    stopSelf()
  }

  private fun applyMetadata() {
    val meta = MediaMetadataCompat.Builder()
      .putString(MediaMetadataCompat.METADATA_KEY_TITLE, info.title ?: "")
      .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, info.artist ?: "")
      .putString(MediaMetadataCompat.METADATA_KEY_ALBUM, info.album ?: "")
      .putLong(MediaMetadataCompat.METADATA_KEY_DURATION, info.durationMs.coerceAtLeast(0))
    artBitmap?.let {
      meta.putBitmap(MediaMetadataCompat.METADATA_KEY_ALBUM_ART, it)
      meta.putBitmap(MediaMetadataCompat.METADATA_KEY_ART, it)
      meta.putBitmap(MediaMetadataCompat.METADATA_KEY_DISPLAY_ICON, it)
    }
    session?.setMetadata(meta.build())
  }

  private fun applyPlaybackState() {
    val state = if (info.isPlaying) PlaybackStateCompat.STATE_PLAYING else PlaybackStateCompat.STATE_PAUSED
    val ps = PlaybackStateCompat.Builder()
      .setActions(
        PlaybackStateCompat.ACTION_PLAY or
          PlaybackStateCompat.ACTION_PAUSE or
          PlaybackStateCompat.ACTION_PLAY_PAUSE or
          PlaybackStateCompat.ACTION_SKIP_TO_NEXT or
          PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS or
          PlaybackStateCompat.ACTION_SEEK_TO or
          PlaybackStateCompat.ACTION_STOP,
      )
      .setState(state, info.positionMs.coerceAtLeast(0), 1f, SystemClock.elapsedRealtime())
      .build()
    session?.setPlaybackState(ps)
  }

  private fun startForegroundWithNotification(): Result<Unit> = runCatching {
    val notif = buildNotification()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      startForeground(NOTIF_ID, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)
    } else {
      startForeground(NOTIF_ID, notif)
    }
  }

  private fun renotify() {
    val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    nm.notify(NOTIF_ID, buildNotification())
  }

  private fun buildNotification(): Notification {
    val token = session?.sessionToken
    val playPauseAction = if (info.isPlaying) mediaAction(android.R.drawable.ic_media_pause, "Pause", ACTION_PAUSE)
    else mediaAction(android.R.drawable.ic_media_play, "Play", ACTION_PLAY)
    val style = MediaStyle().setShowActionsInCompactView(0, 1, 2)
    if (token != null) style.setMediaSession(token)

    val builder = NotificationCompat.Builder(this, CHANNEL_ID)
      .setSmallIcon(applicationInfo.icon)
      .setContentTitle(info.title ?: "")
      .setContentText(info.artist ?: "")
      .setOnlyAlertOnce(true)
      // It stays for as long as the cast session does: it goes when the
      // session ends, not when it is swiped, which would leave the foreground
      // service orphaned.
      .setOngoing(true)
      .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
      .setContentIntent(contentPendingIntent())
      .addAction(mediaAction(android.R.drawable.ic_media_previous, "Previous", ACTION_PREV))
      .addAction(playPauseAction)
      .addAction(mediaAction(android.R.drawable.ic_media_next, "Next", ACTION_NEXT))
      .setStyle(style)
    artBitmap?.let { builder.setLargeIcon(it) }
    return builder.build()
  }

  private fun mediaAction(icon: Int, title: String, action: String): NotificationCompat.Action =
    NotificationCompat.Action(icon, title, servicePendingIntent(action))

  private fun servicePendingIntent(action: String): PendingIntent {
    val intent = Intent(this, CastMediaService::class.java).setAction(action)
    return PendingIntent.getService(this, action.hashCode(), intent, pendingIntentFlags())
  }

  private fun contentPendingIntent(): PendingIntent? {
    val launch = packageManager.getLaunchIntentForPackage(packageName) ?: return null
    return PendingIntent.getActivity(this, 0, launch, pendingIntentFlags())
  }

  private fun pendingIntentFlags(): Int =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    } else {
      PendingIntent.FLAG_UPDATE_CURRENT
    }

  private fun ensureChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (nm.getNotificationChannel(CHANNEL_ID) != null) return
    val channel = NotificationChannel(CHANNEL_ID, "Casting", NotificationManager.IMPORTANCE_LOW).apply {
      setShowBadge(false)
      lockscreenVisibility = Notification.VISIBILITY_PUBLIC
    }
    nm.createNotificationChannel(channel)
  }

  /** Fetches the cover on another thread, best effort, and applies it on the
   *  way back. */
  private fun loadArtwork() {
    val url = info.artworkUrl ?: return
    if (url == lastArtUrl && artBitmap != null) return
    lastArtUrl = url
    Thread {
      val bmp = runCatching { decodeArtwork(url) }.getOrNull() ?: return@Thread
      mainHandler.post {
        // The track may have changed while it downloaded: only apply it if it
        // is still the one playing.
        if (url != info.artworkUrl) return@post
        artBitmap = bmp
        applyMetadata()
        renotify()
      }
    }.start()
  }

  private fun decodeArtwork(url: String): Bitmap? =
    when {
      url.startsWith("content://") -> {
        contentResolver.openInputStream(Uri.parse(url))?.use { BitmapFactory.decodeStream(it) }
      }
      else -> {
        val conn = URL(url).openConnection()
        conn.connectTimeout = 8000
        conn.readTimeout = 8000
        conn.doInput = true
        conn.connect()
        conn.getInputStream().use { BitmapFactory.decodeStream(it) }
      }
    }

  private inner class SessionCallback : MediaSessionCompat.Callback() {
    /**
     * Some Bluetooth/AVRCP remotes send the command as a raw KeyEvent
     * (KEYCODE_MEDIA_NEXT/PREVIOUS) that the default callback does not always
     * turn into onSkipToNext/Previous, which is why skipping did nothing while
     * play and pause worked. They are routed explicitly here. ACTION_DOWN only,
     * so it does not fire twice (down and up).
     */
    override fun onMediaButtonEvent(mediaButtonEvent: Intent): Boolean {
      val ke: KeyEvent? =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
          mediaButtonEvent.getParcelableExtra(Intent.EXTRA_KEY_EVENT, KeyEvent::class.java)
        } else {
          @Suppress("DEPRECATION")
          mediaButtonEvent.getParcelableExtra(Intent.EXTRA_KEY_EVENT)
        }
      if (ke != null && ke.action == KeyEvent.ACTION_DOWN) {
        when (ke.keyCode) {
          KeyEvent.KEYCODE_MEDIA_NEXT -> { onSkipToNext(); return true }
          KeyEvent.KEYCODE_MEDIA_PREVIOUS -> { onSkipToPrevious(); return true }
          KeyEvent.KEYCODE_MEDIA_PLAY -> { onPlay(); return true }
          KeyEvent.KEYCODE_MEDIA_PAUSE -> { onPause(); return true }
          KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE,
          KeyEvent.KEYCODE_HEADSETHOOK -> {
            if (info.isPlaying) onPause() else onPlay()
            return true
          }
          KeyEvent.KEYCODE_MEDIA_STOP -> { onStop(); return true }
        }
      }
      return super.onMediaButtonEvent(mediaButtonEvent)
    }

    override fun onPlay() {
      CastMediaModule.instance?.emitCommand("play", null)
    }

    override fun onPause() {
      CastMediaModule.instance?.emitCommand("pause", null)
    }

    override fun onSkipToNext() {
      CastMediaModule.instance?.emitCommand("next", null)
    }

    override fun onSkipToPrevious() {
      CastMediaModule.instance?.emitCommand("previous", null)
    }

    override fun onSeekTo(pos: Long) {
      CastMediaModule.instance?.emitCommand("seek", pos.toDouble())
    }

    override fun onStop() {
      CastMediaModule.instance?.emitCommand("stop", null)
      stopEverything()
    }
  }

  companion object {
    const val ACTION_START = "expo.modules.castmedia.START"
    const val ACTION_STOP = "expo.modules.castmedia.STOP"
    const val ACTION_PLAY = "expo.modules.castmedia.PLAY"
    const val ACTION_PAUSE = "expo.modules.castmedia.PAUSE"
    const val ACTION_NEXT = "expo.modules.castmedia.NEXT"
    const val ACTION_PREV = "expo.modules.castmedia.PREV"

    private const val CHANNEL_ID = "resonus_cast"
    private const val NOTIF_ID = 4711
    private const val MAX_VOLUME = 20

    @Volatile var instance: CastMediaService? = null
      private set

    /** The initial state the module leaves behind before starting the service. */
    @Volatile var bootInfo: Info? = null
  }
}
