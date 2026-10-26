import ExpoModulesCore
import Foundation

public final class LinkspanHttpConnectModule: Module {
  private let lock = NSLock()
  private var engine: LinkspanHttpConnectEngine?
  private var destroyed = false
  private var generation: Double = 0
  private var retiring: Task<Void, Never>?
  private func current(_ occurrence: Double, create: Bool) async -> LinkspanHttpConnectEngine? {
    let (expected, previous) = snapshot()
    await previous?.value
    return acquire(expected, occurrence: occurrence, create: create)
  }
  private func snapshot() -> (Double, Task<Void, Never>?) { lock.lock(); defer { lock.unlock() }; return (generation, retiring) }
  private func acquire(_ expected: Double, occurrence: Double, create: Bool) -> LinkspanHttpConnectEngine? {
    lock.lock(); defer { lock.unlock() }
    if destroyed || generation != expected || occurrence != expected { return nil }
    if let engine { return engine }
    if !create { return nil }
    let value = LinkspanHttpConnectEngine(); engine = value; return value
  }
  private func take(_ next: Double? = nil, destroy: Bool = false) -> Task<Void, Never>? {
    lock.lock(); defer { lock.unlock() }
    if let next {
      guard next.isFinite, next >= generation, next.rounded() == next else { return retiring }
      generation = next
    }
    if destroy { destroyed = true; generation += 1 }
    guard let old = engine else { return retiring }
    engine = nil
    let previous = retiring
    let task = Task { await previous?.value; await old.dispose() }
    retiring = task
    return task
  }
  private func available() -> Bool { lock.lock(); defer { lock.unlock() }; return !destroyed }
  public func definition() -> ModuleDefinition {
    Name("LinkspanHttpConnect")
    Function("isAvailable") { self.available() }
    AsyncFunction("request") { (json: String, occurrence: Double) async -> String in
      guard json.utf8.count <= 800_000 else { return "{\"success\":false,\"code\":\"resource_exhausted\"}" }
      let object = (try? JSONSerialization.jsonObject(with: Data(json.utf8))) as? [String: Any]
      guard let engine = await self.current(occurrence, create: object?["method"] as? String == "connect") else { return "{\"success\":false,\"code\":\"closed\"}" }
      return await engine.request(json)
    }
    AsyncFunction("dispose") { (occurrence: Double) async -> Void in if let task = self.take(occurrence) { await task.value } }
    OnDestroy { _ = self.take(destroy: true) }
  }
}
