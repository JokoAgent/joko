import Darwin
import ExpoModulesCore

public final class JokoLanDiscoveryModule: Module {
  private let queue = DispatchQueue(label: "app.joko.lan-discovery", qos: .userInitiated)

  public func definition() -> ModuleDefinition {
    Name("JokoLanDiscovery")

    AsyncFunction("discover") { (
      queryBase64: String,
      group: String,
      port: Int,
      timeoutMs: Int,
      maximumResponses: Int
    ) throws -> [[String: String]] in
      try discover(
        queryBase64: queryBase64,
        group: group,
        port: port,
        timeoutMs: timeoutMs,
        maximumResponses: maximumResponses
      )
    }.runOnQueue(queue)
  }

  private func discover(
    queryBase64: String,
    group: String,
    port: Int,
    timeoutMs: Int,
    maximumResponses: Int
  ) throws -> [[String: String]] {
    guard (1...65_535).contains(port), (100...5_000).contains(timeoutMs),
      (1...128).contains(maximumResponses) else {
      throw LanDiscoveryException("LAN discovery bounds are invalid.")
    }
    guard let query = Data(base64Encoded: queryBase64), !query.isEmpty,
      query.count <= Self.maximumDatagramBytes else {
      throw LanDiscoveryException("LAN discovery query is invalid.")
    }
    var destination = sockaddr_in()
    destination.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
    destination.sin_family = sa_family_t(AF_INET)
    destination.sin_port = in_port_t(UInt16(port).bigEndian)
    let groupParts = group.split(separator: ".").compactMap { UInt8($0) }
    guard groupParts.count == 4, (224...239).contains(groupParts[0]),
      inet_pton(AF_INET, group, &destination.sin_addr) == 1 else {
      throw LanDiscoveryException("LAN discovery address is not multicast.")
    }

    let descriptor = Darwin.socket(AF_INET, Int32(SOCK_DGRAM.rawValue), IPPROTO_UDP)
    guard descriptor >= 0 else { throw LanDiscoveryException("LAN discovery socket could not be created.") }
    defer { Darwin.close(descriptor) }
    var ttl: UInt8 = 1
    guard setsockopt(descriptor, IPPROTO_IP, IP_MULTICAST_TTL, &ttl, socklen_t(MemoryLayout.size(ofValue: ttl))) == 0 else {
      throw LanDiscoveryException("LAN discovery multicast scope could not be set.")
    }
    var local = sockaddr_in()
    local.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
    local.sin_family = sa_family_t(AF_INET)
    local.sin_port = 0
    local.sin_addr = in_addr(s_addr: INADDR_ANY)
    let bound = withUnsafePointer(to: &local) { pointer in
      pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
        Darwin.bind(descriptor, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
      }
    }
    guard bound == 0 else { throw LanDiscoveryException("LAN discovery socket could not be bound.") }
    let sent = query.withUnsafeBytes { bytes in
      withUnsafePointer(to: &destination) { pointer in
        pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
          Darwin.sendto(descriptor, bytes.baseAddress, query.count, 0, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
        }
      }
    }
    guard sent == query.count else { throw LanDiscoveryException("LAN discovery query could not be sent.") }

    let deadline = DispatchTime.now().uptimeNanoseconds + UInt64(timeoutMs) * 1_000_000
    var results: [[String: String]] = []
    var seen = Set<String>()
    while results.count < maximumResponses {
      let now = DispatchTime.now().uptimeNanoseconds
      if now >= deadline { break }
      let remainingMilliseconds = Int32(max(1, min(UInt64(Int32.max), (deadline - now) / 1_000_000)))
      var descriptorState = pollfd(fd: descriptor, events: Int16(POLLIN), revents: 0)
      let ready = Darwin.poll(&descriptorState, 1, remainingMilliseconds)
      if ready == 0 { break }
      if ready < 0 {
        if errno == EINTR { continue }
        throw LanDiscoveryException("LAN discovery receive wait failed.")
      }
      var buffer = [UInt8](repeating: 0, count: Self.maximumDatagramBytes)
      var remote = sockaddr_storage()
      var remoteLength = socklen_t(MemoryLayout<sockaddr_storage>.size)
      let received = buffer.withUnsafeMutableBytes { bytes in
        withUnsafeMutablePointer(to: &remote) { remotePointer in
          remotePointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { addressPointer in
            Darwin.recvfrom(descriptor, bytes.baseAddress, bytes.count, 0, addressPointer, &remoteLength)
          }
        }
      }
      if received <= 0 || received > Self.maximumDatagramBytes { continue }
      var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
      let named = withUnsafePointer(to: &remote) { pointer in
        pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
          Darwin.getnameinfo($0, remoteLength, &host, socklen_t(host.count), nil, 0, NI_NUMERICHOST)
        }
      }
      if named != 0 { continue }
      let address = String(cString: host)
      let data = Data(buffer.prefix(received)).base64EncodedString()
      let identity = "\(address)\u{0}\(data)"
      if !seen.insert(identity).inserted { continue }
      results.append(["data": data, "address": address])
    }
    return results
  }

  private static let maximumDatagramBytes = 2_048
}

private final class LanDiscoveryException: Exception {
  private let detail: String

  init(_ detail: String) {
    self.detail = detail
    super.init()
  }

  override var reason: String { detail }
}
