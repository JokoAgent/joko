import Foundation
import Network

// Real loopback sockets exercise the exact production actor, without replacing
// Network.framework or the engine's state/cancellation callbacks.
private final class EchoServer: @unchecked Sendable {
  let listener: NWListener
  let queue = DispatchQueue(label: "app.joko.native-proxy-check")
  private let lock = NSLock()
  private var peers: [NWConnection] = []
  let endings: AsyncStream<Void>
  private let ended: AsyncStream<Void>.Continuation
  init() throws {
    listener = try NWListener(using: .tcp, on: .any)
    var continuation: AsyncStream<Void>.Continuation!
    endings = AsyncStream { continuation = $0 }; ended = continuation
  }
  func start() async throws -> UInt16 {
    listener.newConnectionHandler = { [self] peer in
      lock.lock(); peers.append(peer); lock.unlock()
      peer.stateUpdateHandler = { [self] state in if case .ready = state { receive(peer) } }
      peer.start(queue: queue)
    }
    return try await withCheckedThrowingContinuation { continuation in
      listener.stateUpdateHandler = { [self] state in
        switch state {
        case .ready: listener.stateUpdateHandler = nil; continuation.resume(returning: listener.port!.rawValue)
        case .failed(let error): listener.stateUpdateHandler = nil; continuation.resume(throwing: error)
        default: break
        }
      }
      listener.start(queue: queue)
    }
  }
  private func receive(_ peer: NWConnection) {
    peer.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [self] data, _, complete, error in
      if let data, !data.isEmpty {
        peer.send(content: data, completion: .contentProcessed { [self] sendError in
          if sendError != nil || complete || error != nil { ended.yield(); peer.cancel() }
          else { receive(peer) }
        })
      } else if complete || error != nil { ended.yield(); peer.cancel() }
      else { receive(peer) }
    }
  }
  func stop() {
    listener.cancel(); lock.lock(); let previous = peers; peers = []; lock.unlock()
    for peer in previous { peer.forceCancel() }; ended.finish()
  }
}

private func expect(_ value: Bool, _ label: String) { if !value { fatalError(label) } }
private func call(_ engine: LinkspanHttpConnectEngine, _ method: String, _ id: String, _ args: Any? = nil) async throws -> [String: Any] {
  var row: [String: Any] = ["method": method, "streamId": id]
  if let args { row["args"] = args }
  let json = String(data: try JSONSerialization.data(withJSONObject: row), encoding: .utf8)!
  return try JSONSerialization.jsonObject(with: Data(await engine.request(json).utf8)) as! [String: Any]
}
@main private struct NativeProxyCheck {
  static func main() async throws {
    let server = try EchoServer(); defer { server.stop() }
    let port = try await server.start(), engine = LinkspanHttpConnectEngine()
    let location = ["proxyOrigin": "http://127.0.0.1:\(port)"]
    let first = String(repeating: "1", count: 32), second = String(repeating: "2", count: 32)
    var endings = server.endings.makeAsyncIterator()
    let opened = try await call(engine, "connect", first, location)
    expect(opened["success"] as? Bool == true, "TCP dial failed")
    let bytes = (0..<65536).map { $0 % 251 }
    for _ in 0..<32 {
      let written = try await call(engine, "write", first, bytes)
      expect(written["success"] as? Bool == true, "TCP write failed")
      var echoed: [Int] = []
      while echoed.count < bytes.count {
        let read = try await call(engine, "read", first)
        expect(read["success"] as? Bool == true, "TCP read failed")
        guard let chunk = read["value"] as? [Int], !chunk.isEmpty else { fatalError("TCP ended before complete payload") }
        echoed.append(contentsOf: chunk)
      }
      expect(echoed == bytes, "TCP bytes changed")
    }
    let closed = try await call(engine, "close", first)
    expect(closed["success"] as? Bool == true, "Graceful cancellation receipt failed")
    expect(await endings.next() != nil, "The peer did not observe graceful close")
    let reopened = try await call(engine, "connect", second, location)
    expect(reopened["success"] as? Bool == true, "Replacement TCP dial failed")
    let reading = Task { try await call(engine, "read", second) }
    let aborted = try await call(engine, "abort", second)
    expect(aborted["success"] as? Bool == true, "TCP abort failed")
    let rejected = try await reading.value
    expect(rejected["success"] as? Bool == false, "A retired read succeeded")
    expect(await endings.next() != nil, "The peer did not observe abort")
    await engine.dispose()
    let retired = try await call(engine, "connect", String(repeating: "3", count: 32), location)
    expect(retired["success"] as? Bool == false && retired["code"] as? String == "closed", "A disposed engine accepted a replacement")
    print("NATIVE_PROXY_SWIFT_OK TCP2MiB graceful-state-receipt peer-EOF abort disposed-dial-rejection")
  }
}
