import Foundation

enum RemoteClipboardSize {
  // Rich transfer is JSON chunked by UTF-16 code units. The narrower 16 Ki
  // bound belongs to the separate legacy text RPC, outside this native item.
  static let transferLimit = 32 * 1024 * 1024

  static func acceptsTransfer(_ string: String) -> Bool {
    string.utf16.count <= transferLimit
  }

  static func acceptsTransferUTF8Bytes(_ data: Data) -> Bool {
    // One UTF-16 unit needs at most three UTF-8 bytes. This is only a pre-decode
    // bound; the decoded string is checked again.
    data.count <= transferLimit * 3
  }
}
