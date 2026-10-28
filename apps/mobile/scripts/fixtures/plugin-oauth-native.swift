import Darwin
import Foundation
import Network

private func expect(_ condition: @autoclosure () -> Bool, _ label: String) { if !condition() { fatalError(label) } }
private func freePort() -> UInt16 {
  let descriptor = Darwin.socket(AF_INET, SOCK_STREAM, 0); expect(descriptor >= 0, "socket allocation failed")
  defer { Darwin.close(descriptor) }
  var address = sockaddr_in(); address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size); address.sin_family = sa_family_t(AF_INET); address.sin_port = 0; address.sin_addr = in_addr(s_addr: inet_addr("127.0.0.1"))
  let bound = withUnsafePointer(to: &address) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.bind(descriptor, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) } }
  expect(bound == 0, "test port bind failed"); var length = socklen_t(MemoryLayout<sockaddr_in>.size)
  let read = withUnsafeMutablePointer(to: &address) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(descriptor, $0, &length) } }
  expect(read == 0, "test port observation failed"); return UInt16(bigEndian: address.sin_port)
}
private let state = "test_state_0123456789abcdef"
private func wire(_ port: UInt16, _ query: String? = nil, headers: String = "") -> Data {
  Data("GET /callback?\(query ?? "state=\(state)&code=accepted%2Bvalue") HTTP/1.1\r\nHost: 127.0.0.1:\(port)\r\n\(headers)\r\n".utf8)
}
@main struct PluginOauthNativeChecks {
  static func main() throws {
    let now = floor(Date().timeIntervalSince1970 * 1000), port = freePort()
    let request = try PluginOauthRequest(id: "test_listener_0123456789", callbackUrl: "http://127.0.0.1:\(port)/callback", state: state, expiresAt: now + 30_000)
    expect(request.parse(wire(port)) == ["state": state, "code": "accepted+value"], "exact callback parse failed")
    expect(request.parse(wire(port, "state=\(state)&error=access_denied")) == ["state": state, "error": "access_denied"], "denial parse failed")
    let invalid = [wire(port, "state=wrong&code=code"), wire(port, "state=\(state)&state=\(state)&code=code"), wire(port, "state=\(state)&%73tate=\(state)&code=code"),
      wire(port, "state=\(state)&code=code&error=denied"), wire(port, "state=\(state)&code=%0Asecret"), wire(port, "state=\(state)&code=%7F"), wire(port, "state=\(state)&code=%FF"), wire(port, "state=\(state)&code=%G0"),
      wire(port, "state=\(state)&code=\(String(repeating: "a", count: 4097))"), wire(port, headers: "Origin: https://untrusted.test\r\n"), wire(port, headers: "Transfer-Encoding: chunked\r\n"),
      wire(port, headers: "Content-Length: 1\r\n"), wire(port, headers: "hOsT: 127.0.0.1:\(port)\r\n"), wire(port) + Data([1])]
    for value in invalid { expect(request.parse(value) == nil, "invalid callback was accepted") }
    expect(request.parse(wire(port), now: request.expiresAt) == nil, "expired callback was accepted")
    for url in ["http://localhost:43175/callback", "http://0.0.0.0:43175/callback", "http://[::1]:43175/callback", "https://127.0.0.1:43175/callback", "http://127.0.0.1:80/callback", "http://127.0.0.1:43175/%63allback", "http://127.0.0.1:43175/callback?extra=query"] {
      do { _ = try PluginOauthRequest(id: request.id, callbackUrl: url, state: state, expiresAt: request.expiresAt); fatalError("invalid callback location was accepted") }
      catch PluginOauthRequest.Failure.invalid { }
    }
    let queue = DispatchQueue(label: "app.joko.oauth-native-check"), receiver = try PluginOauthReceiver(request, queue: queue)
    defer { queue.sync { receiver.close() } }
    let ready = DispatchSemaphore(value: 0), delivered = DispatchSemaphore(value: 0), response = DispatchSemaphore(value: 0)
    queue.sync {
      receiver.wait(resolve: { value in expect(value == ["state": state, "code": "accepted+value"], "callback bytes changed"); delivered.signal() }, reject: { fatalError("valid callback wait failed") })
      receiver.start { ok in expect(ok, "native receiver bind failed"); ready.signal() }
    }
    expect(ready.wait(timeout: .now() + 5) == .success, "receiver did not become ready")
    let client = NWConnection(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: port)!, using: .tcp)
    defer { client.cancel() }
    client.stateUpdateHandler = { status in
      if case .ready = status {
        client.send(content: wire(port), completion: .contentProcessed { error in expect(error == nil, "callback write failed") })
        client.receive(minimumIncompleteLength: 1, maximumLength: 16_384) { bytes, _, _, error in
          let text = bytes.flatMap { String(data: $0, encoding: .utf8) } ?? ""
          expect(error == nil && text.hasPrefix("HTTP/1.1 200 OK"), "callback response failed")
          expect(!text.contains(state) && !text.contains("accepted+value"), "callback material escaped into HTTP response"); response.signal()
        }
      }
    }
    client.start(queue: DispatchQueue(label: "app.joko.oauth-test-client"))
    expect(delivered.wait(timeout: .now() + 5) == .success, "callback was not delivered")
    expect(response.wait(timeout: .now() + 5) == .success, "callback HTTP response was not sent")
    queue.sync {
      expect(receiver.status() == "received", "received result was not retained for status")
      var refused = false; receiver.wait(resolve: { _ in fatalError("callback was delivered twice") }, reject: { refused = true }); expect(refused, "second wait was accepted")
      receiver.close(); receiver.close(); expect(receiver.status() == "closed", "retired receiver remained usable")
    }
    let expiryPort = freePort(), expiryRequest = try PluginOauthRequest(id: request.id, callbackUrl: "http://127.0.0.1:\(expiryPort)/callback", state: state, expiresAt: floor(Date().timeIntervalSince1970 * 1000) + 1_200)
    let expiring = try PluginOauthReceiver(expiryRequest, queue: queue), expired = DispatchSemaphore(value: 0), expiryReady = DispatchSemaphore(value: 0)
    defer { queue.sync { expiring.close() } }
    queue.sync { expiring.start { ok in expect(ok, "expiry receiver bind failed"); expiryReady.signal() }; expiring.wait(resolve: { _ in fatalError("partial callback was accepted") }, reject: { expired.signal() }) }
    expect(expiryReady.wait(timeout: .now() + 5) == .success, "expiry receiver did not bind")
    let partial = NWConnection(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: expiryPort)!, using: .tcp)
    defer { partial.cancel() }
    partial.stateUpdateHandler = { status in if case .ready = status { partial.send(content: Data("GET /callback?".utf8), completion: .contentProcessed { _ in }) } }
    partial.start(queue: DispatchQueue(label: "app.joko.oauth-partial-client"))
    expect(expired.wait(timeout: .now() + 5) == .success, "expiry did not settle an incomplete request")
    queue.sync { expect(expiring.status() == "closed", "expired receiver retained authority") }
    print("PLUGIN_OAUTH_SWIFT_OK exact-loopback strict-parse no-secret-echo one-shot expiry partial-client cleanup")
  }
}
