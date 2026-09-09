package expo.modules.homewidget

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.PorterDuff
import android.graphics.PorterDuffXfermode
import android.graphics.Rect
import android.graphics.RectF
import android.net.Uri
import android.util.Log
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import kotlin.math.min

/**
 * The cover as a bitmap the launcher can draw. A RemoteViews carries its
 * bitmaps over the binder, and a widget is refused past a couple of megabytes,
 * so the cover is cut square and scaled down to [SIZE_PX] here, whatever the
 * server sent. The corners are rounded here too: an ImageView in a widget
 * cannot clip.
 *
 * One entry of cache, keyed by URL: the widget is redrawn at every play and
 * pause, and fetching the same cover again for each of those is what this
 * avoids. A new track is a new URL, and the previous one is not coming back
 * soon enough to be worth keeping.
 */
internal object WidgetArtwork {
  private const val TAG = "HomeWidget"
  const val SIZE_PX = 256
  private const val CORNER_PX = 28f
  private const val CONNECT_TIMEOUT_MS = 5_000
  private const val READ_TIMEOUT_MS = 10_000

  @Volatile private var entry: Pair<String, Bitmap>? = null
  /** The last cover that could not be fetched, so a missing one is asked for
   *  once rather than on every push of the same track. */
  @Volatile private var failed: String? = null

  @Volatile private var icon: Bitmap? = null

  /**
   * The app's own icon, for the widget with nothing to show. Drawn here rather
   * than named by resource: the launcher icon belongs to the app, which this
   * module is compiled apart from, and an adaptive icon draws itself into the
   * device's mask only when asked to draw.
   */
  fun appIcon(context: Context): Bitmap? {
    icon?.let { return it }
    val drawable = runCatching { context.packageManager.getApplicationIcon(context.applicationInfo) }
      .getOrNull() ?: return null
    val out = Bitmap.createBitmap(SIZE_PX, SIZE_PX, Bitmap.Config.ARGB_8888)
    drawable.setBounds(0, 0, SIZE_PX, SIZE_PX)
    drawable.draw(Canvas(out))
    icon = out
    return out
  }

  /** The bitmap for [url] if it is the one already fetched, without fetching. */
  fun cached(url: String?): Bitmap? {
    val current = entry ?: return null
    return if (url != null && current.first == url) current.second else null
  }

  /** Fetches and decodes [url], blocking. Call it off the main thread. */
  fun load(url: String): Bitmap? {
    cached(url)?.let { return it }
    if (failed == url) return null
    val bitmap = runCatching { decode(url) }
      .onFailure { Log.w(TAG, "cover: ${it.message}") }
      .getOrNull()
    if (bitmap == null) {
      failed = url
      return null
    }
    failed = null
    entry = url to bitmap
    return bitmap
  }

  private fun decode(url: String): Bitmap? {
    val bytes = when {
      // A downloaded album's cover, private to the app: we are the app.
      url.startsWith("file://") -> Uri.parse(url).path?.let { File(it).readBytes() }
      url.startsWith("http://") || url.startsWith("https://") -> fetch(url)
      else -> null
    } ?: return null
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
    if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
    val opts = BitmapFactory.Options().apply {
      inSampleSize = sampleSize(bounds.outWidth, bounds.outHeight)
    }
    val full = BitmapFactory.decodeByteArray(bytes, 0, bytes.size, opts) ?: return null
    val rounded = squareRounded(full)
    full.recycle()
    return rounded
  }

  private fun fetch(url: String): ByteArray? {
    val conn = URL(url).openConnection() as HttpURLConnection
    conn.connectTimeout = CONNECT_TIMEOUT_MS
    conn.readTimeout = READ_TIMEOUT_MS
    try {
      if (conn.responseCode != HttpURLConnection.HTTP_OK) return null
      return conn.inputStream.use { it.readBytes() }
    } finally {
      conn.disconnect()
    }
  }

  // The largest power-of-two subsampling that keeps the short side >= SIZE_PX,
  // so the decode does not build a 1200px bitmap only to throw most of it away.
  private fun sampleSize(width: Int, height: Int): Int {
    var sample = 1
    var short = min(width, height)
    while (short / 2 >= SIZE_PX) {
      short /= 2
      sample *= 2
    }
    return sample
  }

  private fun squareRounded(src: Bitmap): Bitmap {
    val side = min(src.width, src.height)
    val srcRect = Rect(
      (src.width - side) / 2,
      (src.height - side) / 2,
      (src.width + side) / 2,
      (src.height + side) / 2,
    )
    val out = Bitmap.createBitmap(SIZE_PX, SIZE_PX, Bitmap.Config.ARGB_8888)
    val canvas = Canvas(out)
    val dst = RectF(0f, 0f, SIZE_PX.toFloat(), SIZE_PX.toFloat())
    val paint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG)
    canvas.drawRoundRect(dst, CORNER_PX, CORNER_PX, paint)
    paint.xfermode = PorterDuffXfermode(PorterDuff.Mode.SRC_IN)
    canvas.drawBitmap(src, srcRect, dst, paint)
    return out
  }
}
