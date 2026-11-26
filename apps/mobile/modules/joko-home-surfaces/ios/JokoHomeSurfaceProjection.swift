import ActivityKit
import Foundation

struct JokoHomeSurfaceProjection: Codable, Equatable {
  struct Quota: Codable, Equatable {
    let title: String
    let remaining: Int
    let resetsAt: Int64?
  }

  struct Usage: Codable, Equatable {
    let day: String
    let totalTokens: String
    let costUsd: Double?
    let estimated: Bool?
  }

  let owner: String
  let locale: String
  let expiresAt: Int64
  let quotas: [Quota]
  let usage: Usage?

  static let quotaKind = "JokoQuota"
  static let usageKind = "JokoUsage"
  static let maximumBytes = 12 * 1024

  var expiration: Date { Date(timeIntervalSince1970: Double(expiresAt) / 1000) }
  var chinese: Bool { locale == "zh-CN" }

  static var file: URL? {
    guard let group = Bundle.main.object(forInfoDictionaryKey: "JokoHomeSurfaceGroup") as? String else { return nil }
    return FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group)?
      .appendingPathComponent("home-surfaces-v1.json", isDirectory: false)
  }

  static func read() -> JokoHomeSurfaceProjection? {
    guard let file, let size = try? file.resourceValues(forKeys: [.fileSizeKey]).fileSize,
          size > 0, size <= maximumBytes, let bytes = try? Data(contentsOf: file) else { return nil }
    return decode(bytes)
  }

  static func decode(_ bytes: Data) -> JokoHomeSurfaceProjection? {
    guard bytes.count <= maximumBytes, let result = try? JSONDecoder().decode(Self.self, from: bytes),
          validOwner(result.owner), ["en", "zh-CN"].contains(result.locale), result.quotas.count <= 12,
          result.quotas.allSatisfy({ $0.title.count <= 100 && !$0.title.isEmpty && (0...100).contains($0.remaining) }),
          result.usage.map({ !$0.day.isEmpty && $0.day.count == 10 && !$0.totalTokens.isEmpty
            && $0.totalTokens.utf8.count <= 32 && $0.totalTokens.utf8.allSatisfy({ (48...57).contains($0) })
            && ($0.costUsd.map({ $0.isFinite && $0 >= 0 }) ?? true) }) ?? true else { return nil }
    return result
  }

  static func validOwner(_ owner: String) -> Bool {
    owner.utf8.count == 64 && owner.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
  }
}

struct JokoTaskActivityAttributes: ActivityAttributes {
  struct ContentState: Codable, Hashable {
    let title: String
    let phase: String
    let locale: String
    let link: String
    let expiresAt: Int64
    let runningCount: Int?
    let attentionCount: Int?

    var expiration: Date { Date(timeIntervalSince1970: Double(expiresAt) / 1000) }
    var taskURL: URL? {
      guard let url = URL(string: link), url.scheme == "joko", url.host == "task", url.user == nil,
            url.password == nil, url.port == nil, url.fragment == nil,
            let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
            components.queryItems?.map(\.name).sorted() == ["profile", "server"] else { return nil }
      return url
    }

    var valid: Bool {
      title.count <= 120 && !title.isEmpty && ["running", "waiting", "completed", "failed"].contains(phase) &&
        ["en", "zh-CN"].contains(locale) && link.utf8.count <= 1536 && taskURL != nil &&
        (0...100000).contains(runningCount ?? 0) && (0...100000).contains(attentionCount ?? 0)
    }

    var taskCounts: String {
      let running = runningCount ?? 0
      let attention = attentionCount ?? 0
      let chinese = locale == "zh-CN"
      return [attention > 0 ? (chinese ? "待查看 \(attention)" : "\(attention) to review") : nil,
              running > 0 ? (chinese ? "运行中 \(running)" : "\(running) running") : nil]
        .compactMap { $0 }.joined(separator: " · ")
    }

    func status(stale: Bool) -> String {
      let chinese = locale == "zh-CN"
      if stale { return chinese ? "打开 Joko 刷新" : "Open Joko to refresh" }
      switch phase {
      case "waiting": return chinese ? "等待确认" : "Waiting for you"
      case "completed": return chinese ? "已完成" : "Completed"
      case "failed": return chinese ? "运行失败" : "Failed"
      default: return chinese ? "运行中" : "Running"
      }
    }

    func symbol(stale: Bool) -> String {
      if stale { return "clock" }
      switch phase {
      case "waiting": return "hand.raised"
      case "completed": return "checkmark.circle"
      case "failed": return "exclamationmark.circle"
      default: return "bolt.fill"
      }
    }
  }

  let owner: String
  let task: String
}
