package app.joko.linkspan

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class LinkspanIrohModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("LinkspanIroh")
    Function("isAvailable") { false }
    AsyncFunction("request") { _: String -> "{\"success\":false,\"code\":\"unavailable\"}" }
    AsyncFunction("dispose") { }
  }
}
