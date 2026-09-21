package app.joko.lan

import android.content.Context
import android.net.wifi.WifiManager
import android.os.SystemClock
import android.util.Base64
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.net.DatagramPacket
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.MulticastSocket
import java.net.SocketTimeoutException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

class JokoLanDiscoveryModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("JokoLanDiscovery")

    AsyncFunction("discover") Coroutine {
        queryBase64: String,
        group: String,
        port: Int,
        timeoutMs: Int,
        maximumResponses: Int ->
      withContext(Dispatchers.IO) {
        discover(queryBase64, group, port, timeoutMs, maximumResponses)
      }
    }
  }

  private fun discover(
    queryBase64: String,
    group: String,
    port: Int,
    timeoutMs: Int,
    maximumResponses: Int
  ): List<Map<String, String>> {
    require(port in 1..65_535) { "LAN discovery port is invalid." }
    require(timeoutMs in 100..5_000) { "LAN discovery timeout is invalid." }
    require(maximumResponses in 1..128) { "LAN discovery response limit is invalid." }
    val query = try {
      Base64.decode(queryBase64, Base64.DEFAULT)
    } catch (error: IllegalArgumentException) {
      throw IllegalArgumentException("LAN discovery query is not valid base64.", error)
    }
    require(query.isNotEmpty() && query.size <= MAX_DATAGRAM_BYTES) { "LAN discovery query size is invalid." }
    val address = InetAddress.getByName(group)
    require(address.isMulticastAddress) { "LAN discovery address is not multicast." }

    val context = appContext.reactContext ?: error("The Android application context is unavailable.")
    val wifiManager = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager
    val multicastLock = wifiManager?.createMulticastLock("joko-lan-discovery")?.apply {
      setReferenceCounted(false)
      acquire()
    }
    try {
      MulticastSocket(null).use { socket ->
        socket.reuseAddress = true
        socket.bind(InetSocketAddress(0))
        socket.timeToLive = 1
        socket.send(DatagramPacket(query, query.size, address, port))
        val deadline = SystemClock.elapsedRealtime() + timeoutMs
        val results = mutableListOf<Map<String, String>>()
        val seen = mutableSetOf<String>()
        while (results.size < maximumResponses) {
          val remaining = deadline - SystemClock.elapsedRealtime()
          if (remaining <= 0) break
          socket.soTimeout = remaining.coerceAtMost(Int.MAX_VALUE.toLong()).toInt().coerceAtLeast(1)
          val buffer = ByteArray(MAX_DATAGRAM_BYTES)
          val packet = DatagramPacket(buffer, buffer.size)
          try {
            socket.receive(packet)
          } catch (_: SocketTimeoutException) {
            break
          }
          if (packet.length !in 1..MAX_DATAGRAM_BYTES) continue
          val data = Base64.encodeToString(packet.data.copyOfRange(packet.offset, packet.offset + packet.length), Base64.NO_WRAP)
          val remote = packet.address.hostAddress ?: continue
          if (!seen.add("$remote\u0000$data")) continue
          results.add(mapOf("data" to data, "address" to remote))
        }
        return results
      }
    } finally {
      if (multicastLock?.isHeld == true) multicastLock.release()
    }
  }

  private companion object {
    const val MAX_DATAGRAM_BYTES = 2_048
  }
}
