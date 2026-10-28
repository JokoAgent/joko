package app.joko.pluginoauth

import java.io.ByteArrayOutputStream
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.URI
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
internal data class PluginOauthRequest(val id: String, val callbackUrl: String, val state: String, val expiresAt: Long, val port: Int, val path: String) {
  val host get() = "127.0.0.1:$port"
  companion object {
    fun fromOptions(options: Map<String, Any>, now: Long = System.currentTimeMillis()): PluginOauthRequest {
      require(options.keys == setOf("id", "callbackUrl", "state", "expiresAt"))
      val id = options["id"] as? String ?: error("invalid")
      val state = options["state"] as? String ?: error("invalid")
      val url = options["callbackUrl"] as? String ?: error("invalid")
      val expiry = (options["expiresAt"] as? Number)?.toDouble() ?: error("invalid")
      require(id.matches(Regex("^[A-Za-z0-9_-]{16,128}$")) && state.matches(Regex("^[A-Za-z0-9._~-]{16,512}$")))
      require(expiry.isFinite() && expiry % 1.0 == 0.0 && expiry > now && expiry <= now + 600_000)
      require(url.length <= 300)
      val callback = URI(url)
      require(callback.scheme == "http" && callback.host == "127.0.0.1" && callback.port in 1024..65535)
      require(callback.rawUserInfo == null && callback.rawQuery == null && callback.rawFragment == null)
      val path = callback.rawPath ?: error("invalid")
      require(path.length <= 256 && path.matches(Regex("^/[A-Za-z0-9._~/-]*$")))
      require(url == "http://127.0.0.1:${callback.port}$path")
      return PluginOauthRequest(id, url, state, expiry.toLong(), callback.port, path)
    }
  }
  fun parse(bytes: ByteArray, now: Long = System.currentTimeMillis()): Map<String, String>? = try {
    require(now < expiresAt && bytes.size <= 16_384)
    val text = Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString()
    require(text.endsWith("\r\n\r\n") && text.indexOf("\r\n\r\n") == text.length - 4)
    val lines = text.dropLast(4).split("\r\n")
    val request = lines[0].split(' ')
    require(request.size == 3 && request[0] == "GET" && request[2] in listOf("HTTP/1.0", "HTTP/1.1"))
    require(request[1].length <= 8192 && request[1].startsWith("$path?"))
    val url = URI("http://$host${request[1]}")
    require(url.rawPath == path && url.rawFragment == null)
    val headers = mutableMapOf<String, String>()
    lines.drop(1).forEach { line ->
      val colon = line.indexOf(':'); require(colon > 0)
      val key = line.substring(0, colon).lowercase()
      require(key.matches(Regex("^[!#$%&'*+.^_`|~a-z0-9-]+$")) && !headers.containsKey(key))
      headers[key] = line.substring(colon + 1).trim()
    }
    require(headers["host"] == host && !headers.containsKey("origin") && !headers.containsKey("transfer-encoding"))
    require(headers["content-length"] == null || headers["content-length"] == "0")
    val params = mutableMapOf<String, String>()
    (url.rawQuery ?: "").split('&').forEach { item ->
      val pieces = item.split('=', limit = 2); require(pieces.size == 2)
      val key = decode(pieces[0])
      val value = decode(pieces[1])
      require(!params.containsKey(key) && value.toByteArray().size <= 4096); params[key] = value
    }
    require(params["state"] == state && (params.containsKey("code") != params.containsKey("error")))
    val key = if (params.containsKey("code")) "code" else "error"
    val value = requireNotNull(params[key])
    require(value.isNotEmpty() && value.none { it.code < 32 || it.code == 127 })
    require(key != "error" || value.matches(Regex("^[A-Za-z0-9_.-]{1,128}$")))
    mapOf("state" to state, key to value)
  } catch (_: Exception) { null }
  private fun decode(value: String): String {
    val bytes = ByteArrayOutputStream(); var index = 0
    while (index < value.length) {
      val character = value[index]
      if (character == '%') {
        require(index + 2 < value.length)
        val high = value[index + 1].digitToIntOrNull(16)
        val low = value[index + 2].digitToIntOrNull(16)
        require(high != null && low != null); bytes.write(high * 16 + low); index += 3
      } else { require(character.code <= 127); bytes.write(if (character == '+') 32 else character.code); index++ }
    }
    return Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes.toByteArray())).toString()
  }
}

internal class PluginOauthReceiver(private val request: PluginOauthRequest) {
  private val socket = ServerSocket()
  private val worker = Executors.newScheduledThreadPool(2)
  private var activeClient: Socket? = null
  private var pending: Pair<(Map<String, String>) -> Unit, () -> Unit>? = null
  private var result: Map<String, String>? = null
  private var closed = false
  private var consumed = false
  init {
    try {
      socket.reuseAddress = false
      socket.bind(InetSocketAddress(InetAddress.getByName("127.0.0.1"), request.port), 8)
      socket.soTimeout = 1000
    } catch (error: Exception) { socket.close(); worker.shutdownNow(); throw error }
  }
  fun start() {
    worker.schedule({ close() }, (request.expiresAt - System.currentTimeMillis()).coerceAtLeast(1), TimeUnit.MILLISECONDS)
    worker.execute {
      try {
        while (status() == "waiting") {
          try { socket.accept().use { client -> receive(client) } }
          catch (_: Exception) { /* No request bytes or callback values enter diagnostics. */ }
        }
      } finally { worker.shutdown() }
    }
  }
  private fun receive(client: Socket) {
    synchronized(this) { if (closed) return; activeClient = client }
    try {
      val deadline = minOf(request.expiresAt, System.currentTimeMillis() + 5_000)
      val input = client.getInputStream()
      val bytes = ByteArrayOutputStream(); var complete = false
      var tail = 0
      while (bytes.size() < 16_384) {
        val remaining = deadline - System.currentTimeMillis(); if (remaining <= 0) break
        client.soTimeout = remaining.coerceAtMost(5_000).toInt()
        val byte = input.read(); if (byte < 0) break
        bytes.write(byte); tail = (tail shl 8) or byte
        if (tail == 0x0D0A0D0A) { complete = true; break }
      }
      val value = if (complete) request.parse(bytes.toByteArray()) else null
      val accepted = synchronized(this) {
        if (value != null && !closed && result == null && System.currentTimeMillis() < request.expiresAt) { result = value; socket.close(); true } else false
      }
      val body = if (accepted) "Authorization received. Return to Joko." else "Invalid callback."
      val response = "HTTP/1.1 ${if (accepted) "200 OK" else "400 Bad Request"}\r\nContent-Type: text/plain; charset=utf-8\r\nCache-Control: no-store\r\nContent-Security-Policy: default-src 'none'\r\nConnection: close\r\nContent-Length: ${body.toByteArray().size}\r\n\r\n$body"
      try { client.getOutputStream().write(response.toByteArray()) }
      finally { synchronized(this) { if (accepted && !closed) { pending?.let { consumed = true; it.first(result!!) }; pending = null } } }
    } finally { synchronized(this) { if (activeClient === client) activeClient = null } }
  }
  @Synchronized fun status(): String {
    if (!closed && System.currentTimeMillis() >= request.expiresAt) close()
    return if (result != null) "received" else if (closed) "closed" else "waiting"
  }
  @Synchronized fun waitForCallback(resolve: (Map<String, String>) -> Unit, reject: () -> Unit) {
    if (status() == "closed" || consumed || pending != null) reject()
    else if (result != null) { consumed = true; resolve(result!!) }
    else pending = Pair(resolve, reject)
  }
  @Synchronized fun close() {
    if (closed) return
    closed = true
    try { socket.close() } catch (_: Exception) { }
    try { activeClient?.close() } catch (_: Exception) { }
    activeClient = null; worker.shutdownNow()
    val rejected = pending; pending = null; result = null; rejected?.second?.invoke()
  }
}
