package app.joko.pluginoauth

import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/** The service owns authorization, PKCE and token exchange. This module owns
 * only one ephemeral receiver and never opens URLs or retains credentials. */
class JokoPluginOauthModule : Module() {
  private val receivers = mutableMapOf<String, PluginOauthReceiver>()
  override fun definition() = ModuleDefinition {
    Name("JokoPluginOauth")
    AsyncFunction("start") { options: Map<String, Any> -> synchronized(receivers) {
      require(receivers.isEmpty()) { "PLUGIN_OAUTH_LISTEN_FAILED" }
      var receiver: PluginOauthReceiver? = null
      try {
        val request = PluginOauthRequest.fromOptions(options)
        val fresh = PluginOauthReceiver(request)
        receiver = fresh
        receivers[request.id] = fresh
        fresh.start()
      } catch (_: Exception) {
        receiver?.let { failed -> receivers.entries.removeAll { it.value === failed }; failed.close() }
        error("PLUGIN_OAUTH_LISTEN_FAILED")
      }
    } }
    AsyncFunction("wait") { id: String, promise: Promise -> synchronized(receivers) {
      val receiver = receivers[id]
      if (receiver == null) promise.reject("PLUGIN_OAUTH_CLOSED", "Authorization listener is closed", null)
      else receiver.waitForCallback({ value -> promise.resolve(value) }, { promise.reject("PLUGIN_OAUTH_CLOSED", "Authorization listener is closed", null) })
    } }
    AsyncFunction("status") { id: String -> synchronized(receivers) { receivers[id]?.status() ?: "closed" } }
    AsyncFunction("close") { id: String -> synchronized(receivers) { receivers.remove(id)?.close(); Unit } }
    OnDestroy { synchronized(receivers) { val active = receivers.values.toList(); receivers.clear(); active.forEach { it.close() } } }
  }
}
