package expo.modules.linkplay

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.util.Log
import kotlinx.coroutines.delay
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull
import java.util.concurrent.CopyOnWriteArrayList
import kotlin.coroutines.resume

/**
 * The devices announcing a service on the local network, by Android's own
 * mDNS (`NsdManager`): what WiiM and every other LinkPlay speaker publish as
 * `_linkplay._tcp`. The system does the multicast, on the network it browses
 * on, which is why this finds a speaker where a raw SSDP search from the app
 * has been known to find nothing.
 *
 * Names arrive first and addresses one resolution at a time, because the
 * system resolves one service at a time and answers "already active" to a
 * second: the browse runs for its whole window, then each name is resolved
 * in turn.
 */
class Mdns(private val context: Context) {
  class Found(val name: String, val host: String, val port: Int)

  suspend fun discover(serviceType: String, timeoutMs: Long): List<Found> {
    val nsd = context.getSystemService(Context.NSD_SERVICE) as? NsdManager ?: return emptyList()
    val seen = CopyOnWriteArrayList<NsdServiceInfo>()
    val listener = object : NsdManager.DiscoveryListener {
      override fun onDiscoveryStarted(serviceType: String) {}
      override fun onDiscoveryStopped(serviceType: String) {}
      override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) { Log.w(TAG, "start failed: $errorCode") }
      override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) {}
      override fun onServiceFound(info: NsdServiceInfo) {
        if (seen.none { it.serviceName == info.serviceName }) seen.add(info)
      }
      override fun onServiceLost(info: NsdServiceInfo) {}
    }
    runCatching { nsd.discoverServices(serviceType, NsdManager.PROTOCOL_DNS_SD, listener) }
      .onFailure { Log.w(TAG, "discover: $it"); return emptyList() }
    try {
      delay(timeoutMs)
    } finally {
      runCatching { nsd.stopServiceDiscovery(listener) }
    }
    val found = mutableListOf<Found>()
    for (info in seen) {
      val resolved = withTimeoutOrNull(RESOLVE_TIMEOUT_MS) { resolve(nsd, info) } ?: continue
      val host = resolved.host?.hostAddress ?: continue
      // An IPv6 address is not one the HTTP API answers on.
      if (host.contains(':')) continue
      found.add(Found(resolved.serviceName, host, resolved.port))
    }
    return found
  }

  @Suppress("DEPRECATION")
  private suspend fun resolve(nsd: NsdManager, info: NsdServiceInfo): NsdServiceInfo? =
    suspendCancellableCoroutine { cont ->
      nsd.resolveService(info, object : NsdManager.ResolveListener {
        override fun onResolveFailed(serviceInfo: NsdServiceInfo, errorCode: Int) {
          if (cont.isActive) cont.resume(null)
        }
        override fun onServiceResolved(serviceInfo: NsdServiceInfo) {
          if (cont.isActive) cont.resume(serviceInfo)
        }
      })
    }

  companion object {
    private const val TAG = "LinkPlay"
    private const val RESOLVE_TIMEOUT_MS = 2_500L
  }
}
