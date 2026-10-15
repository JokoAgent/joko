// Test-only framework doubles. SDP/ICE completions are explicitly controlled;
// production Timer and DispatchQueue behavior is exercised using the run loop.
final class UIApplication {
  enum State { case active, background }
  static let shared = UIApplication()
  var applicationState = State.active
}
func RTCInitializeSSL() {}
protocol RTCPeerConnectionDelegate: AnyObject {}
protocol RTCDataChannelDelegate: AnyObject {}
protocol RTCVideoRenderer: AnyObject {
  func setSize(_ size: CGSize)
  func renderFrame(_ frame: RTCVideoFrame?)
}
final class RTCDefaultVideoEncoderFactory {}
final class RTCDefaultVideoDecoderFactory {}
final class RTCPeerConnectionFactory {
  static var latest: RTCPeerConnection!
  init(encoderFactory: RTCDefaultVideoEncoderFactory, decoderFactory: RTCDefaultVideoDecoderFactory) {}
  func peerConnection(with: RTCConfiguration, constraints: RTCMediaConstraints, delegate: RTCPeerConnectionDelegate) -> RTCPeerConnection? {
    let peer = RTCPeerConnection(); peer.delegate = delegate; Self.latest = peer; return peer
  }
}
enum RTCSignalingState { case stable }
enum RTCIceConnectionState: Int { case connected }
enum RTCIceGatheringState: Int { case gathering, complete }
enum RTCPeerConnectionState: Int { case new, connected, disconnected, failed, closed }
final class RTCIceCandidateErrorEvent { var errorCode = 701; var url = "stun:test.invalid:3478" }
final class RTCConfiguration {
  enum Semantics { case unifiedPlan }
  var sdpSemantics = Semantics.unifiedPlan
  var iceServers: [RTCIceServer] = []
}
final class RTCIceServer {
  init(urlStrings: [String], username: String?, credential: String?) {}
}
final class RTCMediaConstraints {
  init(mandatoryConstraints: [String: String]?, optionalConstraints: [String: String]?) {}
}
final class RTCSessionDescription {
  enum Kind { case offer, answer }
  let sdp: String
  init(type: Kind, sdp: String) { self.sdp = sdp }
}
final class RTCRtpTransceiverInit {
  enum Direction { case recvOnly }
  var direction = Direction.recvOnly
}
class RTCMediaStreamTrack {}
final class RTCAudioTrack: RTCMediaStreamTrack { var isEnabled = false }
final class RTCVideoFrame {}
final class RTCVideoTrack: RTCMediaStreamTrack {
  var sink: RTCVideoRenderer?
  func add(_ sink: RTCVideoRenderer) { self.sink = sink }
  func remove(_ sink: RTCVideoRenderer) { self.sink = nil }
}
final class RTCRtpTransceiver {
  final class Receiver { var track: RTCMediaStreamTrack? }
  let receiver = Receiver()
}
final class RTCMediaStream {}
final class RTCDataChannelConfiguration {}
final class RTCDataBuffer {
  let data: Data; let isBinary: Bool
  init(data: Data, isBinary: Bool) { self.data = data; self.isBinary = isBinary }
}
final class RTCDataChannel {
  enum State { case open, closed }
  weak var delegate: RTCDataChannelDelegate?
  var readyState = State.open
  var bufferedAmount = 0
  var sent: [Data] = []
  var closes = 0
  func sendData(_ data: RTCDataBuffer) -> Bool { sent.append(data.data); return true }
  func close() { closes += 1; readyState = .closed }
}
final class RTCIceCandidate {
  let sdp: String; let sdpMLineIndex: Int32; let sdpMid: String?
  init(sdp: String, sdpMLineIndex: Int32, sdpMid: String?) {
    self.sdp = sdp; self.sdpMLineIndex = sdpMLineIndex; self.sdpMid = sdpMid
  }
}
final class RTCStatistics {
  var type = ""; var values: [String: Any] = [:]; var timestamp_us = 0.0; var id = ""
}
final class RTCStatisticsReport { var statistics: [String: RTCStatistics] = [:] }
final class RTCPeerConnection {
  enum Media { case video, audio }
  weak var delegate: RTCPeerConnectionDelegate?
  var localDescription: RTCSessionDescription?
  var remoteDescription: RTCSessionDescription?
  var iceGatheringState = RTCIceGatheringState.complete
  var connectionState = RTCPeerConnectionState.new
  let channel = RTCDataChannel()
  var offerCallback: ((RTCSessionDescription?, Error?) -> Void)?
  var answerCallback: ((Error?) -> Void)?
  var candidateCallbacks: [(Error?) -> Void] = []
  var closes = 0
  var answers = 0
  func addTransceiver(of: Media, init: RTCRtpTransceiverInit) {}
  func dataChannel(forLabel: String, configuration: RTCDataChannelConfiguration) -> RTCDataChannel? { channel }
  func offer(for: RTCMediaConstraints, completionHandler: @escaping (RTCSessionDescription?, Error?) -> Void) { offerCallback = completionHandler }
  func setLocalDescription(_ description: RTCSessionDescription, completionHandler: @escaping (Error?) -> Void) { localDescription = description; completionHandler(nil) }
  func setRemoteDescription(_ description: RTCSessionDescription, completionHandler: @escaping (Error?) -> Void) { answers += 1; remoteDescription = description; answerCallback = completionHandler }
  func add(_ candidate: RTCIceCandidate, completionHandler: @escaping (Error?) -> Void) { candidateCallbacks.append(completionHandler) }
  func statistics(_ completionHandler: @escaping (RTCStatisticsReport) -> Void) { completionHandler(RTCStatisticsReport()) }
  func close() { closes += 1; connectionState = .closed }
}

@main
struct ReceiverIceTests {
  static func drain(_ seconds: Double = 0.03) {
    RunLoop.main.run(until: Date().addingTimeInterval(seconds))
  }
  static func main() {
    assert(RemoteClipboardSize.acceptsImage(width: 2_000, height: 2_000))
    assert(RemoteClipboardSize.acceptsImage(width: 4_000_000, height: 1))
    assert(!RemoteClipboardSize.acceptsImage(width: 2_001, height: 2_000))
    assert(!RemoteClipboardSize.acceptsImage(width: 1, height: 4_000_001))
    for invalid in [Double.nan, Double.infinity, -Double.infinity, 0, -1] {
      assert(!RemoteClipboardSize.acceptsImage(width: invalid, height: 1))
      assert(!RemoteClipboardSize.acceptsImage(width: 1, height: invalid))
    }
    func message(_ receiver: RemoteDesktopReceiver, _ type: String, _ data: [String: Any] = [:]) -> [String: Any] {
      data.merging(["type": type, "epoch": receiver.epoch, "attemptId": receiver.attempt]) { _, value in value }
    }
    func start() -> (RemoteDesktopReceiver, RTCPeerConnection, () -> [[String: Any]]) {
      let receiver = RemoteDesktopReceiver(epoch: "lease", audio: false, trickle: true, net: [:])
      var events: [[String: Any]] = []
      receiver.emit = { events.append($0) }
      receiver.receive(message(receiver, "iceConfig", ["iceServers": []]))
      let peer = RTCPeerConnectionFactory.latest!
      receiver.peerConnection(peer, didGenerate:
        RTCIceCandidate(sdp: "candidate:local", sdpMLineIndex: 0, sdpMid: "0"))
      drain()
      receiver.receive(message(receiver, "answer", ["sdp": "v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=mid:0\r\n"]))
      peer.answerCallback?(nil)
      drain()
      return (receiver, peer, { events })
    }
    let (receiver, peer, events) = start()
    let original = events().last { $0["type"] as? String == "ice" }!
    let originalID = original["exchangeId"] as! Int
    let originalBatch = original["candidates"] as! [[String: Any]]
    assert(originalBatch.count == 1 && original["after"] as? Int == 0)
    // The real private bridge sends only an error receipt on transport failure.
    receiver.receive(message(receiver, "ice", ["exchangeId": Double(originalID), "error": true]))
    assert(peer.closes == 0)
    let remote: [String: Any] = ["candidate": "candidate:remote", "sdpMid": "0",
      "sdpMLineIndex": Double(0), "usernameFragment": NSNull()]
    // A late success for the retired exchange cannot acknowledge its local batch.
    receiver.receive(message(receiver, "ice", ["exchangeId": Double(originalID), "error": false,
      "candidates": [remote], "next": Double(1), "complete": false]))
    assert(peer.candidateCallbacks.isEmpty)
    drain(1.1)
    let retry = events().last { $0["type"] as? String == "ice" }!
    let retryID = retry["exchangeId"] as! Int
    assert(retryID > originalID && retry["after"] as? Int == 0)
    let retryBatch = retry["candidates"] as! [[String: Any]]
    assert(retryBatch.count == 1 && retryBatch[0]["candidate"] as? String == originalBatch[0]["candidate"] as? String)
    receiver.receive(message(receiver, "ice", ["exchangeId": Double(retryID), "error": false,
      "candidates": [remote], "next": Double(1), "complete": false]))
    assert(peer.candidateCallbacks.count == 1 && peer.closes == 0)
    peer.candidateCallbacks[0](nil)
    drain(0.3)
    let acknowledged = events().last { $0["type"] as? String == "ice" }!
    assert(acknowledged["after"] as? Int == 1)
    assert((acknowledged["candidates"] as? [[String: Any]])?.isEmpty == true)
    receiver.stop()

    // Teardown cancels the scheduled retry; it cannot revive a retired receiver.
    let (stopped, stoppedPeer, stoppedEvents) = start()
    let exchange = stoppedEvents().last { $0["type"] as? String == "ice" }!["exchangeId"] as! Int
    stopped.receive(message(stopped, "ice", ["exchangeId": exchange, "error": true]))
    stopped.stop()
    let count = stoppedEvents().count
    drain(1.1)
    assert(stoppedEvents().count == count && stoppedPeer.closes == 1)
    print("Native clipboard budgets and receiver ICE recovery passed")
  }
}

