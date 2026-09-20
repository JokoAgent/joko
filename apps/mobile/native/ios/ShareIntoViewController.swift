import CryptoKit
import Foundation
import Social
import UIKit
import UniformTypeIdentifiers

private let inboxDirectoryName = "JokoIncomingShareV1"
private let manifestFileName = "manifest.json"
private let maximumItems = 20
private let maximumItemBytes = 30 * 1024 * 1024

private struct ShareManifest: Codable {
  let version: Int
  let batchId: String
  let orderKey: String
  let createdAtUnixMs: Int64
  let overflowCount: Int
  let items: [ShareManifestItem]
}

private struct ShareManifestItem: Codable {
  let itemId: String
  let ordinal: Int
  let state: String
  let fileName: String?
  let mediaType: String?
  let byteSize: Int?
  let sha256Hex: String?
  let relativePath: String?
  let reason: String?
}

private enum StoredProviderResult {
  case ready(fileName: String, mediaType: String, byteSize: Int, sha256Hex: String, relativePath: String)
  case rejected(fileName: String?, reason: String)
}

final class ShareIntoViewController: SLComposeServiceViewController {
  private var processing = false

  private var hostAppScheme: String {
    guard let value = Bundle.main.object(forInfoDictionaryKey: "MainTargetUrlScheme") as? String,
          !value.isEmpty else {
      fatalError("Joko incoming sharing requires MainTargetUrlScheme in the extension Info.plist.")
    }
    return value
  }

  private var appGroupId: String {
    guard let value = Bundle.main.object(forInfoDictionaryKey: "AppGroupId") as? String,
          !value.isEmpty else {
      fatalError("Joko incoming sharing requires AppGroupId in the extension Info.plist.")
    }
    return value
  }

  override func isContentValid() -> Bool { true }

  override func viewDidAppear(_ animated: Bool) {
    super.viewDidAppear(animated)
    beginProcessingIfNeeded()
  }

  override func didSelectPost() {
    beginProcessingIfNeeded()
  }

  private func beginProcessingIfNeeded() {
    guard !processing else { return }
    processing = true
    guard let inputItems = extensionContext?.inputItems as? [NSExtensionItem] else {
      finishWithFailure("The shared items were unavailable.")
      return
    }
    Task { @MainActor in
      do {
        try await persistBatch(inputItems)
        openParentApp()
        extensionContext?.completeRequest(returningItems: nil)
      } catch {
        finishWithFailure(safeFailureMessage(error, fallback: "The shared items could not be copied into the protected Joko inbox."))
      }
    }
  }

  private func persistBatch(_ inputItems: [NSExtensionItem]) async throws {
    guard let container = FileManager.default.containerURL(
      forSecurityApplicationGroupIdentifier: appGroupId
    ) else {
      throw shareError("The Joko App Group container is unavailable.")
    }
    let providers = inputItems.flatMap { $0.attachments ?? [] }
    guard !providers.isEmpty else { throw shareError("No file or image was shared.") }

    let batchId = UUID().uuidString.lowercased()
    let createdAt = Date()
    let createdAtUnixMs = Int64((createdAt.timeIntervalSince1970 * 1_000).rounded(.down))
    let createdAtUnixMicros = UInt64(max(0, (createdAt.timeIntervalSince1970 * 1_000_000).rounded(.down)))
    let orderKey = String(format: "batch-%020llu-%@", createdAtUnixMicros, batchId)
    let root = container.appendingPathComponent(inboxDirectoryName, isDirectory: true)
    let staging = root.appendingPathComponent("staging-\(batchId)", isDirectory: true)
    let final = root.appendingPathComponent(orderKey, isDirectory: true)
    let fileManager = FileManager.default
    try fileManager.createDirectory(
      at: root,
      withIntermediateDirectories: true,
      attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication]
    )
    guard !fileManager.fileExists(atPath: staging.path), !fileManager.fileExists(atPath: final.path) else {
      throw shareError("The incoming share identity is already in use.")
    }
    try fileManager.createDirectory(at: staging, withIntermediateDirectories: false)
    var completed = false
    defer {
      if !completed { try? fileManager.removeItem(at: staging) }
    }

    var manifestItems: [ShareManifestItem] = []
    for (ordinal, provider) in providers.prefix(maximumItems).enumerated() {
      let itemId = UUID().uuidString.lowercased()
      let itemDirectory = staging
        .appendingPathComponent("items", isDirectory: true)
        .appendingPathComponent(itemId, isDirectory: true)
      let result = await store(provider: provider, itemDirectory: itemDirectory, itemId: itemId)
      switch result {
      case let .ready(fileName, mediaType, byteSize, sha256Hex, relativePath):
        manifestItems.append(ShareManifestItem(
          itemId: itemId,
          ordinal: ordinal,
          state: "ready",
          fileName: fileName,
          mediaType: mediaType,
          byteSize: byteSize,
          sha256Hex: sha256Hex,
          relativePath: relativePath,
          reason: nil
        ))
      case let .rejected(fileName, reason):
        manifestItems.append(ShareManifestItem(
          itemId: itemId,
          ordinal: ordinal,
          state: "rejected",
          fileName: fileName,
          mediaType: nil,
          byteSize: nil,
          sha256Hex: nil,
          relativePath: nil,
          reason: reason
        ))
      }
    }

    let manifest = ShareManifest(
      version: 1,
      batchId: batchId,
      orderKey: orderKey,
      createdAtUnixMs: createdAtUnixMs,
      overflowCount: max(0, providers.count - maximumItems),
      items: manifestItems
    )
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    let manifestData = try encoder.encode(manifest)
    guard manifestData.count <= 256 * 1024 else { throw shareError("The incoming share manifest is too large.") }
    try manifestData.write(to: staging.appendingPathComponent(manifestFileName), options: .atomic)
    try fileManager.moveItem(at: staging, to: final)
    completed = true
  }

  private func store(
    provider: NSItemProvider,
    itemDirectory: URL,
    itemId: String
  ) async -> StoredProviderResult {
    guard let type = preferredType(for: provider) else {
      return .rejected(fileName: safeOptionalName(provider.suggestedName), reason: "Only files and still images can be added to a new task.")
    }
    do {
      try FileManager.default.createDirectory(at: itemDirectory, withIntermediateDirectories: true)
      let stored = try await loadAndCopy(provider: provider, type: type, itemDirectory: itemDirectory)
      let relativePath = "items/\(itemId)/\(stored.fileName)"
      return .ready(
        fileName: stored.fileName,
        mediaType: stored.mediaType,
        byteSize: stored.byteSize,
        sha256Hex: stored.sha256Hex,
        relativePath: relativePath
      )
    } catch {
      try? FileManager.default.removeItem(at: itemDirectory)
      return .rejected(
        fileName: safeOptionalName(provider.suggestedName),
        reason: safeFailureMessage(error, fallback: "The shared item could not be copied into the protected Joko inbox.")
      )
    }
  }

  private func preferredType(for provider: NSItemProvider) -> UTType? {
    let types = provider.registeredTypeIdentifiers.compactMap(UTType.init)
    if let image = types.first(where: { $0.conforms(to: .image) }) { return image }
    return types.first(where: isAllowedFileType)
  }

  private func isAllowedFileType(_ type: UTType) -> Bool {
    if type.conforms(to: .audio) || type.conforms(to: .movie) || type.conforms(to: .audiovisualContent) {
      return false
    }
    if type.conforms(to: .url) && !type.conforms(to: .fileURL) { return false }
    return type.conforms(to: .data) || type.conforms(to: .fileURL)
  }

  private struct StoredFile {
    let fileName: String
    let mediaType: String
    let byteSize: Int
    let sha256Hex: String
  }

  private func loadAndCopy(
    provider: NSItemProvider,
    type: UTType,
    itemDirectory: URL
  ) async throws -> StoredFile {
    try await withCheckedThrowingContinuation { continuation in
      provider.loadFileRepresentation(forTypeIdentifier: type.identifier) { sourceURL, fileError in
        if let sourceURL {
          do {
            continuation.resume(returning: try self.copyFile(
              sourceURL,
              suggestedName: provider.suggestedName,
              declaredType: type,
              itemDirectory: itemDirectory
            ))
          } catch {
            continuation.resume(throwing: error)
          }
          return
        }
        provider.loadDataRepresentation(forTypeIdentifier: type.identifier) { data, dataError in
          guard let data else {
            continuation.resume(throwing: dataError ?? fileError ?? self.shareError("The shared item could not be read."))
            return
          }
          do {
            continuation.resume(returning: try self.writeData(
              data,
              suggestedName: provider.suggestedName,
              declaredType: type,
              itemDirectory: itemDirectory
            ))
          } catch {
            continuation.resume(throwing: error)
          }
        }
      }
    }
  }

  private func copyFile(
    _ source: URL,
    suggestedName: String?,
    declaredType: UTType,
    itemDirectory: URL
  ) throws -> StoredFile {
    let values = try source.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey])
    guard values.isRegularFile == true, values.isSymbolicLink != true else {
      throw shareError("The shared item is not a regular file.")
    }
    guard let byteSize = values.fileSize, byteSize > 0 else { throw shareError("The shared file is empty.") }
    guard byteSize <= maximumItemBytes else { throw shareError("The shared file exceeds the 30 MB attachment limit.") }
    let sourceName = source.lastPathComponent.isEmpty ? suggestedName : source.lastPathComponent
    let fileName = try resolvedFileName(sourceName, declaredType: declaredType)
    let destination = itemDirectory.appendingPathComponent(fileName, isDirectory: false)
    try FileManager.default.copyItem(at: source, to: destination)
    return try inspectStoredFile(destination, fileName: fileName, declaredType: declaredType)
  }

  private func writeData(
    _ data: Data,
    suggestedName: String?,
    declaredType: UTType,
    itemDirectory: URL
  ) throws -> StoredFile {
    guard !data.isEmpty else { throw shareError("The shared file is empty.") }
    guard data.count <= maximumItemBytes else { throw shareError("The shared file exceeds the 30 MB attachment limit.") }
    let fileName = try resolvedFileName(suggestedName, declaredType: declaredType)
    let destination = itemDirectory.appendingPathComponent(fileName, isDirectory: false)
    try data.write(to: destination, options: [.atomic, .withoutOverwriting])
    return try inspectStoredFile(destination, fileName: fileName, declaredType: declaredType)
  }

  private func inspectStoredFile(_ url: URL, fileName: String, declaredType: UTType) throws -> StoredFile {
    let values = try url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey])
    guard values.isRegularFile == true, values.isSymbolicLink != true,
          let byteSize = values.fileSize, byteSize > 0, byteSize <= maximumItemBytes else {
      throw shareError("The copied shared file is invalid.")
    }
    let extensionType = UTType(filenameExtension: url.pathExtension)
    if let extensionType,
       !declaredType.conforms(to: extensionType),
       !extensionType.conforms(to: declaredType),
       declaredType != .data,
       declaredType != .content,
       declaredType != .item,
       declaredType != .fileURL {
      throw shareError("The shared file extension does not match its declared type.")
    }
    let effectiveType = extensionType ?? declaredType
    guard !effectiveType.conforms(to: .audio), !effectiveType.conforms(to: .movie),
          !effectiveType.conforms(to: .audiovisualContent) else {
      throw shareError("Audio and video are not supported by this share target.")
    }
    let mediaType = effectiveType.preferredMIMEType ?? declaredType.preferredMIMEType ?? "application/octet-stream"
    if (declaredType.conforms(to: .image) || effectiveType.conforms(to: .image)) && !mediaType.hasPrefix("image/") {
      throw shareError("The shared image type is inconsistent.")
    }
    let data = try Data(contentsOf: url, options: [.mappedIfSafe, .uncached])
    guard data.count == byteSize else { throw shareError("The shared file changed while it was copied.") }
    let digest = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    return StoredFile(fileName: fileName, mediaType: mediaType.lowercased(), byteSize: byteSize, sha256Hex: digest)
  }

  private func resolvedFileName(_ proposed: String?, declaredType: UTType) throws -> String {
    var value = proposed?.precomposedStringWithCanonicalMapping ?? ""
    if value.isEmpty {
      value = declaredType.conforms(to: .image) ? "Shared image" : "Shared file"
    }
    if URL(fileURLWithPath: value).pathExtension.isEmpty,
       let preferredExtension = declaredType.preferredFilenameExtension {
      value += ".\(preferredExtension)"
    }
    guard value == URL(fileURLWithPath: value).lastPathComponent,
          value != ".", value != "..",
          !value.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }),
          let utf8Count = value.data(using: .utf8)?.count,
          utf8Count > 0, utf8Count <= 240 else {
      throw shareError("The shared file name is unsafe.")
    }
    return value
  }

  private func safeOptionalName(_ value: String?) -> String? {
    guard let value, !value.isEmpty, value == URL(fileURLWithPath: value).lastPathComponent,
          !value.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }),
          let utf8Count = value.data(using: .utf8)?.count, utf8Count <= 240 else {
      return nil
    }
    return value
  }

  private func boundedReason(_ value: String) -> String {
    let normalized = value.trimmingCharacters(in: .whitespacesAndNewlines)
    return String((normalized.isEmpty ? "The shared item could not be imported." : normalized).prefix(512))
  }

  private func safeFailureMessage(_ error: Error, fallback: String) -> String {
    let native = error as NSError
    return native.domain == "app.joko.incoming-share"
      ? boundedReason(native.localizedDescription)
      : fallback
  }

  private func openParentApp() {
    guard let url = URL(string: "\(hostAppScheme)://expo-sharing") else {
      fatalError("The configured Joko URL scheme is invalid.")
    }
    var responder: UIResponder? = self
    while let current = responder {
      if let application = current as? UIApplication {
        application.open(url, options: [:])
        return
      }
      responder = current.next
    }
  }

  private func finishWithFailure(_ message: String) {
    let error = shareError(boundedReason(message))
    extensionContext?.cancelRequest(withError: error)
  }

  private func shareError(_ message: String) -> NSError {
    NSError(domain: "app.joko.incoming-share", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
  }
}
