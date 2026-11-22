import CommonCrypto
import ExpoModulesCore
import Foundation

/// Runs the speaker filter models (Silero VAD and the voiceprint model) with
/// ONNX Runtime. All feature extraction and gating logic lives in shared
/// TypeScript; this module only loads the two models and runs float32
/// tensors through them, one call at a time on its own serial queue.
public class JokoSpeakerOnnxModule: Module {
  private let queue = DispatchQueue(label: "app.joko.speaker", qos: .userInitiated)
  private var sessions: [String: JokoSpeakerOnnxSession] = [:]
  private var loadedPaths: [String: String] = [:]

  public func definition() -> ModuleDefinition {
    Name("JokoSpeakerOnnx")

    /// Loads (or keeps) both models. Same paths as last time is a no-op.
    AsyncFunction("loadModels") { (vadPath: String, embeddingPath: String) in
      try self.queue.sync {
        let wanted = ["vad": try self.cacheFile(vadPath).path, "embedding": try self.cacheFile(embeddingPath).path]
        if wanted == self.loadedPaths { return }
        var next: [String: JokoSpeakerOnnxSession] = [:]
        for (name, path) in wanted {
          guard let session = JokoSpeakerOnnxSession.load(modelPath: path) else {
            throw SpeakerOnnxException("could not load a verified model")
          }
          next[name] = session
        }
        self.sessions = next
        self.loadedPaths = wanted
      }
    }

    /// `packed` holds the little-endian float32 data of every input, in the
    /// order of `names`, each sized by its `dims`. Returns, per output, its
    /// dims and its float32 data as base64.
    AsyncFunction("run") { (model: String, names: [String], dims: [[Int]], packed: Data) -> [String: [String: Any]] in
      try self.queue.sync {
        guard let session = self.sessions[model] else {
          throw SpeakerOnnxException("model \(model) is not loaded")
        }
        guard let result = session.run(names: names, dimensions: dims.map { $0.map { NSNumber(value: $0) } }, bytes: packed) else {
          throw SpeakerOnnxException("could not evaluate the speaker tensors")
        }
        return result
      }
    }

    /// Hex SHA-256 of a downloaded model file, read in chunks.
    AsyncFunction("sha256File") { (path: String) -> String in
      guard let handle = FileHandle(forReadingAtPath: try self.cacheFile(path).path) else {
        throw SpeakerOnnxException("cannot open file")
      }
      defer { try? handle.close() }
      var context = CC_SHA256_CTX()
      CC_SHA256_Init(&context)
      while true {
        let chunk = handle.readData(ofLength: 1 << 20)
        if chunk.isEmpty { break }
        chunk.withUnsafeBytes { buffer in
          _ = CC_SHA256_Update(&context, buffer.baseAddress, CC_LONG(chunk.count))
        }
      }
      var digest = [UInt8](repeating: 0, count: Int(CC_SHA256_DIGEST_LENGTH))
      CC_SHA256_Final(&digest, &context)
      return digest.map { String(format: "%02x", $0) }.joined()
    }
  }

  private func cacheFile(_ path: String) throws -> URL {
    guard let cache = appContext?.config.cacheDirectory else { throw SpeakerOnnxException("missing model cache") }
    let root = cache.appendingPathComponent("voice-models-v1").resolvingSymlinksInPath().standardizedFileURL
    let file = URL(fileURLWithPath: path).resolvingSymlinksInPath().standardizedFileURL
    guard file.deletingLastPathComponent().path == root.path else { throw SpeakerOnnxException("invalid model cache path") }
    return file
  }
}

final class SpeakerOnnxException: GenericException<String> {
  override var reason: String {
    "Speaker ONNX inference failed: \(param)"
  }
}
