import {
  MAXIMUM_AUDIO_BYTES,
  type AsrErrorCategory,
  type AsrEvent,
  type AsrProvider,
  type AsrStartRequest,
  type AudioChunk,
  type SupportedAudioMimeType
} from "@joko/voice-input";

const DEFAULT_TIMEOUT_MS = 45_000;
const MINIMUM_TIMEOUT_MS = 1_000;
const MAXIMUM_TIMEOUT_MS = 120_000;
const MAXIMUM_RESPONSE_BYTES = 256 * 1024;
const MAXIMUM_TRANSCRIPT_CHARACTERS = 200_000;

export const OPENAI_TRANSCRIPTION_MIME_TYPES = Object.freeze([
  "audio/pcm",
  "audio/webm",
  "audio/mp4",
  "audio/ogg",
  "audio/mpeg",
  "audio/wav"
] as const satisfies readonly SupportedAudioMimeType[]);

export interface OpenAiTranscriptionRoute {
  readonly endpoint: string;
  readonly model: string;
  readonly apiKey?: string;
  readonly timeoutMs?: number;
}

export interface OpenAiTranscriptionProviderOptions extends OpenAiTranscriptionRoute {
  readonly mimeType: SupportedAudioMimeType;
  readonly locale?: string;
  readonly inputPcmSampleRate?: number;
  readonly fetch?: typeof globalThis.fetch;
}

export type OpenAiTranscriptionErrorCode =
  | "authentication"
  | "quota"
  | "protocol"
  | "transport";

/** Content-free error suitable for upper layers that must never expose an upstream body. */
export class OpenAiTranscriptionError extends Error {
  readonly code: OpenAiTranscriptionErrorCode;

  constructor(code: OpenAiTranscriptionErrorCode) {
    super(`Transcription request failed (${code}).`);
    this.name = "OpenAiTranscriptionError";
    this.code = code;
  }
}

/**
 * One-shot OpenAI-compatible transcription transport. Audio, credentials, and
 * transcript text are retained only for this provider instance and are never
 * written to disk or included in errors.
 */
export class OpenAiTranscriptionProvider implements AsrProvider {
  readonly #endpoint: string;
  readonly #model: string;
  readonly #apiKey: string | undefined;
  readonly #mimeType: SupportedAudioMimeType;
  readonly #locale: string | undefined;
  readonly #inputPcmSampleRate: number;
  readonly #timeoutMs: number;
  readonly #fetch: typeof globalThis.fetch;
  readonly #listeners = new Set<(event: AsrEvent) => void>();
  #chunks: ArrayBuffer[] = [];
  #audioBytes = 0;
  #state: "idle" | "started" | "flushing" | "stopped" = "idle";
  #requestAbort: AbortController | undefined;
  #flushPromise: Promise<void> | undefined;
  #disconnected = false;

  constructor(options: OpenAiTranscriptionProviderOptions) {
    const route = validateOpenAiTranscriptionRoute(options);
    if (!OPENAI_TRANSCRIPTION_MIME_TYPES.includes(options.mimeType as typeof OPENAI_TRANSCRIPTION_MIME_TYPES[number])) {
      throw new TypeError("Transcription media type is unsupported.");
    }
    this.#endpoint = route.endpoint;
    this.#model = route.model;
    this.#apiKey = route.apiKey;
    this.#mimeType = options.mimeType;
    this.#locale = options.locale;
    this.#inputPcmSampleRate = validatePcmSampleRate(options.inputPcmSampleRate ?? 16_000);
    this.#timeoutMs = route.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#fetch = options.fetch ?? globalThis.fetch;
    if (typeof this.#fetch !== "function") throw new TypeError("Transcription fetch transport is unavailable.");
  }

  async start(request: AsrStartRequest): Promise<void> {
    if (this.#state !== "idle" || request.mimeType !== this.#mimeType || request.locale !== this.#locale) {
      throw new OpenAiTranscriptionError("protocol");
    }
    this.#state = "started";
    this.#emit({ type: "connected" });
  }

  appendAudio(chunk: AudioChunk): void {
    if (this.#state !== "started") return;
    const nextBytes = this.#audioBytes + chunk.data.byteLength;
    if (chunk.data.byteLength === 0 || nextBytes > MAXIMUM_AUDIO_BYTES) {
      throw new OpenAiTranscriptionError("protocol");
    }
    this.#chunks.push(chunk.data.slice(0));
    this.#audioBytes = nextBytes;
  }

  flushAudio(): Promise<void> {
    if (this.#flushPromise !== undefined) return this.#flushPromise;
    if (this.#state !== "started") return Promise.resolve();
    this.#state = "flushing";
    const chunks = this.#chunks;
    this.#chunks = [];
    this.#audioBytes = 0;
    this.#flushPromise = this.#transcribe(chunks);
    return this.#flushPromise;
  }

  async stop(): Promise<void> {
    if (this.#state === "stopped") return;
    this.#state = "stopped";
    this.#chunks = [];
    this.#audioBytes = 0;
    this.#requestAbort?.abort();
    await this.#flushPromise?.catch(() => undefined);
    if (!this.#disconnected) {
      this.#disconnected = true;
      this.#emit({ type: "disconnected", recoverable: false });
    }
    this.#listeners.clear();
  }

  onEvent(listener: (event: AsrEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async #transcribe(chunks: readonly ArrayBuffer[]): Promise<void> {
    if (chunks.length === 0) return;
    const controller = new AbortController();
    this.#requestAbort = controller;
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    timer.unref?.();
    try {
      const form = new FormData();
      form.set("model", this.#model);
      const language = openAiTranscriptionLanguage(this.#locale);
      if (language !== undefined) form.set("language", language);
      const upload = this.#mimeType === "audio/pcm"
        ? pcm16Wave(chunks, this.#inputPcmSampleRate)
        : { chunks, mimeType: this.#mimeType, fileName: transcriptionFileName(this.#mimeType) };
      form.set("file", new Blob([...upload.chunks], { type: upload.mimeType }), upload.fileName);
      const headers = new Headers();
      if (this.#apiKey !== undefined) headers.set("authorization", `Bearer ${this.#apiKey}`);
      const response = await this.#fetch(this.#endpoint, {
        method: "POST",
        headers,
        body: form,
        signal: controller.signal
      });
      const body = await readBoundedText(response, MAXIMUM_RESPONSE_BYTES);
      if (!response.ok) throw new OpenAiTranscriptionError(categoryForStatus(response.status));
      const transcript = parseTranscript(body);
      if (this.#state !== "stopped") this.#emit({ type: "stable", text: transcript });
    } catch (error) {
      if (this.#state === "stopped") return;
      const failure = error instanceof OpenAiTranscriptionError
        ? error
        : new OpenAiTranscriptionError("transport");
      this.#emit({ type: "error", category: failure.code satisfies AsrErrorCategory, recoverable: false });
      throw failure;
    } finally {
      clearTimeout(timer);
      if (this.#requestAbort === controller) this.#requestAbort = undefined;
    }
  }

  #emit(event: AsrEvent): void {
    for (const listener of [...this.#listeners]) listener(event);
  }
}

export function openAiTranscriptionLanguage(locale: string | undefined): string | undefined {
  if (locale === undefined) return undefined;
  const normalized = locale.trim().toLocaleLowerCase("en-US");
  if (normalized === "" || normalized === "auto") return undefined;
  const named = new Map([
    ["chinese", "zh"],
    ["mandarin", "zh"],
    ["simplified chinese", "zh"],
    ["traditional chinese", "zh"],
    ["english", "en"],
    ["japanese", "ja"],
    ["korean", "ko"]
  ]);
  const mapped = named.get(normalized);
  if (mapped !== undefined) return mapped;
  const primary = normalized.split(/[-_]/u, 1)[0];
  return primary !== undefined && /^[a-z]{2,3}$/u.test(primary) ? primary : undefined;
}

export function validateOpenAiTranscriptionRoute(input: OpenAiTranscriptionRoute): Required<Omit<OpenAiTranscriptionRoute, "apiKey">> & { readonly apiKey?: string } {
  let endpoint: URL;
  try {
    endpoint = new URL(input.endpoint);
  } catch {
    throw new TypeError("Transcription endpoint is invalid.");
  }
  const loopback = endpoint.hostname === "localhost" || endpoint.hostname === "127.0.0.1"
    || endpoint.hostname === "[::1]" || endpoint.hostname === "::1";
  if (
    endpoint.toString().length > 2_048
    || (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && loopback))
    || endpoint.username !== ""
    || endpoint.password !== ""
    || endpoint.hash !== ""
    || endpoint.search !== ""
  ) throw new TypeError("Transcription endpoint is unsafe.");
  const model = input.model.trim();
  if (model === "" || model.length > 256 || /[\u0000-\u001f\u007f]/u.test(model)) {
    throw new TypeError("Transcription model is invalid.");
  }
  const apiKey = input.apiKey;
  if (apiKey !== undefined && (apiKey.length === 0 || apiKey.length > 64 * 1024 || /[\u0000\r\n]/u.test(apiKey))) {
    throw new TypeError("Transcription credential is invalid.");
  }
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < MINIMUM_TIMEOUT_MS || timeoutMs > MAXIMUM_TIMEOUT_MS) {
    throw new TypeError("Transcription timeout is invalid.");
  }
  return {
    endpoint: endpoint.toString(),
    model,
    timeoutMs,
    ...(apiKey === undefined ? {} : { apiKey })
  };
}

async function readBoundedText(response: Response, maximumBytes: number): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared !== null && /^\d+$/u.test(declared) && Number(declared) > maximumBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new OpenAiTranscriptionError("protocol");
  }
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const value = await reader.read();
      if (value.done) break;
      bytes += value.value.byteLength;
      if (bytes > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw new OpenAiTranscriptionError("protocol");
      }
      chunks.push(value.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(body);
}

function parseTranscript(body: string): string {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw new OpenAiTranscriptionError("protocol");
  }
  if (!isRecord(value) || typeof value["text"] !== "string" || value["text"].length > MAXIMUM_TRANSCRIPT_CHARACTERS) {
    throw new OpenAiTranscriptionError("protocol");
  }
  return value["text"].trim();
}

function categoryForStatus(status: number): OpenAiTranscriptionErrorCode {
  if (status === 401 || status === 403) return "authentication";
  if (status === 429) return "quota";
  if (status === 408 || status === 425 || status >= 500) return "transport";
  return "protocol";
}

function transcriptionFileName(mimeType: SupportedAudioMimeType): string {
  switch (mimeType) {
    case "audio/webm": return "dictation.webm";
    case "audio/mp4": return "dictation.m4a";
    case "audio/ogg": return "dictation.ogg";
    case "audio/mpeg": return "dictation.mp3";
    case "audio/wav": return "dictation.wav";
    case "audio/pcm": return "dictation.wav";
  }
}

function pcm16Wave(chunks: readonly ArrayBuffer[], sampleRate: number): {
  readonly chunks: readonly ArrayBuffer[];
  readonly mimeType: "audio/wav";
  readonly fileName: "dictation.wav";
} {
  const byteLength = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  if (byteLength === 0 || byteLength % 2 !== 0 || byteLength > 0xffff_ffff - 36) {
    throw new OpenAiTranscriptionError("protocol");
  }
  const header = new Uint8Array(44);
  const view = new DataView(header.buffer);
  writeAscii(header, 0, "RIFF");
  view.setUint32(4, 36 + byteLength, true);
  writeAscii(header, 8, "WAVE");
  writeAscii(header, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(header, 36, "data");
  view.setUint32(40, byteLength, true);
  return {
    chunks: [header.buffer, ...chunks],
    mimeType: "audio/wav",
    fileName: "dictation.wav"
  };
}

function validatePcmSampleRate(value: number): number {
  if (!Number.isSafeInteger(value) || value < 8_000 || value > 96_000) {
    throw new TypeError("Transcription PCM sample rate is invalid.");
  }
  return value;
}

function writeAscii(target: Uint8Array, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) target[offset + index] = value.charCodeAt(index);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
