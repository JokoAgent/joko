import { constants as bufferConstants } from "node:buffer";
import { StringDecoder } from "node:string_decoder";
import { piError } from "./errors.js";

export const DEFAULT_PI_JSONL_RECORD_BYTES = 16 * 1024 * 1024;
/**
 * JSON.parse needs one V8 string for a complete record. Buffer.MAX_LENGTH can
 * be larger than that string ceiling, so the smaller platform limit is the
 * only honest upper bound for adaptive runtime records.
 */
export const MAX_SAFE_PI_JSONL_RECORD_BYTES = Math.min(
  bufferConstants.MAX_LENGTH,
  bufferConstants.MAX_STRING_LENGTH
);

export interface StrictJsonLineDecoderOptions {
  readonly maxRecordBytes?: number;
  /** Hard ceiling for explicit, monotonic runtime capacity reservations. */
  readonly maxRecordBytesCeiling?: number;
  readonly onValue: (value: unknown) => void;
}

/**
 * Pi RPC requires records to be split on byte 0x0a only. Generic line
 * readers are intentionally avoided because some also split Unicode line
 * separators that are legal inside JSON strings.
 */
export class StrictJsonLineDecoder {
  readonly #decoder = new StringDecoder("utf8");
  #maxRecordBytes: number;
  readonly #maxRecordBytesCeiling: number;
  readonly #onValue: (value: unknown) => void;
  #chunks: Buffer[] = [];
  #bytes = 0;
  #closed = false;

  constructor(options: StrictJsonLineDecoderOptions) {
    const ceiling = options.maxRecordBytesCeiling
      ?? options.maxRecordBytes
      ?? DEFAULT_PI_JSONL_RECORD_BYTES;
    assertRecordByteLimit(ceiling, "JSONL record ceiling");
    const initial = options.maxRecordBytes ?? Math.min(DEFAULT_PI_JSONL_RECORD_BYTES, ceiling);
    assertRecordByteLimit(initial, "JSONL record limit");
    if (initial > ceiling) {
      throw piError(
        "PI_PROTOCOL_RECORD_LIMIT_INVALID",
        "Pi JSONL record limit exceeds its configured ceiling",
        "stream"
      );
    }
    this.#maxRecordBytes = initial;
    this.#maxRecordBytesCeiling = ceiling;
    this.#onValue = options.onValue;
  }

  get maxRecordBytes(): number {
    return this.#maxRecordBytes;
  }

  /**
   * Reserve capacity before dispatching a command that Pi can echo on stdout.
   * This changes only a byte counter; the decoder never preallocates the
   * reserved capacity.
   */
  reserveRecordBytes(requiredBytes: number): void {
    assertRecordByteLimit(requiredBytes, "JSONL record reservation");
    if (requiredBytes > this.#maxRecordBytesCeiling) {
      throw piError(
        "PI_PROTOCOL_RECORD_BUDGET_EXCEEDED",
        `Pi JSONL record reservation exceeds the configured ${this.#maxRecordBytesCeiling}-byte ceiling`,
        "dispatch",
        {
          recovery: "Use a Blob/runtime capability whose wire representation fits the configured JSONL parser ceiling."
        }
      );
    }
    if (requiredBytes > this.#maxRecordBytes) this.#maxRecordBytes = requiredBytes;
  }

  push(chunk: Uint8Array): void {
    if (this.#closed) throw piError("PI_PROTOCOL_CLOSED", "Received bytes after JSONL decoder closed", "stream");
    const buffer = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    let start = 0;
    for (let index = 0; index < buffer.length; index += 1) {
      if (buffer[index] !== 0x0a) continue;
      this.#append(buffer.subarray(start, index));
      this.#finishRecord();
      start = index + 1;
    }
    this.#append(buffer.subarray(start));
  }

  end(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#bytes !== 0) {
      throw piError(
        "PI_PROTOCOL_TRUNCATED_RECORD",
        "Pi stdout ended with a JSON record that was not terminated by LF",
        "stream",
        { stateMayHaveChanged: true, recovery: "Resume the native session and reconcile its durable entry cursor." }
      );
    }
    const trailing = this.#decoder.end();
    if (trailing.length !== 0) {
      throw piError("PI_PROTOCOL_TRUNCATED_UTF8", "Pi stdout ended inside a UTF-8 sequence", "stream");
    }
  }

  #append(chunk: Buffer): void {
    if (chunk.length === 0) return;
    const nextBytes = this.#bytes + chunk.length;
    if (!Number.isSafeInteger(nextBytes) || nextBytes > this.#maxRecordBytes) {
      throw piError(
        "PI_PROTOCOL_RECORD_TOO_LARGE",
        `Pi emitted a JSONL record larger than ${this.#maxRecordBytes} bytes`,
        "stream",
        { stateMayHaveChanged: true }
      );
    }
    this.#bytes = nextBytes;
    this.#chunks.push(chunk);
  }

  #finishRecord(): void {
    let record = this.#chunks.length === 0 ? Buffer.alloc(0) : Buffer.concat(this.#chunks, this.#bytes);
    this.#chunks = [];
    this.#bytes = 0;
    if (record.length > 0 && record[record.length - 1] === 0x0d) record = record.subarray(0, record.length - 1);
    if (record.length === 0) {
      throw piError("PI_PROTOCOL_EMPTY_RECORD", "Pi emitted an empty JSONL record", "stream", { stateMayHaveChanged: true });
    }
    const text = this.#decoder.write(record);
    try {
      this.#onValue(JSON.parse(text) as unknown);
    } catch (error) {
      throw piError("PI_PROTOCOL_INVALID_JSON", "Pi emitted invalid JSONL", "stream", {
        stateMayHaveChanged: true,
        recovery: "Restart the Pi runtime and reconcile from the native JSONL session.",
        cause: error
      });
    }
  }
}

export function encodeJsonLine(value: unknown): Buffer {
  const text = JSON.stringify(value);
  if (text === undefined) throw piError("PI_PROTOCOL_UNSERIALIZABLE", "RPC command is not JSON serializable", "dispatch");
  return Buffer.from(`${text}\n`, "utf8");
}

function assertRecordByteLimit(value: number, label: string): void {
  if (
    !Number.isSafeInteger(value)
    || value <= 0
    || value > MAX_SAFE_PI_JSONL_RECORD_BYTES
  ) {
    throw piError(
      "PI_PROTOCOL_RECORD_LIMIT_INVALID",
      `${label} must be a positive safe integer no larger than the platform JSON string ceiling`,
      "stream"
    );
  }
}
