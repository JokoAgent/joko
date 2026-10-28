import ExpoModulesCore

struct PluginOauthListenerOptions: Record {
  @Field var id: String = ""
  @Field var callbackUrl: String = ""
  @Field var state: String = ""
  @Field var expiresAt: Double = 0
}

public final class JokoPluginOauthModule: Module {
  private let queue = DispatchQueue(label: "app.joko.plugin-oauth")
  private var receivers: [String: PluginOauthReceiver] = [:]
  public func definition() -> ModuleDefinition {
    Name("JokoPluginOauth")
    AsyncFunction("start") { (options: PluginOauthListenerOptions, promise: Promise) in
      do {
        guard self.receivers.isEmpty else { throw PluginOauthRequest.Failure.invalid }
        let request = try PluginOauthRequest(id: options.id, callbackUrl: options.callbackUrl, state: options.state, expiresAt: options.expiresAt)
        let receiver = try PluginOauthReceiver(request, queue: self.queue)
        self.receivers[request.id] = receiver
        receiver.start { [weak self, weak receiver] ok in
          guard let self, let receiver else { promise.reject("PLUGIN_OAUTH_CLOSED", "Authorization listener is closed"); return }
          guard self.receivers[request.id] === receiver else {
            receiver.close(); promise.reject("PLUGIN_OAUTH_CLOSED", "Authorization listener is closed"); return
          }
          if ok { promise.resolve(nil) }
          else {
            self.receivers.removeValue(forKey: request.id)?.close()
            promise.reject("PLUGIN_OAUTH_LISTEN_FAILED", "Unable to bind callback listener")
          }
        }
      } catch { promise.reject("PLUGIN_OAUTH_LISTEN_FAILED", "Unable to bind callback listener") }
    }.runOnQueue(queue)
    AsyncFunction("wait") { (id: String, promise: Promise) in
      guard let receiver = self.receivers[id] else { promise.reject("PLUGIN_OAUTH_CLOSED", "Authorization listener is closed"); return }
      receiver.wait(resolve: { value in promise.resolve(value) }, reject: { promise.reject("PLUGIN_OAUTH_CLOSED", "Authorization listener is closed") })
    }.runOnQueue(queue)
    AsyncFunction("status") { (id: String) -> String in self.receivers[id]?.status() ?? "closed" }.runOnQueue(queue)
    AsyncFunction("close") { (id: String) in self.receivers.removeValue(forKey: id)?.close() }.runOnQueue(queue)
    OnDestroy { self.queue.async { let active = Array(self.receivers.values); self.receivers.removeAll(); active.forEach { $0.close() } } }
  }
}
