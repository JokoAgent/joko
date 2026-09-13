import type { BlobRef } from "./types.js";

/** Producer-authored metadata for one canonical audio Artifact. */
export interface AudioArtifactMetadata {
  readonly kind: "generic" | "music" | "sound_effect";
  readonly title: string;
  readonly description: string;
  readonly durationSeconds?: number;
  readonly artwork?: {
    readonly blob: BlobRef;
    readonly width: number;
    readonly height: number;
    readonly alt: string;
  };
}

export const AUDIO_ARTIFACT_MAXIMUM_TRACKS = 8;
export const AUDIO_ARTWORK_MAXIMUM_BYTES = 8 * 1024 * 1024;
export const AUDIO_ARTWORK_MAXIMUM_PIXELS = 40_000_000;

/** Validates the current persisted/public value; never repairs or infers tags. */
export function assertAudioArtifactMetadata(value: unknown): asserts value is AudioArtifactMetadata {
  if (!record(value) || typeof value["kind"] !== "string" || !["generic", "music", "sound_effect"].includes(value["kind"])
    || !text(value["title"], 4 * 1024) || !text(value["description"], 64 * 1024)
    || !keys(value, ["kind", "title", "description", "durationSeconds", "artwork"])) throw invalid();
  const duration = value["durationSeconds"];
  if (duration !== undefined && (typeof duration !== "number" || !Number.isFinite(duration) || duration <= 0 || duration > 86_400)) throw invalid();
  const artwork = value["artwork"];
  if (artwork === undefined) return;
  if (!record(artwork) || !keys(artwork, ["blob", "width", "height", "alt"])
    || !Number.isSafeInteger(artwork["width"]) || Number(artwork["width"]) <= 0
    || !Number.isSafeInteger(artwork["height"]) || Number(artwork["height"]) <= 0
    || Number(artwork["width"]) * Number(artwork["height"]) > AUDIO_ARTWORK_MAXIMUM_PIXELS
    || !text(artwork["alt"], 4 * 1024)) throw invalid();
  const blob = artwork["blob"];
  if (!record(blob) || !keys(blob, ["id", "sha256", "byteLength", "mimeType", "fileName"])
    || !text(blob["id"], 4096) || blob["id"] === ""
    || typeof blob["sha256"] !== "string" || !/^[a-f0-9]{64}$/u.test(blob["sha256"])
    || !Number.isSafeInteger(blob["byteLength"]) || Number(blob["byteLength"]) <= 0
    || Number(blob["byteLength"]) > AUDIO_ARTWORK_MAXIMUM_BYTES
    || typeof blob["mimeType"] !== "string" || !["image/png", "image/jpeg", "image/webp"].includes(blob["mimeType"])
    || blob["fileName"] !== undefined && !text(blob["fileName"], 4096)) throw invalid();
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown, maximum: number): boolean {
  return typeof value === "string" && !value.includes("\0") && new TextEncoder().encode(value).byteLength <= maximum;
}

function keys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function invalid(): Error { return new Error("Audio Artifact metadata is invalid."); }
