import Foundation
import CoreFoundation

enum RemoteDesktopBridgeNumber {
  /// Expo's untyped JS dictionaries contain Double, not Swift Int. Keep the
  /// wire contract strict: no truncation, booleans or unsafe JS integers.
  static func integer(_ value: Any?) -> Int? {
    guard let number = value as? NSNumber,
          CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
    let value = number.doubleValue
    guard value.isFinite, abs(value) <= 9_007_199_254_740_991 else { return nil }
    return Int(exactly: value)
  }

  static func finite(_ value: Any?) -> Double? {
    guard let number = value as? NSNumber,
          CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
    let result = number.doubleValue
    return result.isFinite ? result : nil
  }

  static func boolean(_ value: Any?) -> Bool? {
    guard let number = value as? NSNumber,
          CFGetTypeID(number) == CFBooleanGetTypeID() else { return nil }
    return number.boolValue
  }

  static func generation(_ value: Any?) -> String? {
    guard let text = value as? String, !text.isEmpty, text.utf8.count <= 20,
          text.first != "0", text.utf8.allSatisfy({ $0 >= 48 && $0 <= 57 }),
          let number = UInt64(text), number > 0 else { return nil }
    return text
  }

  static func uuid(_ value: Any?) -> String? {
    guard let text = value as? String, let parsed = UUID(uuidString: text),
          parsed.uuidString.lowercased() == text else { return nil }
    let bytes = Array(text.utf8)
    guard bytes[14] == 52, [56, 57, 97, 98].contains(bytes[19]) else { return nil }
    return text
  }
}

struct RemoteDesktopInputGrant: Equatable {
  let attemptId: String
  let controlGeneration: String
  let sequenceBase: Int
  let sequenceLimit: Int

  init?(_ value: [String: Any]) {
    guard Set(value.keys) == ["attemptId", "controlGeneration", "sequenceBase", "sequenceLimit"],
          let attemptId = RemoteDesktopBridgeNumber.uuid(value["attemptId"]),
          let generation = RemoteDesktopBridgeNumber.generation(value["controlGeneration"]),
          let base = RemoteDesktopBridgeNumber.integer(value["sequenceBase"]), base >= 0,
          let limit = RemoteDesktopBridgeNumber.integer(value["sequenceLimit"]), limit > base else { return nil }
    self.attemptId = attemptId
    controlGeneration = generation
    sequenceBase = base
    sequenceLimit = limit
  }

  func matches(_ message: [String: Any]) -> Bool {
    message["attemptId"] as? String == attemptId &&
      message["controlGeneration"] as? String == controlGeneration &&
      RemoteDesktopBridgeNumber.integer(message["sequenceBase"]) == sequenceBase &&
      RemoteDesktopBridgeNumber.integer(message["sequenceLimit"]) == sequenceLimit
  }
}

enum RemoteDesktopInputWire {
  private static let keys: Set<String> = Set(
    "ABCDEFGHIJKLMNOPQRSTUVWXYZ".map { "Key\($0)" } + "0123456789".map { "Digit\($0)" } +
    (1...12).map { "F\($0)" } + [
      "Enter", "Escape", "Tab", "Space", "Backspace", "Delete", "Insert", "Home", "End",
      "PageUp", "PageDown", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "ShiftLeft",
      "ControlLeft", "AltLeft", "MetaLeft", "Minus", "Equal", "BracketLeft", "BracketRight",
      "Backslash", "Semicolon", "Quote", "Backquote", "Comma", "Period", "Slash"
    ])

  private static func unit(_ value: Any?) -> Bool {
    guard let number = RemoteDesktopBridgeNumber.finite(value) else { return false }
    return number >= 0 && number <= 1
  }

  static func encode(sequence: Int, events: [[String: Any]]) -> Data? {
    guard sequence >= 1, !events.isEmpty, events.count <= 64 else { return nil }
    for event in events {
      let fields = Set(event.keys)
      switch event["kind"] as? String {
      case "move":
        guard fields == ["kind", "x", "y"], unit(event["x"]), unit(event["y"]) else { return nil }
      case "button":
        guard fields == ["kind", "x", "y", "button", "down"], unit(event["x"]), unit(event["y"]),
              let button = RemoteDesktopBridgeNumber.integer(event["button"]), (0...2).contains(button),
              RemoteDesktopBridgeNumber.boolean(event["down"]) != nil else { return nil }
      case "scroll":
        guard fields == ["kind", "dx", "dy"],
              let x = RemoteDesktopBridgeNumber.finite(event["dx"]), abs(x) <= 2_000,
              let y = RemoteDesktopBridgeNumber.finite(event["dy"]), abs(y) <= 2_000 else { return nil }
      case "key":
        guard fields == ["kind", "code", "down"], let code = event["code"] as? String, keys.contains(code),
              RemoteDesktopBridgeNumber.boolean(event["down"]) != nil else { return nil }
      case "text":
        guard fields == ["kind", "text"], let text = event["text"] as? String,
              !text.isEmpty, text.utf16.count <= 4_096 else { return nil }
      case "release":
        guard fields == ["kind"] else { return nil }
      default: return nil
      }
    }
    guard let encodedEvents = try? JSONSerialization.data(withJSONObject: events, options: [.withoutEscapingSlashes]),
          let text = String(data: encodedEvents, encoding: .utf8), text.utf16.count <= 16_384,
          let data = try? JSONSerialization.data(withJSONObject: ["sequence": sequence, "events": events],
            options: [.withoutEscapingSlashes]), data.count <= 32_768 else { return nil }
    return data
  }
}
