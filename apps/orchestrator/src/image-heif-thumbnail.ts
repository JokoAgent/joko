import { Worker } from "node:worker_threads";

export interface HeifThumbnailRequest {
  readonly bytes: Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly orientation?: number;
  readonly maximumPixels: number;
  readonly maximumDimension: number;
  readonly maximumOutputBytes: number;
}

export interface HeifThumbnail {
  readonly data: Uint8Array;
  readonly widthPixels: number;
  readonly heightPixels: number;
}

/** Decoder lifetimes remain part of the caller's processing slot, including termination. */
export function readHeifFileThumbnail(request: HeifThumbnailRequest, signal: AbortSignal): Promise<HeifThumbnail> {
  signal.throwIfAborted();
  const bytes = Uint8Array.from(request.bytes);
  const entry = import.meta.url.endsWith(".ts") ? "./image-heif-worker.mts" : "./image-heif-worker.mjs";
  const worker = new Worker(new URL(entry, import.meta.url), {
    workerData: { ...request, bytes }, transferList: [bytes.buffer],
    env: {}, execArgv: [], stdout: true, stderr: true, resourceLimits: { maxOldGenerationSizeMb: 384 }
  });
  // Third-party decoder diagnostics stay inside this disposable worker.
  worker.stdout?.resume(); worker.stderr?.resume();
  return new Promise((resolve, reject) => {
    let result: HeifThumbnail | undefined;
    const stop = () => { void worker.terminate().catch(() => undefined); };
    worker.once("message", (message: unknown) => {
      if (message && typeof message === "object" && "data" in message && message.data instanceof Uint8Array
        && "widthPixels" in message && Number.isSafeInteger(message.widthPixels) && typeof message.widthPixels === "number"
        && "heightPixels" in message && Number.isSafeInteger(message.heightPixels) && typeof message.heightPixels === "number"
        && message.widthPixels > 0 && message.heightPixels > 0 && message.widthPixels <= 256 && message.heightPixels <= 256
        && message.data.length > 0 && message.data.length <= request.maximumOutputBytes) {
        result = { data: message.data, widthPixels: message.widthPixels, heightPixels: message.heightPixels };
      }
      stop();
    });
    worker.once("error", () => { result = undefined; stop(); });
    worker.once("exit", () => {
      signal.removeEventListener("abort", stop);
      if (signal.aborted) reject(signal.reason ?? new Error("The image thumbnail was cancelled."));
      else if (result) resolve(result);
      else reject(new Error("The HEIF image could not be decoded."));
    });
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
  });
}
