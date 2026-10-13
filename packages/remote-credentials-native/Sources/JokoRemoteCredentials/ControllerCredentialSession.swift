import Foundation

/// Native-only credential transaction. A bridge can transport ciphertext and
/// desktop results, but cannot assert that a password succeeded or should save.
final class ControllerCredentialSession {
  enum Received {
    case ignored
    case ready(CredentialAccount)
    case authenticated(Bool)
    case response(id: String, body: Data, success: Bool, saved: Bool)
  }
  private struct PendingAttempt {
    let id: String
    let account: CredentialAccount
    var secretToSave: Data?
  }
  private let channel: NativeChannel
  private let hostPlatform: String
  private let save: (Data, CredentialAccount) throws -> Void
  private var account: CredentialAccount?
  private var pending: PendingAttempt?
  private var authorized = false
  private var abandoned: [String] = []
  private var commands: [String: String] = [:]

  init(channel: NativeChannel, hostPlatform: String, save: @escaping (Data, CredentialAccount) throws -> Void) {
    self.channel = channel; self.hostPlatform = hostPlatform; self.save = save
  }

  func ready() throws -> String { try channel.seal(body: Data(), purpose: "ready") }

  /// Called only by native password UI or the actual protected vault read.
  func authenticate(password: Data, remember: Bool) throws -> String {
    try channel.requireConfirmed()
    guard let account, pending == nil, !authorized, !password.isEmpty,
      password.count <= 4096, !password.contains(0), String(data: password, encoding: .utf8) != nil else {
      throw CredentialError.invalidMessage
    }
    let id = UUID().uuidString.lowercased()
    let packet = try channel.seal(body: JSONEncoder().encode(AuthenticationAttempt(id: id,
      account: account, password: password)), purpose: "authenticate")
    pending = PendingAttempt(id: id, account: account, secretToSave: remember ? password : nil)
    return packet
  }

  /// A transport retry sends only this query, never the password again.
  func authenticationStatus() throws -> String {
    guard let pending else { throw CredentialError.invalidMessage }
    return try channel.seal(body: JSONSerialization.data(withJSONObject: ["id": pending.id]),
      purpose: "authentication-status")
  }

  func request(_ body: Data) throws -> (id: String, ciphertext: String) {
    try channel.requireConfirmed()
    guard authorized, commands.count < 64,
      let value = try JSONSerialization.jsonObject(with: body) as? [String: Any],
      let op = value["op"] as? String,
      ["capabilities", "permissions", "start", "heartbeat", "stop", "frame", "control",
       "presentation", "input", "offer", "ice", "displayModes", "resolution",
       "hostMute", "privacyScreen", "clipboardSync", "clipboardVersion"].contains(op) else { throw CredentialError.invalidMessage }
    let id = UUID().uuidString.lowercased()
    let ciphertext = try channel.seal(body: JSONEncoder().encode(CredentialDesktopRequest(id: id,
      payload: body)), purpose: "request")
    commands[id] = op
    return (id, ciphertext)
  }

  func receive(_ ciphertext: String) throws -> Received {
    let packet = try channel.open(ciphertext)
    switch packet.purpose {
    case "ready":
      guard account == nil, packet.body.count <= 1024,
        let value = try? JSONDecoder().decode(CredentialAccount.self, from: packet.body),
        validAccountRecord(value.recordID), !value.name.isEmpty,
        value.name.utf8.count <= 256, !value.name.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else {
        throw CredentialError.invalidIdentity
      }
      account = value
      return .ready(value)
    case "authentication-result":
      guard let pending,
        let result = try? JSONDecoder().decode(AuthenticationResult.self, from: packet.body),
        result.id == pending.id, result.account == pending.account else { throw CredentialError.invalidIdentity }
      authorized = result.accepted
      if !result.accepted { self.pending = nil }
      if let failure = result.failure {
        guard !result.accepted else { throw CredentialError.invalidMessage }
        throw failure
      }
      if result.accepted {
        self.pending = nil
        if let secret = pending.secretToSave { try save(secret, pending.account) }
      }
      return .authenticated(result.accepted)
    case "response":
      guard authorized,
        let response = try? JSONDecoder().decode(CredentialDesktopResponse.self, from: packet.body) else { throw CredentialError.invalidMessage }
      if let index = abandoned.firstIndex(of: response.id) { abandoned.remove(at: index); return .ignored }
      guard commands.removeValue(forKey: response.id) != nil else { throw CredentialError.invalidMessage }
      return .response(id: response.id, body: response.payload, success: response.success, saved: false)
    default:
      throw CredentialError.invalidMessage
    }
  }

  private func validAccountRecord(_ value: String) -> Bool {
    switch hostPlatform {
    case "darwin": return UUID(uuidString: value) != nil
    case "linux":
      // The native Linux account binds machine-id, UID and login name with SHA256.
      let bytes = Array(value.utf8)
      return bytes.count == 64 && bytes.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
    default: return false
    }
  }

  func abandonRequest(_ id: String) {
    if commands.removeValue(forKey: id) != nil {
      abandoned.append(id)
      if abandoned.count > 256 { abandoned.removeFirst() }
    }
  }
  func close() { pending = nil; account = nil; authorized = false; commands.removeAll(); abandoned.removeAll(); channel.close() }
}
