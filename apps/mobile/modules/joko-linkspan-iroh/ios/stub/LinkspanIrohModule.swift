import ExpoModulesCore

public final class LinkspanIrohModule: Module {
  public func definition() -> ModuleDefinition {
    Name("LinkspanIroh")
    Function("isAvailable") { false }
    AsyncFunction("request") { (_: String) -> String in "{\"success\":false,\"code\":\"unavailable\"}" }
    AsyncFunction("dispose") { }
  }
}
