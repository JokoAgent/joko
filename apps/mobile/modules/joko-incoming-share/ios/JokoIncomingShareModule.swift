import CryptoKit
import ExpoModulesCore
import Foundation
import UniformTypeIdentifiers

private let incomingShareRootName = "JokoIncomingShareV1"
private let incomingShareManifestName = "manifest.json"
private let incomingShareBindingName = "binding.json"
private let incomingShareClaimName = "claim.json"
private let incomingShareMaximumItems = 20
private let incomingShareMaximumBytes = 30 * 1024 * 1024
private let incomingShareMaximumTextItemBytes = 32 * 1024
private let incomingShareMaximumURLItemBytes = 8 * 1024
private let incomingShareMaximumTextBatchBytes = 128 * 1024
private let incomingShareMaximumManifestBytes = 256 * 1024
private let incomingShareStagingLifetime: TimeInterval = 24 * 60 * 60

private struct IncomingShareManifest: Codable {
  let version: Int
  let batchId: String
  let orderKey: String
  let createdAtUnixMs: Int64
  let overflowCount: Int
  let items: [IncomingShareManifestItem]
}

private struct IncomingShareManifestItem: Codable {
  let itemId: String
  let ordinal: Int
  let state: String
  let kind: String?
  let fileName: String?
  let mediaType: String?
  let byteSize: Int?
  let sha256Hex: String?
  let relativePath: String?
  let text: String?
  let reason: String?
}

private struct IncomingShareBinding: Codable {
  let version: Int
  let batchId: String
  let profileId: String
  let boundAtUnixMs: Int64
}

private struct IncomingShareClaim: Codable, Equatable {
  let version: Int
  let batchId: String
  let claimId: String
  let profileId: String
  let destinationKind: String
  let sessionId: String?
  let targetId: String
  let surfaceOwnerKey: String
  let policyKey: String
  let acceptedItemIds: [String]
  let acceptedItemProofs: [IncomingShareAcceptedItemProof]
  let claimedAtUnixMs: Int64
}

private struct IncomingShareAcceptedItemProof: Codable, Equatable {
  let itemId: String
  let kind: String
  let byteSize: Int
  let sha256Hex: String
  let fileName: String?
  let mediaType: String?
}

private struct ValidatedIncomingShareBatch {
  let directory: URL
  let manifest: IncomingShareManifest
  let binding: IncomingShareBinding?
  let claim: IncomingShareClaim?
  let items: [[String: Any]]
}

public final class JokoIncomingShareModule: Module {
  public func definition() -> ModuleDefinition {
    Name("JokoIncomingShare")

    AsyncFunction("getNextBatch") { () -> [String: Any]? in
      do { return try self.getNextBatch() }
      catch { throw exposedIncomingShareError(error, fallback: "The protected incoming-share inbox could not be read.") }
    }
    AsyncFunction("bindBatch") { (batchId: String, profileId: String) -> [String: Any] in
      do { return try self.bindBatch(batchId: batchId, profileId: profileId) }
      catch { throw exposedIncomingShareError(error, fallback: "The incoming share profile binding could not be saved.") }
    }
    AsyncFunction("claimBatch") {
      (
        batchId: String,
        profileId: String,
        destinationKind: String,
        sessionId: String?,
        targetId: String,
        surfaceOwnerKey: String,
        policyKey: String,
        acceptedItemIds: [String]
      ) -> [String: Any] in
      do {
        return try self.claimBatch(
          batchId: batchId,
          profileId: profileId,
          destinationKind: destinationKind,
          sessionId: sessionId,
          targetId: targetId,
          surfaceOwnerKey: surfaceOwnerKey,
          policyKey: policyKey,
          acceptedItemIds: acceptedItemIds
        )
      } catch {
        throw exposedIncomingShareError(error, fallback: "The incoming share project claim could not be saved.")
      }
    }
    AsyncFunction("acknowledgeBatch") { (batchId: String, profileId: String, claimId: String) in
      do { try self.acknowledgeBatch(batchId: batchId, profileId: profileId, claimId: claimId) }
      catch { throw exposedIncomingShareError(error, fallback: "The consumed incoming share could not be removed.") }
    }
    AsyncFunction("discardBatch") { (batchId: String) in
      do { try self.discardBatch(batchId: batchId) }
      catch { throw exposedIncomingShareError(error, fallback: "The incoming share could not be discarded.") }
    }
  }

  private var appGroupId: String {
    get throws {
      guard let value = Bundle.main.object(forInfoDictionaryKey: "ExpoShareIntoAppGroupId") as? String,
            !value.isEmpty else {
        throw incomingShareError("The Joko incoming-share App Group is not configured.")
      }
      return value
    }
  }

  private func getNextBatch() throws -> [String: Any]? {
    let root = try inboxRoot(create: false)
    guard FileManager.default.fileExists(atPath: root.path) else { return nil }
    try cleanupStaleStagingDirectories(root: root)
    guard let directory = try batchDirectories(root: root).first else { return nil }
    do {
      return batchDictionary(try validateBatch(directory))
    } catch {
      let batchId = batchIdFromDirectoryName(directory.lastPathComponent) ?? "invalid"
      return [
        "status": "invalid",
        "batchId": batchId,
        "orderKey": directory.lastPathComponent,
        "createdAtUnixMs": 0,
        "overflowCount": 0,
        "items": [],
        "invalidReason": exposedIncomingShareMessage(error, fallback: "The incoming share batch failed local validation.")
      ]
    }
  }

  private func bindBatch(batchId: String, profileId: String) throws -> [String: Any] {
    try assertBatchId(batchId)
    try assertProfileId(profileId)
    let directory = try requiredBatchDirectory(batchId: batchId)
    let current = try validateBatch(directory)
    if let binding = current.binding {
      guard binding.profileId == profileId else {
        throw incomingShareError("This incoming share is already bound to another Joko connection profile.")
      }
      return batchDictionary(current)
    }
    let binding = IncomingShareBinding(
      version: 1,
      batchId: batchId,
      profileId: profileId,
      boundAtUnixMs: Int64((Date().timeIntervalSince1970 * 1_000).rounded(.down))
    )
    let data = try JSONEncoder().encode(binding)
    try data.write(to: directory.appendingPathComponent(incomingShareBindingName), options: [.atomic, .withoutOverwriting])
    return batchDictionary(try validateBatch(directory))
  }

  private func claimBatch(
    batchId: String,
    profileId: String,
    destinationKind: String,
    sessionId: String?,
    targetId: String,
    surfaceOwnerKey: String,
    policyKey: String,
    acceptedItemIds: [String]
  ) throws -> [String: Any] {
    try assertBatchId(batchId)
    try assertProfileId(profileId)
    try assertDestination(destinationKind, sessionId: sessionId)
    try assertTargetId(targetId)
    try assertOpaqueText(surfaceOwnerKey, maximumBytes: 16_384, allowOwnerSeparators: true)
    try assertOpaqueText(policyKey, maximumBytes: 16_384, allowOwnerSeparators: false)
    let directory = try requiredBatchDirectory(batchId: batchId)
    let current = try validateBatch(directory)
    guard current.binding?.profileId == profileId else {
      throw incomingShareError("The incoming share is not bound to this Joko connection profile.")
    }
    let readyIds = current.manifest.items.sorted(by: { $0.ordinal < $1.ordinal })
      .filter { $0.state == "ready" }.map(\.itemId)
    guard acceptedItemIds.count <= readyIds.count,
          Set(acceptedItemIds).count == acceptedItemIds.count,
          acceptedItemIds.allSatisfy({ readyIds.contains($0) }),
          acceptedItemIds == readyIds.filter({ acceptedItemIds.contains($0) }) else {
      throw incomingShareError("The incoming share accepted item order is invalid.")
    }
    for itemId in acceptedItemIds { try assertBatchId(itemId) }
    if let claim = current.claim {
      guard claim.profileId == profileId, claim.destinationKind == destinationKind,
            claim.sessionId == sessionId, claim.targetId == targetId,
            claim.surfaceOwnerKey == surfaceOwnerKey, claim.policyKey == policyKey,
            claim.acceptedItemIds == acceptedItemIds else {
        throw incomingShareError("This incoming share is already claimed by another project or model authority.")
      }
      return batchDictionary(current)
    }
    let claim = IncomingShareClaim(
      version: 1,
      batchId: batchId,
      claimId: UUID().uuidString.lowercased(),
      profileId: profileId,
      destinationKind: destinationKind,
      sessionId: sessionId,
      targetId: targetId,
      surfaceOwnerKey: surfaceOwnerKey,
      policyKey: policyKey,
      acceptedItemIds: acceptedItemIds,
      acceptedItemProofs: try acceptedProofs(manifest: current.manifest, acceptedItemIds: acceptedItemIds),
      claimedAtUnixMs: Int64((Date().timeIntervalSince1970 * 1_000).rounded(.down))
    )
    let data = try JSONEncoder().encode(claim)
    try data.write(to: directory.appendingPathComponent(incomingShareClaimName), options: [.atomic, .withoutOverwriting])
    return batchDictionary(try validateBatch(directory))
  }

  private func acknowledgeBatch(batchId: String, profileId: String, claimId: String) throws {
    try assertBatchId(batchId)
    try assertProfileId(profileId)
    try assertBatchId(claimId)
    let directory = try requiredBatchDirectory(batchId: batchId)
    let batch = try validateBatch(directory)
    guard batch.binding?.profileId == profileId,
          batch.claim?.profileId == profileId,
          batch.claim?.claimId == claimId else {
      throw incomingShareError("The incoming share claim is not owned by this Joko connection profile.")
    }
    try removeExactBatch(directory)
  }

  private func discardBatch(batchId: String) throws {
    try assertBatchId(batchId)
    try removeExactBatch(requiredBatchDirectory(batchId: batchId))
  }

  private func batchDictionary(_ batch: ValidatedIncomingShareBatch) -> [String: Any] {
    var value: [String: Any] = [
      "status": "ready",
      "batchId": batch.manifest.batchId,
      "orderKey": batch.manifest.orderKey,
      "createdAtUnixMs": batch.manifest.createdAtUnixMs,
      "overflowCount": batch.manifest.overflowCount,
      "items": batch.items
    ]
    if let binding = batch.binding { value["boundProfileId"] = binding.profileId }
    if let claim = batch.claim {
      var claimValue: [String: Any] = [
        "claimId": claim.claimId,
        "destinationKind": claim.destinationKind,
        "targetId": claim.targetId,
        "surfaceOwnerKey": claim.surfaceOwnerKey,
        "policyKey": claim.policyKey,
        "acceptedItemIds": claim.acceptedItemIds,
        "acceptedItemProofs": claim.acceptedItemProofs.map { proof in
          var value: [String: Any] = [
            "itemId": proof.itemId,
            "kind": proof.kind,
            "byteSize": proof.byteSize,
            "sha256Hex": proof.sha256Hex
          ]
          if let fileName = proof.fileName { value["fileName"] = fileName }
          if let mediaType = proof.mediaType { value["mediaType"] = mediaType }
          return value
        }
      ]
      if let sessionId = claim.sessionId { claimValue["sessionId"] = sessionId }
      value["claim"] = claimValue
    }
    return value
  }

  private func validateBatch(_ directory: URL) throws -> ValidatedIncomingShareBatch {
    let root = try inboxRoot(create: false)
    try assertContainedRegularDirectory(directory, root: root)
    let directoryName = directory.lastPathComponent
    guard isOrderKey(directoryName), let derivedBatchId = batchIdFromDirectoryName(directoryName) else {
      throw incomingShareError("The incoming share directory identity is invalid.")
    }
    let manifestURL = directory.appendingPathComponent(incomingShareManifestName)
    let manifestData = try readBoundedRegularFile(manifestURL, root: directory, maximumBytes: incomingShareMaximumManifestBytes)
    let manifest: IncomingShareManifest
    do {
      manifest = try JSONDecoder().decode(IncomingShareManifest.self, from: manifestData)
    } catch {
      throw incomingShareError("The incoming share manifest is malformed.")
    }
    guard manifest.version == 1, manifest.batchId == derivedBatchId,
          manifest.orderKey == directoryName,
          manifest.createdAtUnixMs > 0,
          manifest.overflowCount >= 0, manifest.overflowCount <= 1_000_000,
          manifest.items.count <= incomingShareMaximumItems else {
      throw incomingShareError("The incoming share manifest identity or bounds are invalid.")
    }
    var itemIds = Set<String>()
    var ordinals = Set<Int>()
    var items: [[String: Any]] = []
    var textBatchBytes = 0
    for item in manifest.items.sorted(by: { $0.ordinal < $1.ordinal }) {
      try assertBatchId(item.itemId)
      guard itemIds.insert(item.itemId).inserted,
            item.ordinal >= 0, item.ordinal < incomingShareMaximumItems,
            ordinals.insert(item.ordinal).inserted else {
        throw incomingShareError("The incoming share contains a duplicate item identity or order.")
      }
      if item.state == "rejected" {
        guard item.kind == nil, item.mediaType == nil, item.byteSize == nil,
              item.sha256Hex == nil, item.relativePath == nil, item.text == nil,
              let reason = item.reason,
              !boundedMessage(reason).isEmpty, reason.count <= 512 else {
          throw incomingShareError("An incoming share rejection record is invalid.")
        }
        var rejected: [String: Any] = [
          "state": "rejected",
          "itemId": item.itemId,
          "ordinal": item.ordinal,
          "reason": boundedMessage(reason)
        ]
        if let fileName = item.fileName { rejected["fileName"] = try safeFileName(fileName) }
        items.append(rejected)
        continue
      }
      guard item.state == "ready", item.reason == nil,
            let kind = item.kind,
            let byteSize = item.byteSize,
            let sha256Hex = item.sha256Hex,
            isSha256(sha256Hex) else {
        throw incomingShareError("An incoming share item record is incomplete.")
      }
      if kind == "text" || kind == "url" {
        guard item.fileName == nil, item.mediaType == nil, item.relativePath == nil,
              let text = item.text else {
          throw incomingShareError("An incoming share text record is invalid.")
        }
        let bytes = Data(text.utf8)
        let itemLimit = kind == "url" ? incomingShareMaximumURLItemBytes : incomingShareMaximumTextItemBytes
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              bytes.count == byteSize, byteSize <= itemLimit,
              !text.unicodeScalars.contains(where: { $0.value == 0 }) else {
          throw incomingShareError("An incoming share text item changed or exceeds its limit.")
        }
        textBatchBytes += byteSize
        guard textBatchBytes <= incomingShareMaximumTextBatchBytes else {
          throw incomingShareError("An incoming share text batch exceeds its limit.")
        }
        if kind == "url" { try assertWebURL(text) }
        let digest = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
        guard digest == sha256Hex else {
          throw incomingShareError("An incoming share text item failed its SHA-256 check.")
        }
        items.append([
          "state": "ready",
          "kind": kind,
          "itemId": item.itemId,
          "ordinal": item.ordinal,
          "text": text,
          "byteSize": byteSize,
          "sha256Hex": sha256Hex
        ])
        continue
      }
      guard kind == "file", item.text == nil,
            let fileNameValue = item.fileName,
            let mediaTypeValue = item.mediaType,
            let relativePath = item.relativePath else {
        throw incomingShareError("An incoming share item record is incomplete.")
      }
      let fileName = try safeFileName(fileNameValue)
      let mediaType = try safeMediaType(mediaTypeValue)
      guard byteSize > 0, byteSize <= incomingShareMaximumBytes,
            isSha256(sha256Hex),
            relativePath == "items/\(item.itemId)/\(fileName)" else {
        throw incomingShareError("An incoming share item identity or size is invalid.")
      }
      let fileURL = directory.appendingPathComponent(relativePath, isDirectory: false)
      let bytes = try readBoundedRegularFile(fileURL, root: directory, maximumBytes: incomingShareMaximumBytes)
      guard bytes.count == byteSize else { throw incomingShareError("An incoming share file changed size.") }
      let digest = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
      guard digest == sha256Hex else { throw incomingShareError("An incoming share file failed its SHA-256 check.") }
      try assertMediaType(mediaType, matches: fileURL)
      items.append([
        "state": "ready",
        "kind": "file",
        "itemId": item.itemId,
        "ordinal": item.ordinal,
        "fileName": fileName,
        "mediaType": mediaType,
        "byteSize": byteSize,
        "sha256Hex": sha256Hex,
        "uri": fileURL.absoluteString
      ])
    }
    let binding = try readBinding(directory: directory, batchId: manifest.batchId)
    let claim = try readClaim(directory: directory, manifest: manifest, binding: binding)
    return ValidatedIncomingShareBatch(
      directory: directory,
      manifest: manifest,
      binding: binding,
      claim: claim,
      items: items
    )
  }

  private func readBinding(directory: URL, batchId: String) throws -> IncomingShareBinding? {
    let url = directory.appendingPathComponent(incomingShareBindingName)
    guard FileManager.default.fileExists(atPath: url.path) else { return nil }
    let data = try readBoundedRegularFile(url, root: directory, maximumBytes: 4 * 1024)
    let binding: IncomingShareBinding
    do {
      binding = try JSONDecoder().decode(IncomingShareBinding.self, from: data)
    } catch {
      throw incomingShareError("The incoming share profile binding is malformed.")
    }
    guard binding.version == 1, binding.batchId == batchId, binding.boundAtUnixMs > 0 else {
      throw incomingShareError("The incoming share profile binding is invalid.")
    }
    try assertProfileId(binding.profileId)
    return binding
  }

  private func readClaim(
    directory: URL,
    manifest: IncomingShareManifest,
    binding: IncomingShareBinding?
  ) throws -> IncomingShareClaim? {
    let url = directory.appendingPathComponent(incomingShareClaimName)
    guard FileManager.default.fileExists(atPath: url.path) else { return nil }
    guard let binding else { throw incomingShareError("The incoming share target claim has no profile binding.") }
    let data = try readBoundedRegularFile(url, root: directory, maximumBytes: 64 * 1024)
    let claim: IncomingShareClaim
    do {
      claim = try JSONDecoder().decode(IncomingShareClaim.self, from: data)
    } catch {
      throw incomingShareError("The incoming share target claim is malformed.")
    }
    guard claim.version == 1, claim.batchId == manifest.batchId,
          claim.profileId == binding.profileId, claim.claimedAtUnixMs > 0 else {
      throw incomingShareError("The incoming share target claim identity is invalid.")
    }
    try assertBatchId(claim.claimId)
    try assertProfileId(claim.profileId)
    try assertDestination(claim.destinationKind, sessionId: claim.sessionId)
    try assertTargetId(claim.targetId)
    try assertOpaqueText(claim.surfaceOwnerKey, maximumBytes: 16_384, allowOwnerSeparators: true)
    try assertOpaqueText(claim.policyKey, maximumBytes: 16_384, allowOwnerSeparators: false)
    let readyIds = manifest.items.sorted(by: { $0.ordinal < $1.ordinal })
      .filter { $0.state == "ready" }.map(\.itemId)
    guard claim.acceptedItemIds.count <= readyIds.count,
          Set(claim.acceptedItemIds).count == claim.acceptedItemIds.count,
          claim.acceptedItemIds.allSatisfy({ readyIds.contains($0) }),
          claim.acceptedItemIds == readyIds.filter({ claim.acceptedItemIds.contains($0) }) else {
      throw incomingShareError("The incoming share target claim item order is invalid.")
    }
    for itemId in claim.acceptedItemIds { try assertBatchId(itemId) }
    guard claim.acceptedItemProofs == (try acceptedProofs(
      manifest: manifest,
      acceptedItemIds: claim.acceptedItemIds
    )) else {
      throw incomingShareError("The incoming share claimed content changed.")
    }
    return claim
  }

  private func acceptedProofs(
    manifest: IncomingShareManifest,
    acceptedItemIds: [String]
  ) throws -> [IncomingShareAcceptedItemProof] {
    let accepted = Set(acceptedItemIds)
    return try manifest.items.sorted(by: { $0.ordinal < $1.ordinal })
      .filter { accepted.contains($0.itemId) }
      .map { item in
        guard item.state == "ready", let kind = item.kind,
              let byteSize = item.byteSize, let sha256Hex = item.sha256Hex else {
          throw incomingShareError("The incoming share claimed item is not ready.")
        }
        return IncomingShareAcceptedItemProof(
          itemId: item.itemId,
          kind: kind,
          byteSize: byteSize,
          sha256Hex: sha256Hex,
          fileName: kind == "file" ? item.fileName : nil,
          mediaType: kind == "file" ? item.mediaType : nil
        )
      }
  }

  private func assertMediaType(_ mediaType: String, matches fileURL: URL) throws {
    let declared = UTType(mimeType: mediaType)
    let byExtension = UTType(filenameExtension: fileURL.pathExtension)
    if let declared {
      if declared.conforms(to: .audio) || declared.conforms(to: .movie)
        || declared.conforms(to: .audiovisualContent) {
        throw incomingShareError("Audio and video are not supported by this incoming share surface.")
      }
    }
    if let byExtension {
      if byExtension.conforms(to: .audio) || byExtension.conforms(to: .movie)
        || byExtension.conforms(to: .audiovisualContent) {
        throw incomingShareError("The incoming share file extension is not supported.")
      }
      if let preferred = byExtension.preferredMIMEType, preferred.lowercased() != mediaType {
        throw incomingShareError("The incoming share MIME type does not match its file extension.")
      }
    }
    if let declared, let byExtension,
       !declared.conforms(to: byExtension), !byExtension.conforms(to: declared) {
      throw incomingShareError("The incoming share MIME type does not match its file extension.")
    }
    if mediaType.hasPrefix("image/"), let byExtension, !byExtension.conforms(to: .image) {
      throw incomingShareError("The incoming share image extension is inconsistent.")
    }
    if let byExtension, byExtension.conforms(to: .image), !mediaType.hasPrefix("image/") {
      throw incomingShareError("The incoming share image MIME type is inconsistent.")
    }
  }

  private func inboxRoot(create: Bool) throws -> URL {
    guard let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: try appGroupId) else {
      throw incomingShareError("The Joko incoming-share App Group container is unavailable.")
    }
    let root = container.appendingPathComponent(incomingShareRootName, isDirectory: true)
    if create && !FileManager.default.fileExists(atPath: root.path) {
      try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }
    if FileManager.default.fileExists(atPath: root.path) {
      try assertContainedRegularDirectory(root, root: container)
    }
    return root
  }

  private func batchDirectories(root: URL) throws -> [URL] {
    let urls = try FileManager.default.contentsOfDirectory(
      at: root,
      includingPropertiesForKeys: [.isDirectoryKey, .isSymbolicLinkKey],
      options: [.skipsHiddenFiles]
    )
    return urls.filter { isOrderKey($0.lastPathComponent) }.sorted { $0.lastPathComponent < $1.lastPathComponent }
  }

  private func requiredBatchDirectory(batchId: String) throws -> URL {
    let root = try inboxRoot(create: false)
    guard FileManager.default.fileExists(atPath: root.path) else {
      throw incomingShareError("The incoming share batch is no longer available.")
    }
    let matches = try batchDirectories(root: root).filter { batchIdFromDirectoryName($0.lastPathComponent) == batchId }
    guard matches.count == 1, let directory = matches.first else {
      throw incomingShareError(matches.isEmpty
        ? "The incoming share batch is no longer available."
        : "The incoming share batch identity is duplicated.")
    }
    try assertContainedRegularDirectory(directory, root: root)
    return directory
  }

  private func removeExactBatch(_ directory: URL) throws {
    let root = try inboxRoot(create: false)
    try assertContainedRegularDirectory(directory, root: root)
    try FileManager.default.removeItem(at: directory)
    if FileManager.default.fileExists(atPath: directory.path) {
      throw incomingShareError("The incoming share files could not be removed.")
    }
  }

  private func cleanupStaleStagingDirectories(root: URL) throws {
    let now = Date()
    let urls = try FileManager.default.contentsOfDirectory(
      at: root,
      includingPropertiesForKeys: [.isDirectoryKey, .isSymbolicLinkKey, .contentModificationDateKey],
      options: [.skipsHiddenFiles]
    )
    for url in urls where url.lastPathComponent.hasPrefix("staging-") {
      let values = try url.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey, .contentModificationDateKey])
      guard values.isDirectory == true, values.isSymbolicLink != true,
            let modified = values.contentModificationDate,
            now.timeIntervalSince(modified) >= incomingShareStagingLifetime else { continue }
      try assertContainedRegularDirectory(url, root: root)
      try FileManager.default.removeItem(at: url)
    }
  }
}

private func readBoundedRegularFile(_ url: URL, root: URL, maximumBytes: Int) throws -> Data {
  try assertContained(url, root: root)
  let values = try url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey])
  guard values.isRegularFile == true, values.isSymbolicLink != true,
        let size = values.fileSize, size > 0, size <= maximumBytes else {
    throw incomingShareError("An incoming share path is not a bounded regular file.")
  }
  let data = try Data(contentsOf: url, options: [.mappedIfSafe, .uncached])
  guard data.count == size else { throw incomingShareError("An incoming share file changed while it was read.") }
  return data
}

private func assertContainedRegularDirectory(_ url: URL, root: URL) throws {
  try assertContained(url, root: root)
  let values = try url.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
  guard values.isDirectory == true, values.isSymbolicLink != true else {
    throw incomingShareError("An incoming share directory is invalid.")
  }
}

private func assertContained(_ url: URL, root: URL) throws {
  let exactRoot = root.standardizedFileURL.resolvingSymlinksInPath().path
  let exactURL = url.standardizedFileURL.resolvingSymlinksInPath().path
  guard exactURL == exactRoot || exactURL.hasPrefix(exactRoot + "/") else {
    throw incomingShareError("An incoming share path escapes the Joko App Group inbox.")
  }
}

private func safeFileName(_ value: String) throws -> String {
  let normalized = value.precomposedStringWithCanonicalMapping
  guard !normalized.isEmpty, normalized != ".", normalized != "..",
        normalized == URL(fileURLWithPath: normalized).lastPathComponent,
        !normalized.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }),
        let count = normalized.data(using: .utf8)?.count, count <= 240 else {
    throw incomingShareError("An incoming share file name is unsafe.")
  }
  return normalized
}

private func safeMediaType(_ value: String) throws -> String {
  let normalized = value.lowercased()
  guard normalized == value, normalized.count <= 255,
        normalized.range(
          of: "^[a-z0-9!#$&^_.+-]+/[a-z0-9!#$&^_.+-]+$",
          options: .regularExpression
        ) != nil else {
    throw incomingShareError("An incoming share MIME type is invalid.")
  }
  return normalized
}

private func assertBatchId(_ value: String) throws {
  guard value.range(
    of: "^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    options: .regularExpression
  ) != nil,
  let uuid = UUID(uuidString: value), uuid.uuidString.lowercased() == value else {
    throw incomingShareError("The incoming share identity is invalid.")
  }
}

private func assertProfileId(_ value: String) throws {
  guard value.range(of: "^[A-Za-z0-9_-]{1,128}$", options: .regularExpression) != nil else {
    throw incomingShareError("The Joko connection profile identity is invalid.")
  }
}

private func assertTargetId(_ value: String) throws {
  guard value.range(of: "^[A-Za-z0-9_-]{1,128}$", options: .regularExpression) != nil else {
    throw incomingShareError("The Joko project identity is invalid.")
  }
}

private func assertDestination(_ kind: String, sessionId: String?) throws {
  if kind == "new_task" {
    guard sessionId == nil else {
      throw incomingShareError("The incoming share new-task destination cannot name a session.")
    }
    return
  }
  guard kind == "existing_task", let sessionId,
        sessionId.range(of: "^[A-Za-z0-9_-]{1,128}$", options: .regularExpression) != nil else {
    throw incomingShareError("The incoming share existing-task destination is invalid.")
  }
}

private func assertWebURL(_ value: String) throws {
  guard value.hasPrefix("http://") || value.hasPrefix("https://"),
        !value.unicodeScalars.contains(where: { $0.value <= 0x20 || $0.value == 0x7f }) else {
    throw incomingShareError("An incoming share web URL is invalid.")
  }
  guard let components = URLComponents(string: value),
        let scheme = components.scheme, ["http", "https"].contains(scheme),
        let host = components.host, !host.isEmpty, components.url != nil else {
    throw incomingShareError("An incoming share web URL is invalid.")
  }
}

private func assertOpaqueText(
  _ value: String,
  maximumBytes: Int,
  allowOwnerSeparators: Bool
) throws {
  guard !value.isEmpty, let data = value.data(using: .utf8), data.count <= maximumBytes else {
    throw incomingShareError("The incoming share authority claim is invalid.")
  }
  let disallowed = CharacterSet.controlCharacters.subtracting(
    allowOwnerSeparators ? CharacterSet(charactersIn: "\u{001e}\u{001f}") : CharacterSet()
  )
  guard !value.unicodeScalars.contains(where: { disallowed.contains($0) }) else {
    throw incomingShareError("The incoming share authority claim contains invalid control characters.")
  }
}

private func isOrderKey(_ value: String) -> Bool {
  value.range(
    of: "^batch-[0-9]{20}-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    options: .regularExpression
  ) != nil
}

private func batchIdFromDirectoryName(_ value: String) -> String? {
  guard isOrderKey(value) else { return nil }
  let candidate = String(value.suffix(36))
  guard let uuid = UUID(uuidString: candidate), uuid.uuidString.lowercased() == candidate else { return nil }
  return candidate
}

private func isSha256(_ value: String) -> Bool {
  value.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil
}

private func boundedMessage(_ value: String) -> String {
  String(value.trimmingCharacters(in: .whitespacesAndNewlines).prefix(512))
}

private func exposedIncomingShareMessage(_ error: Error, fallback: String) -> String {
  let native = error as NSError
  return native.domain == "app.joko.incoming-share"
    ? boundedMessage(native.localizedDescription)
    : fallback
}

private func exposedIncomingShareError(_ error: Error, fallback: String) -> NSError {
  incomingShareError(exposedIncomingShareMessage(error, fallback: fallback))
}

private func incomingShareError(_ message: String) -> NSError {
  NSError(domain: "app.joko.incoming-share", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
}
