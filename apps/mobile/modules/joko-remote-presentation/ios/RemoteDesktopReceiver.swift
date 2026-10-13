import Foundation
import WebRTC
import UIKit

/// One lease owns one receiver. Signaling uses the existing JS adapter; media,
/// decoding and PiP challenge replies never pass through JS. All state is main-queue
/// confined, including callbacks from WebRTC's signaling and decoder threads.
final class RemoteDesktopReceiver: NSObject, RTCPeerConnectionDelegate, RTCDataChannelDelegate {
  private static let factory: RTCPeerConnectionFactory = {
    RTCInitializeSSL()
    return RTCPeerConnectionFactory(encoderFactory: RTCDefaultVideoEncoderFactory(),
                                    decoderFactory: RTCDefaultVideoDecoderFactory())
  }()
  let epoch: String
  let attempt = UUID().uuidString.lowercased()
  var emit: ([String: Any]) -> Void = { _ in }
  var onFrame: (RTCVideoFrame) -> Bool = { _ in false }
  var isPresenting: () -> Bool = { false }
  var isPresentationAuthorized: () -> Bool = { false }
  private var peer: RTCPeerConnection?
  private var channel: RTCDataChannel?
  private var track: RTCVideoTrack?
  private var audioTrack: RTCAudioTrack?
  private var sink: RemoteDesktopFrameSink?
  private var stopped = false
  private var audio = false
  private var trickle: Bool
  private let net: [String: Any]
  private var candidates: [[String: Any]] = []
  private var localAck = 0
  private var remoteAfter = 0
  private var exchange = 0
  private var pending: (id: Int, count: Int)?
  private var remoteSeen = Set<String>()
  private var exchangeUntil = Date.distantPast
  private var timer: Timer?
  private var iceTimer: Timer?
  private var disconnectTimer: Timer?
  private var statsTimer: Timer?
  private var statsBusy = false
  private var statsSample: (id: String, bytes: Double, time: Double)?
  private var offerSent = false
  private var frameReady = false
  private var pendingViewChallenge: String?
  private var answeredViewChallenges = Set<String>()
  private var inputGrant: RemoteDesktopInputGrant?
  private var lastSequence = 0
  private var newestControlGeneration: UInt64 = 0
  private var remoteSections: [String?] = []

  init(epoch: String, audio: Bool, trickle: Bool, net: [String: Any]) {
    self.epoch = epoch
    self.audio = audio
    self.trickle = trickle
    self.net = net
    super.init()
  }
  private func seconds(_ key: String, _ fallback: Double) -> Double {
    guard let value = RemoteDesktopBridgeNumber.finite(net[key]), value > 0, value <= 120_000 else {
      return fallback / 1000
    }
    return value / 1000
  }
  func post(_ type: String, _ payload: [String: Any] = [:]) {
    guard !stopped else { return }
    emit(payload.merging(["type": type, "epoch": epoch, "attemptId": attempt]) { _, new in new })
  }
  func begin(fallbackServers: [[String: Any]]) {
    post("iceConfig")
    timer = Timer.scheduledTimer(withTimeInterval: seconds("iceConfigMs", 8_000) + seconds("iceConfigBridgeMs", 500), repeats: false) { [weak self] _ in
      self?.start(servers: fallbackServers, source: "native-deadline")
    }
  }
  func receive(_ message: [String: Any]) {
    guard !stopped, message["epoch"] as? String == epoch,
          message["attemptId"] as? String == attempt else { return }
    switch message["type"] as? String {
    case "iceConfig":
      let servers = message["iceServers"] as? [[String: Any]] ?? []
      start(servers: servers, source: "bridge")
    case "answer":
      guard let peer, let sdp = message["sdp"] as? String, !sdp.isEmpty,
            sdp.utf16.count <= 64_000, sdp.utf8.count <= 64_000,
            let sections = Self.answerSections(sdp) else { fail("answer"); return }
      peer.setRemoteDescription(RTCSessionDescription(type: .answer, sdp: sdp)) { [weak self] error in
        DispatchQueue.main.async {
          guard let self, !self.stopped else { return }
          guard error == nil else { self.fail("answer"); return }
          self.remoteSections = sections
          self.deadline(self.seconds("connectMs", 15_000), "connect-timeout")
          self.exchangeUntil = Date().addingTimeInterval(self.seconds("exchangeMs", 30_000))
          self.pollIce()
        }
      }
    case "ice": receiveIce(message)
    case "fallback":
      guard let retry = RemoteDesktopBridgeNumber.boolean(message["retry"]),
            let pending = RemoteDesktopBridgeNumber.boolean(message["capturePending"]) else { return }
      fail(pending ? "capture-pending" : "host", retry: retry)
    default: break
    }
  }
  private func start(servers: [[String: Any]], source: String) {
    guard !stopped, peer == nil else { return }
    timer?.invalidate()
    let config = RTCConfiguration()
    config.sdpSemantics = .unifiedPlan
    config.iceServers = servers.compactMap { server in
      let urls = server["urls"] as? [String] ?? []
      guard !urls.isEmpty else { return nil }
      return RTCIceServer(urlStrings: urls, username: server["username"] as? String,
                         credential: server["credential"] as? String)
    }
    let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
    guard let rtc = Self.factory.peerConnection(with: config, constraints: constraints, delegate: self) else {
      fail("setup"); return
    }
    peer = rtc
    // Receive-only: never create microphone or camera capture tracks.
    let direction = RTCRtpTransceiverInit()
    direction.direction = .recvOnly
    rtc.addTransceiver(of: .video, init: direction)
    rtc.addTransceiver(of: .audio, init: direction)
    channel = rtc.dataChannel(forLabel: "input-v1", configuration: RTCDataChannelConfiguration())
    channel?.delegate = self
    rtc.offer(for: constraints) { [weak self] description, error in
      DispatchQueue.main.async {
        guard let self, !self.stopped else { return }
        guard let description, error == nil else { self.fail("offer"); return }
        rtc.setLocalDescription(description) { [weak self] error in
          DispatchQueue.main.async {
            guard let self, !self.stopped else { return }
            guard error == nil else { self.fail("offer"); return }
            if self.trickle || rtc.iceGatheringState == .complete { self.sendOffer() }
            else {
              self.timer = Timer.scheduledTimer(withTimeInterval: 5, repeats: false) { [weak self] _ in self?.sendOffer() }
            }
          }
        }
      }
    }
    statsTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in self?.reportStats() }
  }
  private func sendOffer() {
    guard !stopped, !offerSent, let sdp = peer?.localDescription?.sdp else { return }
    guard !sdp.isEmpty, sdp.utf16.count <= 64_000, sdp.utf8.count <= 64_000 else {
      fail("offer", retry: false); return
    }
    offerSent = true
    deadline(seconds("answerMs", 45_000), "answer-timeout")
    post("offer", ["sdp": sdp])
  }
  private func deadline(_ duration: Double, _ reason: String) {
    timer?.invalidate()
    timer = Timer.scheduledTimer(withTimeInterval: duration, repeats: false) { [weak self] _ in
      guard let self, self.peer?.connectionState != .connected else { return }
      self.fail(reason)
    }
  }
  private func pollIce() {
    guard !stopped, trickle, peer?.remoteDescription != nil, pending == nil,
          Date() < exchangeUntil else { return }
    let batch = Array(candidates.dropFirst(localAck).prefix(16))
    exchange += 1
    pending = (exchange, batch.count)
    post("ice", ["candidates": batch, "after": remoteAfter, "exchangeId": exchange])
    scheduleIce(4.5)
  }
  private func scheduleIce(_ seconds: Double) {
    iceTimer?.invalidate()
    iceTimer = Timer.scheduledTimer(withTimeInterval: seconds, repeats: false) { [weak self] _ in
      self?.pending = nil
      self?.pollIce()
    }
  }
  private func receiveIce(_ message: [String: Any]) {
    guard let batch = pending,
          RemoteDesktopBridgeNumber.integer(message["exchangeId"]) == batch.id, let peer else { return }
    iceTimer?.invalidate()
    guard let failed = RemoteDesktopBridgeNumber.boolean(message["error"]) else { fail("candidates"); return }
    guard let complete = RemoteDesktopBridgeNumber.boolean(message["complete"]),
          let values = message["candidates"] as? [[String: Any]], values.count <= 16,
          let next = RemoteDesktopBridgeNumber.integer(message["next"]), next == remoteAfter + values.count, next <= 128 else {
      fail("candidates"); return
    }
    // WebRTC serializes addIceCandidate internally. Mark the batch complete only
    // after every callback, so an old exchange cannot acknowledge a newer batch.
    func add(_ index: Int) {
      guard !stopped, pending?.id == batch.id else { return }
      if index == values.count {
        localAck += batch.count
        remoteAfter = next
        pending = nil
        if !(complete && peer.iceGatheringState == .complete && localAck == candidates.count) {
          scheduleIce(seconds("pollMs", 250))
        }
        return
      }
      let value = values[index]
      guard Set(value.keys) == ["candidate", "sdpMid", "sdpMLineIndex", "usernameFragment"],
            let sdp = value["candidate"] as? String, sdp.hasPrefix("candidate:"),
            sdp.utf16.count <= 2_048, sdp.utf8.count <= 2_048,
            let line = candidateLine(value) else {
        fail("candidates"); return
      }
      let key = "\(value["sdpMid"] as? String ?? ""):\(line):\(sdp)"
      if remoteSeen.contains(key) { add(index + 1); return }
      guard remoteSeen.count < 128 else { fail("candidates"); return }
      peer.add(RTCIceCandidate(sdp: sdp, sdpMLineIndex: Int32(line), sdpMid: value["sdpMid"] as? String)) { [weak self] error in
        DispatchQueue.main.async {
          guard let self, !self.stopped else { return }
          guard error == nil else { self.fail("candidates"); return }
          self.remoteSeen.insert(key)
          add(index + 1)
        }
      }
    }
    add(0)
  }
  func stop() {
    guard !stopped else { return }
    stopped = true
    revokeInput()
    pendingViewChallenge = nil
    answeredViewChallenges.removeAll()
    for task in [timer, iceTimer, disconnectTimer, statsTimer] { task?.invalidate() }
    if let sink { track?.remove(sink) }
    sink?.onFrame = nil
    sink = nil
    track = nil
    audioTrack?.isEnabled = false
    audioTrack = nil
    channel?.delegate = nil
    channel?.close()
    channel = nil
    peer?.delegate = nil
    peer?.close()
    peer = nil
    emit = { _ in }
    onFrame = { _ in false }
  }
  func sendInput(_ message: [String: Any]) -> Bool {
    guard !stopped, message["epoch"] as? String == epoch,
          let grant = inputGrant, grant.attemptId == attempt, grant.matches(message),
          !isPresenting(), UIApplication.shared.applicationState == .active,
          peer?.connectionState == .connected, let channel, channel.readyState == .open,
          channel.bufferedAmount < 16_384, let sequence = RemoteDesktopBridgeNumber.integer(message["sequence"]),
          sequence > grant.sequenceBase, sequence <= grant.sequenceLimit, sequence > lastSequence,
          let events = message["events"] as? [[String: Any]],
          let data = RemoteDesktopInputWire.encode(sequence: sequence, events: events) else { return false }
    guard channel.sendData(RTCDataBuffer(data: data, isBinary: false)) else { return false }
    lastSequence = sequence
    return true
  }

  func revokeInput() { inputGrant = nil }

  func authorizeInput(_ message: [String: Any]) {
    guard !stopped, message["epoch"] as? String == epoch else { return }
    if message["grant"] is NSNull { revokeInput(); return }
    guard !isPresenting(), UIApplication.shared.applicationState == .active,
          let value = message["grant"] as? [String: Any], let grant = RemoteDesktopInputGrant(value),
          grant.attemptId == attempt, let generation = UInt64(grant.controlGeneration),
          generation >= newestControlGeneration else { return }
    if inputGrant == grant { return }
    inputGrant = grant
    newestControlGeneration = generation
    lastSequence = max(lastSequence, grant.sequenceBase)
  }

  private static func answerSections(_ sdp: String) -> [String?]? {
    var result: [String?] = []
    var mids = Set<String>()
    for raw in sdp.components(separatedBy: "\n") {
      let line = raw.hasSuffix("\r") ? String(raw.dropLast()) : raw
      if line.hasPrefix("m=") {
        guard result.count < 32 else { return nil }
        result.append(nil)
      } else if line.hasPrefix("a=mid:") {
        let mid = String(line.dropFirst(6))
        guard !result.isEmpty, !mid.isEmpty, mid.utf16.count <= 128,
              result[result.count - 1] == nil, mids.insert(mid).inserted else { return nil }
        result[result.count - 1] = mid
      }
    }
    return result.isEmpty ? nil : result
  }

  private func candidateLine(_ value: [String: Any]) -> Int? {
    let mid = value["sdpMid"] as? String
    guard value["sdpMid"] is NSNull || (mid != nil && mid!.utf16.count <= 128),
          value["usernameFragment"] is NSNull ||
            ((value["usernameFragment"] as? String)?.utf16.count ?? 257) <= 256 else { return nil }
    if value["sdpMLineIndex"] is NSNull {
      guard let mid, let line = remoteSections.firstIndex(where: { $0 == mid }) else { return nil }
      return line
    }
    guard let line = RemoteDesktopBridgeNumber.integer(value["sdpMLineIndex"]), line >= 0, line < 32,
          line < remoteSections.count else { return nil }
    if let mid, remoteSections[line] != mid { return nil }
    return line
  }
  private func fail(_ reason: String, retry: Bool = true) {
    revokeInput()
    pendingViewChallenge = nil
    post("fallback", ["reason": reason, "retry": retry])
    stop()
  }
  private func reportStats() {
    guard !stopped, !statsBusy, UIApplication.shared.applicationState == .active, let peer else { return }
    statsBusy = true
    peer.statistics { [weak self] report in
      DispatchQueue.main.async {
        guard let self, !self.stopped else { return }
        self.statsBusy = false
        let rows = Array(report.statistics.values)
        let pairID = rows.first(where: { $0.type == "transport" })?.values["selectedCandidatePairId"] as? String
        let pair = pairID.flatMap { report.statistics[$0] }
        let local = (pair?.values["localCandidateId"] as? String).flatMap { report.statistics[$0] }?.values["candidateType"] as? String
        let remote = (pair?.values["remoteCandidateId"] as? String).flatMap { report.statistics[$0] }?.values["candidateType"] as? String
        guard let video = rows.first(where: { $0.type == "inbound-rtp" && ($0.values["kind"] as? String) == "video" }) else { return }
        var data: [String: Any] = [
          "transport": local == "relay" || remote == "relay" ? "relay" : (local != nil && remote != nil ? "direct" : "video"),
          "latencyMs": NSNull(), "bytesPerSecond": NSNull()
        ]
        if let rtt = RemoteDesktopBridgeNumber.finite(pair?.values["currentRoundTripTime"]), rtt >= 0,
           (rtt * 1000).isFinite { data["latencyMs"] = rtt * 1000 }
        if let bytes = RemoteDesktopBridgeNumber.finite(video.values["bytesReceived"]), bytes >= 0 {
          let time = video.timestamp_us / 1_000_000
          if time.isFinite, let previous = self.statsSample, previous.id == video.id,
             time > previous.time, bytes >= previous.bytes {
            let rate = (bytes - previous.bytes) / (time - previous.time)
            if rate.isFinite, rate >= 0 { data["bytesPerSecond"] = rate }
          }
          if time.isFinite { self.statsSample = (video.id, bytes, time) }
        }
        self.post("network", data)
      }
    }
  }
  func peerConnection(_ peerConnection: RTCPeerConnection, didGenerate candidate: RTCIceCandidate) {
    DispatchQueue.main.async { [weak self] in
      guard let self, !self.stopped else { return }
      guard self.trickle else { return }
      guard self.candidates.count < 128 else { self.fail("candidate-limit", retry: false); return }
      guard candidate.sdp.hasPrefix("candidate:"), candidate.sdp.utf16.count <= 2_048,
            candidate.sdp.utf8.count <= 2_048,
            candidate.sdpMLineIndex >= 0, candidate.sdpMLineIndex < 32,
            (candidate.sdpMid?.utf16.count ?? 0) <= 128 else { self.fail("candidates", retry: false); return }
      let parts = candidate.sdp.split(whereSeparator: { $0.isWhitespace })
      let fragment = parts.firstIndex(of: "ufrag").flatMap { index in
        index + 1 < parts.count ? String(parts[index + 1]) : nil
      }
      guard (fragment?.utf16.count ?? 0) <= 256 else { self.fail("candidates", retry: false); return }
      let value: [String: Any] = ["candidate": candidate.sdp, "sdpMLineIndex": Int(candidate.sdpMLineIndex),
        "sdpMid": candidate.sdpMid.map { $0 as Any } ?? NSNull(),
        "usernameFragment": fragment.map { $0 as Any } ?? NSNull()]
      self.candidates.append(value)
    }
  }
  func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceGatheringState) {
    DispatchQueue.main.async { [weak self] in
      if newState == .complete && self?.trickle == false { self?.sendOffer() }
    }
  }
  func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCPeerConnectionState) {
    DispatchQueue.main.async { [weak self] in
      guard let self, !self.stopped else { return }
      if newState == .failed || newState == .closed { self.fail("transport") }
      else if newState == .disconnected {
        guard self.disconnectTimer == nil else { return }
        self.post("reconnecting")
        self.disconnectTimer = Timer.scheduledTimer(withTimeInterval: self.seconds("disconnectedMs", 5_000), repeats: false) { [weak self] _ in self?.fail("disconnected") }
      } else if newState == .connected {
        self.timer?.invalidate()
        self.disconnectTimer?.invalidate()
        self.disconnectTimer = nil
        if self.frameReady { self.post("streaming") }
      }
    }
  }
  func peerConnection(_ peerConnection: RTCPeerConnection, didStartReceivingOn transceiver: RTCRtpTransceiver) {
    DispatchQueue.main.async { [weak self] in
      guard let self, !self.stopped else { return }
      if let audio = transceiver.receiver.track as? RTCAudioTrack {
        self.audioTrack = audio
        audio.isEnabled = self.audio
      }
      guard let video = transceiver.receiver.track as? RTCVideoTrack else { return }
      if let sink = self.sink { self.track?.remove(sink) }
      let sink = RemoteDesktopFrameSink()
      sink.onFrame = { [weak self] frame in
        guard let self, !self.stopped else { return }
        guard self.onFrame(frame) else { return }
        if !self.frameReady {
          self.frameReady = true
          self.post("videoFrameReady")
          self.post("streaming")
        }
      }
      self.sink = sink
      self.track = video
      video.add(sink)
    }
  }
  func dataChannel(_ dataChannel: RTCDataChannel, didReceiveMessageWith buffer: RTCDataBuffer) {
    guard !buffer.isBinary, buffer.data.count <= 80_000 else { return }
    DispatchQueue.main.async { [weak self] in
      guard let self, !self.stopped, self.channel === dataChannel,
            let message = try? JSONSerialization.jsonObject(with: buffer.data) as? [String: Any] else { return }
      if message["type"] as? String == "viewPing", Set(message.keys) == ["type", "challenge"],
         let challenge = RemoteDesktopBridgeNumber.uuid(message["challenge"]),
         !self.answeredViewChallenges.contains(challenge),
         dataChannel.readyState == .open {
        // The host keeps one outstanding challenge. It can arrive before PiP
        // starts, so retain it until AVKit confirms actual presentation.
        self.pendingViewChallenge = challenge
        self.replyToViewChallenge()
      } else if message["type"] as? String == "cursor", UIApplication.shared.applicationState == .active {
        self.post("nativeCursor", ["cursor": message["cursor"] ?? NSNull()])
      }
    }
  }
  func replyToViewChallenge() {
    guard !stopped, isPresenting(), isPresentationAuthorized(), let challenge = pendingViewChallenge,
          let channel, channel.readyState == .open else { return }
    if channel.sendData(RTCDataBuffer(data: Data(challenge.utf8), isBinary: false)) {
      answeredViewChallenges.insert(challenge)
      pendingViewChallenge = nil
    }
  }
  func dataChannelDidChangeState(_ dataChannel: RTCDataChannel) {}
  func peerConnection(_ peerConnection: RTCPeerConnection, didChange stateChanged: RTCSignalingState) {}
  func peerConnection(_ peerConnection: RTCPeerConnection, didAdd stream: RTCMediaStream) {}
  func peerConnection(_ peerConnection: RTCPeerConnection, didRemove stream: RTCMediaStream) {}
  func peerConnectionShouldNegotiate(_ peerConnection: RTCPeerConnection) {}
  func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceConnectionState) {
  }
  func peerConnection(_ peerConnection: RTCPeerConnection, didFailToGatherIceCandidate event: RTCIceCandidateErrorEvent) {}
  func peerConnection(_ peerConnection: RTCPeerConnection, didRemove candidates: [RTCIceCandidate]) {}
  func peerConnection(_ peerConnection: RTCPeerConnection, didOpen dataChannel: RTCDataChannel) {}
}

/// A single-slot mailbox prevents decode callbacks from building a main-queue
/// frame backlog. The native receiver still consumes frames while JS is suspended.
private final class RemoteDesktopFrameSink: NSObject, RTCVideoRenderer {
  var onFrame: ((RTCVideoFrame) -> Void)?
  private let lock = NSLock()
  private var latest: RTCVideoFrame?
  private var queued = false
  func setSize(_ size: CGSize) {}
  func renderFrame(_ frame: RTCVideoFrame?) {
    guard let frame else { return }
    lock.lock()
    latest = frame
    if queued { lock.unlock(); return }
    queued = true
    lock.unlock()
    DispatchQueue.main.async { [weak self] in
      guard let self else { return }
      self.lock.lock()
      let frame = self.latest
      self.latest = nil
      self.queued = false
      self.lock.unlock()
      if let frame { self.onFrame?(frame) }
    }
  }
}
