export interface SimulatorH264Frame {
  readonly bytes: Uint8Array;
  readonly format: "annex-b" | "length-prefixed";
  readonly width: number;
  readonly height: number;
  readonly timestampMicros: number;
  readonly keyFrame: boolean;
}

export type SimulatorH264FallbackReason = "webcodecs-unavailable" | "missing-key-frame" |
  "missing-parameter-sets" | "unsupported-configuration" | "decoder-error";
export type SimulatorH264DecodeResult = "decoded" | "waiting-for-key-frame" | "fallback" |
  "closed" | "stale";

interface DecoderConfiguration {
  codec: string;
  codedWidth: number;
  codedHeight: number;
  optimizeForLatency: true;
  hardwareAcceleration: "prefer-hardware";
}
interface EncodedChunkInit {
  type: "key" | "delta";
  timestamp: number;
  data: Uint8Array;
}
export interface DecodedFrame { close(): void; }
interface Decoder {
  configure(configuration: DecoderConfiguration): void;
  decode(chunk: unknown): void;
  close(): void;
}
interface DecoderCallbacks {
  output(frame: DecodedFrame): void;
  error(error: DOMException): void;
}
export interface SimulatorH264DecoderRuntime {
  isConfigSupported(configuration: DecoderConfiguration): Promise<boolean>;
  createDecoder(callbacks: DecoderCallbacks): Decoder;
  createChunk(init: EncodedChunkInit): unknown;
}
export interface SimulatorH264DecoderOptions {
  readonly runtime?: SimulatorH264DecoderRuntime | null;
  readonly renderFrame: (frame: DecodedFrame, width: number, height: number) => void;
  readonly onFrameRendered?: () => void;
  readonly onFallback: (reason: SimulatorH264FallbackReason) => void;
  readonly maxConsecutiveErrors?: number;
  readonly maxFramesAwaitingKeyFrame?: number;
}

interface DecoderIdentity { generation: bigint; width: number; height: number; codec: string; }
interface PendingDecode {
  frame: SimulatorH264Frame;
  generation: bigint;
  epoch: number;
  resolve(result: SimulatorH264DecodeResult): void;
}
const START_CODE = new Uint8Array([0, 0, 0, 1]);
const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const MAX_DIMENSION = 8_192;
// Product capture forces an IDR at least every two seconds at up to 60 FPS.
const DEFAULT_KEY_FRAME_WAIT = 120;

function startCodeLength(bytes: Uint8Array, offset: number): number {
  if (bytes[offset] !== 0 || bytes[offset + 1] !== 0) return 0;
  if (bytes[offset + 2] === 1) return 3;
  return bytes[offset + 2] === 0 && bytes[offset + 3] === 1 ? 4 : 0;
}

export function splitAnnexBNalUnits(bytes: Uint8Array): Uint8Array[] {
  const units: Uint8Array[] = [];
  let offset = 0;
  while (offset + 3 <= bytes.byteLength) {
    const prefix = startCodeLength(bytes, offset);
    if (prefix === 0) { offset += 1; continue; }
    const start = offset + prefix;
    let end = start;
    while (end + 3 <= bytes.byteLength && startCodeLength(bytes, end) === 0) end += 1;
    if (end + 3 > bytes.byteLength) end = bytes.byteLength;
    if (end > start) units.push(bytes.subarray(start, end));
    offset = end;
  }
  return units;
}

function splitLengthPrefixedNalUnits(bytes: Uint8Array): Uint8Array[] | null {
  const units: Uint8Array[] = [];
  let offset = 0;
  while (offset < bytes.byteLength) {
    if (offset + 4 > bytes.byteLength) return null;
    const length = bytes[offset]! * 0x1000000 + bytes[offset + 1]! * 0x10000 +
      bytes[offset + 2]! * 0x100 + bytes[offset + 3]!;
    offset += 4;
    if (length < 1 || offset + length > bytes.byteLength) return null;
    units.push(bytes.subarray(offset, offset + length));
    offset += length;
  }
  return units;
}

export function normalizeH264AccessUnit(frame: SimulatorH264Frame): {
  readonly bytes: Uint8Array; readonly nalUnits: readonly Uint8Array[];
} | null {
  if (frame.bytes.byteLength < 5 || frame.bytes.byteLength > MAX_FRAME_BYTES ||
      !Number.isSafeInteger(frame.width) || frame.width < 1 || frame.width > MAX_DIMENSION ||
      !Number.isSafeInteger(frame.height) || frame.height < 1 || frame.height > MAX_DIMENSION ||
      !Number.isSafeInteger(frame.timestampMicros) || frame.timestampMicros < 0) return null;
  const nalUnits = frame.format === "annex-b" ? splitAnnexBNalUnits(frame.bytes)
    : splitLengthPrefixedNalUnits(frame.bytes);
  if (!nalUnits?.length) return null;
  if (frame.format === "annex-b") return { bytes: frame.bytes.slice(), nalUnits };
  const size = nalUnits.reduce((total, unit) => total + START_CODE.byteLength + unit.byteLength, 0);
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const unit of nalUnits) {
    bytes.set(START_CODE, offset);
    offset += START_CODE.byteLength;
    bytes.set(unit, offset);
    offset += unit.byteLength;
  }
  return { bytes, nalUnits };
}

export function codecFromH264NalUnits(units: readonly Uint8Array[]): string | null {
  const parameterSet = units.find(unit => (unit[0]! & 0x1f) === 7);
  if (!parameterSet || parameterSet.byteLength < 4) return null;
  return `avc1.${[...parameterSet.subarray(1, 4)].map(byte => byte.toString(16).padStart(2, "0")).join("")}`;
}

function containsNalType(units: readonly Uint8Array[], type: number): boolean {
  return units.some(unit => (unit[0]! & 0x1f) === type);
}

export function createBrowserSimulatorH264DecoderRuntime(): SimulatorH264DecoderRuntime | null {
  const browser = globalThis as typeof globalThis & {
    VideoDecoder?: {
      new (callbacks: DecoderCallbacks): Decoder;
      isConfigSupported(configuration: DecoderConfiguration): Promise<{ supported?: boolean }>;
    };
    EncodedVideoChunk?: new (init: EncodedChunkInit) => unknown;
  };
  if (!browser.VideoDecoder || !browser.EncodedVideoChunk) return null;
  const VideoDecoderConstructor = browser.VideoDecoder;
  const EncodedVideoChunkConstructor = browser.EncodedVideoChunk;
  return {
    async isConfigSupported(configuration) {
      return (await VideoDecoderConstructor.isConfigSupported(configuration)).supported === true;
    },
    createDecoder(callbacks) { return new VideoDecoderConstructor(callbacks); },
    createChunk(init) { return new EncodedVideoChunkConstructor(init); }
  };
}

/** One visible-route decoder. Encoded input is latest-wins; decoded frames are always closed. */
export class SimulatorH264Decoder {
  readonly #runtime: SimulatorH264DecoderRuntime | null;
  readonly #renderFrame: SimulatorH264DecoderOptions["renderFrame"];
  readonly #onFrameRendered: SimulatorH264DecoderOptions["onFrameRendered"];
  readonly #onFallback: SimulatorH264DecoderOptions["onFallback"];
  readonly #maxConsecutiveErrors: number;
  readonly #maxFramesAwaitingKeyFrame: number;
  #decoder: Decoder | null = null;
  #identity: DecoderIdentity | null = null;
  #decoderToken = 0;
  #epoch = 0;
  #consecutiveErrors = 0;
  #framesAwaitingKeyFrame = 0;
  #fallbackReason: SimulatorH264FallbackReason | null = null;
  #closed = false;
  #processing = false;
  #pending: PendingDecode | null = null;

  constructor(options: SimulatorH264DecoderOptions) {
    this.#runtime = options.runtime === undefined ? createBrowserSimulatorH264DecoderRuntime()
      : options.runtime;
    this.#renderFrame = options.renderFrame;
    this.#onFrameRendered = options.onFrameRendered;
    this.#onFallback = options.onFallback;
    this.#maxConsecutiveErrors = Math.max(1, options.maxConsecutiveErrors ?? 3);
    this.#maxFramesAwaitingKeyFrame = Math.max(1, options.maxFramesAwaitingKeyFrame ?? DEFAULT_KEY_FRAME_WAIT);
  }

  decode(frame: SimulatorH264Frame, generation: bigint): Promise<SimulatorH264DecodeResult> {
    if (this.#closed) return Promise.resolve("closed");
    return new Promise(resolve => {
      this.#pending?.resolve("stale");
      this.#pending = { frame, generation, epoch: this.#epoch, resolve };
      void this.#drain();
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#epoch += 1;
    this.#pending?.resolve("closed");
    this.#pending = null;
    this.#disposeDecoder();
  }

  async #drain(): Promise<void> {
    if (this.#processing) return;
    this.#processing = true;
    try {
      while (this.#pending) {
        const pending = this.#pending;
        this.#pending = null;
        pending.resolve(await this.#decode(pending.frame, pending.generation, pending.epoch));
      }
    } finally {
      this.#processing = false;
      if (this.#pending) void this.#drain();
    }
  }

  async #decode(frame: SimulatorH264Frame, generation: bigint,
    epoch: number): Promise<SimulatorH264DecodeResult> {
    if (this.#closed) return "closed";
    if (epoch !== this.#epoch) return "stale";
    if (this.#fallbackReason) return "fallback";
    if (!this.#runtime) return this.#fallback("webcodecs-unavailable");
    const normalized = normalizeH264AccessUnit(frame);
    if (!normalized) return this.#decoderError();
    if (this.#identity && (this.#identity.generation !== generation ||
        this.#identity.width !== frame.width || this.#identity.height !== frame.height)) {
      this.#resetForKeyFrame();
    }
    if (!this.#decoder) {
      if (!frame.keyFrame) {
        if (++this.#framesAwaitingKeyFrame >= this.#maxFramesAwaitingKeyFrame)
          return this.#fallback("missing-key-frame");
        return "waiting-for-key-frame";
      }
      if (!containsNalType(normalized.nalUnits, 7) || !containsNalType(normalized.nalUnits, 8))
        return this.#fallback("missing-parameter-sets");
      const codec = codecFromH264NalUnits(normalized.nalUnits);
      if (!codec) return this.#fallback("missing-parameter-sets");
      const configuration: DecoderConfiguration = { codec, codedWidth: frame.width,
        codedHeight: frame.height, optimizeForLatency: true,
        hardwareAcceleration: "prefer-hardware" };
      let supported: boolean;
      try { supported = await this.#runtime.isConfigSupported(configuration); }
      catch { return this.#decoderError(); }
      if (this.#closed || epoch !== this.#epoch || this.#fallbackReason) return "stale";
      if (!supported) return this.#fallback("unsupported-configuration");
      try { this.#createDecoder({ generation, width: frame.width, height: frame.height, codec }); }
      catch { return this.#decoderError(); }
      this.#framesAwaitingKeyFrame = 0;
    }
    try {
      this.#decoder!.decode(this.#runtime.createChunk({ type: frame.keyFrame ? "key" : "delta",
        timestamp: frame.timestampMicros, data: normalized.bytes }));
      return "decoded";
    } catch { return this.#decoderError(); }
  }

  #createDecoder(identity: DecoderIdentity): void {
    const token = ++this.#decoderToken;
    const decoder = this.#runtime!.createDecoder({
      output: frame => {
        if (this.#closed || token !== this.#decoderToken || this.#fallbackReason) {
          frame.close();
          return;
        }
        try {
          this.#renderFrame(frame, identity.width, identity.height);
          this.#consecutiveErrors = 0;
          this.#onFrameRendered?.();
        } catch { this.#decoderError(); }
        finally { frame.close(); }
      },
      error: () => { if (!this.#closed && token === this.#decoderToken) this.#decoderError(); }
    });
    this.#decoder = decoder;
    this.#identity = identity;
    try { decoder.configure({ codec: identity.codec, codedWidth: identity.width,
      codedHeight: identity.height, optimizeForLatency: true,
      hardwareAcceleration: "prefer-hardware" }); }
    catch (error) { this.#disposeDecoder(); this.#identity = null; throw error; }
  }

  #decoderError(): SimulatorH264DecodeResult {
    if (++this.#consecutiveErrors >= this.#maxConsecutiveErrors) return this.#fallback("decoder-error");
    this.#resetForKeyFrame();
    return "waiting-for-key-frame";
  }

  #resetForKeyFrame(): void {
    this.#disposeDecoder();
    this.#identity = null;
    this.#framesAwaitingKeyFrame = 0;
  }

  #disposeDecoder(): void {
    this.#decoderToken += 1;
    const decoder = this.#decoder;
    this.#decoder = null;
    try { decoder?.close(); } catch { /* A failed decoder may already be closed. */ }
  }

  #fallback(reason: SimulatorH264FallbackReason): SimulatorH264DecodeResult {
    if (this.#fallbackReason) return "fallback";
    this.#fallbackReason = reason;
    this.#disposeDecoder();
    this.#onFallback(reason);
    return "fallback";
  }
}
