package app.joko.linkspan.connect

import java.net.InetSocketAddress
import java.net.Proxy
import java.net.Socket
import java.net.SocketTimeoutException
import java.net.URI
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import javax.net.ssl.SNIHostName
import javax.net.ssl.SSLException
import javax.net.ssl.SSLSocket
import javax.net.ssl.SSLSocketFactory
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.withTimeout
import org.json.JSONArray
import org.json.JSONObject

/** TCP or system-verified proxy TLS. No CONNECT, Noise, or business authentication here. */
class LinkspanHttpConnectEngine {
  private class SafeError(val code: String) : Exception()
  private class Entry(val socket: Socket) {
    val reading = AtomicBoolean(false)
    @Volatile var failure: String? = null
    var opened = false
    var closing = false
    var write: CompletableDeferred<Unit>? = null
  }
  private data class Location(val origin: String, val host: String, val port: Int, val tls: Boolean)
  private val lock = Any()
  private val streams = HashMap<String, Entry>()
  private val deadlines = Executors.newSingleThreadScheduledExecutor { task -> Thread(task, "joko-proxy-deadline").apply { isDaemon = true } }
  private var disposed = false

  suspend fun request(json: String): String {
    var id: String? = null
    var method: String? = null
    return try {
      if (json.length > 800000) throw SafeError("resource_exhausted")
      val row = JSONObject(json)
      id = row.optString("streamId"); method = row.optString("method")
      if (row.opt("streamId") !is String || !Regex("^[a-f0-9]{32}$").matches(id) || row.keys().asSequence().any { it !in listOf("method", "streamId", "args") }
        || method !in listOf("connect", "write") && row.has("args")) throw SafeError("invalid_argument")
      synchronized(lock) { if (disposed) throw SafeError("closed") }
      val value: Any? = when (method) {
        "connect" -> connect(id, location(row.optJSONObject("args") ?: throw SafeError("invalid_argument")))
        "read" -> read(id)
        "write" -> { write(id, bytes(row.optJSONArray("args") ?: throw SafeError("invalid_argument"))); null }
        "close" -> { close(id); null }
        "abort" -> { take(id, "cancelled"); null }
        else -> throw SafeError("invalid_argument")
      }
      JSONObject().put("success", true).put("value", value ?: JSONObject.NULL).toString()
    } catch (error: Exception) {
      val code = when (error) {
        is SafeError -> error.code
        is SocketTimeoutException, is TimeoutCancellationException -> "deadline_exceeded"
        is SSLException -> "authentication_failed"
        is org.json.JSONException, is IllegalArgumentException -> "invalid_argument"
        else -> "transport_error"
      }
      if (id != null && method in listOf("connect", "read", "write", "close")) take(id, code)
      JSONObject().put("success", false).put("code", code).toString()
    }
  }
  private fun location(row: JSONObject): Location {
    if (row.length() != 1 || !row.has("proxyOrigin")) throw SafeError("invalid_argument")
    val origin = row.getString("proxyOrigin")
    if (origin.length !in 1..2048 || origin.any { it.code <= 32 || it.code >= 127 }) throw SafeError("invalid_argument")
    val uri = URI(origin)
    val scheme = uri.scheme
    if (scheme !in listOf("http", "https") || uri.rawUserInfo != null || !uri.rawPath.isNullOrEmpty() || uri.rawQuery != null || uri.rawFragment != null) throw SafeError("invalid_argument")
    val host = uri.host?.removeSurrounding("[", "]") ?: throw SafeError("invalid_argument")
    val standard = if (scheme == "https") 443 else 80
    val port = if (uri.port == -1) standard else uri.port
    val authority = if (host.contains(':')) "[$host]" else host
    if (host.isEmpty() || host != host.lowercase(java.util.Locale.ROOT) || port !in 1..65535 || origin != "$scheme://$authority${if (port == standard) "" else ":$port"}") throw SafeError("invalid_argument")
    return Location(origin, host, port, scheme == "https")
  }
  private fun socket(location: Location): Socket {
    if (!location.tls) return Socket(Proxy.NO_PROXY)
    return (SSLSocketFactory.getDefault().createSocket() as SSLSocket).apply {
      sslParameters = sslParameters.apply {
        endpointIdentificationAlgorithm = "HTTPS"
        if (!location.host.contains(':') && !Regex("^[0-9.]+$").matches(location.host)) serverNames = listOf(SNIHostName(location.host))
      }
    }
  }
  private fun connect(id: String, location: Location): JSONObject {
    val entry = Entry(socket(location))
    synchronized(lock) {
      if (disposed || streams.containsKey(id) || streams.size >= 32) {
        entry.socket.close(); throw SafeError(if (disposed) "closed" else if (streams.containsKey(id)) "invalid_argument" else "resource_exhausted")
      }
      streams[id] = entry
    }
    val timeout = deadlines.schedule({ take(id, "deadline_exceeded", entry) }, 30, TimeUnit.SECONDS)
    try {
      val address = InetSocketAddress(location.host, location.port)
      current(id, entry)
      entry.socket.connect(address, 30000)
      entry.socket.tcpNoDelay = true
      if (entry.socket is SSLSocket) { entry.socket.soTimeout = 30000; entry.socket.startHandshake(); entry.socket.soTimeout = 0 }
      synchronized(lock) { current(id, entry); entry.opened = true }
      // This identifies only the selected locator; Noise authenticates the node.
      return JSONObject().put("remoteEndpointId", location.origin)
    } catch (error: Exception) {
      val failure = entry.failure
      if (failure != null) throw SafeError(failure)
      throw error
    } finally { timeout.cancel(false) }
  }
  private fun current(id: String, entry: Entry) {
    synchronized(lock) {
      entry.failure?.let { throw SafeError(it) }
      if (disposed || streams[id] !== entry || entry.closing) throw SafeError("closed")
    }
  }
  private fun read(id: String): Any? {
    val entry = synchronized(lock) { streams[id]?.also { if (!it.opened || it.closing) throw SafeError("closed") } } ?: throw SafeError("closed")
    if (!entry.reading.compareAndSet(false, true)) throw SafeError("resource_exhausted")
    try {
      val buffer = ByteArray(65536)
      val size = try { entry.socket.getInputStream().read(buffer) } catch (error: Exception) {
        if (entry.failure == "closed") return null
        entry.failure?.let { throw SafeError(it) }; throw error
      }
      return if (size < 0) null else JSONArray().apply { for (index in 0 until size) put(buffer[index].toInt() and 255) }
    } finally { entry.reading.set(false) }
  }
  private fun write(id: String, bytes: ByteArray) {
    val completed = CompletableDeferred<Unit>()
    val entry = synchronized(lock) {
      val value = streams[id] ?: throw SafeError("closed")
      if (!value.opened || value.closing) throw SafeError("closed")
      if (value.write != null) throw SafeError("resource_exhausted")
      value.write = completed; value
    }
    try { entry.socket.getOutputStream().write(bytes) }
    catch (error: Exception) { entry.failure?.let { throw SafeError(it) }; throw error }
    finally { synchronized(lock) { if (entry.write === completed) entry.write = null }; completed.complete(Unit) }
  }
  private suspend fun close(id: String) {
    val selected = synchronized(lock) { streams[id]?.also { it.closing = true } }
    if (selected == null) return
    try { withTimeout(30000) { synchronized(lock) { selected.write }?.await() } }
    finally { take(id, "closed", selected, reportFailure = true) }
  }
  private fun take(id: String, code: String, expected: Entry? = null, reportFailure: Boolean = false) {
    val entry = synchronized(lock) {
      val value = streams[id] ?: return
      if (expected != null && value !== expected) return
      streams.remove(id); value.failure = code; value
    }
    try { entry.socket.close() } catch (_: Exception) { if (reportFailure) throw SafeError("transport_error") }
  }
  private fun bytes(array: JSONArray): ByteArray {
    if (array.length() > 131072) throw SafeError("resource_exhausted")
    return ByteArray(array.length()) { index ->
      val value = array.get(index)
      if (value !is Number || value.toDouble() != value.toInt().toDouble() || value.toInt() !in 0..255) throw SafeError("invalid_argument")
      value.toInt().toByte()
    }
  }
  fun dispose() {
    val previous = synchronized(lock) { disposed = true; streams.toMap().also { streams.clear() } }
    var failed = false
    previous.values.forEach { entry -> entry.failure = "closed"; try { entry.socket.close() } catch (_: Exception) { failed = true } }
    deadlines.shutdownNow()
    if (failed) throw SafeError("transport_error")
  }
}
