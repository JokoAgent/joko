import CoreFoundation
import CoreGraphics
import Darwin
import Foundation
import ObjectiveC

private let maxInputBytes = 2 * 1024 * 1024
private let maxSamples = 4_096
private let maxDurationMs = 60_000
private let liveIdleSeconds = 5.0
private let maxLiveLineBytes = 512
private var cancellationRequested: Int32 = 0

private typealias ClassObjectError = @convention(c) (
    AnyClass, Selector, AnyObject, UnsafeMutablePointer<NSError?>
) -> AnyObject?
private typealias ObjectError = @convention(c) (
    AnyObject, Selector, UnsafeMutablePointer<NSError?>
) -> AnyObject?
private typealias ObjectNoArgs = @convention(c) (AnyObject, Selector) -> AnyObject?
private typealias Allocate = @convention(c) (AnyClass, Selector) -> AnyObject
private typealias InitializeHID = @convention(c) (
    AnyObject, Selector, AnyObject, UnsafeMutablePointer<NSError?>
) -> AnyObject?
private typealias SendHID = @convention(c) (
    AnyObject, Selector, UnsafeMutableRawPointer, Bool, AnyObject?, AnyObject?
) -> Void
private typealias MouseMessage = @convention(c) (
    UnsafePointer<CGPoint>, UnsafePointer<CGPoint>?, UInt32, UInt,
    CGFloat, CGFloat, UInt32
) -> UnsafeMutableRawPointer?

private struct TouchSample {
    let x: Double
    let y: Double
    let phase: String
    let dtMs: Int
    let edge: UInt32
}

private func reply(_ code: String) -> Never {
    let bytes = Data("{\"code\":\"\(code)\"}\n".utf8)
    FileHandle.standardOutput.write(bytes)
    exit(code == "OK" ? 0 : 1)
}

private func implementation(_ cls: AnyClass, _ selector: Selector,
                            classMethod: Bool = false) -> IMP? {
    let method = classMethod
        ? class_getClassMethod(cls, selector)
        : class_getInstanceMethod(cls, selector)
    guard let method else { return nil }
    return method_getImplementation(method)
}

private func argument(_ flag: String) -> String? {
    guard let index = CommandLine.arguments.firstIndex(of: flag),
          index + 1 < CommandLine.arguments.count else { return nil }
    return CommandLine.arguments[index + 1]
}

private func exactDevice(_ udid: String) -> AnyObject? {
    guard let contextClass = NSClassFromString("SimServiceContext"),
          let sharedIMP = implementation(contextClass,
            NSSelectorFromString("sharedServiceContextForDeveloperDir:error:"),
            classMethod: true),
          let setIMP = implementation(contextClass,
            NSSelectorFromString("defaultDeviceSetWithError:")) else { return nil }
    let shared = unsafeBitCast(sharedIMP, to: ClassObjectError.self)
    let developerDir = ProcessInfo.processInfo.environment["DEVELOPER_DIR"]
        ?? "/Applications/Xcode.app/Contents/Developer"
    var error: NSError?
    guard let context = shared(contextClass,
        NSSelectorFromString("sharedServiceContextForDeveloperDir:error:"),
        developerDir as NSString, &error) else { return nil }
    let deviceSet = unsafeBitCast(setIMP, to: ObjectError.self)
    guard let set = deviceSet(context,
        NSSelectorFromString("defaultDeviceSetWithError:"), &error),
          let devicesIMP = implementation(type(of: set),
            NSSelectorFromString("devicesByUDID")) else { return nil }
    let devices = unsafeBitCast(devicesIMP, to: ObjectNoArgs.self)
    guard let collection = devices(set, NSSelectorFromString("devicesByUDID"))
        as? NSDictionary else { return nil }
    return collection.first(where: { key, _ in
        String(describing: key).uppercased() == udid.uppercased()
    })?.value as AnyObject?
}

private final class HIDInjector {
    private let client: AnyObject
    private let selector = NSSelectorFromString(
        "sendWithMessage:freeWhenDone:completionQueue:completion:"
    )
    private let sendHID: SendHID
    private let mouseMessage: MouseMessage

    init?(device: AnyObject) {
        guard let symbol = dlsym(UnsafeMutableRawPointer(bitPattern: -2),
            "IndigoHIDMessageForMouseNSEvent"),
              let cls = NSClassFromString(
                "_TtC12SimulatorKit24SimDeviceLegacyHIDClient"),
              let allocIMP = implementation(cls, NSSelectorFromString("alloc"),
                classMethod: true),
              let initIMP = implementation(cls,
                NSSelectorFromString("initWithDevice:error:")) else { return nil }
        let allocate = unsafeBitCast(allocIMP, to: Allocate.self)
        let initialize = unsafeBitCast(initIMP, to: InitializeHID.self)
        let allocated = allocate(cls, NSSelectorFromString("alloc"))
        var error: NSError?
        guard let client = initialize(allocated,
            NSSelectorFromString("initWithDevice:error:"), device, &error),
              let sendIMP = implementation(type(of: client), selector) else {
            return nil
        }
        self.client = client
        self.sendHID = unsafeBitCast(sendIMP, to: SendHID.self)
        self.mouseMessage = unsafeBitCast(symbol, to: MouseMessage.self)
    }

    func send(_ first: TouchSample, _ second: TouchSample?) -> Bool {
        let eventType: UInt = first.phase == "up" || first.phase == "cancel" ? 2 : 1
        var firstPoint = CGPoint(x: first.x, y: first.y)
        let message: UnsafeMutableRawPointer?
        if var secondPoint = second.map({ CGPoint(x: $0.x, y: $0.y) }) {
            message = withUnsafePointer(to: &secondPoint) { pointer in
                mouseMessage(&firstPoint, pointer, 0x32, eventType, 1, 1, 0)
            }
        } else {
            message = mouseMessage(&firstPoint, nil, 0x32, eventType,
                1, 1, first.edge)
        }
        guard let message else { return false }
        sendHID(client, selector, message, true, nil, nil)
        return true
    }
}

private func numeric(_ value: Any?) -> NSNumber? {
    guard let number = value as? NSNumber,
          CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
    return number
}

private func touchEdge(_ value: Any?) -> UInt32? {
    switch value as? String {
    case "none": return 0
    case "left": return 1
    case "top": return 2
    case "bottom": return 3
    case "right": return 4
    default: return nil
    }
}

private func parsePath(_ value: Any?) -> [TouchSample]? {
    guard let input = value as? [[String: Any]],
          input.count >= 2, input.count <= maxSamples else { return nil }
    var result: [TouchSample] = []
    result.reserveCapacity(input.count)
    var duration = 0
    var edge: UInt32?
    for (index, value) in input.enumerated() {
        guard let x = numeric(value["x"])?.doubleValue,
              let y = numeric(value["y"])?.doubleValue,
              x.isFinite, y.isFinite, x >= 0, x <= 1, y >= 0, y <= 1,
              let phase = value["phase"] as? String,
              let delay = numeric(value["dtMs"])?.doubleValue,
              delay.isFinite, delay.rounded() == delay,
              delay >= 0, delay <= Double(maxDurationMs),
              let pointEdge = touchEdge(value["edge"]) else { return nil }
        if index == 0 {
            guard phase == "down", delay == 0 else { return nil }
        } else if index == input.count - 1 {
            guard phase == "up" || phase == "cancel" else { return nil }
        } else {
            guard phase == "move", delay >= 4 else { return nil }
        }
        edge = edge ?? pointEdge
        guard edge == pointEdge else { return nil }
        duration += Int(delay)
        guard duration <= maxDurationMs else { return nil }
        result.append(TouchSample(x: x, y: y, phase: phase,
            dtMs: Int(delay), edge: pointEdge))
    }
    return result
}

private func readInput() -> [String: Any]? {
    var data = Data()
    var buffer = [UInt8](repeating: 0, count: 64 * 1024)
    while true {
        let count = read(STDIN_FILENO, &buffer, buffer.count)
        if count < 0 { return nil }
        if count == 0 { break }
        data.append(contentsOf: buffer[0..<count])
        if data.count > maxInputBytes { return nil }
    }
    return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
}

private func wait(_ milliseconds: Int) -> Bool {
    var remaining = milliseconds
    while remaining > 0 {
        if cancellationRequested != 0 { return false }
        let step = min(remaining, 10)
        Thread.sleep(forTimeInterval: Double(step) / 1_000)
        remaining -= step
    }
    return cancellationRequested == 0
}

private func liveReply(_ code: String, sequence: Int? = nil) {
    let suffix = sequence.map { ",\"sequence\":\($0)" } ?? ""
    FileHandle.standardOutput.write(Data("{\"code\":\"\(code)\"\(suffix)}\n".utf8))
}

private func readLiveLine(_ buffer: inout Data, until deadline: Double) -> Data? {
    while cancellationRequested == 0 && ProcessInfo.processInfo.systemUptime < deadline {
        if let newline = buffer.firstIndex(of: 10) {
            let line = Data(buffer[..<newline])
            buffer.removeSubrange(buffer.startIndex...newline)
            return line.count <= maxLiveLineBytes ? line : nil
        }
        guard buffer.count <= maxLiveLineBytes else { return nil }
        var descriptor = pollfd(fd: STDIN_FILENO, events: Int16(POLLIN), revents: 0)
        let ready = Darwin.poll(&descriptor, 1, 250)
        if ready == 0 || ready < 0 && errno == EINTR { continue }
        if ready < 0 { return nil }
        var chunk = [UInt8](repeating: 0, count: 1_024)
        let count = read(STDIN_FILENO, &chunk, chunk.count)
        if count <= 0 { return nil }
        buffer.append(contentsOf: chunk[0..<count])
    }
    return nil
}

private func runLive(_ injector: HIDInjector) -> Never {
    signal(SIGTERM) { _ in cancellationRequested = 1 }
    signal(SIGINT) { _ in cancellationRequested = 1 }
    var buffer = Data()
    var gestureId: String?
    var lastSequence = -1
    var lastPoint: TouchSample?
    let startedAt = ProcessInfo.processInfo.systemUptime
    liveReply("READY")
    for _ in 0..<maxSamples {
        let now = ProcessInfo.processInfo.systemUptime
        if now - startedAt >= Double(maxDurationMs) / 1_000 { break }
        let deadline = min(now + liveIdleSeconds,
            startedAt + Double(maxDurationMs) / 1_000)
        guard let line = readLiveLine(&buffer, until: deadline),
              let object = try? JSONSerialization.jsonObject(with: line),
              let value = object as? [String: Any],
              let identifier = value["gestureId"] as? String,
              UUID(uuidString: identifier) != nil,
              let sequenceValue = numeric(value["sequence"])?.doubleValue,
              sequenceValue.isFinite,
              sequenceValue.rounded() == sequenceValue,
              sequenceValue == Double(lastSequence + 1),
              let phase = value["phase"] as? String,
              let x = numeric(value["x"])?.doubleValue,
              let y = numeric(value["y"])?.doubleValue,
              x.isFinite, y.isFinite,
              x >= 0, x <= 1, y >= 0, y <= 1 else { break }
        if gestureId == nil {
            guard phase == "begin" else { break }
            gestureId = identifier
        } else {
            guard gestureId == identifier,
                  phase == "move" || phase == "end" || phase == "cancel" else { break }
        }
        let sample = TouchSample(x: x, y: y,
            phase: phase == "begin" ? "down" : phase == "end" ? "up" : phase,
            dtMs: 0, edge: 0)
        guard cancellationRequested == 0, injector.send(sample, nil) else { break }
        lastSequence += 1
        lastPoint = sample
        liveReply("OK", sequence: lastSequence)
        if phase == "end" || phase == "cancel" { exit(0) }
    }
    if let lastPoint, lastPoint.phase != "up" && lastPoint.phase != "cancel" {
        _ = injector.send(TouchSample(x: lastPoint.x, y: lastPoint.y,
            phase: "cancel", dtMs: 0, edge: 0), nil)
    }
    liveReply("INPUT_OUTCOME_UNKNOWN")
    exit(1)
}

guard let udid = argument("--simulator-udid"), UUID(uuidString: udid) != nil,
      let generation = argument("--generation"),
      let generationNumber = Int(generation), generationNumber > 0,
      CommandLine.arguments.contains("--probe") ||
        CommandLine.arguments.contains("--touch") ||
        CommandLine.arguments.contains("--live-touch") else {
    reply("INVALID_ARGUMENT")
}
guard let device = exactDevice(udid), let injector = HIDInjector(device: device) else {
    reply("NATIVE_INPUT_UNAVAILABLE")
}
if CommandLine.arguments.contains("--probe") { reply("OK") }
if CommandLine.arguments.contains("--live-touch") { runLive(injector) }
guard let input = readInput(),
      input["simulatorUdid"] as? String == udid,
      input["generation"] as? Int == generationNumber,
      let first = parsePath(input["first"]) else {
    reply("INVALID_ARGUMENT")
}
let second: [TouchSample]?
if input["second"] == nil {
    second = nil
} else {
    guard let parsed = parsePath(input["second"]),
          parsed.count == first.count,
          first.indices.allSatisfy({ index in
            parsed[index].phase == first[index].phase &&
            parsed[index].dtMs == first[index].dtMs &&
            parsed[index].edge == 0 && first[index].edge == 0
          }) else { reply("INVALID_ARGUMENT") }
    second = parsed
}
signal(SIGTERM) { _ in cancellationRequested = 1 }
signal(SIGINT) { _ in cancellationRequested = 1 }
var lastFirst = first[0]
var lastSecond = second?[0]
var contactActive = false
for index in first.indices {
    let point = first[index]
    if !wait(point.dtMs) || !injector.send(point, second?[index]) {
        if contactActive {
            let releaseFirst = TouchSample(x: lastFirst.x, y: lastFirst.y,
                phase: "cancel", dtMs: 0, edge: lastFirst.edge)
            let releaseSecond = lastSecond.map { TouchSample(x: $0.x, y: $0.y,
                phase: "cancel", dtMs: 0, edge: $0.edge) }
            _ = injector.send(releaseFirst, releaseSecond)
        }
        reply("INPUT_OUTCOME_UNKNOWN")
    }
    lastFirst = point
    lastSecond = second?[index]
    contactActive = point.phase != "up" && point.phase != "cancel"
}
_ = wait(100)
reply("OK")
