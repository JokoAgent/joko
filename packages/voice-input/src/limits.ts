import type { AudioChunk, SupportedAudioMimeType } from "./types.js";

export const DEFAULT_STABLE_WAIT_MS = 500;
export const STALL_WALL_TIMEOUT_MS = 4_000;
export const STALL_VOICED_AUDIO_MS = 2_000;
export const MAXIMUM_RECOVERY_ATTEMPTS = 3;
export const MAXIMUM_AUDIO_CHUNK_BYTES = 1024 * 1024;
export const MAXIMUM_AUDIO_BYTES = 64 * 1024 * 1024;
export const MAXIMUM_AUDIO_CHUNK_DURATION_MS = 10_000;
export const MAXIMUM_AUDIO_DURATION_MS = 10 * 60 * 1_000;
export const MAXIMUM_LOCALE_CHARACTERS = 35;
export const MAXIMUM_REFINEMENT_INSTRUCTIONS_CHARACTERS = 1_000;
export const MAXIMUM_DICTIONARY_TERM_CHARACTERS = 120;
export const MAXIMUM_DICTIONARY_TERMS = 200;
export const MAXIMUM_DICTIONARY_CHARACTERS = 8_000;

const SUPPORTED_AUDIO_MIME_TYPES = new Set<SupportedAudioMimeType>([
  "audio/mp4",
  "audio/mpeg",
  "audio/ogg",
  "audio/pcm",
  "audio/wav",
  "audio/webm"
]);

export type VoiceInputBoundsErrorCode =
  | "audio_chunk_bytes"
  | "audio_chunk_duration"
  | "audio_total_bytes"
  | "audio_total_duration"
  | "locale"
  | "mime_type"
  | "refinement_context"
  | "stable_wait";

export class VoiceInputBoundsError extends Error {
  readonly code: VoiceInputBoundsErrorCode;

  constructor(code: VoiceInputBoundsErrorCode) {
    super(`Voice input value is outside the supported ${code.replaceAll("_", " ")} bound.`);
    this.name = "VoiceInputBoundsError";
    this.code = code;
  }
}

export function normalizeMimeType(value: string): SupportedAudioMimeType {
  if (typeof value !== "string" || value.length > 64) throw new VoiceInputBoundsError("mime_type");
  const normalized = value.trim().toLocaleLowerCase("en-US");
  if (!SUPPORTED_AUDIO_MIME_TYPES.has(normalized as SupportedAudioMimeType)) {
    throw new VoiceInputBoundsError("mime_type");
  }
  return normalized as SupportedAudioMimeType;
}

export function normalizeLocale(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const candidate = value.trim();
  if (candidate.length === 0 || candidate.length > MAXIMUM_LOCALE_CHARACTERS) {
    throw new VoiceInputBoundsError("locale");
  }
  try {
    const canonical = Intl.getCanonicalLocales(candidate);
    if (canonical.length !== 1 || canonical[0] === undefined || canonical[0].length > MAXIMUM_LOCALE_CHARACTERS) {
      throw new VoiceInputBoundsError("locale");
    }
    return canonical[0];
  } catch (error) {
    if (error instanceof VoiceInputBoundsError) throw error;
    throw new VoiceInputBoundsError("locale");
  }
}

export function normalizeRefinementInstructions(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.replace(/\r\n?/gu, "\n").trim();
  if (normalized.length === 0) return undefined;
  if (normalized.length > MAXIMUM_REFINEMENT_INSTRUCTIONS_CHARACTERS || /\u0000/u.test(normalized)) {
    throw new VoiceInputBoundsError("refinement_context");
  }
  return normalized;
}

export function normalizeDictionaryTerms(values: readonly string[] | undefined): readonly string[] {
  if (values === undefined) return [];
  if (!Array.isArray(values) || values.length > MAXIMUM_DICTIONARY_TERMS) {
    throw new VoiceInputBoundsError("refinement_context");
  }
  const seen = new Set<string>();
  const normalized: string[] = [];
  let characters = 0;
  for (const value of values) {
    if (typeof value !== "string") throw new VoiceInputBoundsError("refinement_context");
    const term = value.replace(/\s+/gu, " ").trim();
    if (term.length === 0) continue;
    if (term.length > MAXIMUM_DICTIONARY_TERM_CHARACTERS || /[\u0000-\u001f\u007f]/u.test(term)) {
      throw new VoiceInputBoundsError("refinement_context");
    }
    const key = term.toLocaleLowerCase();
    if (seen.has(key)) continue;
    characters += term.length;
    if (characters > MAXIMUM_DICTIONARY_CHARACTERS) throw new VoiceInputBoundsError("refinement_context");
    seen.add(key);
    normalized.push(term);
  }
  return Object.freeze(normalized);
}

export function validateStableWait(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 5_000) {
    throw new VoiceInputBoundsError("stable_wait");
  }
  return value;
}

export function validateAudioChunk(
  chunk: AudioChunk,
  totals: { readonly bytes: number; readonly durationMs: number }
): { readonly bytes: number; readonly durationMs: number } {
  if (!(chunk.data instanceof ArrayBuffer) || chunk.data.byteLength === 0 || chunk.data.byteLength > MAXIMUM_AUDIO_CHUNK_BYTES) {
    throw new VoiceInputBoundsError("audio_chunk_bytes");
  }
  if (
    !Number.isFinite(chunk.durationMs) ||
    chunk.durationMs <= 0 ||
    chunk.durationMs > MAXIMUM_AUDIO_CHUNK_DURATION_MS
  ) {
    throw new VoiceInputBoundsError("audio_chunk_duration");
  }
  const bytes = totals.bytes + chunk.data.byteLength;
  const durationMs = totals.durationMs + chunk.durationMs;
  if (bytes > MAXIMUM_AUDIO_BYTES) throw new VoiceInputBoundsError("audio_total_bytes");
  if (durationMs > MAXIMUM_AUDIO_DURATION_MS) throw new VoiceInputBoundsError("audio_total_duration");
  return { bytes, durationMs };
}
