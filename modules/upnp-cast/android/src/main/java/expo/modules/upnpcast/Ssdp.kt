package expo.modules.upnpcast

import android.content.Context
import android.net.wifi.WifiManager
import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.net.DatagramPacket
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.MulticastSocket
import java.net.SocketTimeoutException
import java.util.concurrent.ConcurrentHashMap

object Ssdp {
  private const val ADDRESS = "239.255.255.250"
  private const val PORT = 1900
  private const val LIMITED_BROADCAST = "255.255.255.255"

  /**
   * Everything (a speaker answers once per service, which is the surest way
   * of hearing it at all), the root devices, and renderers by name for the
   * firmware that only answers to the exact type it was asked for.
   */
  private val TARGETS = listOf(
    "ssdp:all",
    "upnp:rootdevice",
    "urn:schemas-upnp-org:device:MediaRenderer:1"
  )

  /**
   * Asks the network who can play, and listens for `timeoutMs`. Returns each
   * description URL that answered, with the address it answered from.
   *
   * On the LAN network on purpose (see `LanNetwork`), sent from the LAN
   * interface itself and with the Wi-Fi multicast lock held: without it a good
   * many phones, Samsung first of all, drop multicast in the driver to save
   * power, and the search went out from a socket that was never going to hear
   * the whole of the answer. The question is asked three times, a second
   * apart, because it is UDP and a speaker that missed it the first time has
   * no way of knowing there was one; and to the broadcast addresses as well as
   * the multicast group, since some routers filter one and not the other and
   * the speakers answer both.
   *
   * Answers to a search come back unicast to the socket that asked, so that
   * socket is the one read. A second socket on the group's own port picks up
   * the `NOTIFY` a speaker sends of its own accord, for the ones that never
   * heard the question.
   */
  suspend fun discover(context: Context?, timeoutMs: Long): Map<String, String> = withContext(Dispatchers.IO) {
    val found = ConcurrentHashMap<String, String>()
    if (context == null) Log.w(Soap.TAG, "search without a context: no multicast lock and no network choice")
    val lan = context?.let { LanNetwork.pick(it) }
    LanNetwork.current = lan?.network
    val lock = context?.let { multicastLock(it) }
    Log.d(Soap.TAG, "search for $timeoutMs ms, multicast lock ${if (lock != null) "held" else "not held"}")
    val group = InetAddress.getByName(ADDRESS)
    val destinations =
      listOfNotNull(group, InetAddress.getByName(LIMITED_BROADCAST), lan?.broadcast).distinct()
    val deadline = System.currentTimeMillis() + timeoutMs
    val requester = openRequester(lan)
    val listener = openListener(lan, group)
    try {
      coroutineScope {
        if (requester != null) {
          launch { sendRounds(requester, destinations, deadline) }
          launch { readUntil(requester, deadline, found) }
        }
        if (listener != null) launch { readUntil(listener, deadline, found) }
      }
    } finally {
      requester?.close()
      listener?.close()
      lock?.let { runCatching { it.release() } }
    }
    Log.d(Soap.TAG, "search over: ${found.size} description(s) ${found.keys}")
    found
  }

  private fun multicastLock(context: Context): WifiManager.MulticastLock? = runCatching {
    val wifi = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
    wifi.createMulticastLock("resonus-ssdp").apply {
      setReferenceCounted(false)
      acquire()
    }
  }.onFailure { Log.w(Soap.TAG, "multicast lock not acquired: $it") }.getOrNull()

  /**
   * The socket the search goes out from and its answers come back to, bound
   * to the LAN's own address and interface so that neither a VPN nor mobile
   * data gets to carry it.
   */
  private fun openRequester(lan: LanNetwork.Link?): MulticastSocket? = runCatching {
    val bindTo = lan?.address?.let { InetSocketAddress(it, 0) } ?: InetSocketAddress(0)
    MulticastSocket(bindTo).apply {
      lan?.network?.let { network ->
        runCatching { network.bindSocket(this) }
          .onFailure { Log.w(Soap.TAG, "search socket not bound to the network: $it") }
      }
      lan?.networkInterface?.let { iface ->
        runCatching { networkInterface = iface }
          .onFailure { Log.w(Soap.TAG, "multicast interface not set to ${iface.name}: $it") }
      }
      timeToLive = TTL
      broadcast = true
      soTimeout = RECEIVE_SLICE_MS
      Log.d(
        Soap.TAG,
        "search socket ${localAddress.hostAddress}:$localPort via ${lan?.interfaceName ?: "the default interface"}"
      )
    }
  }.onFailure { Log.w(Soap.TAG, "search socket not opened: $it") }.getOrNull()

  /** The group's own port, for the `NOTIFY` speakers send unasked. */
  private fun openListener(lan: LanNetwork.Link?, group: InetAddress): MulticastSocket? = runCatching {
    MulticastSocket(null).apply {
      reuseAddress = true
      bind(InetSocketAddress(PORT))
      val iface = lan?.networkInterface
      joinGroup(InetSocketAddress(group, PORT), iface)
      soTimeout = RECEIVE_SLICE_MS
      Log.d(Soap.TAG, "listening for NOTIFY on $ADDRESS:$PORT via ${iface?.name ?: "the default interface"}")
    }
  }.onFailure { Log.w(Soap.TAG, "not listening for NOTIFY: $it") }.getOrNull()

  private suspend fun sendRounds(socket: MulticastSocket, destinations: List<InetAddress>, deadline: Long) {
    for (round in 1..ROUNDS) {
      if (System.currentTimeMillis() >= deadline) return
      for (target in TARGETS) {
        val request = buildString {
          append("M-SEARCH * HTTP/1.1\r\n")
          append("HOST: $ADDRESS:$PORT\r\n")
          append("MAN: \"ssdp:discover\"\r\n")
          append("MX: $MX_SECONDS\r\n")
          append("ST: $target\r\n")
          append("USER-AGENT: Android UPnP/1.1 Resonus\r\n\r\n")
        }.toByteArray(Charsets.US_ASCII)
        for (destination in destinations) {
          runCatching { socket.send(DatagramPacket(request, request.size, destination, PORT)) }
            .onFailure { Log.w(Soap.TAG, "M-SEARCH $target to ${destination.hostAddress} failed: $it") }
        }
      }
      Log.d(
        Soap.TAG,
        "M-SEARCH round $round/$ROUNDS to ${destinations.joinToString { "${it.hostAddress}:$PORT" }} " +
          "for ${TARGETS.joinToString()}"
      )
      if (round < ROUNDS) delay(ROUND_INTERVAL_MS)
    }
  }

  private fun readUntil(socket: MulticastSocket, deadline: Long, found: MutableMap<String, String>) {
    val buffer = ByteArray(BUFFER_BYTES)
    while (System.currentTimeMillis() < deadline) {
      val packet = DatagramPacket(buffer, buffer.size)
      try {
        socket.receive(packet)
      } catch (_: SocketTimeoutException) {
        continue
      } catch (e: Exception) {
        Log.w(Soap.TAG, "receive on port ${socket.localPort} stopped: $e")
        return
      }
      val address = packet.address?.hostAddress ?: continue
      val message = Message.parse(String(packet.data, 0, packet.length, Charsets.ISO_8859_1)) ?: continue
      if (!message.isReply && !message.isAlive) continue
      val location = message.location
      if (location.isNullOrEmpty()) {
        Log.v(Soap.TAG, "${message.kind} from $address without a location: ${message.headers}")
        continue
      }
      if (found.putIfAbsent(location, address) == null) {
        Log.d(Soap.TAG, "${message.kind} from $address: ${message.headers} location=$location")
      } else {
        Log.v(Soap.TAG, "${message.kind} from $address again: ${message.headers}")
      }
    }
  }

  /**
   * A search answer or a `NOTIFY`, read leniently: header names in any case,
   * and nothing assumed about which ones are there.
   */
  private class Message(private val startLine: String, private val header: Map<String, String>) {
    val isReply: Boolean get() = startLine.startsWith("HTTP/", ignoreCase = true) && startLine.contains(" 200")

    val isAlive: Boolean
      get() = startLine.startsWith("NOTIFY", ignoreCase = true) &&
        header["nts"]?.contains("ssdp:alive", ignoreCase = true) == true

    val kind: String get() = if (isReply) "reply" else "notify"

    val location: String? get() = header["location"]

    val headers: String
      get() = listOf("st", "nt", "usn", "server")
        .mapNotNull { name -> header[name]?.let { "$name=$it" } }
        .joinToString(" ")

    companion object {
      fun parse(text: String): Message? {
        val lines = text.lineSequence().map { it.trim() }.filter { it.isNotEmpty() }.toList()
        val startLine = lines.firstOrNull() ?: return null
        val header = HashMap<String, String>()
        for (line in lines.drop(1)) {
          val colon = line.indexOf(':')
          if (colon <= 0) continue
          header[line.substring(0, colon).trim().lowercase()] = line.substring(colon + 1).trim()
        }
        return Message(startLine, header)
      }
    }
  }

  private const val MX_SECONDS = 3
  private const val ROUNDS = 3
  private const val ROUND_INTERVAL_MS = 1000L
  private const val TTL = 4
  private const val RECEIVE_SLICE_MS = 400
  private const val BUFFER_BYTES = 8192
}
