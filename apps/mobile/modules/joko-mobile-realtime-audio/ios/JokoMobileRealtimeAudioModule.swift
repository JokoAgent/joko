import AVFoundation
import ExpoModulesCore

private let onAudioChunk = "onAudioChunk"
private let onAudioError = "onAudioError"

public class JokoMobileRealtimeAudioModule: Module {
  private let engine = AVAudioEngine()
  private let sessionStateQueue = DispatchQueue(label: "app.joko.realtime-audio.session-state")
  private let sessionKeepAliveSeconds: TimeInterval = 10
  private var isCapturing = false
  private var targetSampleRate = 16_000.0
  private var chunkIndex = 0
  private var interruptionObserver: NSObjectProtocol?
  private var routeChangeObserver: NSObjectProtocol?
  private var deactivateWorkItem: DispatchWorkItem?

  public func definition() -> ModuleDefinition {
    Name("JokoMobileRealtimeAudio")
    Events(onAudioChunk, onAudioError)

    AsyncFunction("start") { (options: [String: Any]?) in
      try self.startCapture(options: options)
    }
    AsyncFunction("stop") {
      self.stopCapture()
    }
    AsyncFunction("prewarm") {
      self.prewarmAudioSession()
    }
    OnAppEntersBackground {
      self.stopCapture(deactivateImmediately: true)
    }
    OnDestroy {
      self.stopCapture(deactivateImmediately: true)
    }
  }

  private func prewarmAudioSession() {
    sessionStateQueue.sync {
      self.cancelScheduledDeactivateLocked()
      guard !self.isCapturing else { return }
      defer { self.scheduleDeactivateLocked() }
      let session = AVAudioSession.sharedInstance()
      guard session.recordPermission != .denied else { return }
      do {
        try session.setCategory(.playAndRecord, mode: .measurement, options: [.duckOthers, .defaultToSpeaker])
        try session.setActive(true)
      } catch {
        // Best effort only; start reports the actionable failure.
      }
    }
  }

  private func startCapture(options: [String: Any]?) throws {
    try sessionStateQueue.sync {
      self.cancelScheduledDeactivateLocked()
      if self.isCapturing { return }
      if let sampleRate = numericOption(options, key: "sampleRate"), sampleRate > 0 {
        self.targetSampleRate = sampleRate
      }
      let bufferSize = AVAudioFrameCount(integerOption(options, key: "bufferSize") ?? 2_048)
      let session = AVAudioSession.sharedInstance()
      guard session.recordPermission != .denied else {
        self.scheduleDeactivateLocked()
        throw Exception(name: "ERR_MIC_PERMISSION_DENIED", description: "Microphone permission is required for voice input.")
      }
      do {
        try session.setCategory(.playAndRecord, mode: .measurement, options: [.duckOthers, .defaultToSpeaker])
        try session.setActive(true)
      } catch {
        self.scheduleDeactivateLocked()
        throw Exception(name: "ERR_AUDIO_SESSION", description: "Failed to configure the voice audio session.")
      }

      self.installAudioSessionObservers()
      let inputNode = self.engine.inputNode
      let inputFormat = inputNode.inputFormat(forBus: 0)
      self.chunkIndex = 0
      inputNode.removeTap(onBus: 0)
      inputNode.installTap(onBus: 0, bufferSize: bufferSize, format: inputFormat) { [weak self] buffer, time in
        self?.handleInputBuffer(buffer, time: time)
      }
      do {
        self.engine.prepare()
        try self.engine.start()
        self.isCapturing = true
      } catch {
        self.removeAudioSessionObservers()
        inputNode.removeTap(onBus: 0)
        self.scheduleDeactivateLocked()
        throw Exception(name: "ERR_AUDIO_ENGINE_START", description: "Failed to start voice capture.")
      }
    }
  }

  private func stopCapture(deactivateImmediately: Bool = false) {
    sessionStateQueue.sync {
      self.removeAudioSessionObservers()
      if self.engine.isRunning {
        self.engine.inputNode.removeTap(onBus: 0)
        self.engine.stop()
      }
      self.isCapturing = false
      if deactivateImmediately {
        self.cancelScheduledDeactivateLocked()
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
      } else {
        self.scheduleDeactivateLocked()
      }
    }
  }

  private func handleInputBuffer(_ buffer: AVAudioPCMBuffer, time: AVAudioTime) {
    guard let channelData = buffer.floatChannelData else {
      emitError("Voice input did not provide PCM samples.")
      return
    }
    let frameCount = Int(buffer.frameLength)
    guard frameCount > 0 else { return }
    let inputSampleRate = buffer.format.sampleRate
    let channelCount = max(1, Int(buffer.format.channelCount))
    let targetFrameCount = max(1, Int((Double(frameCount) * targetSampleRate / inputSampleRate).rounded(.down)))
    var pcm = Data(capacity: targetFrameCount * 2)
    let scale = inputSampleRate / targetSampleRate
    for targetIndex in 0..<targetFrameCount {
      let sourceIndex = min(frameCount - 1, Int(Double(targetIndex) * scale))
      var mono: Float = 0
      for channelIndex in 0..<channelCount {
        mono += channelData[channelIndex][sourceIndex]
      }
      mono /= Float(channelCount)
      let clamped = max(-1, min(1, mono))
      var sample = Int16(clamped * Float(Int16.max)).littleEndian
      withUnsafeBytes(of: &sample) { pcm.append(contentsOf: $0) }
    }
    let payload: [String: Any] = [
      "base64Pcm16": pcm.base64EncodedString(),
      "capturedAt": Date().timeIntervalSince1970 * 1_000,
      "chunkIndex": chunkIndex,
      "sampleRate": Int(targetSampleRate),
      "durationMs": Double(targetFrameCount) / targetSampleRate * 1_000
    ]
    chunkIndex += 1
    DispatchQueue.main.async { [weak self] in self?.sendEvent(onAudioChunk, payload) }
  }

  private func installAudioSessionObservers() {
    removeAudioSessionObservers()
    let center = NotificationCenter.default
    let session = AVAudioSession.sharedInstance()
    interruptionObserver = center.addObserver(
      forName: AVAudioSession.interruptionNotification,
      object: session,
      queue: .main
    ) { [weak self] notification in
      guard let self, self.isCapturing else { return }
      let rawType = unsignedIntegerValue(notification.userInfo?[AVAudioSessionInterruptionTypeKey])
      guard rawType == AVAudioSession.InterruptionType.began.rawValue else { return }
      self.emitError("Voice input was interrupted by the system.")
      self.stopCapture(deactivateImmediately: true)
    }
    routeChangeObserver = center.addObserver(
      forName: AVAudioSession.routeChangeNotification,
      object: session,
      queue: .main
    ) { [weak self] notification in
      guard let self, self.isCapturing else { return }
      let rawReason = unsignedIntegerValue(notification.userInfo?[AVAudioSessionRouteChangeReasonKey])
      guard rawReason == AVAudioSession.RouteChangeReason.oldDeviceUnavailable.rawValue else { return }
      self.emitError("The voice input microphone route became unavailable.")
      self.stopCapture(deactivateImmediately: true)
    }
  }

  private func removeAudioSessionObservers() {
    let center = NotificationCenter.default
    if let observer = interruptionObserver { center.removeObserver(observer); interruptionObserver = nil }
    if let observer = routeChangeObserver { center.removeObserver(observer); routeChangeObserver = nil }
  }

  private func scheduleDeactivateLocked() {
    cancelScheduledDeactivateLocked()
    let workItem = DispatchWorkItem { [weak self] in
      guard let self else { return }
      self.deactivateWorkItem = nil
      guard !self.isCapturing else { return }
      try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
    deactivateWorkItem = workItem
    sessionStateQueue.asyncAfter(deadline: .now() + sessionKeepAliveSeconds, execute: workItem)
  }

  private func cancelScheduledDeactivateLocked() {
    deactivateWorkItem?.cancel()
    deactivateWorkItem = nil
  }

  private func emitError(_ message: String) {
    DispatchQueue.main.async { [weak self] in self?.sendEvent(onAudioError, ["message": message]) }
  }
}

private func numericOption(_ options: [String: Any]?, key: String) -> Double? {
  if let value = options?[key] as? Double { return value }
  if let value = options?[key] as? Int { return Double(value) }
  if let value = options?[key] as? NSNumber { return value.doubleValue }
  return nil
}

private func integerOption(_ options: [String: Any]?, key: String) -> Int? {
  if let value = options?[key] as? Int { return value }
  if let value = options?[key] as? Double { return Int(value) }
  if let value = options?[key] as? NSNumber { return value.intValue }
  return nil
}

private func unsignedIntegerValue(_ value: Any?) -> UInt? {
  if let value = value as? UInt { return value }
  if let value = value as? Int { return UInt(value) }
  if let value = value as? NSNumber { return value.uintValue }
  return nil
}
