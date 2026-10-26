package app.joko.linkspan.connect

import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

class LinkspanHttpConnectModule : Module() {
  private val lock = Any()
  private var engine: LinkspanHttpConnectEngine? = null
  private var destroyed = false
  private var generation = 0.0
  private fun current(expected: Double, create: Boolean): LinkspanHttpConnectEngine? = synchronized(lock) {
    if (destroyed || expected != generation) null else engine ?: if (!create) null else LinkspanHttpConnectEngine().also { engine = it }
  }
  private fun retire(next: Double? = null, destroy: Boolean = false) {
    val previous = synchronized(lock) {
      if (next != null) {
        if (!next.isFinite() || next < generation || next % 1.0 != 0.0) return
        generation = next
      }
      if (destroy) { destroyed = true; generation += 1.0 }
      engine.also { engine = null }
    }
    previous?.dispose()
  }
  override fun definition() = ModuleDefinition {
    Name("LinkspanHttpConnect")
    Function("isAvailable") { synchronized(lock) { !destroyed } }
    AsyncFunction("request") Coroutine { json: String, occurrence: Double ->
      if (json.length > 800000) "{\"success\":false,\"code\":\"resource_exhausted\"}"
      else {
        val method = runCatching { org.json.JSONObject(json).optString("method") }.getOrNull()
        // A pool full of blocking reads/writes must never queue cancellation
        // behind those same operations. Socket.close releases their OS waits.
        withContext(if (method == "abort" || method == "close") Dispatchers.Default else Dispatchers.IO) {
          current(occurrence, method == "connect")?.request(json) ?: "{\"success\":false,\"code\":\"closed\"}"
        }
      }
    }
    AsyncFunction("dispose") Coroutine { occurrence: Double -> withContext(Dispatchers.Default) { retire(occurrence) }; Unit }
    OnDestroy { runCatching { retire(destroy = true) } }
  }
}
