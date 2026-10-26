import ExpoModulesCore

public final class LinkspanHttpConnectModule: Module {
  public func definition() -> ModuleDefinition {
    Name("LinkspanHttpConnect")
    Function("isAvailable") { false }
    AsyncFunction("request") { (_: String, _: Double) -> String in "{\"success\":false,\"code\":\"unavailable\"}" }
    AsyncFunction("dispose") { (_: Double) in }
  }
}
