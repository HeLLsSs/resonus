// Adapted from wavio (github.com/Joel-Mercier/wavio, MIT) for Resonus.
package expo.modules.carauto

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.util.LruCache
import androidx.media3.common.MediaMetadata
import java.io.ByteArrayOutputStream

/**
 * Cover art for Android Auto. The AA host draws the covers in its *own*
 * process: it can fetch an http(s) artworkUri by itself, but it cannot read our
 * file:// covers, which are private to the app. For those the bitmap is decoded
 * and scaled down in our process and the JPEG bytes are sent with
 * setArtworkData, which travels over the binder so the host can draw it without
 * touching the filesystem. Remote URLs still go as setArtworkUri: they are
 * small, and fetching them is the host's business.
 *
 * The bytes are kept small (320px at most, JPEG q80, so ~20-40KB) and cached by
 * path, so the album and queue items that share a cover are only decoded once.
 * `apply` returns how many bytes it embedded (0 for a uri, or for nothing at
 * all) so the caller can keep a binder transaction within bounds. See the guard
 * in JsProxyPlayer.
 */
internal object CarArtwork {
  private const val MAX_DIM = 320
  private const val QUALITY = 80

  /**
   * For a cover in a browse list, where it is drawn as a tile and never fills
   * the screen. A page of them travels in one binder transaction, so what
   * matters there is how little each one weighs: at this size they come out
   * around a tenth of a full one.
   */
  const val THUMB_DIM = 192

  /** What JS writes for the tree's own icons, e.g. `res://ic_car_albums`. */
  private const val RES_SCHEME = "res://"

  private val cache = object : LruCache<String, ByteArray>(8 * 1024 * 1024) {
    override fun sizeOf(key: String, value: ByteArray): Int = value.size
  }

  /** Resolved here rather than written into the tree from JS: the package name
   *  carries the build's applicationId suffix, which JS has no way to know. */
  @Volatile private var drawableBase: String? = null

  /**
   * Every icon the tree may name, against the drawable it stands for.
   *
   * Written out one by one, and this is the only reason the icons survive a
   * release build. Nothing else refers to them: JS writes `res://ic_car_home`
   * into the tree as a string, so with the name resolved at runtime the
   * resource shrinker found no reference to any of them and took all fourteen
   * out of the APK. The car then drew every tab and every shelf row blank,
   * while the debug build the tree was written against looked right.
   *
   * Naming them here also means a row asking for an icon that does not exist
   * stops the build rather than coming out empty in a car.
   */
  private val ICONS: Map<String, Int> = mapOf(
    "ic_car_albums" to R.drawable.ic_car_albums,
    "ic_car_artists" to R.drawable.ic_car_artists,
    "ic_car_bookmark" to R.drawable.ic_car_bookmark,
    "ic_car_downloaded" to R.drawable.ic_car_downloaded,
    "ic_car_favorites" to R.drawable.ic_car_favorites,
    "ic_car_foryou" to R.drawable.ic_car_foryou,
    "ic_car_genres" to R.drawable.ic_car_genres,
    "ic_car_home" to R.drawable.ic_car_home,
    "ic_car_library" to R.drawable.ic_car_library,
    "ic_car_playlists" to R.drawable.ic_car_playlists,
    "ic_car_queue" to R.drawable.ic_car_queue,
    "ic_car_recent" to R.drawable.ic_car_recent,
    "ic_car_shuffle" to R.drawable.ic_car_shuffle,
    "ic_car_smart_playlists" to R.drawable.ic_car_smart_playlists,
  )

  fun init(context: Context) {
    drawableBase = "android.resource://${context.packageName}/"
  }

  /**
   * Puts the cover on [builder]. With [embed] false a local file is never
   * decoded and its uri is used as it is, which is how the caller limits how
   * much artwork it embeds in one transaction. Returns the bytes embedded.
   */
  fun apply(
    builder: MediaMetadata.Builder,
    artworkUrl: String?,
    embed: Boolean = true,
    maxDim: Int = MAX_DIM,
  ): Int {
    if (artworkUrl == null) return 0
    // A category icon of ours: a resource uri the host resolves against this
    // package, so it arrives as a drawable it can tint, and not as a bitmap.
    if (artworkUrl.startsWith(RES_SCHEME)) {
      val base = drawableBase ?: return 0
      // By id rather than by name: the name is gone from a shrunk build (see
      // ICONS), and an android.resource:// uri built out of one resolves to
      // nothing there. The id is what survives, and the host reads that form
      // of the uri just as happily.
      val id = ICONS[artworkUrl.removePrefix(RES_SCHEME)] ?: return 0
      builder.setArtworkUri(Uri.parse(base + id))
      return 0
    }
    val bytes = if (embed) localArtworkData(artworkUrl, maxDim) else null
    if (bytes != null) {
      builder.setArtworkData(bytes, MediaMetadata.PICTURE_TYPE_FRONT_COVER)
      return bytes.size
    }
    builder.setArtworkUri(Uri.parse(artworkUrl))
    return 0
  }

  private fun localArtworkData(uri: String, maxDim: Int): ByteArray? {
    if (!uri.startsWith("file://")) return null
    val path = Uri.parse(uri).path ?: return null
    // Keyed by size too: the same cover is asked for as a tile and as the big
    // one on Now Playing, and one would otherwise be served at the other's size.
    val key = "$path@$maxDim"
    cache.get(key)?.let { return it }
    return runCatching {
      val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
      BitmapFactory.decodeFile(path, bounds)
      if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
      val opts = BitmapFactory.Options().apply {
        inSampleSize = sampleSize(bounds.outWidth, bounds.outHeight, maxDim)
      }
      val bmp = BitmapFactory.decodeFile(path, opts) ?: return null
      val out = ByteArrayOutputStream()
      bmp.compress(Bitmap.CompressFormat.JPEG, QUALITY, out)
      bmp.recycle()
      out.toByteArray().also { cache.put(key, it) }
    }.getOrNull()
  }

  // The largest power-of-two subsampling that keeps both sides >= maxDim.
  private fun sampleSize(width: Int, height: Int, maxDim: Int): Int {
    var sample = 1
    var w = width
    var h = height
    while (w / 2 >= maxDim && h / 2 >= maxDim) {
      w /= 2
      h /= 2
      sample *= 2
    }
    return sample
  }
}
