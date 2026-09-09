package expo.modules.localhttp

import android.content.Context
import android.net.Uri
import android.os.ParcelFileDescriptor
import org.json.JSONArray
import java.io.BufferedOutputStream
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.HttpURLConnection
import java.net.Inet4Address
import java.net.NetworkInterface
import java.net.ServerSocket
import java.net.Socket
import java.net.URL
import java.util.Collections
import java.util.UUID
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * A one-purpose HTTP server: hands the files this phone holds to a renderer on
 * the same network.
 *
 * Casting is not sending audio anywhere. The renderer is told a URL and goes and
 * fetches it itself, which is why a song on the server casts and a song on the
 * phone did not: there was no address to give for `content://…`. This puts one
 * in front of it.
 *
 * What it will answer is only ever what JS has published, under a key JS chose,
 * behind a token made fresh each time the server starts. Anyone on the Wi-Fi can
 * reach the port — that is the whole point of it — so nothing else is reachable:
 * no directory listing, no paths from the request, and a key that means nothing
 * once the session is over.
 *
 * The same door also relays a song the server has, for a profile whose server
 * wants extra HTTP headers (a proxy in front of it, Cloudflare Access and the
 * like): the renderer can be handed a URL and nothing else, so it is handed
 * this phone's, and the phone fetches from the server with the headers on and
 * passes the bytes through. The headers never leave the phone.
 */
class FileServer(private val ctx: Context) {
  /** Something JS has published under a key. */
  sealed class Entry {
    /** A file on this phone, and what to announce it as. */
    data class Local(val uri: String, val mime: String) : Entry()

    /** A URL on the server, fetched from here with these headers on. */
    data class Remote(val url: String, val headers: Map<String, String>) : Entry()
  }

  /**
   * Swapped whole, never edited in place. Publishing happens between one track
   * and the next, which is exactly when the renderer may still be pulling the
   * last bytes of the one before: emptying the map and filling it again left a
   * window, however short, where what it asked for was a 404.
   */
  @Volatile private var entries: Map<String, Entry> = emptyMap()
  private val token = UUID.randomUUID().toString().replace("-", "").substring(0, 16)

  private var socket: ServerSocket? = null
  private var pool: ExecutorService? = null
  @Volatile private var running = false

  /** Opens the port. Idempotent: starting an already started server does nothing. */
  fun start() {
    if (running) return
    val server = ServerSocket(0)
    socket = server
    pool = Executors.newCachedThreadPool()
    running = true
    Thread({ acceptLoop(server) }, "local-http-accept").apply { isDaemon = true }.start()
  }

  fun stop() {
    running = false
    entries = emptyMap()
    try {
      socket?.close()
    } catch (_: IOException) {
      // Closing the socket is what wakes the accept loop up; it throws there too.
    }
    socket = null
    pool?.shutdownNow()
    pool = null
  }

  /**
   * Where a renderer should come looking, or null while there is no address to
   * be reached at. A phone with the Wi-Fi off has none, and a URL built on the
   * loopback address would be this phone telling a speaker to fetch from
   * itself.
   */
  fun origin(): String? {
    val port = socket?.localPort ?: return null
    val host = lanAddress() ?: return null
    return "http://$host:$port/$token"
  }

  /**
   * Replaces what is published. The payload is a list of `{ key, uri, mime }`
   * for a file on the phone or `{ key, url, headers }` for one to relay.
   */
  fun setEntries(json: String) {
    val list = JSONArray(json)
    val next = HashMap<String, Entry>(list.length())
    for (i in 0 until list.length()) {
      val item = list.getJSONObject(i)
      val key = item.optString("key")
      if (key.isEmpty()) continue
      val uri = item.optString("uri")
      val url = item.optString("url")
      if (uri.isNotEmpty()) {
        next[key] = Entry.Local(uri, item.optString("mime", "application/octet-stream"))
      } else if (url.startsWith("http://") || url.startsWith("https://")) {
        val headers = HashMap<String, String>()
        val given = item.optJSONObject("headers")
        if (given != null) for (name in given.keys()) headers[name] = given.optString(name)
        next[key] = Entry.Remote(url, headers)
      }
    }
    entries = next
  }

  private fun acceptLoop(server: ServerSocket) {
    while (running) {
      val client =
        try {
          server.accept()
        } catch (_: IOException) {
          // Either the socket was closed on the way out, or the accept failed
          // and the next one is the answer. Both read the same from here.
          if (!running) return else continue
        }
      pool?.execute { serve(client) }
    }
  }

  private fun serve(client: Socket) {
    try {
      // A renderer that opens a connection and says nothing must not hold a
      // thread for the rest of the session.
      client.soTimeout = REQUEST_TIMEOUT_MS
      client.getInputStream().use { input ->
        BufferedOutputStream(client.getOutputStream()).use { out ->
          respond(input, out)
        }
      }
    } catch (_: Exception) {
      // A renderer closing mid-song is how seeking looks from this end, and how
      // stopping looks. Neither is worth a crash on a thread nobody is watching.
    } finally {
      try {
        client.close()
      } catch (_: IOException) {
      }
    }
  }

  private fun respond(input: InputStream, out: OutputStream) {
    val head = readHead(input) ?: return
    val lines = head.split("\r\n")
    val requestLine = lines.firstOrNull()?.split(" ") ?: return
    val method = requestLine.getOrNull(0)?.uppercase() ?: return
    val path = requestLine.getOrNull(1) ?: return
    if (method != "GET" && method != "HEAD") return status(out, 405, "Method Not Allowed")

    // `/<token>/<key>`, and nothing else is a path this server knows.
    val parts = path.trim('/').split('/')
    if (parts.size != 2 || parts[0] != token) return status(out, 404, "Not Found")
    when (val entry = entries[parts[1]] ?: return status(out, 404, "Not Found")) {
      is Entry.Remote -> relay(method, lines, entry, out)
      is Entry.Local -> serveFile(method, lines, entry, out)
    }
  }

  /**
   * Fetches the server's URL with the profile's headers on and hands the answer
   * on as it came: the status, the type, the length when the server gave one,
   * and the byte range if the renderer asked for one and the server honoured
   * it. A transcoded stream has no length and no ranges, and the renderer is
   * told exactly that rather than promised bytes it cannot seek to.
   */
  private fun relay(method: String, lines: List<String>, entry: Entry.Remote, out: OutputStream) {
    val connection =
      try {
        (URL(entry.url).openConnection() as HttpURLConnection).apply {
          requestMethod = method
          connectTimeout = REQUEST_TIMEOUT_MS
          readTimeout = RELAY_READ_TIMEOUT_MS
          // Not followed: a redirect to another host would carry the
          // profile's headers there. A 3xx is answered as a 502 below.
          instanceFollowRedirects = false
          for ((name, value) in entry.headers) setRequestProperty(name, value)
          lines.firstOrNull { it.startsWith("range:", ignoreCase = true) }?.let {
            setRequestProperty("Range", it.substringAfter(':').trim())
          }
        }
      } catch (_: Exception) {
        return status(out, 502, "Bad Gateway")
      }
    try {
      val code =
        try {
          connection.responseCode
        } catch (_: Exception) {
          return status(out, 502, "Bad Gateway")
        }
      if (code < 200 || code >= 300 && code != 304) {
        // The server's own refusal, passed on: a wrong header is a 401 or a
        // 403 from the proxy, and a renderer told so gives up the same way it
        // would have been given up on by the server directly.
        return status(out, if (code in 400..599) code else 502, connection.responseMessage ?: "Error")
      }
      val length = connection.getHeaderField("Content-Length")?.trim()?.toLongOrNull()
      val ranges = code == 206 || connection.getHeaderField("Accept-Ranges")?.contains("bytes", ignoreCase = true) == true
      writeHead(
        out,
        code,
        connection.responseMessage ?: if (code == 206) "Partial Content" else "OK",
        connection.contentType ?: "application/octet-stream",
        length,
        connection.getHeaderField("Content-Range"),
        ranges,
      )
      if (method == "HEAD") {
        out.flush()
        return
      }
      connection.inputStream.use { body ->
        val buffer = ByteArray(COPY_BUFFER)
        while (true) {
          val read = body.read(buffer)
          if (read < 0) break
          out.write(buffer, 0, read)
        }
      }
      out.flush()
    } finally {
      connection.disconnect()
    }
  }

  private fun serveFile(method: String, lines: List<String>, entry: Entry.Local, out: OutputStream) {
    val pfd =
      try {
        ctx.contentResolver.openFileDescriptor(Uri.parse(entry.uri), "r")
      } catch (_: Exception) {
        null
      } ?: return status(out, 404, "Not Found")

    ParcelFileDescriptor.AutoCloseInputStream(pfd).use { file ->
      val total = pfd.statSize
      // A stream with no length is not something a renderer can be told about:
      // it asks for byte ranges, and there is nothing to range over.
      if (total < 0) return status(out, 500, "Internal Server Error")

      val range = parseRange(lines, total)
      // Only a byte range this server should have understood earns a refusal.
      // Anything else it cannot read is a header to ignore, not a reason to
      // turn the request down: a renderer told 416 gives up, and the file was
      // there to be served whole all along.
      val askedBytes =
        lines.any {
          it.startsWith("range:", ignoreCase = true) &&
            it.substringAfter(':').trim().startsWith("bytes=", ignoreCase = true)
        }
      if (range == null && askedBytes) {
        // Asked for a range that is not in the file. The header is what says
        // how long it actually is, which is how a renderer corrects itself.
        writeHead(
          out,
          416,
          "Requested Range Not Satisfiable",
          entry.mime,
          0,
          "bytes */$total",
        )
        out.flush()
        return
      }

      val start = range?.first ?: 0L
      val end = range?.second ?: (total - 1)
      val length = end - start + 1
      writeHead(
        out,
        if (range != null) 206 else 200,
        if (range != null) "Partial Content" else "OK",
        entry.mime,
        length,
        if (range != null) "bytes $start-$end/$total" else null,
      )
      if (method == "HEAD") {
        out.flush()
        return
      }
      file.channel.position(start)
      copy(file, out, length)
      out.flush()
    }
  }

  /** Reads up to the blank line that ends the request headers. */
  private fun readHead(input: InputStream): String? {
    val buffer = StringBuilder()
    var last = 0
    while (buffer.length < MAX_HEAD_BYTES) {
      val b = input.read()
      if (b < 0) return null
      buffer.append(b.toChar())
      if (b == '\n'.code && last == '\n'.code) break
      if (b != '\r'.code) last = b
    }
    return buffer.toString()
  }

  /**
   * `Range: bytes=start-end`, resolved against the real length. Only the single
   * range form, which is the only one anything asks a music file for.
   */
  private fun parseRange(lines: List<String>, total: Long): Pair<Long, Long>? {
    val header =
      lines.firstOrNull { it.startsWith("range:", ignoreCase = true) }?.substringAfter(':')?.trim()
        ?: return null
    if (!header.startsWith("bytes=", ignoreCase = true)) return null
    val spec = header.substring("bytes=".length).substringBefore(',').trim()
    val dash = spec.indexOf('-')
    if (dash < 0) return null
    val fromText = spec.substring(0, dash).trim()
    val toText = spec.substring(dash + 1).trim()
    val start: Long
    val end: Long
    if (fromText.isEmpty()) {
      // `bytes=-500`: the last 500 bytes.
      val fromEnd = toText.toLongOrNull() ?: return null
      if (fromEnd <= 0) return null
      start = maxOf(0L, total - fromEnd)
      end = total - 1
    } else {
      start = fromText.toLongOrNull() ?: return null
      end = if (toText.isEmpty()) total - 1 else (toText.toLongOrNull() ?: return null)
    }
    if (start < 0 || start > end || start >= total) return null
    return Pair(start, minOf(end, total - 1))
  }

  /** [length] null is a body that ends when the connection does: a relayed
   *  stream the server itself did not measure. */
  private fun writeHead(
    out: OutputStream,
    code: Int,
    reason: String,
    mime: String,
    length: Long?,
    contentRange: String?,
    ranges: Boolean = true,
  ) {
    val head = StringBuilder()
    head.append("HTTP/1.1 $code $reason\r\n")
    head.append("Content-Type: $mime\r\n")
    if (length != null) head.append("Content-Length: $length\r\n")
    if (ranges) head.append("Accept-Ranges: bytes\r\n")
    if (contentRange != null) head.append("Content-Range: $contentRange\r\n")
    // What a DLNA renderer reads to decide it may seek: OP=01 says byte ranges
    // are answered, which is the difference between a progress bar that works
    // and a speaker that refuses the file outright. OP=00 for a relayed stream
    // the server will not range over, so the renderer does not try.
    head.append("transferMode.dlna.org: Streaming\r\n")
    head.append(
      "contentFeatures.dlna.org: DLNA.ORG_OP=${if (ranges) "01" else "00"};DLNA.ORG_CI=0;" +
        "DLNA.ORG_FLAGS=01700000000000000000000000000000\r\n",
    )
    // One request per connection: keeping them alive would mean reading the
    // next request off a socket a renderer has usually already abandoned.
    head.append("Connection: close\r\n\r\n")
    out.write(head.toString().toByteArray())
  }

  private fun status(out: OutputStream, code: Int, reason: String) {
    writeHead(out, code, reason, "text/plain", 0, null)
    out.flush()
  }

  private fun copy(input: InputStream, out: OutputStream, length: Long) {
    val buffer = ByteArray(COPY_BUFFER)
    var left = length
    while (left > 0) {
      val want = if (left < buffer.size) left.toInt() else buffer.size
      val read = input.read(buffer, 0, want)
      if (read <= 0) return
      out.write(buffer, 0, read)
      left -= read
    }
  }

  /**
   * This phone's address on the network the renderer is on. Site-local IPv4
   * only: a speaker is asked to open this URL, and it can only follow one that
   * means something from where it stands.
   */
  private fun lanAddress(): String? {
    val interfaces =
      try {
        Collections.list(NetworkInterface.getNetworkInterfaces())
      } catch (_: Exception) {
        return null
      }
    for (iface in interfaces) {
      val usable =
        try {
          iface.isUp && !iface.isLoopback
        } catch (_: Exception) {
          false
        }
      if (!usable) continue
      for (address in Collections.list(iface.inetAddresses)) {
        if (address is Inet4Address && !address.isLoopbackAddress && address.isSiteLocalAddress) {
          return address.hostAddress
        }
      }
    }
    return null
  }

  private companion object {
    const val REQUEST_TIMEOUT_MS = 15000
    /** A server transcoding on the fly can go quiet for a while between chunks. */
    const val RELAY_READ_TIMEOUT_MS = 60000
    const val MAX_HEAD_BYTES = 8192
    const val COPY_BUFFER = 64 * 1024
  }
}
