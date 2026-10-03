interface JsonObject {
  [key: string]: unknown;
}

export interface ManagedResponsesSseRepair {
  /** Consume one decoded upstream Fetch body chunk and return zero or more downstream chunks. */
  write(chunk: Uint8Array): readonly Uint8Array[];
  /** Flush a final unterminated SSE frame after the upstream reader reports done. */
  finish(): readonly Uint8Array[];
}

export interface ManagedResponsesSseRepairOptions {
  readonly protocol: string;
  readonly contentType: string | null | undefined;
}

const MAXIMUM_PENDING_FRAME_BYTES = 16 * 1024 * 1024;
const EMPTY_BYTES: Uint8Array = new Uint8Array();
const encoder = new TextEncoder();

/**
 * Create a best-effort repairer only for decoded managed Responses SSE bodies.
 * Fetch has already decoded content encoding before chunks reach this boundary.
 */
export function createManagedResponsesSseRepair(
  options: ManagedResponsesSseRepairOptions
): ManagedResponsesSseRepair | undefined {
  if (options.protocol !== "openai-responses" || !isEventStream(options.contentType)) return undefined;
  return new ManagedResponsesSseRepairState();
}

class ManagedResponsesSseRepairState implements ManagedResponsesSseRepair {
  #finished = false;
  #oversizedFrame = false;
  #oversizedSuffix: Uint8Array = EMPTY_BYTES;
  #pending: Uint8Array = EMPTY_BYTES;

  write(chunk: Uint8Array): readonly Uint8Array[] {
    if (this.#finished) throw new Error("The managed Responses SSE body is already complete.");
    if (!(chunk instanceof Uint8Array)) throw new Error("The managed Responses SSE body chunk is invalid.");
    if (chunk.byteLength === 0) return [];
    const output: Uint8Array[] = [];
    let remaining = chunk;
    if (this.#oversizedFrame) remaining = this.#writeOversizedFrame(remaining, output);
    if (remaining.byteLength > 0) this.#writeBuffered(remaining, output);
    return output;
  }

  finish(): readonly Uint8Array[] {
    if (this.#finished) return [];
    this.#finished = true;
    if (this.#oversizedFrame) {
      this.#oversizedFrame = false;
      this.#oversizedSuffix = EMPTY_BYTES;
      return [];
    }
    if (this.#pending.byteLength === 0) return [];
    const pending = this.#pending;
    this.#pending = EMPTY_BYTES;
    return [rewriteFrame(pending, EMPTY_BYTES, pending)];
  }

  #writeBuffered(chunk: Uint8Array, output: Uint8Array[]): void {
    const buffered = concatenate(this.#pending, chunk);
    let offset = 0;
    for (;;) {
      const boundary = findFrameBoundary(buffered, offset);
      if (boundary === undefined) break;
      const frame = buffered.subarray(offset, boundary.start);
      const framed = buffered.subarray(offset, boundary.end);
      const delimiter = buffered.subarray(boundary.start, boundary.end);
      output.push(frame.byteLength > MAXIMUM_PENDING_FRAME_BYTES
        ? framed
        : rewriteFrame(frame, delimiter, framed));
      offset = boundary.end;
    }
    this.#pending = buffered.slice(offset);
    if (this.#pending.byteLength <= MAXIMUM_PENDING_FRAME_BYTES) return;

    output.push(this.#pending);
    this.#oversizedFrame = true;
    this.#oversizedSuffix = tailForBoundary(this.#pending);
    this.#pending = EMPTY_BYTES;
  }

  #writeOversizedFrame(chunk: Uint8Array, output: Uint8Array[]): Uint8Array {
    const scan = concatenate(this.#oversizedSuffix, chunk);
    const boundary = findFrameBoundary(scan, 0);
    if (boundary === undefined) {
      output.push(chunk);
      this.#oversizedSuffix = tailForBoundary(scan);
      return EMPTY_BYTES;
    }

    const endInChunk = boundary.end - this.#oversizedSuffix.byteLength;
    if (endInChunk > 0) output.push(chunk.subarray(0, endInChunk));
    this.#oversizedFrame = false;
    this.#oversizedSuffix = EMPTY_BYTES;
    return chunk.subarray(Math.max(0, endInChunk));
  }
}

function rewriteFrame(frame: Uint8Array, delimiter: Uint8Array, original: Uint8Array): Uint8Array {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(frame);
  } catch {
    return original;
  }
  const lines = splitLines(text);
  const dataIndexes: number[] = [];
  const data: string[] = [];
  lines.forEach((line, index) => {
    if (!line.text.startsWith("data:")) return;
    dataIndexes.push(index);
    const value = line.text.slice(5);
    data.push(value.startsWith(" ") ? value.slice(1) : value);
  });
  if (dataIndexes.length === 0) return original;
  const payload = data.join("\n");
  if (payload.length === 0 || payload === "[DONE]") return original;

  let event: unknown;
  try {
    event = JSON.parse(payload);
  } catch {
    return original;
  }
  const repaired = repairEvent(event);
  if (repaired === undefined) return original;

  const firstDataIndex = dataIndexes[0]!;
  const dataIndexSet = new Set(dataIndexes);
  const repairedLines = lines.flatMap((line, index) => {
    if (index === firstDataIndex) return [`data: ${JSON.stringify(repaired)}`];
    return dataIndexSet.has(index) ? [] : [line.text];
  });
  const separator = lines.find((line) => line.ending !== "")?.ending ?? "\n";
  return concatenate(encoder.encode(repairedLines.join(separator)), delimiter);
}

function repairEvent(value: unknown): JsonObject | undefined {
  if (!isObject(value) || typeof value["type"] !== "string") return undefined;
  const type = value["type"];
  if (type.endsWith(".delta")) return undefined;
  if (type === "response.output_item.added" || type === "response.output_item.done") {
    const item = repairItem(value["item"]);
    return item === undefined ? undefined : { ...value, item };
  }
  const response = value["response"];
  if (!isObject(response) || !Array.isArray(response["output"])) return undefined;
  let changed = false;
  const output = response["output"].map((item) => {
    const repaired = repairItem(item);
    if (repaired === undefined) return item;
    changed = true;
    return repaired;
  });
  return changed ? { ...value, response: { ...response, output } } : undefined;
}

function repairItem(value: unknown): JsonObject | undefined {
  if (!isObject(value)) return undefined;
  if (value["type"] === "reasoning" && value["summary"] === null) {
    return { ...value, summary: [] };
  }
  if (value["type"] === "message" && value["content"] === null) {
    return { ...value, content: [] };
  }
  return undefined;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEventStream(value: string | null | undefined): boolean {
  if (typeof value !== "string") return false;
  return value.split(";", 1)[0]!.trim().toLowerCase() === "text/event-stream";
}

interface FrameBoundary {
  readonly start: number;
  readonly end: number;
}

function findFrameBoundary(bytes: Uint8Array, offset: number): FrameBoundary | undefined {
  for (let index = offset; index < bytes.byteLength; index += 1) {
    const first = lineBreakLength(bytes, index);
    if (first === 0) continue;
    const second = lineBreakLength(bytes, index + first);
    if (second > 0) return { start: index, end: index + first + second };
    index += first - 1;
  }
  return undefined;
}

function lineBreakLength(bytes: Uint8Array, index: number): number {
  if (bytes[index] === 0x0a) return 1;
  return bytes[index] === 0x0d && bytes[index + 1] === 0x0a ? 2 : 0;
}

function tailForBoundary(bytes: Uint8Array): Uint8Array {
  return bytes.slice(Math.max(0, bytes.byteLength - 3));
}

function concatenate(left: Uint8Array, right: Uint8Array): Uint8Array {
  if (left.byteLength === 0) return right;
  if (right.byteLength === 0) return left;
  const combined = new Uint8Array(left.byteLength + right.byteLength);
  combined.set(left, 0);
  combined.set(right, left.byteLength);
  return combined;
}

interface SseLine {
  readonly text: string;
  readonly ending: string;
}

function splitLines(value: string): SseLine[] {
  const lines: SseLine[] = [];
  const endings = /\r?\n/gu;
  let offset = 0;
  for (const match of value.matchAll(endings)) {
    lines.push({ text: value.slice(offset, match.index), ending: match[0] });
    offset = match.index + match[0].length;
  }
  lines.push({ text: value.slice(offset), ending: "" });
  return lines;
}
