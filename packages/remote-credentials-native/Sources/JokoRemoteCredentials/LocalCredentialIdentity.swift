import Foundation

/// Public material only. Authenticated transport plus explicit native setup establishes a pin.
struct LocalCredentialIdentity: Codable {
  let version: Int
  let deviceId: String
  let serverId: String
  let publicKey: IdentityPublicKey
  init(deviceId: String, serverId: String, publicKey: IdentityPublicKey) {
    version = 1; self.deviceId = deviceId; self.serverId = serverId; self.publicKey = publicKey
  }
  func encoded() throws -> String {
    let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
    return String(decoding: try encoder.encode(self), as: UTF8.self)
  }
  static func decode(_ text: String, deviceId: String, serverId: String) throws -> LocalCredentialIdentity {
    guard text.utf8.count <= 4096,
      let object = try? JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any],
      Set(object.keys) == Set(["version", "deviceId", "serverId", "publicKey"]),
      let value = try? JSONDecoder().decode(Self.self, from: Data(text.utf8)),
      value.version == 1, value.deviceId == deviceId, !deviceId.isEmpty, deviceId.utf8.count <= 512,
      value.serverId == serverId, !serverId.isEmpty, serverId.utf8.count <= 512
      else { throw CredentialError.invalidIdentity }
    _ = try value.publicKey.securityKey()
    return value
  }
  var peer: ChannelIdentity {
    ChannelIdentity(id: deviceId, serverId: serverId, publicKey: publicKey, checkedAt: Date())
  }
  func requirePin(_ pin: IdentityPublicKey?) throws {
    guard let pin, pin == publicKey else { throw CredentialError.invalidIdentity }
  }
}
