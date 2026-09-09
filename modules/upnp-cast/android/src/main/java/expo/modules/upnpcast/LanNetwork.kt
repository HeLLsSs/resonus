package expo.modules.upnpcast

import android.content.Context
import android.net.ConnectivityManager
import android.net.LinkProperties
import android.net.Network
import android.net.NetworkCapabilities
import android.util.Log
import java.net.HttpURLConnection
import java.net.Inet4Address
import java.net.InetAddress
import java.net.NetworkInterface
import java.net.URL

/**
 * The network the speakers are on, which is not always the one the phone
 * sends on by default.
 *
 * A VPN (Tailscale, say, which is how a lot of self-hosted servers are reached
 * from outside) takes the default route, and a search sent through it never
 * reaches the living room: the multicast goes into the tunnel and the speaker
 * that would have answered is never asked. The same goes for the HTTP that
 * follows, the description and the control calls, on a VPN that carries
 * everything. So the search picks the Wi-Fi (or wired) network itself and
 * binds to it, and every connection to a renderer is opened on that same
 * network, VPN or no VPN.
 *
 * Nor is the first Wi-Fi network the system lists always the right one: a
 * hotspot the phone is sharing, a Wi-Fi Direct link or a carrier's restricted
 * network all carry the Wi-Fi transport and none of them lead to a speaker.
 * The one the phone actually browses on (validated, unrestricted, with an IPv4
 * address) wins, and the others are only fallbacks.
 */
object LanNetwork {
  /** What a search needs to know about the network it goes out on. */
  class Link(
    val network: Network,
    val interfaceName: String?,
    val address: Inet4Address?,
    val prefixLength: Int
  ) {
    val networkInterface: NetworkInterface?
      get() = interfaceName?.let { name -> runCatching { NetworkInterface.getByName(name) }.getOrNull() }

    /** The subnet's directed broadcast address, 192.168.1.255 for a /24. */
    val broadcast: InetAddress?
      get() {
        val bytes = address?.address ?: return null
        if (prefixLength !in 1..31) return null
        val hostBits = 32 - prefixLength
        val mask = (1L shl hostBits) - 1
        var value = 0L
        for (byte in bytes) value = (value shl 8) or (byte.toLong() and 0xff)
        value = value or mask
        return runCatching {
          InetAddress.getByAddress(byteArrayOf(
            (value shr 24).toByte(), (value shr 16).toByte(), (value shr 8).toByte(), value.toByte()
          ))
        }.getOrNull()
      }

    override fun toString(): String =
      "${interfaceName ?: "?"} ${address?.hostAddress ?: "no IPv4"}/$prefixLength"
  }

  /** Chosen by the last search; null when there was nothing to choose from. */
  @Volatile var current: Network? = null

  fun pick(context: Context): Link? = runCatching {
    val manager =
      context.applicationContext.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
    val active = manager.activeNetwork
    @Suppress("DEPRECATION")
    val candidates = manager.allNetworks.mapNotNull { network ->
      val caps = manager.getNetworkCapabilities(network) ?: return@mapNotNull null
      val local = caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) ||
        caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)
      val link = link(network, manager.getLinkProperties(network))
      val score = if (local && !caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN)) {
        (if (caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_RESTRICTED)) 8 else 0) +
          (if (link.address != null) 4 else 0) +
          (if (caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)) 2 else 0) +
          (if (network == active) 1 else 0)
      } else {
        -1
      }
      Log.d(Soap.TAG, "network $link ${describe(caps)}${if (network == active) " active" else ""} score=$score")
      if (score < 0) null else score to link
    }
    val chosen = candidates.maxByOrNull { it.first }?.second
    if (chosen == null) Log.w(Soap.TAG, "no Wi-Fi or wired network to search on, sending on the default route")
    else Log.d(Soap.TAG, "searching on $chosen")
    chosen
  }.onFailure { Log.w(Soap.TAG, "network choice failed: $it") }.getOrNull()

  private fun link(network: Network, properties: LinkProperties?): Link {
    val ipv4 = properties?.linkAddresses?.firstOrNull { it.address is Inet4Address }
    return Link(network, properties?.interfaceName, ipv4?.address as? Inet4Address, ipv4?.prefixLength ?: 0)
  }

  private fun describe(caps: NetworkCapabilities): String {
    val transports = listOf(
      NetworkCapabilities.TRANSPORT_WIFI to "wifi",
      NetworkCapabilities.TRANSPORT_ETHERNET to "ethernet",
      NetworkCapabilities.TRANSPORT_CELLULAR to "cellular",
      NetworkCapabilities.TRANSPORT_VPN to "vpn",
      NetworkCapabilities.TRANSPORT_BLUETOOTH to "bluetooth"
    ).filter { caps.hasTransport(it.first) }.map { it.second }
    val capabilities = listOf(
      NetworkCapabilities.NET_CAPABILITY_INTERNET to "internet",
      NetworkCapabilities.NET_CAPABILITY_VALIDATED to "validated",
      NetworkCapabilities.NET_CAPABILITY_NOT_RESTRICTED to "unrestricted",
      NetworkCapabilities.NET_CAPABILITY_NOT_METERED to "unmetered"
    ).filter { caps.hasCapability(it.first) }.map { it.second }
    return "[${(transports + capabilities).joinToString(" ")}]"
  }

  /** An HTTP connection on the LAN network, or on the default one without it. */
  fun open(url: String): HttpURLConnection {
    val target = URL(url)
    val bound = current?.let { runCatching { it.openConnection(target) }.getOrNull() }
    return (bound ?: target.openConnection()) as HttpURLConnection
  }
}
