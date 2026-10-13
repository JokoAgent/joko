import Foundation

/// Nonsecret authenticated Joko identity. Profile isolation never crosses the peer channel.
public struct CredentialNativeOwner: Codable, Equatable, Sendable {
  public let serverId: String
  public let deviceId: String
  public let profileId: String
  public init(serverId: String, deviceId: String, profileId: String) {
    self.serverId = serverId; self.deviceId = deviceId; self.profileId = profileId
  }
  func validate() throws {
    guard [serverId, deviceId, profileId].allSatisfy({ !$0.isEmpty && $0.utf8.count <= 512
      && $0 == $0.trimmingCharacters(in: .whitespacesAndNewlines)
      && !$0.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) })
      else { throw CredentialError.invalidIdentity }
  }
}
public struct ChannelIdentity {
  public let id: String
  public let serverId: String
  public let publicKey: IdentityPublicKey
  let checkedAt: Date
}
func validIdentityID(_ value: String) -> Bool {
  guard let uuid = UUID(uuidString: value), uuid.uuidString.lowercased() == value else { return false }
  let bytes = Array(value.utf8)
  return bytes[14] == 52 && [56, 57, 97, 98].contains(bytes[19])
}
