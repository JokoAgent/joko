/** A bounded, in-memory reader for the MJPEG port of an already-owned WDA process. */
export class SimulatorMjpegError extends Error {
  constructor(readonly code: "INVALID_ARGUMENT" | "STREAM_UNAVAILABLE" | "STREAM_INVALID" |
    "STREAM_TOO_LARGE" | "STREAM_TIMEOUT", message: string) { super(message); }
}

const CRLF = new Uint8Array([13, 10]);
const HEADER_END = new Uint8Array([13, 10, 13, 10]);
const DEFAULT_MAX_FRAME_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_HEADER_BYTES = 16 * 1024;
const DEFAULT_MAX_STREAM_BYTES = 512 * 1024 * 1024;

function locate(haystack: Uint8Array, needle: Uint8Array): number {
  outer: for (let index = 0; index <= haystack.length - needle.length; index += 1) {
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (haystack[index + offset] !== needle[offset]) continue outer;
    }
    return index;
  }
  return -1;
}

function append(left: Uint8Array, right: Uint8Array): Uint8Array {
  if (left.length === 0) return right.slice();
  const next = new Uint8Array(left.length + right.length);
  next.set(left);
  next.set(right, left.length);
  return next;
}

function bounded(value: number | undefined, fallback: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result <= 0) throw new SimulatorMjpegError(
    "INVALID_ARGUMENT", "Simulator stream budget is invalid.");
  return result;
}

export function parseSimulatorMjpegBoundary(contentType: string | null): string {
  if (!contentType || /[\r\n]/u.test(contentType) ||
      !/^multipart\/x-mixed-replace(?:\s*;|\s*$)/iu.test(contentType)) {
    throw new SimulatorMjpegError("STREAM_INVALID", "Simulator stream content type is invalid.");
  }
  const match = /(?:^|;)\s*boundary\s*=\s*(?:"([^"]+)"|([^;\s]+))/iu.exec(contentType);
  const boundary = (match?.[1] ?? match?.[2] ?? "").replace(/^--/u, "");
  if (!boundary || boundary.length > 70 || !/^[A-Za-z0-9'()+_,./:=?-]+$/u.test(boundary)) {
    throw new SimulatorMjpegError("STREAM_INVALID", "Simulator stream boundary is invalid.");
  }
  return boundary;
}

/** Content-Length framing prevents a JPEG body from being mistaken for a multipart boundary. */
export class SimulatorMjpegParser {
  readonly #boundary: Uint8Array;
  readonly #maxFrameBytes: number;
  readonly #maxHeaderBytes: number;
  #buffer: Uint8Array = new Uint8Array();
  #state: "boundary" | "header" | "frame" | "ended" = "boundary";
  #frameLength = 0;

  constructor(boundary: string, options: { maxFrameBytes?: number; maxHeaderBytes?: number } = {}) {
    if (!boundary || boundary.length > 70 || !/^[A-Za-z0-9'()+_,./:=?-]+$/u.test(boundary)) {
      throw new SimulatorMjpegError("INVALID_ARGUMENT", "Simulator stream boundary is invalid.");
    }
    this.#boundary = new TextEncoder().encode(`--${boundary}`);
    this.#maxFrameBytes = bounded(options.maxFrameBytes, DEFAULT_MAX_FRAME_BYTES);
    this.#maxHeaderBytes = bounded(options.maxHeaderBytes, DEFAULT_MAX_HEADER_BYTES);
  }

  push(chunk: Uint8Array): Uint8Array[] {
    if (this.#state === "ended") return [];
    if (chunk.byteLength > this.#maxFrameBytes + this.#maxHeaderBytes + this.#boundary.length + 4) {
      throw new SimulatorMjpegError("STREAM_TOO_LARGE", "Simulator stream chunk exceeded its budget.");
    }
    this.#buffer = append(this.#buffer, chunk);
    const frames: Uint8Array[] = [];
    for (;;) {
      if (this.#state === "boundary") {
        const index = locate(this.#buffer, this.#boundary);
        if (index < 0) {
          this.#buffer = this.#buffer.slice(-Math.min(this.#buffer.length, this.#boundary.length - 1));
          break;
        }
        if (this.#buffer.length < index + this.#boundary.length + 2) {
          this.#buffer = this.#buffer.slice(index);
          break;
        }
        this.#buffer = this.#buffer.slice(index + this.#boundary.length);
        if (this.#buffer[0] === 45 && this.#buffer[1] === 45) {
          this.#state = "ended";
          this.#buffer = new Uint8Array();
          break;
        }
        if (this.#buffer[0] !== CRLF[0] || this.#buffer[1] !== CRLF[1]) {
          throw new SimulatorMjpegError("STREAM_INVALID", "Simulator stream boundary is malformed.");
        }
        this.#buffer = this.#buffer.slice(2);
        this.#state = "header";
      }
      if (this.#state === "header") {
        const index = locate(this.#buffer, HEADER_END);
        if (index < 0) {
          if (this.#buffer.length > this.#maxHeaderBytes) throw new SimulatorMjpegError(
            "STREAM_TOO_LARGE", "Simulator stream header exceeded its budget.");
          break;
        }
        if (index > this.#maxHeaderBytes) throw new SimulatorMjpegError(
          "STREAM_TOO_LARGE", "Simulator stream header exceeded its budget.");
        const lines = new TextDecoder("latin1").decode(this.#buffer.subarray(0, index)).split("\r\n");
        const lengths = lines.filter(line => /^content-length\s*:/iu.test(line));
        if (lengths.length !== 1) throw new SimulatorMjpegError(
          "STREAM_INVALID", "Simulator stream frame length is missing or repeated.");
        const raw = lengths[0]!.slice(lengths[0]!.indexOf(":") + 1).trim();
        if (!/^[1-9][0-9]*$/u.test(raw)) throw new SimulatorMjpegError(
          "STREAM_INVALID", "Simulator stream frame length is invalid.");
        this.#frameLength = Number(raw);
        if (!Number.isSafeInteger(this.#frameLength) || this.#frameLength > this.#maxFrameBytes) {
          throw new SimulatorMjpegError("STREAM_TOO_LARGE", "Simulator stream frame exceeded its budget.");
        }
        this.#buffer = this.#buffer.slice(index + HEADER_END.length);
        this.#state = "frame";
      }
      if (this.#state === "frame") {
        if (this.#buffer.length < this.#frameLength) {
          if (this.#buffer.length > this.#maxFrameBytes) throw new SimulatorMjpegError(
            "STREAM_TOO_LARGE", "Simulator stream frame exceeded its budget.");
          break;
        }
        const frame = this.#buffer.slice(0, this.#frameLength);
        if (frame.length < 4 || frame[0] !== 0xff || frame[1] !== 0xd8 ||
            frame[frame.length - 2] !== 0xff || frame[frame.length - 1] !== 0xd9) {
          throw new SimulatorMjpegError("STREAM_INVALID", "Simulator stream frame is not JPEG.");
        }
        frames.push(frame);
        this.#buffer = this.#buffer.slice(this.#frameLength);
        if (this.#buffer.length >= 2 && this.#buffer[0] === CRLF[0] && this.#buffer[1] === CRLF[1]) {
          this.#buffer = this.#buffer.slice(2);
        }
        this.#frameLength = 0;
        this.#state = "boundary";
      }
    }
    return frames;
  }

  finish(): void {
    if (this.#state === "header" || this.#state === "frame") throw new SimulatorMjpegError(
      "STREAM_INVALID", "Simulator stream ended mid-frame.");
  }
}

export interface SimulatorMjpegFrame { readonly bytes: Uint8Array; readonly receivedAt: string }

/** The port is supplied by the owned driver manager, never by a UI request. */
export async function* streamSimulatorMjpeg(port: number, options: {
  readonly signal?: AbortSignal;
  readonly fetch?: typeof globalThis.fetch;
  readonly maxFrameBytes?: number;
  readonly maxStreamBytes?: number;
  readonly connectTimeoutMs?: number;
  readonly idleTimeoutMs?: number;
} = {}): AsyncGenerator<SimulatorMjpegFrame> {
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65_535) throw new SimulatorMjpegError(
    "INVALID_ARGUMENT", "Simulator stream port is invalid.");
  const maxFrameBytes = bounded(options.maxFrameBytes, DEFAULT_MAX_FRAME_BYTES);
  const maxStreamBytes = bounded(options.maxStreamBytes, DEFAULT_MAX_STREAM_BYTES);
  const connectTimeoutMs = bounded(options.connectTimeoutMs, 5_000);
  const idleTimeoutMs = bounded(options.idleTimeoutMs, 10_000);
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  let timeout = setTimeout(abort, connectTimeoutMs);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let totalBytes = 0;
  try {
    const response = await (options.fetch ?? fetch)(`http://127.0.0.1:${port}/`, {
      signal: controller.signal, redirect: "error", credentials: "omit"
    });
    clearTimeout(timeout);
    if (!response.ok || !response.body) throw new SimulatorMjpegError(
      "STREAM_UNAVAILABLE", "Simulator stream is not available.");
    const parser = new SimulatorMjpegParser(
      parseSimulatorMjpegBoundary(response.headers.get("content-type")), { maxFrameBytes });
    reader = response.body.getReader();
    for (;;) {
      timeout = setTimeout(abort, idleTimeoutMs);
      const next = await reader.read();
      clearTimeout(timeout);
      if (next.done) { parser.finish(); return; }
      totalBytes += next.value.byteLength;
      if (totalBytes > maxStreamBytes) throw new SimulatorMjpegError(
        "STREAM_TOO_LARGE", "Simulator stream session exceeded its budget.");
      for (const bytes of parser.push(next.value)) {
        if (options.signal?.aborted) return;
        yield { bytes, receivedAt: new Date().toISOString() };
      }
    }
  } catch (error) {
    if (options.signal?.aborted) return;
    if (error instanceof SimulatorMjpegError) throw error;
    throw new SimulatorMjpegError(controller.signal.aborted ? "STREAM_TIMEOUT" : "STREAM_UNAVAILABLE",
      controller.signal.aborted ? "Simulator stream timed out." : "Simulator stream disconnected.");
  } finally {
    clearTimeout(timeout);
    controller.abort();
    options.signal?.removeEventListener("abort", abort);
    await reader?.cancel().catch(() => undefined);
    reader?.releaseLock();
  }
}
