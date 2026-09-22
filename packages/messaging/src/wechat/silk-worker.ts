import { parentPort } from "node:worker_threads";
import { decode } from "silk-wasm";

const port = parentPort;
if (port === null) throw new Error("WeChat voice decoder requires a worker thread.");

const OUTPUT_LIMIT = 20 * 1_024 * 1_024;

port.once("message", async (request: unknown) => {
  if (!isRequest(request)) {
    port.postMessage({ ok: false });
    return;
  }
  try {
    const result = await decode(new Uint8Array(request.bytes), 24_000);
    const pcm = result.data;
    if (!(pcm instanceof Uint8Array) || pcm.byteLength === 0 || pcm.byteLength % 2 !== 0
      || pcm.byteLength > OUTPUT_LIMIT - 44) throw new Error("invalid decoder output");
    const wav = Buffer.allocUnsafe(pcm.byteLength + 44);
    wav.write("RIFF", 0, "ascii");
    wav.writeUInt32LE(pcm.byteLength + 36, 4);
    wav.write("WAVEfmt ", 8, "ascii");
    wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20);
    wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(24_000, 24);
    wav.writeUInt32LE(48_000, 28);
    wav.writeUInt16LE(2, 32);
    wav.writeUInt16LE(16, 34);
    wav.write("data", 36, "ascii");
    wav.writeUInt32LE(pcm.byteLength, 40);
    wav.set(pcm, 44);
    const output = Uint8Array.from(wav);
    port.postMessage({ ok: true, bytes: output.buffer }, [output.buffer]);
  } catch {
    port.postMessage({ ok: false });
  }
});

function isRequest(value: unknown): value is { readonly bytes: ArrayBuffer } {
  return value !== null && typeof value === "object" && "bytes" in value
    && value.bytes instanceof ArrayBuffer && value.bytes.byteLength <= 5 * 1_024 * 1_024;
}
