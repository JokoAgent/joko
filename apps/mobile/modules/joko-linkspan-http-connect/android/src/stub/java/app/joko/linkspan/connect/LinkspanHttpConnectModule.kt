package app.joko.linkspan.connect

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class LinkspanHttpConnectModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("LinkspanHttpConnect")
    Function("isAvailable") { false }
    AsyncFunction("request") { _: String, _: Double -> "{\"success\":false,\"code\":\"unavailable\"}" }
    AsyncFunction("dispose") { _: Double -> Unit }
  }
}
