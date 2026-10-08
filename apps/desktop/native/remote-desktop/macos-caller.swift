#if os(macOS)
import Foundation
import Security

// Authenticate the kernel-supplied audit token on all three libuv stdio
// sockets. No argv, environment value, PID by itself, or shared secret can
// downgrade this caller check.
struct DesktopInputCaller {
  let token: Data
  let parent: pid_t
  let requirement: SecRequirement

  static func signingInfo(_ code: SecCode) -> [String: Any]? {
    var staticCode: SecStaticCode?
    var information: CFDictionary?
    guard SecCodeCopyStaticCode(code, [], &staticCode) == errSecSuccess,
      let staticCode = staticCode,
      SecCodeCopySigningInformation(
        staticCode,
        SecCSFlags(rawValue: kSecCSSigningInformation),
        &information
      ) == errSecSuccess else { return nil }
    return information as? [String: Any]
  }

  static func peer(_ descriptor: Int32) -> Data? {
    var token = audit_token_t()
    var size = socklen_t(MemoryLayout<audit_token_t>.size)
    guard getsockopt(descriptor, 0 /* SOL_LOCAL */, 6 /* LOCAL_PEERTOKEN */, &token, &size) == 0,
      size == MemoryLayout<audit_token_t>.size else { return nil }
    return withUnsafeBytes(of: token) { Data($0) }
  }

  func code() -> SecCode? {
    guard getppid() == parent else { return nil }
    var code: SecCode?
    let attributes = [kSecGuestAttributeAudit: token] as CFDictionary
    guard SecCodeCopyGuestWithAttributes(nil, attributes, [], &code) == errSecSuccess,
      let code = code,
      SecCodeCheckValidity(code, [], requirement) == errSecSuccess else { return nil }
    return code
  }

  static func hasSealedHelper(_ code: SecCode, executable: URL) -> Bool {
    var staticCode: SecStaticCode?
    guard SecCodeCopyStaticCode(code, [], &staticCode) == errSecSuccess,
      let staticCode = staticCode,
      let bytes = try? Data(contentsOf: executable) else { return false }
    return SecCodeValidateFileResource(
      staticCode,
      "Resources/native-remote-desktop/joko-macos-remote-desktop-input" as CFString,
      bytes as CFData,
      []
    ) == errSecSuccess
  }

  static func authenticate() -> DesktopInputCaller? {
    guard let token = peer(STDIN_FILENO), peer(STDOUT_FILENO) == token,
      peer(STDERR_FILENO) == token else { return nil }
    let words = token.withUnsafeBytes { Array($0.bindMemory(to: UInt32.self)) }
    let parent = getppid()
    guard parent > 1, words.count > 5, words[5] == UInt32(parent),
      words[1] == geteuid() else { return nil }

    var requirement: SecRequirement?
    let executable: URL
#if REMOTE_DESKTOP_INPUT_DEVELOPMENT
    let encodedExecutable = "REMOTE_DESKTOP_INPUT_DEVELOPMENT_EXECUTABLE"
    guard let data = Data(base64Encoded: encodedExecutable),
      let value = String(data: data, encoding: .utf8), value.hasPrefix("/") else { return nil }
    executable = URL(fileURLWithPath: value).resolvingSymlinksInPath()
    var expected: SecStaticCode?
    guard SecStaticCodeCreateWithPath(executable as CFURL, [], &expected) == errSecSuccess,
      let expected = expected,
      SecCodeCopyDesignatedRequirement(expected, [], &requirement) == errSecSuccess else { return nil }
#else
    var own: SecCode?
    guard SecCodeCopySelf([], &own) == errSecSuccess, let own = own,
      SecCodeCheckValidity(own, [], nil) == errSecSuccess,
      let info = signingInfo(own),
      let team = info[kSecCodeInfoTeamIdentifier as String] as? String,
      team.range(of: "^[A-Z0-9]+$", options: .regularExpression) != nil,
      let ownExecutable = info[kSecCodeInfoMainExecutable as String] as? URL else { return nil }
    var appURL = ownExecutable.resolvingSymlinksInPath()
    for _ in 0..<4 { appURL.deleteLastPathComponent() }
    guard let bundle = Bundle(url: appURL), bundle.bundleIdentifier == "app.joko.desktop",
      let mainExecutable = bundle.executableURL else { return nil }
    executable = mainExecutable.resolvingSymlinksInPath()
    let rule = "anchor apple generic and identifier \"app.joko.desktop\" and certificate leaf[subject.OU] = \"\(team)\""
    guard SecRequirementCreateWithString(rule as CFString, [], &requirement) == errSecSuccess else { return nil }
#endif
    guard let requirement = requirement else { return nil }
    let caller = DesktopInputCaller(token: token, parent: parent, requirement: requirement)
    guard let code = caller.code(), let info = signingInfo(code),
      let actual = info[kSecCodeInfoMainExecutable as String] as? URL,
      actual.resolvingSymlinksInPath() == executable else { return nil }
#if !REMOTE_DESKTOP_INPUT_DEVELOPMENT
    guard let flags = info[kSecCodeInfoFlags as String] as? UInt32,
      flags & 0x10000 != 0, flags & 0x0002 == 0,
      hasSealedHelper(code, executable: ownExecutable) else { return nil }
#endif
    return caller
  }
}
#endif
