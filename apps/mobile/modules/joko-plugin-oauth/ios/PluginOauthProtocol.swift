import Foundation
struct PluginOauthRequest {
  enum Failure: Error { case invalid }
  let id: String
  let state: String
  let expiresAt: Double
  let port: UInt16
  let path: String
  var host: String { "127.0.0.1:\(port)" }
  init(id: String, callbackUrl: String, state: String, expiresAt: Double, now: Double = Date().timeIntervalSince1970 * 1000) throws {
    guard Self.matches(id, "^[A-Za-z0-9_-]{16,128}$"), Self.matches(state, "^[A-Za-z0-9._~-]{16,512}$"),
      expiresAt.isFinite, expiresAt.rounded(.towardZero) == expiresAt, expiresAt > now, expiresAt <= now + 600_000,
      callbackUrl.utf8.count <= 300, let url = URLComponents(string: callbackUrl), url.scheme == "http", url.host == "127.0.0.1",
      let port = url.port, (1024...65535).contains(port), url.user == nil, url.password == nil,
      url.query == nil, url.fragment == nil, url.percentEncodedPath.utf8.count <= 256,
      Self.matches(url.percentEncodedPath, "^/[A-Za-z0-9._~/-]*$"),
      callbackUrl == "http://127.0.0.1:\(port)\(url.percentEncodedPath)" else { throw Failure.invalid }
    self.id = id; self.state = state; self.expiresAt = expiresAt; self.port = UInt16(port); path = url.percentEncodedPath
  }
  func parse(_ bytes: Data, now: Double = Date().timeIntervalSince1970 * 1000) -> [String: String]? {
    guard now < expiresAt, bytes.count <= 16_384, let text = String(data: bytes, encoding: .utf8),
      let boundary = text.range(of: "\r\n\r\n"), boundary.upperBound == text.endIndex else { return nil }
    let lines = String(text[..<boundary.lowerBound]).components(separatedBy: "\r\n")
    let request = (lines.first ?? "").split(separator: " ", omittingEmptySubsequences: false)
    guard request.count == 3, request[0] == "GET", ["HTTP/1.0", "HTTP/1.1"].contains(String(request[2])),
      request[1].utf8.count <= 8192, request[1].hasPrefix(path + "?"),
      let url = URLComponents(string: "http://" + host + String(request[1])), url.percentEncodedPath == path, url.fragment == nil,
      url.string == "http://" + host + String(request[1])
    else { return nil }
    var headers: [String: String] = [:]
    for line in lines.dropFirst() {
      guard let colon = line.firstIndex(of: ":"), colon != line.startIndex else { return nil }
      let name = line[..<colon].lowercased()
      guard Self.matches(name, "^[!#$%&'*+.^_`|~a-z0-9-]+$"), headers[name] == nil else { return nil }
      headers[name] = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
    }
    guard headers["host"] == host, headers["origin"] == nil, headers["transfer-encoding"] == nil,
      headers["content-length"] == nil || headers["content-length"] == "0" else { return nil }
    var params: [String: String] = [:]
    for field in (url.percentEncodedQuery ?? "").split(separator: "&", omittingEmptySubsequences: false) {
      let pieces = field.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
      guard pieces.count == 2,
        let key = String(pieces[0]).replacingOccurrences(of: "+", with: " ").removingPercentEncoding,
        let value = String(pieces[1]).replacingOccurrences(of: "+", with: " ").removingPercentEncoding,
        params[key] == nil, value.utf8.count <= 4096 else { return nil }
      params[key] = value
    }
    guard params["state"] == state, (params["code"] != nil) != (params["error"] != nil) else { return nil }
    let key = params["code"] == nil ? "error" : "code"
    guard let value = params[key], !value.isEmpty, !value.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }),
      key != "error" || Self.matches(value, "^[A-Za-z0-9_.-]{1,128}$") else { return nil }
    return ["state": state, key: value]
  }
  private static func matches(_ value: String, _ pattern: String) -> Bool {
    value.range(of: pattern, options: .regularExpression) == value.startIndex..<value.endIndex
  }
}
