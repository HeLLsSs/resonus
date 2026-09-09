package expo.modules.upnpcast

import android.util.Xml
import org.xmlpull.v1.XmlPullParser
import java.io.StringReader
import java.net.URL

class DeviceDescription private constructor(
  val friendlyName: String?,
  val modelName: String?,
  val manufacturer: String?,
  val udn: String?,
  private val urlBase: String?,
  private val location: String,
  private val services: List<Service>
) {
  data class Service(val type: String, val controlUrl: String)

  /**
   * Any version of the service will do: a renderer declaring `AVTransport:2`
   * is driven the same way, and the sub-devices of a `<deviceList>` are
   * searched along with the root.
   */
  fun controlUrl(serviceType: String): String? {
    val family = serviceType.substringBeforeLast(':')
    val service = services.firstOrNull { it.type.trim().startsWith(family, ignoreCase = true) }
      ?: return null
    if (service.controlUrl.isEmpty()) return null
    val base = urlBase?.takeIf { it.isNotEmpty() } ?: location
    return runCatching { URL(URL(base), service.controlUrl).toString() }.getOrNull()
  }

  val isRenderer: Boolean get() = controlUrl(Services.AV_TRANSPORT) != null

  val isSonos: Boolean
    get() = manufacturer?.contains("Sonos", ignoreCase = true) == true ||
      modelName?.contains("Sonos", ignoreCase = true) == true

  fun displayName(): String? = friendlyName?.takeIf { it.isNotBlank() }

  val isTv: Boolean
    get() = listOfNotNull(friendlyName, modelName).any { name ->
      TV_HINTS.any { name.contains(it, ignoreCase = true) }
    }

  companion object {
    private val TV_HINTS = listOf("TV", "Television", "Bravia", "Chromecast", "Roku", "Fire", "Kodi")

    fun parse(xml: String, location: String): DeviceDescription? {
      var friendlyName: String? = null
      var modelName: String? = null
      var manufacturer: String? = null
      var udn: String? = null
      var urlBase: String? = null
      val services = mutableListOf<Service>()

      var serviceType: String? = null
      var controlUrl: String? = null
      var inService = false

      try {
        val parser = Xml.newPullParser()
        parser.setFeature(XmlPullParser.FEATURE_PROCESS_NAMESPACES, false)
        parser.setInput(StringReader(xml))
        var event = parser.eventType
        while (event != XmlPullParser.END_DOCUMENT) {
          if (event == XmlPullParser.START_TAG) {
            when (parser.name.substringAfter(':').lowercase()) {
              "service" -> {
                inService = true
                serviceType = null
                controlUrl = null
              }
              "friendlyname" -> friendlyName = friendlyName ?: parser.nextText().trim()
              "modelname" -> modelName = modelName ?: parser.nextText().trim()
              "manufacturer" -> manufacturer = manufacturer ?: parser.nextText().trim()
              "udn" -> udn = udn ?: parser.nextText().trim().removePrefix("uuid:")
              "urlbase" -> urlBase = urlBase ?: parser.nextText().trim()
              "servicetype" -> if (inService) serviceType = parser.nextText().trim()
              "controlurl" -> if (inService) controlUrl = parser.nextText().trim()
            }
          } else if (
            event == XmlPullParser.END_TAG &&
            parser.name.substringAfter(':').equals("service", ignoreCase = true)
          ) {
            inService = false
            val type = serviceType
            val url = controlUrl
            if (type != null && url != null) services.add(Service(type, url))
          }
          event = parser.next()
        }
      } catch (_: Exception) {
        return null
      }

      return DeviceDescription(
        friendlyName,
        modelName,
        manufacturer,
        udn,
        urlBase,
        location,
        services
      )
    }
  }
}
