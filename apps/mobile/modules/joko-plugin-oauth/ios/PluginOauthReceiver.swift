import Foundation
import Network

/** Queue-confined, one-shot and strictly loopback. No provider requests. */
final class PluginOauthReceiver {
  private let listener: NWListener
  private let queue: DispatchQueue
  private let request: PluginOauthRequest
  private var clients: [UUID: NWConnection] = [:]
  private var pending: (resolve: ([String: String]) -> Void, reject: () -> Void)?
  private var result: [String: String]?
  private var closed = false
  private var consumed = false
  private var deadline: DispatchWorkItem?
  init(_ request: PluginOauthRequest, queue: DispatchQueue) throws {
    self.request = request; self.queue = queue
    let parameters = NWParameters.tcp
    parameters.allowLocalEndpointReuse = false
    parameters.requiredLocalEndpoint = .hostPort(host: .ipv4(.loopback), port: NWEndpoint.Port(rawValue: request.port)!)
    listener = try NWListener(using: parameters)
  }
  func start(_ ready: @escaping (Bool) -> Void) {
    var settled = false
    listener.stateUpdateHandler = { [weak self] state in
      if !settled {
        if case .ready = state { settled = true; ready(self?.closed == false) }
        else if case .failed = state { settled = true; ready(false) }
        else if case .cancelled = state { settled = true; ready(false) }
      }
    }
    listener.newConnectionHandler = { [weak self] connection in
      guard let self, !self.closed, self.result == nil, self.clients.count < 8 else { connection.cancel(); return }
      let id = UUID(); self.clients[id] = connection; connection.start(queue: self.queue)
      self.queue.asyncAfter(deadline: .now() + 5) { [weak self] in self?.clients.removeValue(forKey: id)?.cancel() }
      self.receive(id, Data())
    }
    let timeout = DispatchWorkItem { [weak self] in self?.close() }; deadline = timeout
    queue.asyncAfter(deadline: .now() + max(0, (request.expiresAt - Date().timeIntervalSince1970 * 1000) / 1000), execute: timeout)
    listener.start(queue: queue)
  }
  func status() -> String {
    if !closed && Date().timeIntervalSince1970 * 1000 >= request.expiresAt { close() }
    return result != nil ? "received" : closed ? "closed" : "waiting"
  }
  func wait(resolve: @escaping ([String: String]) -> Void, reject: @escaping () -> Void) {
    guard status() != "closed", !consumed, pending == nil else { reject(); return }
    if let result { consumed = true; resolve(result) } else { pending = (resolve, reject) }
  }
  func close() {
    guard !closed else { return }; closed = true
    deadline?.cancel(); listener.cancel(); clients.values.forEach { $0.cancel() }; clients.removeAll()
    let rejected = pending; pending = nil; result = nil; rejected?.reject()
  }
  private func receive(_ id: UUID, _ previous: Data) {
    clients[id]?.receive(minimumIncompleteLength: 1, maximumLength: 4096) { [weak self] data, _, ended, error in
      guard let self, !self.closed, self.result == nil else { return }
      var bytes = previous; if let data { bytes.append(data) }
      guard bytes.count <= 16_384 else { self.respond(id, accepted: false); return }
      if bytes.range(of: Data("\r\n\r\n".utf8)) != nil {
        guard let value = self.request.parse(bytes) else { self.respond(id, accepted: false); return }
        self.result = value; self.listener.cancel(); self.respond(id, accepted: true)
        for other in Array(self.clients.keys) where other != id { self.clients.removeValue(forKey: other)?.cancel() }
      } else if ended || error != nil { self.clients.removeValue(forKey: id)?.cancel() }
      else { self.receive(id, bytes) }
    }
  }
  private func respond(_ id: UUID, accepted: Bool) {
    let body = accepted ? "Authorization received. Return to Joko." : "Invalid callback."
    let response = "HTTP/1.1 \(accepted ? "200 OK" : "400 Bad Request")\r\nContent-Type: text/plain; charset=utf-8\r\nCache-Control: no-store\r\nContent-Security-Policy: default-src 'none'\r\nConnection: close\r\nContent-Length: \(body.utf8.count)\r\n\r\n\(body)"
    clients[id]?.send(content: Data(response.utf8), completion: .contentProcessed { [weak self] _ in
      guard let self else { return }; self.clients.removeValue(forKey: id)?.cancel()
      if accepted, !self.closed, let pending = self.pending, let value = self.result {
        self.consumed = true; self.pending = nil; pending.resolve(value)
      }
    })
  }
}
