import Foundation
import ApplicationServices
import AppKit
import Security

guard let inputCaller = DesktopInputCaller.authenticate() else { exit(77) }

func unlockedSession() -> Bool {
  guard let state = CGSessionCopyCurrentDictionary() as? [String: Any],
    (state[kCGSessionUserIDKey as String] as? NSNumber)?.uint32Value == geteuid(),
    state[kCGSessionOnConsoleKey as String] as? Bool == true,
    state[kCGSessionLoginDoneKey as String] as? Bool == true else { return false }
  return state["CGSSessionScreenIsLocked"] as? Bool != true
}

if CommandLine.arguments.count == 2 && CommandLine.arguments[1] == "--check" {
  print(AXIsProcessTrusted() ? "ready" : "permission")
  exit(0)
}

guard unlockedSession() else { print("locked"); fflush(stdout); exit(2) }
guard AXIsProcessTrusted() else { print("permission"); fflush(stdout); exit(2) }

let source = CGEventSource(stateID: .privateState)
let keyMetadataSource = CGEventSource(stateID: .privateState)
var keys = Set<CGKeyCode>()
var buttons = Set<Int>()
var location = CGPoint.zero
var lastSeen = Date()
var lastClickAt = Date.distantPast
var lastClickLocation = CGPoint.zero
var lastClickButton = -1
var clickCount: Int64 = 0
let lock = NSLock()
let keyCodes: [String: CGKeyCode] = [
  "KeyA":0,"KeyS":1,"KeyD":2,"KeyF":3,"KeyH":4,"KeyG":5,"KeyZ":6,"KeyX":7,"KeyC":8,"KeyV":9,
  "KeyB":11,"KeyQ":12,"KeyW":13,"KeyE":14,"KeyR":15,"KeyY":16,"KeyT":17,
  "Digit1":18,"Digit2":19,"Digit3":20,"Digit4":21,"Digit6":22,"Digit5":23,"Equal":24,"Digit9":25,
  "Digit7":26,"Minus":27,"Digit8":28,"Digit0":29,"BracketRight":30,"KeyO":31,"KeyU":32,
  "BracketLeft":33,"KeyI":34,"KeyP":35,"Enter":36,"KeyL":37,"KeyJ":38,"Quote":39,"KeyK":40,
  "Semicolon":41,"Backslash":42,"Comma":43,"Slash":44,"KeyN":45,"KeyM":46,"Period":47,
  "Tab":48,"Space":49,"Backquote":50,"Backspace":51,"Escape":53,"MetaLeft":55,"ShiftLeft":56,
  "AltLeft":58,"ControlLeft":59,"F1":122,"F2":120,"F3":99,"F4":118,"F5":96,"F6":97,"F7":98,
  "F8":100,"F9":101,"F10":109,"F11":103,"F12":111,"Insert":114,"Home":115,"PageUp":116,
  "Delete":117,"End":119,"PageDown":121,"ArrowLeft":123,"ArrowRight":124,"ArrowDown":125,"ArrowUp":126
]

func flags() -> CGEventFlags {
  var result: CGEventFlags = []
  for (key, flag) in [(55, CGEventFlags.maskCommand), (56, .maskShift),
    (58, .maskAlternate), (59, .maskControl)] where keys.contains(CGKeyCode(key)) {
    result.insert(flag)
  }
  return result
}

func key(_ code: CGKeyCode, _ down: Bool) {
  if down { keys.insert(code) } else { keys.remove(code) }
  guard let event = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: down) else { return }
  var nativeFlags = CGEvent(keyboardEventSource: keyMetadataSource, virtualKey: code, keyDown: down)?.flags ?? []
  nativeFlags.subtract([.maskCommand, .maskShift, .maskAlternate, .maskControl, .maskAlphaShift])
  event.flags = nativeFlags.union(flags())
  event.post(tap: .cghidEventTap)
  usleep(8_000)
}

func mouse(_ button: Int, _ down: Bool) {
  let nativeButton: CGMouseButton = button == 2 ? .right : button == 1 ? .center : .left
  let type: CGEventType = button == 2 ? (down ? .rightMouseDown : .rightMouseUp)
    : button == 1 ? (down ? .otherMouseDown : .otherMouseUp)
    : (down ? .leftMouseDown : .leftMouseUp)
  if down { buttons.insert(button) } else { buttons.remove(button) }
  if down {
    let nearby = hypot(location.x - lastClickLocation.x, location.y - lastClickLocation.y) < 5
    clickCount = button == lastClickButton && nearby && Date().timeIntervalSince(lastClickAt) < 0.5
      ? min(3, clickCount + 1) : 1
    lastClickAt = Date(); lastClickLocation = location; lastClickButton = button
  }
  let event = CGEvent(mouseEventSource: source, mouseType: type,
    mouseCursorPosition: location, mouseButton: nativeButton)
  event?.setIntegerValueField(.mouseEventClickState, value: clickCount)
  event?.flags = flags()
  event?.post(tap: .cghidEventTap)
}

func releaseAll() {
  for button in Array(buttons) { mouse(button, false) }
  for code in Array(keys) { key(code, false) }
}

func apply(_ event: [String: Any]) {
  guard let kind = event["kind"] as? String else { return }
  if kind == "release" { releaseAll(); return }
  if kind == "move" || kind == "button" {
    guard let x = event["x"] as? Double, let y = event["y"] as? Double,
      x.isFinite, y.isFinite else { return }
    location = CGPoint(x: x, y: y)
    if kind == "button", let button = event["button"] as? Int,
      (0...2).contains(button), let down = event["down"] as? Bool {
      mouse(button, down)
    } else {
      let button = buttons.contains(0) ? 0 : buttons.contains(2) ? 2 : buttons.contains(1) ? 1 : -1
      let type: CGEventType = button == 0 ? .leftMouseDragged : button == 2 ? .rightMouseDragged
        : button == 1 ? .otherMouseDragged : .mouseMoved
      let nativeButton: CGMouseButton = button == 2 ? .right : button == 1 ? .center : .left
      let move = CGEvent(mouseEventSource: source, mouseType: type,
        mouseCursorPosition: location, mouseButton: nativeButton)
      move?.flags = flags(); move?.post(tap: .cghidEventTap)
    }
  } else if kind == "key", let code = event["code"] as? String,
    let native = keyCodes[code], let down = event["down"] as? Bool {
    key(native, down)
  } else if kind == "scroll", let dy = event["dy"] as? Double,
    let dx = event["dx"] as? Double, dx.isFinite, dy.isFinite {
    CGEvent(scrollWheelEvent2Source: source, units: .pixel, wheelCount: 2,
      wheel1: -Int32(dy), wheel2: -Int32(dx), wheel3: 0)?.post(tap: .cghidEventTap)
  } else if kind == "text", let text = event["text"] as? String {
    for character in text.prefix(4_096) {
      var units = Array(String(character).utf16)
      for down in [true, false] {
        let unicode = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: down)
        unicode?.keyboardSetUnicodeString(stringLength: units.count, unicodeString: &units)
        unicode?.post(tap: .cghidEventTap)
      }
    }
  }
}

print("ready"); fflush(stdout)
let watchdog = DispatchSource.makeTimerSource(queue: .global())
watchdog.schedule(deadline: .now() + 1, repeating: 1)
watchdog.setEventHandler {
  lock.lock(); defer { lock.unlock() }
  guard inputCaller.code() != nil, AXIsProcessTrusted(), unlockedSession() else {
    releaseAll(); print("error"); fflush(stdout); exit(2)
  }
  if Date().timeIntervalSince(lastSeen) > 5 { releaseAll() }
}
watchdog.resume()
signal(SIGTERM, SIG_IGN)
let termination = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .global())
termination.setEventHandler { lock.lock(); releaseAll(); lock.unlock(); exit(0) }
termination.resume()

while let line = readLine() {
  guard inputCaller.code() != nil, unlockedSession() else {
    lock.lock(); releaseAll(); lock.unlock(); exit(77)
  }
  guard line.utf8.count <= 32_768, let data = line.data(using: .utf8),
    let events = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]],
    events.count <= 64 else { break }
  lock.lock(); lastSeen = Date()
  for event in events { apply(event) }
  lock.unlock()
}
lock.lock(); releaseAll(); lock.unlock()
