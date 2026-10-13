import ExpoModulesCore
import JokoRemoteCredentials

private func localOwner(_ fields: [String: String]) throws -> CredentialNativeOwner {
  guard Set(fields.keys) == Set(["serverId", "deviceId", "profileId"]),
    let server = fields["serverId"], let device = fields["deviceId"], let profile = fields["profileId"]
    else { throw CredentialError.invalidIdentity }
  return CredentialNativeOwner(serverId: server, deviceId: device, profileId: profile)
}
private func credentialCall<T>(_ action: () async throws -> T) async throws -> T {
  do { return try await action() }
  catch {
    let failure = (error as? CredentialError ?? CredentialError.unavailable).rawValue
    throw Exception(name: failure, description: failure, code: failure)
  }
}
public final class JokoRemoteCredentialsModule: Module {
  @MainActor private lazy var client: NativeCredentialClient = {
    let value = NativeCredentialClient()
    value.onInvalidated = { [weak self] handle in self?.sendEvent("invalidated", ["handle": handle]) }
    return value
  }()
  public func definition() -> ModuleDefinition {
    Name("JokoRemoteCredentials")
    Events("invalidated")
    AsyncFunction("configure") { (owner: [String: String]) async throws -> String in
      try await credentialCall { try await self.client.configure(owner: localOwner(owner)) }
    }
    AsyncFunction("savedUnlockSettings") { (owner: [String: String], target: String) async throws -> [String: Bool] in
      try await credentialCall { try await self.client.savedSettings(owner: localOwner(owner), target: target) }
    }
    AsyncFunction("forgetSavedUnlock") { (owner: [String: String], target: String) async throws in
      try await credentialCall { try await self.client.forgetSaved(owner: localOwner(owner), target: target) }
    }
    AsyncFunction("setSavedUnlockBiometric") { (owner: [String: String], target: String, enabled: Bool, locale: String) async throws in
      try await credentialCall { try await self.client.changeBiometric(owner: localOwner(owner), target: target, enabled: enabled, locale: locale) }
    }
    AsyncFunction("beginUnlock") { (target: String, setup: Bool, biometric: Bool, descriptor: String, hostPlatform: String) async throws -> [String: String] in
      try await credentialCall { try await self.client.begin(target: target, descriptor: descriptor, setup: setup, savedOnly: !setup, biometric: biometric, hostPlatform: hostPlatform) }
    }
    AsyncFunction("accept") { (handle: String, offer: String) async throws -> String in
      try await credentialCall { try await self.client.accept(handle: handle, offer: offer) }
    }
    AsyncFunction("receive") { (handle: String, ciphertext: String) async throws -> String in
      try await credentialCall { try await self.client.receive(handle: handle, ciphertext: ciphertext) }
    }
    AsyncFunction("password") { (handle: String, useSaved: Bool, locale: String, theme: String) async throws -> String in
      try await credentialCall { try await self.client.password(handle: handle, useSaved: useSaved, locale: locale, theme: theme) }
    }
    AsyncFunction("authenticationStatus") { (handle: String) async throws -> String in
      try await credentialCall { try await self.client.authenticationStatus(handle: handle) }
    }
    AsyncFunction("request") { (handle: String, body: String) async throws -> [String: String] in
      try await credentialCall { try await self.client.request(handle: handle, body: body) }
    }
    AsyncFunction("abandonRequest") { (handle: String, id: String) async throws in
      try await credentialCall { try await self.client.abandonRequest(handle: handle, id: id) }
    }
    AsyncFunction("end") { (handle: String) async -> String? in await self.client.end(handle: handle) }
    AsyncFunction("close") { (handle: String) async in await self.client.close(handle: handle) }
    AsyncFunction("reset") { () async in await self.client.reset() }
    OnAppEntersBackground { Task { @MainActor in self.client.close() } }
    OnDestroy { Task { @MainActor in self.client.reset() } }
  }
}
