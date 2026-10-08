import ExpoModulesCore
import UIKit
import UniformTypeIdentifiers

public class JokoRemotePresentationModule: Module {
  public func definition() -> ModuleDefinition {
    Name("JokoRemotePresentation")

    AsyncFunction("readClipboard") { () -> String in
      try RemoteClipboard.read()
    }.runOnQueue(.main)

    AsyncFunction("writeClipboard") { (json: String) in
      try RemoteClipboard.write(json)
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
      let width = UInt64(image.size.width * image.scale)
      let height = UInt64(image.size.height * image.scale)
      guard width > 0, height > 0, width <= 64_000_000 / height else {
        throw failure("REMOTE_DESKTOP_CLIPBOARD_TOO_LONG")
      }
      guard let png = image.pngData() else {
        throw failure("REMOTE_DESKTOP_CLIPBOARD_UNSUPPORTED")
      }
      guard png.count <= RemoteClipboardSize.transferLimit * 3 / 4 else {
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

  static func write(_ json: String) throws {
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
      guard let png = Data(base64Encoded: encoded), png.count >= 24,
        Array(png.prefix(8)) == [137, 80, 78, 71, 13, 10, 26, 10] else {
        throw failure("REMOTE_DESKTOP_CLIPBOARD_UNSUPPORTED")
      }
      let width = png[16..<20].reduce(UInt64(0)) { ($0 << 8) | UInt64($1) }
      let height = png[20..<24].reduce(UInt64(0)) { ($0 << 8) | UInt64($1) }
      guard width > 0, height > 0, width <= 64_000_000 / height,
        UIImage(data: png) != nil else {
        throw failure("REMOTE_DESKTOP_CLIPBOARD_UNSUPPORTED")
      }
      item["public.png"] = png
    }

    try foreground()
    UIPasteboard.general.setItems([item], options: [:])
  }
}
