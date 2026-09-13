import ApplicationServices
import AppKit
import Foundation

func emit(_ payload: [String: Any]) {
  guard
    let data = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]),
    let line = String(data: data, encoding: .utf8)
  else {
    return
  }
  print(line)
  fflush(stdout)
}

func listenAccessGranted() -> Bool {
  if #available(macOS 10.15, *) {
    return CGPreflightListenEventAccess()
  }
  return true
}

if CommandLine.arguments.contains("--preflight-listen-access") {
  emit(["type": "permission", "code": listenAccessGranted() ? "granted" : "denied"])
  exit(0)
}

if CommandLine.arguments.contains("--request-listen-access") {
  let granted: Bool
  if #available(macOS 10.15, *) {
    granted = CGRequestListenEventAccess()
  } else {
    granted = true
  }
  emit(["type": "permission", "code": granted ? "granted" : "denied"])
  exit(0)
}

if !listenAccessGranted() {
  emit(["type": "error", "code": "permission"])
  exit(3)
}

let modifierNames: [Int64: String] = [
  55: "MetaLeft",
  54: "MetaRight",
  58: "AltLeft",
  61: "AltRight",
  59: "ControlLeft",
  62: "ControlRight",
  56: "ShiftLeft",
  60: "ShiftRight",
  63: "Fn",
]

let modifierFlags: [String: CGEventFlags] = [
  "MetaLeft": .maskCommand,
  "MetaRight": .maskCommand,
  "AltLeft": .maskAlternate,
  "AltRight": .maskAlternate,
  "ControlLeft": .maskControl,
  "ControlRight": .maskControl,
  "ShiftLeft": .maskShift,
  "ShiftRight": .maskShift,
  "Fn": .maskSecondaryFn,
]

let modifierPeers: [UInt64: Set<String>] = [
  CGEventFlags.maskCommand.rawValue: ["MetaLeft", "MetaRight"],
  CGEventFlags.maskAlternate.rawValue: ["AltLeft", "AltRight"],
  CGEventFlags.maskControl.rawValue: ["ControlLeft", "ControlRight"],
  CGEventFlags.maskShift.rawValue: ["ShiftLeft", "ShiftRight"],
  CGEventFlags.maskSecondaryFn.rawValue: ["Fn"],
]

let standardNamesByKeyCode: [Int64: String] = [
  0: "KeyA", 1: "KeyS", 2: "KeyD", 3: "KeyF", 4: "KeyH", 5: "KeyG",
  6: "KeyZ", 7: "KeyX", 8: "KeyC", 9: "KeyV", 11: "KeyB", 12: "KeyQ",
  13: "KeyW", 14: "KeyE", 15: "KeyR", 16: "KeyY", 17: "KeyT",
  18: "Digit1", 19: "Digit2", 20: "Digit3", 21: "Digit4", 22: "Digit6",
  23: "Digit5", 24: "Equal", 25: "Digit9", 26: "Digit7", 27: "Minus",
  28: "Digit8", 29: "Digit0", 30: "BracketRight", 31: "KeyO", 32: "KeyU",
  33: "BracketLeft", 34: "KeyI", 35: "KeyP", 36: "Enter", 37: "KeyL",
  38: "KeyJ", 39: "Quote", 40: "KeyK", 41: "Semicolon", 42: "Backslash",
  43: "Comma", 44: "Slash", 45: "KeyN", 46: "KeyM", 47: "Period",
  48: "Tab", 49: "Space", 50: "Backquote", 51: "Backspace", 53: "Escape",
  64: "F17", 79: "F18", 80: "F19", 90: "F20",
  96: "F5", 97: "F6", 98: "F7", 99: "F3",
  100: "F8", 101: "F9", 103: "F11", 105: "F13",
  106: "F16", 107: "F14", 109: "F10", 111: "F12",
  113: "F15", 118: "F4", 120: "F2", 122: "F1",
  117: "Delete", 123: "ArrowLeft", 124: "ArrowRight", 125: "ArrowDown", 126: "ArrowUp",
]

enum KeyboardState {
  static var modifiers = Set<String>()
  static var namedKeysByCode: [Int64: String] = [:]
  static var otherKeyCodes = Set<Int64>()
  static var lastSnapshot: [String] = []

  static func functionName(_ event: CGEvent) -> String? {
    var length = 0
    var characters = [UniChar](repeating: 0, count: 2)
    event.keyboardGetUnicodeString(
      maxStringLength: characters.count,
      actualStringLength: &length,
      unicodeString: &characters
    )
    guard length == 1 else { return nil }
    let value = Int(characters[0])
    let first = Int(NSF1FunctionKey)
    let last = Int(NSF24FunctionKey)
    guard value >= first && value <= last else { return nil }
    return "F\(value - first + 1)"
  }

  static func publishIfChanged() {
    var snapshot = modifiers.sorted()
    snapshot.append(contentsOf: Set(namedKeysByCode.values).sorted())
    if !otherKeyCodes.isEmpty { snapshot.append("Other") }
    snapshot.sort()
    guard snapshot != lastSnapshot else { return }
    lastSnapshot = snapshot
    emit(["type": "keys", "keys": snapshot])
  }

  static func reset() {
    modifiers.removeAll()
    namedKeysByCode.removeAll()
    otherKeyCodes.removeAll()
    publishIfChanged()
  }

  static func updateModifier(_ name: String, flags: CGEventFlags) {
    guard let flag = modifierFlags[name] else { return }
    if flags.contains(flag) {
      let peers = modifierPeers[flag.rawValue] ?? []
      let anotherPeerDown = peers.contains { $0 != name && modifiers.contains($0) }
      if modifiers.contains(name) && anotherPeerDown {
        modifiers.remove(name)
      } else {
        modifiers.insert(name)
      }
    } else {
      modifiers.remove(name)
    }
    publishIfChanged()
  }

  static func updateKey(_ event: CGEvent, down: Bool) {
    let keyCode = event.getIntegerValueField(.keyboardEventKeycode)
    if down {
      if let standardName = functionName(event) ?? standardNamesByKeyCode[keyCode] {
        namedKeysByCode[keyCode] = standardName
      } else {
        otherKeyCodes.insert(keyCode)
      }
    } else if namedKeysByCode.removeValue(forKey: keyCode) == nil {
      otherKeyCodes.remove(keyCode)
    }
    publishIfChanged()
  }

  static func handle(type: CGEventType, event: CGEvent) -> Unmanaged<CGEvent>? {
    if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
      reset()
      if let eventTap = activeEventTap { CGEvent.tapEnable(tap: eventTap, enable: true) }
      return Unmanaged.passUnretained(event)
    }
    if type == .leftMouseUp || type == .rightMouseUp || type == .otherMouseUp {
      emit(["type": "mouse-up"])
      return Unmanaged.passUnretained(event)
    }
    let keyCode = event.getIntegerValueField(.keyboardEventKeycode)
    if type == .flagsChanged, let name = modifierNames[keyCode] {
      updateModifier(name, flags: event.flags)
    } else if type == .keyDown || type == .keyUp {
      updateKey(event, down: type == .keyDown)
    }
    return Unmanaged.passUnretained(event)
  }
}

var activeEventTap: CFMachPort?
let mask = (1 << CGEventType.flagsChanged.rawValue)
  | (1 << CGEventType.keyDown.rawValue)
  | (1 << CGEventType.keyUp.rawValue)
  | (1 << CGEventType.leftMouseUp.rawValue)
  | (1 << CGEventType.rightMouseUp.rawValue)
  | (1 << CGEventType.otherMouseUp.rawValue)

activeEventTap = CGEvent.tapCreate(
  tap: .cgSessionEventTap,
  place: .headInsertEventTap,
  options: .listenOnly,
  eventsOfInterest: CGEventMask(mask),
  callback: { _, type, event, _ in KeyboardState.handle(type: type, event: event) },
  userInfo: nil
)

guard let eventTap = activeEventTap else {
  emit(["type": "error", "code": "permission"])
  exit(3)
}

let runLoopSource = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, eventTap, 0)
CFRunLoopAddSource(CFRunLoopGetCurrent(), runLoopSource, .commonModes)
CGEvent.tapEnable(tap: eventTap, enable: true)
emit(["type": "ready"])
CFRunLoopRun()
