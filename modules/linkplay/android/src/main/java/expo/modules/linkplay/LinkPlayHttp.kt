package expo.modules.linkplay

import java.io.ByteArrayInputStream
import java.net.HttpURLConnection
import java.net.URL
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import javax.net.ssl.HostnameVerifier
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLSession
import javax.net.ssl.X509TrustManager

/**
 * The LinkPlay HTTP API (`httpapi.asp?command=…`), as a WiiM serves it: over
 * HTTPS only, with one self-signed certificate shared by every device, issued
 * to www.linkplay.com and not to the speaker's address. No ordinary client
 * accepts that, and no ordinary client should: trusting it means trusting
 * this one certificate and nothing else. That is what is done here, and the
 * name check, which cannot pass, is replaced by the same test: the peer must
 * present exactly this certificate.
 */
object LinkPlayHttp {
  private const val PEM = """
-----BEGIN CERTIFICATE-----
MIIEATCCAumgAwIBAgIJAIis2nWA+bRbMA0GCSqGSIb3DQEBCwUAMIGWMQswCQYD
VQQGEwJDTjERMA8GA1UECAwIU2hhbmdoYWkxETAPBgNVBAcMCFNoYW5naGFpMREw
DwYDVQQKDAhsaW5rcGxheTERMA8GA1UECwwIbGlua3BsYXkxGTAXBgNVBAMMEHd3
dy5saW5rcGxheS5jb20xIDAeBgkqhkiG9w0BCQEWEW1haWxAbGlua3BsYXkuY29t
MB4XDTE4MTExNDEyMjQxOFoXDTI4MTExMTEyMjQxOFowgZYxCzAJBgNVBAYTAkNO
MREwDwYDVQQIDAhTaGFuZ2hhaTERMA8GA1UEBwwIU2hhbmdoYWkxETAPBgNVBAoM
CGxpbmtwbGF5MREwDwYDVQQLDAhsaW5rcGxheTEZMBcGA1UEAwwQd3d3Lmxpbmtw
bGF5LmNvbTEgMB4GCSqGSIb3DQEJARYRbWFpbEBsaW5rcGxheS5jb20wggEiMA0G
CSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQCvHA4cinJAj3gkUcna4kdDpKwccNxW
gO44VHAKe8DjfOkvjTEx8lgS+jNp+OMk4KP80Koi+bX7CYlOOqcFdkh+Dr95CGou
hnjM0tR++8vkQWDHY+bLqgogJ7OBhxMPMA0rsUOUEPT79peY0fMhNHHVG2U2zJNY
DpWJ0dwl+l0AQoYaImeau1uR2k/5Qc5dNsMAUhrEFsbniIL+3dpNL4UNlSR6pPwj
ibK1uvap3mXs+35BcbUrccrdIC7RQ1YIP04kbM62MjrJ/dRrS+iivlef8/CtNGNr
lhY1iU2xhu/wsG5VCBzhO6SvZ0O+cfTOQwUbVjMmr66bQ8ADKl0x5KufAgMBAAGj
UDBOMB0GA1UdDgQWBBSIHFMV2yDQ7LubyjX+62oSUnQw7TAfBgNVHSMEGDAWgBSI
HFMV2yDQ7LubyjX+62oSUnQw7TAMBgNVHRMEBTADAQH/MA0GCSqGSIb3DQEBCwUA
A4IBAQBNKB648BV9NN0lr8PCIJBPZIETSds6/itsVVOuoW6hEGhzmHT533vMZ8hA
If4F3M8SHyXe8SKpdSHbnKoVMdjq/hyRJ9xcuzTJghQUfZeq4q6OQn9ehRekmXjU
XoEDbqyRfmqLaN3dwO5ODiFDbHl+sT1GQK70ILx6rI52cDWz6jeenQZ2KtToiATx
1DIMc8Rh6Dh+aIre6XYVbrOXbMqPeMrldDTAoW4El6Tcqq8Mwrif79bVNc1QDOoi
qLJgrk4gu5WEuFWv55MaV6/1pLzqkbYau6XKUV9zo8f8sG0NDih3wYeWgJvzQtRF
6k4Qk0aDsTJD1n7GOwMZwgpE8FHN
-----END CERTIFICATE-----
"""
  private const val TIMEOUT_MS = 6_000

  private val pinned: X509Certificate by lazy {
    CertificateFactory.getInstance("X.509")
      .generateCertificate(ByteArrayInputStream(PEM.trim().toByteArray())) as X509Certificate
  }

  private val trust = object : X509TrustManager {
    override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) =
      throw java.security.cert.CertificateException("No client certificates here")

    override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) {
      if (chain.isEmpty() || !chain[0].encoded.contentEquals(pinned.encoded)) {
        throw java.security.cert.CertificateException("Not the LinkPlay certificate")
      }
    }

    override fun getAcceptedIssuers(): Array<X509Certificate> = arrayOf(pinned)
  }

  private val verifier = HostnameVerifier { _: String, session: SSLSession ->
    runCatching {
      val peer = session.peerCertificates.firstOrNull() as? X509Certificate
      peer != null && peer.encoded.contentEquals(pinned.encoded)
    }.getOrDefault(false)
  }

  private val sslContext: SSLContext by lazy {
    SSLContext.getInstance("TLS").apply { init(null, arrayOf(trust), null) }
  }

  /** One command to one device; the body as the device answers it. */
  fun call(host: String, command: String): String {
    // The command goes as it is: the device reads everything after
    // `command=`, colons, slashes and the query of a stream URL included, and
    // encoding any of it is what breaks it. Only what cannot travel in a URL
    // at all is encoded.
    val safe = command.replace(" ", "%20").replace("\n", "")
    val url = URL("https://$host/httpapi.asp?command=$safe")
    val connection = url.openConnection() as HttpsURLConnection
    connection.sslSocketFactory = sslContext.socketFactory
    connection.hostnameVerifier = verifier
    connection.connectTimeout = TIMEOUT_MS
    connection.readTimeout = TIMEOUT_MS
    connection.requestMethod = "GET"
    try {
      val code = connection.responseCode
      val stream = if (code >= HttpURLConnection.HTTP_BAD_REQUEST) connection.errorStream else connection.inputStream
      val body = stream?.bufferedReader()?.use { it.readText() } ?: ""
      if (code >= HttpURLConnection.HTTP_BAD_REQUEST) throw IllegalStateException("HTTP $code")
      return body
    } finally {
      connection.disconnect()
    }
  }
}
