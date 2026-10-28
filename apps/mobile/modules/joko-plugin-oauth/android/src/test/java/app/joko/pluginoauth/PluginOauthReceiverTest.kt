package app.joko.pluginoauth

import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.io.IOException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import org.junit.Assert.*
import org.junit.Test

class PluginOauthReceiverTest {
  private val state = "test_state_0123456789abcdef"
  private fun options(port: Int = 43175, ttl: Long = 30_000) = mapOf<String, Any>("id" to "test_listener_0123456789", "callbackUrl" to "http://127.0.0.1:$port/callback", "state" to state, "expiresAt" to System.currentTimeMillis() + ttl)
  private fun wire(port: Int = 43175, query: String = "state=$state&code=accepted%2Bvalue", headers: String = "") = "GET /callback?$query HTTP/1.1\r\nHost: 127.0.0.1:$port\r\n${headers}\r\n".toByteArray()
  private fun freePort(): Int = ServerSocket(0, 1, InetAddress.getByName("127.0.0.1")).use { it.localPort }
  @Test fun parsesOnlyTheExactLoopbackPathHostStateAndOneBoundedResult() {
    val request = PluginOauthRequest.fromOptions(options())
    assertEquals(mapOf("state" to state, "code" to "accepted+value"), request.parse(wire()))
    assertEquals(mapOf("state" to state, "error" to "access_denied"), request.parse(wire(query = "state=$state&error=access_denied")))
    val rejected = listOf(
      wire(query = "state=wrong&code=code"), wire(query = "state=$state&state=$state&code=code"),
      wire(query = "state=$state&%73tate=$state&code=code"), wire(query = "state=$state&code=a&error=denied"),
      wire(query = "state=$state&code="), wire(query = "state=$state&code=%0Asecret"), wire(query = "state=$state&code=%7F"),
      wire(query = "state=$state&code=%FF"), wire(query = "state=$state&code=%G0"),
      wire(query = "state=$state&error=not%20a%20code"), wire(query = "state=$state&code=${"a".repeat(4097)}"),
      wire(headers = "Origin: https://untrusted.test\r\n"), wire(headers = "Transfer-Encoding: chunked\r\n"),
      wire(headers = "Content-Length: 1\r\n"), wire(headers = "hOsT: 127.0.0.1:43175\r\n"),
      String(wire()).replace("GET /callback?", "POST /callback?").toByteArray(),
      String(wire()).replace("GET /callback?", "GET /different?").toByteArray(),
      String(wire()).replace("Host: 127.0.0.1:43175", "Host: localhost:43175").toByteArray(),
      wire() + byteArrayOf(1), ByteArray(16_385)
    )
    rejected.forEach { assertNull("Invalid request was accepted", request.parse(it)) }
    assertNull(request.parse(wire(), request.expiresAt))
    for (url in listOf("http://localhost:43175/callback", "http://0.0.0.0:43175/callback", "http://[::1]:43175/callback", "https://127.0.0.1:43175/callback", "http://127.0.0.1:80/callback", "http://127.0.0.1:43175/%63allback", "http://127.0.0.1:43175/callback?query=extra")) {
      assertThrows(IllegalArgumentException::class.java) { PluginOauthRequest.fromOptions(options() + ("callbackUrl" to url)) }
    }
    assertThrows(IllegalArgumentException::class.java) { PluginOauthRequest.fromOptions(options() + ("expiresAt" to Double.NaN)) }
    assertThrows(IllegalArgumentException::class.java) { PluginOauthRequest.fromOptions(options() + ("state" to "$state\n")) }
  }
  @Test fun actualSocketDeliversOnceAndNeverEchoesCallbackMaterial() {
    val port = freePort()
    val request = PluginOauthRequest.fromOptions(options(port))
    val receiver = PluginOauthReceiver(request)
    val completed = CountDownLatch(1)
    val result = AtomicReference<Map<String, String>>()
    val rejected = AtomicInteger()
    try {
      receiver.start(); receiver.waitForCallback({ result.set(it); completed.countDown() }, { rejected.incrementAndGet(); completed.countDown() })
      Socket("127.0.0.1", port).use { client ->
        client.soTimeout = 3_000; client.getOutputStream().write(wire(port))
        val response = client.getInputStream().readBytes().toString(Charsets.UTF_8)
        assertTrue(response.startsWith("HTTP/1.1 200 OK")); assertFalse(response.contains(state)); assertFalse(response.contains("accepted+value"))
      }
      assertTrue(completed.await(3, TimeUnit.SECONDS)); assertEquals(0, rejected.get())
      assertEquals(mapOf("state" to state, "code" to "accepted+value"), result.get()); assertEquals("received", receiver.status())
      receiver.waitForCallback({ fail("Callback was consumed twice") }, { rejected.incrementAndGet() }); assertEquals(1, rejected.get())
      receiver.close(); receiver.close(); assertEquals("closed", receiver.status())
    } finally { receiver.close() }
  }
  @Test fun expiryClosesAnIncompleteClientAndSettlesItsWaitExactlyOnce() {
    val port = freePort()
    val receiver = PluginOauthReceiver(PluginOauthRequest.fromOptions(options(port, 1_200)))
    val ended = CountDownLatch(1)
    val rejected = AtomicInteger()
    try {
      receiver.start(); receiver.waitForCallback({ fail("Partial callback was accepted") }, { rejected.incrementAndGet(); ended.countDown() })
      Socket("127.0.0.1", port).use { client ->
        client.soTimeout = 4_000; client.getOutputStream().write("GET /callback?".toByteArray())
        assertTrue(ended.await(4, TimeUnit.SECONDS)); assertEquals("closed", receiver.status())
        val end = try { client.getInputStream().read() } catch (_: IOException) { -1 }
        assertEquals(-1, end)
      }
      receiver.close(); assertEquals(1, rejected.get())
    } finally { receiver.close() }
  }
}
