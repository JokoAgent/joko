const MAX_METADATA_BYTES = 512;
const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const MAX_BODY_BYTES = 2 + MAX_METADATA_BYTES + MAX_FRAME_BYTES;
const MAX_DIMENSION = 8_192;
const MAX_FRAMES_PER_READ = 16;

export interface SimulatorNativeH264Frame {
  readonly sequence: number;
  readonly width: number;
  readonly height: number;
  readonly timestampMicros: number;
  readonly keyFrame: boolean;
  readonly format: "annex-b";
  readonly bytes: Uint8Array;
  readonly receivedAt: string;
}

export class SimulatorNativeH264ProtocolError extends Error {
  constructor() { super("Simulator native frame stream is invalid."); }
}

/** Length-framed, bounded binary stream from one exact-device helper process. */
export class SimulatorNativeH264FrameParser {
  readonly #prefix = new Uint8Array(4);
  #prefixUsed = 0;
  #body: Uint8Array | null = null;
  #bodyUsed = 0;
  #lastSequence = 0;

  push(chunk: Uint8Array): SimulatorNativeH264Frame[] {
    const frames: SimulatorNativeH264Frame[] = [];
    let cursor = 0;
    while (cursor < chunk.byteLength) {
      if (this.#body === null) {
        const taken = Math.min(4 - this.#prefixUsed, chunk.byteLength - cursor);
        this.#prefix.set(chunk.subarray(cursor, cursor + taken), this.#prefixUsed);
        this.#prefixUsed += taken;
        cursor += taken;
        if (this.#prefixUsed !== 4) continue;
        const size = this.#prefix[0]! | this.#prefix[1]! << 8 |
          this.#prefix[2]! << 16 | this.#prefix[3]! << 24;
        if (size < 2 + 5 || size > MAX_BODY_BYTES) throw new SimulatorNativeH264ProtocolError();
        this.#body = new Uint8Array(size);
        this.#bodyUsed = 0;
        this.#prefixUsed = 0;
      }
      const body = this.#body;
      const taken = Math.min(body.byteLength - this.#bodyUsed, chunk.byteLength - cursor);
      body.set(chunk.subarray(cursor, cursor + taken), this.#bodyUsed);
      this.#bodyUsed += taken;
      cursor += taken;
      if (this.#bodyUsed !== body.byteLength) continue;
      const frame = this.#parse(body);
      this.#body = null;
      this.#bodyUsed = 0;
      frames.push(frame);
      if (frames.length > MAX_FRAMES_PER_READ) throw new SimulatorNativeH264ProtocolError();
    }
    return frames;
  }

  finish(): void {
    if (this.#prefixUsed !== 0 || this.#body !== null) throw new SimulatorNativeH264ProtocolError();
  }

  #parse(body: Uint8Array): SimulatorNativeH264Frame {
    const metadataLength = body[0]! | body[1]! << 8;
    if (metadataLength < 1 || metadataLength > MAX_METADATA_BYTES ||
        2 + metadataLength + 5 > body.byteLength) throw new SimulatorNativeH264ProtocolError();
    let value: unknown;
    try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body.subarray(2,
      2 + metadataLength))); }
    catch { throw new SimulatorNativeH264ProtocolError(); }
    if (value === null || typeof value !== "object" || Array.isArray(value))
      throw new SimulatorNativeH264ProtocolError();
    const metadata = value as Record<string, unknown>;
    const keys = Object.keys(metadata).sort();
    if (keys.join(",") !== "format,height,keyFrame,sequence,timestampMicros,width" ||
        metadata["format"] !== "annex-b" ||
        !Number.isSafeInteger(metadata["sequence"]) ||
        (metadata["sequence"] as number) !== this.#lastSequence + 1 ||
        !Number.isSafeInteger(metadata["width"]) ||
        (metadata["width"] as number) < 1 || (metadata["width"] as number) > MAX_DIMENSION ||
        !Number.isSafeInteger(metadata["height"]) ||
        (metadata["height"] as number) < 1 || (metadata["height"] as number) > MAX_DIMENSION ||
        !Number.isSafeInteger(metadata["timestampMicros"]) ||
        (metadata["timestampMicros"] as number) < 0 ||
        typeof metadata["keyFrame"] !== "boolean") throw new SimulatorNativeH264ProtocolError();
    const bytes = body.subarray(2 + metadataLength);
    if (bytes.byteLength > MAX_FRAME_BYTES || bytes[0] !== 0 || bytes[1] !== 0 ||
        bytes[2] !== 0 || bytes[3] !== 1 || (bytes[4]! & 0x1f) === 0)
      throw new SimulatorNativeH264ProtocolError();
    this.#lastSequence = metadata["sequence"] as number;
    return { sequence: this.#lastSequence, width: metadata["width"] as number,
      height: metadata["height"] as number,
      timestampMicros: metadata["timestampMicros"] as number,
      keyFrame: metadata["keyFrame"] as boolean, format: "annex-b",
      bytes, receivedAt: new Date().toISOString() };
  }
}
