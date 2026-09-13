import { gzipSync, gunzipSync } from "node:zlib";

export const MAXIMUM_MESSAGE_BYTES = 256 * 1024;
export const MAXIMUM_TRANSCRIPT_CHARACTERS = 200_000;

export function configurationFrame(): Buffer {
  return frame(1, 0, Buffer.from(JSON.stringify({
    audio: { format: "pcm", codec: "raw", rate: 16_000, bits: 16, channel: 1 },
    request: { model_name: "bigmodel", result_type: "full", show_utterances: true,
      enable_nonstream: true, end_window_size: 300, enable_punc: true, enable_itn: true }
  })), undefined);
}

export function audioFrame(audio: Buffer, sequence: number): Buffer {
  return frame(2, sequence < 0 ? 3 : 1, audio, sequence);
}

function frame(type: number, flags: number, payload: Buffer, sequence: number | undefined): Buffer {
  const data = gzipSync(payload);
  const header = Buffer.alloc(sequence === undefined ? 8 : 12);
  header.set([0x11, (type << 4) | flags, type === 1 ? 0x11 : 0x01, 0]);
  if (sequence !== undefined) header.writeInt32BE(sequence, 4);
  header.writeUInt32BE(data.length, header.length - 4);
  return Buffer.concat([header, data]);
}

export type ServerMessage = { readonly type: "error"; readonly code: number } | {
  readonly type: "result";
  readonly sequence?: number;
  readonly last: boolean;
  readonly text?: string;
  readonly stable?: string;
};

/** Decodes only the documented v1 full-result/error protocol and bounded JSON. */
export function serverMessage(data: Buffer): ServerMessage {
  if (data.length < 8 || data.length > MAXIMUM_MESSAGE_BYTES || data[0] !== 0x11 || data[3] !== 0) invalid();
  const type = data[1]! >> 4;
  const flags = data[1]! & 15;
  const serialization = data[2]! >> 4;
  const compression = data[2]! & 15;
  if (flags > 3 || compression > 1 || (type !== 9 && type !== 15)) invalid();
  let offset = 4;
  let sequence: number | undefined;
  let code: number | undefined;
  if (type === 15) {
    if (flags !== 0 || serialization > 1 || data.length < 12) invalid();
    code = data.readUInt32BE(offset);
    offset += 4;
  } else {
    if (serialization !== 1) invalid();
    if ((flags & 1) !== 0) {
      if (data.length < 12) invalid();
      sequence = data.readInt32BE(offset);
      if ((flags === 1 && sequence <= 0) || (flags === 3 && sequence >= 0)) invalid();
      offset += 4;
    }
  }
  const size = data.readUInt32BE(offset);
  offset += 4;
  if (size !== data.length - offset) invalid();
  const payload = compression === 1
    ? gunzipSync(data.subarray(offset), { maxOutputLength: MAXIMUM_MESSAGE_BYTES }) : data.subarray(offset);
  // Provider errors are classified by numeric code; their untrusted content is never retained.
  if (type === 15) return { type: "error", code: code! };
  const object: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload));
  if (!record(object)) invalid();
  const result = object["result"];
  const last = (flags & 2) !== 0;
  if (result === undefined) {
    if (Object.keys(object).some((key) => key !== "audio_info")) invalid();
    return { type: "result", sequence, last };
  }
  if (!record(result) || typeof result["text"] !== "string" || result["text"].length > MAXIMUM_TRANSCRIPT_CHARACTERS) invalid();
  const text = result["text"];
  const utterances = result["utterances"];
  let stableEnd = 0;
  if (utterances !== undefined) {
    if (!Array.isArray(utterances) || utterances.length > 4_096) invalid();
    let offset = 0;
    let mutable = false;
    let previousEnd = 0;
    for (const utterance of utterances) {
      if (!record(utterance) || typeof utterance["text"] !== "string" || typeof utterance["definite"] !== "boolean"
        || !Number.isSafeInteger(utterance["start_time"]) || !Number.isSafeInteger(utterance["end_time"])
        || (utterance["start_time"] as number) < previousEnd || (utterance["end_time"] as number) < (utterance["start_time"] as number)) invalid();
      previousEnd = utterance["end_time"] as number;
      const part = utterance["text"].trim();
      while (offset < text.length && /\s/u.test(text[offset]!)) offset += 1;
      if (!text.startsWith(part, offset)) invalid();
      offset += part.length;
      mutable ||= !utterance["definite"];
      if (!mutable) stableEnd = offset;
    }
  }
  return { type: "result", sequence, last, text, stable: last ? text : text.slice(0, stableEnd) };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function invalid(): never { throw new Error("Invalid transcription protocol message."); }
