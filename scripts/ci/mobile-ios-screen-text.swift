import Foundation
import Vision

// Observe Simulator screenshots using Apple's local Vision framework. This does
// not inject accessibility values or change the app's pixels or navigation.
guard CommandLine.arguments.count == 2 else {
  fatalError("Expected one Simulator screenshot path.")
}
let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.recognitionLanguages = ["en-US"]
request.usesLanguageCorrection = false
try VNImageRequestHandler(url: URL(fileURLWithPath: CommandLine.arguments[1])).perform([request])
let lines: [[String: Any]] = (request.results ?? []).compactMap { observation in
  guard let candidate = observation.topCandidates(1).first else { return nil }
  return ["text": String(candidate.string.prefix(500)), "confidence": candidate.confidence]
}
let bytes = try JSONSerialization.data(withJSONObject: ["lines": lines], options: [.sortedKeys])
FileHandle.standardOutput.write(bytes)
