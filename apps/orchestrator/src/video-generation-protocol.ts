import { containsRecognizedCredential } from "@joko/core";

export const VIDEO_GENERATION_DURATIONS = { minimum: 1, maximum: 15 } as const;
export const VIDEO_GENERATION_RESOLUTIONS = ["480p", "720p", "1080p"] as const;
export const VIDEO_GENERATION_ASPECT_RATIOS = ["16:9", "9:16", "1:1", "4:3", "3:4", "3:2", "2:3"] as const;

const MAXIMUM_RESPONSE_BYTES = 1024 * 1024;
const MAXIMUM_PROMPT_BYTES = 32 * 1024;

export interface VideoGenerationInput {
  readonly prompt: string;
  readonly duration?: number;
  readonly resolution?: (typeof VIDEO_GENERATION_RESOLUTIONS)[number];
  readonly aspect_ratio?: (typeof VIDEO_GENERATION_ASPECT_RATIOS)[number];
}

export interface VideoGenerationConnection {
  readonly baseUrl: string;
  readonly headers: Readonly<Record<string, string>>;
}

export type VideoGenerationStatus =
  | { readonly state: "pending" | "failed" | "expired" }
  | { readonly state: "done"; readonly contentUrl: URL; readonly duration?: number };

type VideoFetch = (url: URL, init: RequestInit, beforeDispatch: () => void) => Promise<Response>;

export class VideoGenerationRejected extends Error {
  constructor() { super("The video provider rejected the request."); }
}

export function parseVideoGenerationInput(input: Readonly<Record<string, unknown>>): VideoGenerationInput {
  const { prompt, duration, resolution, aspect_ratio: ratio } = input;
  if (typeof prompt !== "string" || !prompt.trim() || Buffer.byteLength(prompt, "utf8") > MAXIMUM_PROMPT_BYTES
    || containsRecognizedCredential(prompt)) throw new Error("A bounded video prompt without credentials is required.");
  if (duration !== undefined && (typeof duration !== "number" || !Number.isSafeInteger(duration)
    || duration < VIDEO_GENERATION_DURATIONS.minimum || duration > VIDEO_GENERATION_DURATIONS.maximum)) {
    throw new Error("Video duration must be a whole number from 1 to 15 seconds.");
  }
  const selectedResolution = VIDEO_GENERATION_RESOLUTIONS.find(value => value === resolution);
  const selectedRatio = VIDEO_GENERATION_ASPECT_RATIOS.find(value => value === ratio);
  if (resolution !== undefined && selectedResolution === undefined) throw new Error("The selected video resolution is unsupported.");
  if (ratio !== undefined && selectedRatio === undefined) throw new Error("The selected video aspect ratio is unsupported.");
  return { prompt, ...(typeof duration === "number" ? { duration } : {}),
    ...(selectedResolution === undefined ? {} : { resolution: selectedResolution }),
    ...(selectedRatio === undefined ? {} : { aspect_ratio: selectedRatio }) };
}

export function videoGenerationBaseUrl(input: string): string | undefined {
  try {
    const url = new URL(input);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)
      || url.username || url.password || url.search || url.hash) return undefined;
    const prefix = url.pathname.replace(/\/+$/u, "");
    url.pathname = prefix.endsWith("/v1") ? prefix : `${prefix}/v1`;
    return url.toString();
  } catch { return undefined; }
}

export async function submitVideoGeneration(input: {
  readonly connection: VideoGenerationConnection;
  readonly modelId: string;
  readonly options: VideoGenerationInput;
  readonly imageUrl?: string;
  readonly signal?: AbortSignal;
  readonly beforeDispatch: () => void;
  readonly fetch: VideoFetch;
}): Promise<string> {
  const response = await input.fetch(new URL(`${input.connection.baseUrl}/videos/generations`), {
    method: "POST", redirect: "manual", credentials: "omit",
    headers: { ...input.connection.headers, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ ...input.options, model: input.modelId,
      ...(input.imageUrl === undefined ? {} : { image: { url: input.imageUrl } }) }),
    signal: input.signal === undefined ? AbortSignal.timeout(120_000) : AbortSignal.any([input.signal, AbortSignal.timeout(120_000)])
  }, input.beforeDispatch);
  if (!response.ok && [400, 401, 403, 404, 405, 413, 415, 422].includes(response.status)) {
    await response.body?.cancel().catch(() => undefined);
    throw new VideoGenerationRejected();
  }
  const body = await videoJson(response);
  const id = body["request_id"];
  if (typeof id !== "string" || !validVideoRequestId(id)) throw new Error("The video provider did not return a usable request ID.");
  return id;
}

export async function pollVideoGeneration(input: {
  readonly connection: VideoGenerationConnection;
  readonly requestId: string;
  readonly signal?: AbortSignal;
  readonly beforeDispatch: () => void;
  readonly fetch: VideoFetch;
}): Promise<VideoGenerationStatus> {
  if (!validVideoRequestId(input.requestId)) throw new Error("The stored video request ID is invalid.");
  const response = await input.fetch(new URL(`${input.connection.baseUrl}/videos/${encodeURIComponent(input.requestId)}`), {
    method: "GET", redirect: "manual", credentials: "omit",
    headers: { ...input.connection.headers, accept: "application/json" },
    signal: input.signal === undefined ? AbortSignal.timeout(30_000) : AbortSignal.any([input.signal, AbortSignal.timeout(30_000)])
  }, input.beforeDispatch);
  const body = await videoJson(response);
  const state = body["status"];
  if (state === "pending" || state === "failed" || state === "expired") return { state };
  const video = object(body["video"]);
  if (state !== "done" || typeof video?.["url"] !== "string" || video["url"].length > 8_192) {
    throw new Error("The video provider did not return a usable status.");
  }
  const url = new URL(video["url"]);
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password || url.hash) {
    throw new Error("The video provider returned an invalid result URL.");
  }
  const duration = video["duration"];
  return { state, contentUrl: url,
    ...(typeof duration === "number" && Number.isFinite(duration) && duration > 0 ? { duration } : {}) };
}

function validVideoRequestId(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,256}$/u.test(value) && !containsRecognizedCredential(value);
}

async function videoJson(response: Response): Promise<Readonly<Record<string, unknown>>> {
  const declaredLength = response.headers.get("content-length");
  if (!response.ok || response.body === null || declaredLength !== null && Number(declaredLength) > MAXIMUM_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("The video provider response is unavailable.");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAXIMUM_RESPONSE_BYTES) throw new Error("The video provider response exceeded its size limit.");
      chunks.push(chunk.value);
    }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  try {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
    const value = object(JSON.parse(decoded));
    if (value !== undefined) return value;
  } catch { /* Provider bodies and result URLs remain private. */ }
  throw new Error("The video provider returned an invalid response.");
}

function object(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : undefined;
}
