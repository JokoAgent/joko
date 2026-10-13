import Darwin
import Foundation

/// Shared by replacement host helpers. Only five nonsecret timestamps can be
/// persisted; password/account/attempt/session material never enters this file.
enum CredentialAttemptWindow {
  static func admit(directory: URL, now: TimeInterval = Date().timeIntervalSince1970) throws {
    let lockPath = directory.appendingPathComponent("credential-attempt-window.lock")
    let statePath = directory.appendingPathComponent("credential-attempt-window.json")
    let descriptor = open(lockPath.path, O_RDWR | O_CREAT | O_NOFOLLOW, 0o600)
    guard descriptor >= 0 else { throw CredentialError.unavailable }
    defer { close(descriptor) }
    try ownedRegularFile(descriptor, maximumBytes: 0)
    guard flock(descriptor, LOCK_EX | LOCK_NB) == 0 else { throw CredentialError.unavailable }
    defer { _ = flock(descriptor, LOCK_UN) }
    guard now.isFinite, now > 0 else { throw CredentialError.unavailable }
    var attempts: [TimeInterval] = []
    let existing = open(statePath.path, O_RDONLY | O_NOFOLLOW)
    if existing >= 0 {
      defer { close(existing) }
      try ownedRegularFile(existing, maximumBytes: 1024)
      var bytes = [UInt8](repeating: 0, count: 1025)
      let count = read(existing, &bytes, bytes.count)
      guard count > 0, count <= 1024,
        let values = try? JSONDecoder().decode([TimeInterval].self, from: Data(bytes.prefix(count))),
        values.count <= 5, values.allSatisfy({ $0.isFinite && $0 > 0 && $0 <= now }),
        values == values.sorted() else { throw CredentialError.unavailable }
      attempts = values.filter { now - $0 < 60 }
    } else if errno != ENOENT { throw CredentialError.unavailable }
    guard attempts.count < 5 else { throw CredentialError.unavailable }
    attempts.append(now)
    let bytes = try JSONEncoder().encode(attempts)
    let temporary = directory.appendingPathComponent(".credential-attempt-window-" + UUID().uuidString.lowercased())
    let output = open(temporary.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
    guard output >= 0 else { throw CredentialError.unavailable }
    defer { close(output); unlink(temporary.path) }
    guard bytes.withUnsafeBytes({ write(output, $0.baseAddress, $0.count) }) == bytes.count,
      fsync(output) == 0, rename(temporary.path, statePath.path) == 0 else { throw CredentialError.unavailable }
    let folder = open(directory.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
    guard folder >= 0 else { throw CredentialError.unavailable }
    defer { close(folder) }
    guard fsync(folder) == 0 else { throw CredentialError.unavailable }
  }

  private static func ownedRegularFile(_ descriptor: Int32, maximumBytes: Int) throws {
    var info = stat()
    guard fstat(descriptor, &info) == 0, info.st_mode & S_IFMT == S_IFREG,
      info.st_uid == getuid(), info.st_mode & 0o077 == 0,
      info.st_size >= 0, info.st_size <= off_t(maximumBytes) else { throw CredentialError.unavailable }
  }
}
