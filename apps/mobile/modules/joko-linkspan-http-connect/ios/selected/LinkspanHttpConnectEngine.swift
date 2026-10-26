import Foundation
import CoreFoundation
import Network
import Security

/// Raw proxy TCP or system-verified TLS. Trusted JS owns CONNECT and Noise.
actor LinkspanHttpConnectEngine {
  private struct SafeError: Error { let code: String }
  private final class Entry: @unchecked Sendable {
    let connection: NWConnection
    var opened = false
    var closing = false
    var cancelling = false
    var eof = false
    var dial: CheckedContinuation<Void, Error>?
    var read: CheckedContinuation<Data?, Error>?
    var write: CheckedContinuation<Void, Error>?
    var closes: [CheckedContinuation<Void, Error>] = []
    var timer: Task<Void, Never>?
    init(_ connection: NWConnection) { self.connection = connection }
  }
  private struct Location { let origin: String; let host: String; let port: UInt16; let tls: Bool }
  private let queue = DispatchQueue(label: "app.joko.linkspan.proxy")
  private var streams: [String: Entry] = [:]
  private var disposed = false

  func request(_ json: String) async -> String {
    var id: String?, method: String?
    do {
      guard json.utf8.count <= 800_000 else { throw SafeError(code: "resource_exhausted") }
      guard let row = try JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any],
        let streamId = row["streamId"] as? String, streamId.range(of: "^[a-f0-9]{32}$", options: .regularExpression) != nil,
        let operation = row["method"] as? String, Set(row.keys).isSubset(of: ["method", "streamId", "args"])
      else { throw SafeError(code: "invalid_argument") }
      id = streamId; method = operation
      guard !disposed else { throw SafeError(code: "closed") }
      if !["connect", "write"].contains(operation), row["args"] != nil { throw SafeError(code: "invalid_argument") }
      var result: Any = NSNull()
      switch operation {
      case "connect":
        guard let args = row["args"] as? [String: Any] else { throw SafeError(code: "invalid_argument") }
        let location = try location(args)
        try await connect(streamId, location)
        result = ["remoteEndpointId": location.origin] // Locator only; not authenticated identity.
      case "read":
        if let bytes = try await read(streamId) { result = bytes.map { Int($0) } }
      case "write": try await write(streamId, bytes(row["args"]))
      case "close": try await close(streamId)
      case "abort": finish(streamId, code: "cancelled")
      default: throw SafeError(code: "invalid_argument")
      }
      return encode(["success": true, "value": result])
    } catch {
      let code = (error as? SafeError)?.code ?? "transport_error"
      if let id, ["connect", "read", "write", "close"].contains(method ?? "") { finish(id, code: code) }
      return encode(["success": false, "code": code])
    }
  }
  private func location(_ row: [String: Any]) throws -> Location {
    guard Set(row.keys) == ["proxyOrigin"], let origin = row["proxyOrigin"] as? String, origin.utf8.count <= 2048,
      !origin.isEmpty, origin.utf8.allSatisfy({ $0 > 32 && $0 < 127 }), let url = URLComponents(string: origin),
      let scheme = url.scheme, ["http", "https"].contains(scheme), url.user == nil, url.password == nil,
      url.path.isEmpty, url.query == nil, url.fragment == nil, let rawHost = url.host
    else { throw SafeError(code: "invalid_argument") }
    let host = rawHost.hasPrefix("[") && rawHost.hasSuffix("]") ? String(rawHost.dropFirst().dropLast()) : rawHost
    let standard = scheme == "https" ? 443 : 80, port = url.port ?? standard
    let authority = host.contains(":") ? "[\(host)]" : host
    guard !host.isEmpty, host == host.lowercased(), (1...65535).contains(port),
      origin == "\(scheme)://\(authority)\(port == standard ? "" : ":\(port)")"
    else { throw SafeError(code: "invalid_argument") }
    return Location(origin: origin, host: host, port: UInt16(port), tls: scheme == "https")
  }
  private func connect(_ id: String, _ location: Location) async throws {
    guard !disposed, streams[id] == nil, streams.count < 32 else { throw SafeError(code: disposed ? "closed" : streams[id] != nil ? "invalid_argument" : "resource_exhausted") }
    let parameters: NWParameters
    if location.tls {
      let tls = NWProtocolTLS.Options()
      sec_protocol_options_set_tls_server_name(tls.securityProtocolOptions, location.host)
      sec_protocol_options_set_peer_authentication_required(tls.securityProtocolOptions, true)
      parameters = NWParameters(tls: tls, tcp: NWProtocolTCP.Options())
    } else { parameters = .tcp }
    let entry = Entry(NWConnection(host: NWEndpoint.Host(location.host), port: NWEndpoint.Port(rawValue: location.port)!, using: parameters))
    streams[id] = entry
    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
      entry.dial = continuation
      entry.connection.stateUpdateHandler = { [weak self, weak entry] state in
        guard let self, let entry else { return }
        Task { await self.state(id, entry, state) }
      }
      entry.timer = Task { [weak self] in
        do { try await Task.sleep(nanoseconds: 30_000_000_000) } catch { return }
        await self?.expire(id, entry)
      }
      entry.connection.start(queue: queue)
    }
    guard streams[id] === entry, entry.opened, !entry.closing, !disposed else { throw SafeError(code: "closed") }
  }
  private func state(_ id: String, _ entry: Entry, _ state: NWConnection.State) {
    guard streams[id] === entry else { return }
    switch state {
    case .ready:
      entry.opened = true; entry.timer?.cancel(); entry.timer = nil
      let continuation = entry.dial; entry.dial = nil; continuation?.resume()
    case .failed(let error): finish(id, code: errorCode(error))
    case .cancelled: complete(id, entry, code: "closed", graceful: entry.cancelling)
    default: break
    }
  }
  private func expire(_ id: String, _ entry: Entry) { if streams[id] === entry { finish(id, code: "deadline_exceeded") } }
  private func read(_ id: String) async throws -> Data? {
    guard let entry = streams[id], entry.opened, !entry.closing else { throw SafeError(code: "closed") }
    guard entry.read == nil else { throw SafeError(code: "resource_exhausted") }
    if entry.eof { return nil }
    return try await withCheckedThrowingContinuation { continuation in
      entry.read = continuation
      entry.connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self, weak entry] data, _, complete, error in
        guard let self, let entry else { return }
        Task { await self.received(id, entry, data, complete, error) }
      }
    }
  }
  private func received(_ id: String, _ entry: Entry, _ data: Data?, _ complete: Bool, _ error: NWError?) {
    guard streams[id] === entry else { return }
    if entry.cancelling { return }
    if let error { finish(id, code: errorCode(error)); return }
    guard let continuation = entry.read else { return }; entry.read = nil
    entry.eof = complete
    continuation.resume(returning: data?.isEmpty == false ? data : nil)
  }
  private func write(_ id: String, _ data: Data) async throws {
    guard let entry = streams[id], entry.opened, !entry.closing else { throw SafeError(code: "closed") }
    guard entry.write == nil else { throw SafeError(code: "resource_exhausted") }
    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
      entry.write = continuation
      entry.connection.send(content: data, completion: .contentProcessed { [weak self, weak entry] error in
        guard let self, let entry else { return }
        Task { await self.written(id, entry, error) }
      })
    }
  }
  private func written(_ id: String, _ entry: Entry, _ error: NWError?) {
    guard streams[id] === entry else { return }
    if entry.cancelling { return }
    if let error { finish(id, code: errorCode(error)); return }
    let continuation = entry.write; entry.write = nil; continuation?.resume()
    if entry.closing { finish(id, code: "closed", graceful: true) }
  }
  private func close(_ id: String) async throws {
    guard let entry = streams[id] else { return }
    guard entry.closes.count < 4 else { throw SafeError(code: "resource_exhausted") }
    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
      entry.closes.append(continuation)
      entry.closing = true
      if entry.write == nil { finish(id, code: "closed", graceful: true) }
      else if entry.timer == nil {
        entry.timer = Task { [weak self] in
          do { try await Task.sleep(nanoseconds: 30_000_000_000) } catch { return }
          await self?.expire(id, entry)
        }
      }
    }
  }
  private func finish(_ id: String, code: String, graceful: Bool = false) {
    guard let entry = streams[id] else { return }
    if graceful {
      if entry.cancelling { return }
      entry.cancelling = true
      if entry.timer == nil {
        entry.timer = Task { [weak self] in
          do { try await Task.sleep(nanoseconds: 30_000_000_000) } catch { return }
          await self?.expire(id, entry)
        }
      }
      // cancel() starts graceful disconnection; close completes at its state receipt.
      entry.connection.cancel()
      return
    }
    entry.connection.forceCancel()
    complete(id, entry, code: code)
  }
  private func complete(_ id: String, _ entry: Entry, code: String, graceful: Bool = false) {
    guard streams[id] === entry else { return }
    streams.removeValue(forKey: id)
    entry.timer?.cancel()
    let error = SafeError(code: code)
    entry.dial?.resume(throwing: error); entry.dial = nil
    if graceful { entry.read?.resume(returning: nil) } else { entry.read?.resume(throwing: error) }; entry.read = nil
    entry.write?.resume(throwing: error); entry.write = nil
    for continuation in entry.closes { if graceful { continuation.resume() } else { continuation.resume(throwing: error) } }
    entry.closes.removeAll()
  }
  private func bytes(_ value: Any?) throws -> Data {
    guard let values = value as? [Any], values.count <= 131072 else { throw SafeError(code: "invalid_argument") }
    var data = Data(capacity: values.count)
    for value in values {
      guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
        number.doubleValue == Double(number.intValue), (0...255).contains(number.intValue) else { throw SafeError(code: "invalid_argument") }
      data.append(UInt8(number.intValue))
    }
    return data
  }
  private func errorCode(_ error: NWError) -> String { if case .tls = error { return "authentication_failed" }; return "transport_error" }
  private func encode(_ value: [String: Any]) -> String { (try? JSONSerialization.data(withJSONObject: value)).flatMap { String(data: $0, encoding: .utf8) } ?? "{\"success\":false,\"code\":\"protocol_error\"}" }
  func dispose() { disposed = true; for id in Array(streams.keys) { finish(id, code: "closed") } }
}
