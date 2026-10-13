import Foundation
import JokoRemoteCredentials
import DesktopNativeCaller

#if os(macOS)
import AppKit
@main @MainActor
struct CredentialHostMain {
  static func main() {
    let application = NSApplication.shared
    application.setActivationPolicy(.accessory)
    Task { await serve(); application.terminate(nil) }
    application.run()
  }
  static func serve() async {
    guard let caller = DesktopNativeCaller.authenticate(resourceName: "joko-macos-remote-credentials",
      developmentExecutable: "CREDENTIAL_HOST_DEVELOPMENT_EXECUTABLE"),
      CommandLine.arguments.count == 2, CommandLine.arguments[1].hasPrefix("/") else { exit(77) }
    let directory = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
    let host = HostCredentialServer(directory: directory)
    let viewer = NativeCredentialClient(storageDirectory: directory.appendingPathComponent("viewer"))
    let input = AsyncStream<Data>(bufferingPolicy: .bufferingOldest(64)) { continuation in
      DispatchQueue(label: "joko.credential.stdin").async {
        var buffer = Data()
        do {
          while let chunk = try CredentialPipeInput.readChunk(from: FileHandle.standardInput.fileDescriptor) {
            buffer.append(chunk)
            guard buffer.count <= 4 * 1024 * 1024 else { exit(77) }
            while let newline = buffer.firstIndex(of: 10) {
              let line = Data(buffer[..<newline]); buffer.removeSubrange(...newline)
              if case .dropped = continuation.yield(line) { exit(77) }
            }
          }
        } catch { /* EOF retires the native security owner. */ }
        continuation.finish()
      }
    }
    func process(_ line: Data) async {
      guard caller.code() != nil else { exit(77) }
      var id = ""
      do {
        guard let value = try JSONSerialization.jsonObject(with: line) as? [String: Any],
          let requestID = value["id"] as? String, requestID.utf8.count <= 128,
          let method = value["method"] as? String else { throw CredentialError.invalidMessage }
        id = requestID
        func string(_ key: String) throws -> String {
          guard let result = value[key] as? String else { throw CredentialError.invalidMessage }; return result
        }
        func boolean(_ key: String) throws -> Bool {
          guard let result = value[key] as? NSNumber, CFGetTypeID(result) == CFBooleanGetTypeID() else { throw CredentialError.invalidMessage }
          return result.boolValue
        }
        func owner() throws -> CredentialNativeOwner {
          guard let fields = value["owner"] as? [String: String],
            Set(fields.keys) == Set(["serverId", "deviceId", "profileId"]),
            let serverId = fields["serverId"], let deviceId = fields["deviceId"], let profileId = fields["profileId"]
            else { throw CredentialError.invalidIdentity }
          return CredentialNativeOwner(serverId: serverId, deviceId: deviceId, profileId: profileId)
        }
        func keys(_ fields: String...) throws {
          guard Set(value.keys) == Set(["id", "method"] + fields) else { throw CredentialError.invalidMessage }
        }
        let result: Any
        switch method {
        case "configure": try keys("owner"); result = try host.configure(owner: owner())
        case "begin": try keys("peer", "offer", "descriptor"); result = try await host.begin(peer: string("peer"), offer: string("offer"), descriptor: string("descriptor"))
        case "receive": try keys("peer", "handle", "ciphertext"); result = try await host.receive(peer: string("peer"), handle: string("handle"), ciphertext: string("ciphertext"))
        case "response":
          try keys("peer", "handle", "requestId", "body", "success")
          result = try host.response(peer: string("peer"), handle: string("handle"), id: string("requestId"), body: string("body"), success: boolean("success"))
        case "status": try keys(); result = host.status()
        case "closeHandle": try keys("peer", "handle"); host.close(peer: try string("peer"), handle: try string("handle")); result = true
        case "closeAll": try keys(); host.closeAll(); result = true
        case "reset": try keys(); host.reset(); result = true
        case "viewerSettings": try keys("owner", "target"); result = try viewer.savedSettings(owner: owner(), target: string("target"))
        case "viewerConfigure": try keys("owner"); result = try viewer.configure(owner: owner())
        case "viewerBegin":
          try keys("target", "descriptor", "setup", "biometric")
          let setup = try boolean("setup")
          result = try await viewer.begin(target: string("target"), descriptor: string("descriptor"), setup: setup, savedOnly: !setup, biometric: boolean("biometric"))
        case "viewerAccept": try keys("handle", "offer"); result = try viewer.accept(handle: string("handle"), offer: string("offer"))
        case "viewerReceive": try keys("handle", "ciphertext"); result = try viewer.receive(handle: string("handle"), ciphertext: string("ciphertext"))
        case "viewerPassword":
          try keys("handle", "useSaved", "locale", "theme")
          result = try await viewer.password(handle: string("handle"), useSaved: boolean("useSaved"), locale: string("locale"), theme: string("theme"))
        case "viewerAuthenticationStatus": try keys("handle"); result = try viewer.authenticationStatus(handle: string("handle"))
        case "viewerForget": try keys("owner", "target"); try viewer.forgetSaved(owner: owner(), target: string("target")); result = true
        case "viewerBiometric":
          try keys("owner", "target", "enabled", "locale")
          try await viewer.changeBiometric(owner: owner(), target: string("target"), enabled: boolean("enabled"), locale: string("locale")); result = true
        case "viewerEnd": try keys("handle"); result = viewer.end(handle: try string("handle")) ?? ""
        case "viewerReset": try keys(); viewer.reset(); result = true
        default: throw CredentialError.invalidMessage
        }
        guard caller.code() != nil else { exit(77) }
        try emit(["id": id, "result": result])
      } catch {
        try? emit(["id": id, "error": (error as? CredentialError)?.rawValue ?? CredentialError.unavailable.rawValue])
      }
    }
    var jobs: [UUID: Task<Void, Never>] = [:]
    for await line in input {
      let value = try? JSONSerialization.jsonObject(with: line) as? [String: Any]
      let method = value?["method"] as? String
      if let method, ["begin", "receive", "viewerBegin", "viewerPassword", "viewerBiometric"].contains(method) {
        guard jobs.count < 8 else {
          try? emit(["id": value?["id"] as? String ?? "", "error": CredentialError.unavailable.rawValue]); continue
        }
        let id = UUID()
        jobs[id] = Task { await process(line); jobs.removeValue(forKey: id) }
      } else { await process(line) }
    }
    for job in jobs.values { job.cancel() }
    host.reset(); viewer.reset()
  }
  private static func emit(_ value: [String: Any]) throws {
    var data = try JSONSerialization.data(withJSONObject: value); data.append(10)
    try FileHandle.standardOutput.write(contentsOf: data)
  }
}
#else
@main struct UnsupportedCredentialHost { static func main() {} }
#endif
