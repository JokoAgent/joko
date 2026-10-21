import ExpoModulesCore
import UIKit
import AVFoundation
import UniformTypeIdentifiers
import WebRTC

public class JokoRemotePresentationModule: Module {
  private var previousAudio: (
    AVAudioSession.Category,
    AVAudioSession.Mode,
    AVAudioSession.CategoryOptions
  )?
  private var previousRtcAudio: RTCAudioSessionConfiguration?
  private var installedRtcAudio: RTCAudioSessionConfiguration?
  private var installedRtcSnapshot: RTCAudioSessionConfiguration?

  private func copyAudio(_ source: RTCAudioSessionConfiguration) -> RTCAudioSessionConfiguration {
    let copy = RTCAudioSessionConfiguration()
    copy.category = source.category
    copy.mode = source.mode
    copy.categoryOptions = source.categoryOptions
    copy.sampleRate = source.sampleRate
    copy.ioBufferDuration = source.ioBufferDuration
    copy.inputNumberOfChannels = source.inputNumberOfChannels
    copy.outputNumberOfChannels = source.outputNumberOfChannels
    return copy
  }

  private func restoreRtcAudioIfOwned() {
    let current = RTCAudioSessionConfiguration.webRTC()
    if let installed = installedRtcAudio, let snapshot = installedRtcSnapshot,
       let previous = previousRtcAudio, current === installed,
       current.category == snapshot.category, current.mode == snapshot.mode,
       current.categoryOptions == snapshot.categoryOptions, current.sampleRate == snapshot.sampleRate,
       current.ioBufferDuration == snapshot.ioBufferDuration,
       current.inputNumberOfChannels == snapshot.inputNumberOfChannels,
       current.outputNumberOfChannels == snapshot.outputNumberOfChannels {
      RTCAudioSessionConfiguration.setWebRTC(previous)
    }
    previousRtcAudio = nil
    installedRtcAudio = nil
    installedRtcSnapshot = nil
  }

  public func definition() -> ModuleDefinition {
    Name("JokoRemotePresentation")
    Constants(["nativeVideo": true, "windowLayoutAvailable": true])

    View(RemoteDesktopVideoView.self) {
      Events("onMessage")
      Prop("inlineVisible") { (view: RemoteDesktopVideoView, visible: Bool) in
        view.inlineVisible = visible
      }
      AsyncFunction("receive") { (view: RemoteDesktopVideoView, message: [String: Any]) in
        view.receive(message)
      }
      AsyncFunction("sendInput") { (view: RemoteDesktopVideoView, message: [String: Any]) -> Bool in
        view.sendInput(message)
      }
      AsyncFunction("sendRequest") { (view: RemoteDesktopVideoView, message: [String: Any]) -> Bool in
        view.sendRequest(message)
      }
    }

    View(JokoWindowLayoutView.self) {
      ViewName("WindowLayout")
      Events("onGeometryChange")
    }

    AsyncFunction("rotate") { (landscape: Bool, promise: Promise) in
      guard UIApplication.shared.applicationState == .active,
            let scene = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene })
              .first(where: { $0.activationState == .foregroundActive && $0.windows.contains(where: { $0.isKeyWindow }) }) else {
        promise.reject("REMOTE_DESKTOP_ROTATION_UNAVAILABLE", "REMOTE_DESKTOP_ROTATION_UNAVAILABLE")
        return
      }
      scene.windows.first(where: { $0.isKeyWindow })?.rootViewController?.setNeedsUpdateOfSupportedInterfaceOrientations()
      var settled = false
      let orientation: UIInterfaceOrientationMask = landscape ? .landscapeRight : .portrait
      scene.requestGeometryUpdate(.iOS(interfaceOrientations: orientation)) { _ in
        if !settled {
          settled = true
          promise.reject("REMOTE_DESKTOP_ROTATION_FAILED", "REMOTE_DESKTOP_ROTATION_FAILED")
        }
      }
      DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
        guard !settled else { return }
        settled = true
        let target: UIInterfaceOrientation = landscape ? .landscapeRight : .portrait
        if UIApplication.shared.applicationState == .active, scene.activationState == .foregroundActive,
           scene.interfaceOrientation == target { promise.resolve(nil) }
        else { promise.reject("REMOTE_DESKTOP_ROTATION_FAILED", "REMOTE_DESKTOP_ROTATION_FAILED") }
      }
    }.runOnQueue(.main)

    AsyncFunction("clipboardVersion") { () -> String in
      try RemoteClipboard.foreground()
      return String(UIPasteboard.general.changeCount)
    }.runOnQueue(.main)

    AsyncFunction("syncClipboard") { (json: String, version: String) -> String in
      try RemoteClipboard.foreground()
      guard String(UIPasteboard.general.changeCount) == version else {
        throw RemoteClipboard.failure("REMOTE_DESKTOP_CLIPBOARD_CHANGED")
      }
      try RemoteClipboard.write(json, expectedVersion: version)
      return String(UIPasteboard.general.changeCount)
    }.runOnQueue(.main)

    AsyncFunction("readClipboard") { () -> String in
      try RemoteClipboard.read()
    }.runOnQueue(.main)

    AsyncFunction("writeClipboard") { (json: String) in
      try RemoteClipboard.write(json)
    }.runOnQueue(.main)

    AsyncFunction("playback") { (enabled: Bool) in
      let session = AVAudioSession.sharedInstance()
      if enabled {
        if self.previousAudio == nil {
          self.previousAudio = (session.category, session.mode, session.categoryOptions)
          self.previousRtcAudio = self.copyAudio(RTCAudioSessionConfiguration.webRTC())
        }
        let configuration = self.copyAudio(RTCAudioSessionConfiguration.webRTC())
        configuration.category = AVAudioSession.Category.playback.rawValue
        configuration.mode = AVAudioSession.Mode.moviePlayback.rawValue
        configuration.categoryOptions = [.mixWithOthers]
        self.installedRtcAudio = configuration
        self.installedRtcSnapshot = self.copyAudio(configuration)
        RTCAudioSessionConfiguration.setWebRTC(configuration)
        do {
          try session.setCategory(.playback, mode: .moviePlayback, options: [.mixWithOthers])
          try session.setActive(true)
        } catch {
          // Enabling is one main-queue transaction. Roll back a partial native
          // mutation before surfacing the optional-audio failure to JavaScript.
          if let previous = self.previousAudio {
            try? session.setActive(false, options: .notifyOthersOnDeactivation)
            try? session.setCategory(previous.0, mode: previous.1, options: previous.2)
          }
          self.previousAudio = nil
          self.restoreRtcAudioIfOwned()
          throw NSError(domain: "JokoRemotePresentation", code: 1,
            userInfo: [NSLocalizedDescriptionKey: "REMOTE_DESKTOP_AUDIO_UNAVAILABLE"])
        }
      } else if let previous = self.previousAudio {
        // A newer voice or media owner wins. Restore only the exact category
        // installed by this Remote Desktop occurrence.
        do {
          if session.category == .playback && session.mode == .moviePlayback
            && session.categoryOptions == [.mixWithOthers] {
            try session.setActive(false, options: .notifyOthersOnDeactivation)
            try session.setCategory(previous.0, mode: previous.1, options: previous.2)
          }
          self.restoreRtcAudioIfOwned()
          self.previousAudio = nil
        } catch {
          throw NSError(domain: "JokoRemotePresentation", code: 1,
            userInfo: [NSLocalizedDescriptionKey: "REMOTE_DESKTOP_AUDIO_UNAVAILABLE"])
        }
      }
    }.runOnQueue(.main)
  }
}

/** One atomic portable item; file URLs and private formats are never read. */
enum RemoteClipboard {
  static func failure(_ code: String) -> NSError {
    NSError(domain: "JokoClipboard", code: 1, userInfo: [NSLocalizedDescriptionKey: code])
  }

  static func foreground() throws {
    guard UIApplication.shared.applicationState == .active else {
      throw failure("REMOTE_DESKTOP_CLIPBOARD_RETIRED")
    }
  }

  static func read() throws -> String {
    try foreground()
    let board = UIPasteboard.general
    let version = board.changeCount
    let items = board.items
    guard !items.isEmpty else { throw failure("REMOTE_DESKTOP_CLIPBOARD_EMPTY") }
    guard items.count == 1 else { throw failure("REMOTE_DESKTOP_CLIPBOARD_UNSUPPORTED") }
    let item = items[0]

    // UIKit resolves alternative image representations for the same item. Do
    // not sort UTIs or dereference a source URL to manufacture clipboard bytes.
    let image = board.image
    if image == nil && item.keys.contains(where: { UTType($0)?.conforms(to: .fileURL) == true }) {
      throw failure("REMOTE_DESKTOP_CLIPBOARD_UNSUPPORTED")
    }

    var result: [String: String] = [:]
    func string(_ type: String) throws -> String? {
      let value: String?
      if let string = item[type] as? String {
        value = string
      } else if let data = item[type] as? Data {
        guard RemoteClipboardSize.acceptsTransferUTF8Bytes(data),
          let decoded = String(data: data, encoding: .utf8) else {
          throw failure("REMOTE_DESKTOP_CLIPBOARD_UNSUPPORTED")
        }
        value = decoded
      } else {
        value = nil
      }
      guard let value, !value.isEmpty else { return nil }
      guard RemoteClipboardSize.acceptsTransfer(value) else {
        throw failure("REMOTE_DESKTOP_CLIPBOARD_TOO_LONG")
      }
      return value
    }

    for type in ["public.utf8-plain-text", "public.text", "public.plain-text"] {
      if let text = try string(type) {
        result["text"] = text
        break
      }
    }
    result["html"] = try string("public.html")
    result["rtf"] = try string("public.rtf")

    if let raw = item["public.url"] {
      let url = (raw as? URL) ?? (raw as? String).flatMap(URL.init(string:))
      if let url, ["http", "https"].contains(url.scheme?.lowercased() ?? ""),
        RemoteClipboardSize.acceptsTransfer(url.absoluteString) {
        result["url"] = url.absoluteString
      } else if image == nil {
        throw failure("REMOTE_DESKTOP_CLIPBOARD_UNSUPPORTED")
      }
    }

    if let image {
      guard (image.images?.count ?? 1) <= 1 else {
        throw failure("REMOTE_DESKTOP_CLIPBOARD_UNSUPPORTED")
      }
      guard RemoteClipboardSize.acceptsImage(
        width: Double(image.size.width * image.scale), height: Double(image.size.height * image.scale)
      ) else {
        throw failure("REMOTE_DESKTOP_CLIPBOARD_TOO_LONG")
      }
      if let bitmap = image.cgImage,
        !RemoteClipboardSize.acceptsImage(width: Double(bitmap.width), height: Double(bitmap.height)) {
        throw failure("REMOTE_DESKTOP_CLIPBOARD_TOO_LONG")
      }
      guard let png = image.pngData() else {
        throw failure("REMOTE_DESKTOP_CLIPBOARD_UNSUPPORTED")
      }
      guard png.count <= RemoteClipboardSize.imageBytes else {
        throw failure("REMOTE_DESKTOP_CLIPBOARD_TOO_LONG")
      }
      result["png"] = png.base64EncodedString()
    }

    guard !result.isEmpty else { throw failure("REMOTE_DESKTOP_CLIPBOARD_UNSUPPORTED") }
    try foreground()
    guard version == board.changeCount else { throw failure("REMOTE_DESKTOP_CLIPBOARD_CHANGED") }
    let data = try JSONSerialization.data(withJSONObject: result)
    guard let json = String(data: data, encoding: .utf8),
      RemoteClipboardSize.acceptsTransfer(json) else {
      throw failure("REMOTE_DESKTOP_CLIPBOARD_TOO_LONG")
    }
    return json
  }

  static func write(_ json: String, expectedVersion: String? = nil) throws {
    try foreground()
    guard RemoteClipboardSize.acceptsTransfer(json), let data = json.data(using: .utf8),
      let content = try JSONSerialization.jsonObject(with: data) as? [String: String],
      !content.isEmpty,
      content.keys.allSatisfy({ ["text", "html", "rtf", "url", "png"].contains($0) }),
      content.values.allSatisfy({ !$0.isEmpty && RemoteClipboardSize.acceptsTransfer($0) }) else {
      throw failure("REMOTE_DESKTOP_CLIPBOARD_UNSUPPORTED")
    }

    var item: [String: Any] = [:]
    if let text = content["text"] {
      item["public.utf8-plain-text"] = text
    }
    if let html = content["html"] { item["public.html"] = Data(html.utf8) }
    if let rtf = content["rtf"] { item["public.rtf"] = Data(rtf.utf8) }
    if let string = content["url"] {
      guard let url = URL(string: string),
        ["http", "https"].contains(url.scheme?.lowercased() ?? "") else {
        throw failure("REMOTE_DESKTOP_CLIPBOARD_UNSUPPORTED")
      }
      item["public.url"] = url
    }
    if let encoded = content["png"] {
      guard encoded.utf8.count <= ((RemoteClipboardSize.imageBytes + 2) / 3) * 4 else {
        throw failure("REMOTE_DESKTOP_CLIPBOARD_TOO_LONG")
      }
      guard let png = Data(base64Encoded: encoded), png.count >= 24,
        Array(png.prefix(8)) == [137, 80, 78, 71, 13, 10, 26, 10] else {
        throw failure("REMOTE_DESKTOP_CLIPBOARD_UNSUPPORTED")
      }
      guard png.count <= RemoteClipboardSize.imageBytes else {
        throw failure("REMOTE_DESKTOP_CLIPBOARD_TOO_LONG")
      }
      let width = png[16..<20].reduce(UInt64(0)) { ($0 << 8) | UInt64($1) }
      let height = png[20..<24].reduce(UInt64(0)) { ($0 << 8) | UInt64($1) }
      guard RemoteClipboardSize.acceptsImage(width: Double(width), height: Double(height)) else {
        throw failure("REMOTE_DESKTOP_CLIPBOARD_TOO_LONG")
      }
      guard UIImage(data: png) != nil else {
        throw failure("REMOTE_DESKTOP_CLIPBOARD_UNSUPPORTED")
      }
      item["public.png"] = png
    }

    try foreground()
    if let expectedVersion, String(UIPasteboard.general.changeCount) != expectedVersion {
      throw failure("REMOTE_DESKTOP_CLIPBOARD_CHANGED")
    }
    UIPasteboard.general.setItems([item], options: [:])
  }
}
