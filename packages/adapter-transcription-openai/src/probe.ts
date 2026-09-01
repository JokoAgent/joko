import { validateOpenAiTranscriptionRoute, type OpenAiTranscriptionRoute } from "./provider.js";

const DEFAULT_PROBE_TIMEOUT_MS = 10_000;
const PROBE_AUDIO_DURATION_MS = 100;
const PROBE_AUDIO_SAMPLE_RATE = 16_000;

export type OpenAiTranscriptionProbeFailure =
  | "authenticationFailed"
  | "network"
  | "routeUnavailable"
  | "serviceError"
  | "timeout";

export type OpenAiTranscriptionProbeResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: OpenAiTranscriptionProbeFailure };

export interface OpenAiTranscriptionProbeOptions extends OpenAiTranscriptionRoute {
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
}

/**
 * Sends a bounded silent WAV to validate the configured route and credential.
 * No upstream response body is retained or returned to the caller.
 */
export async function probeOpenAiTranscriptionRoute(
  options: OpenAiTranscriptionProbeOptions
): Promise<OpenAiTranscriptionProbeResult> {
  const route = validateOpenAiTranscriptionRoute({
    endpoint: options.endpoint,
    model: options.model,
    ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
    timeoutMs: options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS
  });
  const fetch = options.fetch ?? globalThis.fetch;
  if (typeof fetch !== "function") return { ok: false, reason: "network" };
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, route.timeoutMs);
  timer.unref?.();
  try {
    const form = new FormData();
    form.set("model", route.model);
    const wav = silentPcm16Wav(PROBE_AUDIO_SAMPLE_RATE, PROBE_AUDIO_DURATION_MS);
    const wavBuffer = wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength) as ArrayBuffer;
    form.set("file", new Blob([wavBuffer], { type: "audio/wav" }), "connection-test.wav");
    const headers = new Headers();
    if (route.apiKey !== undefined) headers.set("authorization", `Bearer ${route.apiKey}`);
    const response = await fetch(route.endpoint, {
      method: "POST",
      headers,
      body: form,
      signal: controller.signal
    });
    await response.body?.cancel().catch(() => undefined);
    if (response.ok) return { ok: true };
    if (response.status === 401 || response.status === 403) return { ok: false, reason: "authenticationFailed" };
    if (response.status === 404 || response.status === 405 || response.status === 501) return { ok: false, reason: "routeUnavailable" };
    if (response.status === 408 || response.status === 504) return { ok: false, reason: "timeout" };
    return { ok: false, reason: "serviceError" };
  } catch {
    return { ok: false, reason: timedOut ? "timeout" : "network" };
  } finally {
    clearTimeout(timer);
  }
}

function silentPcm16Wav(sampleRate: number, durationMs: number): Uint8Array {
  const pcmBytes = Math.ceil(sampleRate * durationMs / 1_000) * 2;
  const bytes = new Uint8Array(44 + pcmBytes);
  const view = new DataView(bytes.buffer);
  writeAscii(bytes, 0, "RIFF");
  view.setUint32(4, 36 + pcmBytes, true);
  writeAscii(bytes, 8, "WAVE");
  writeAscii(bytes, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(bytes, 36, "data");
  view.setUint32(40, pcmBytes, true);
  return bytes;
}

function writeAscii(target: Uint8Array, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) target[offset + index] = value.charCodeAt(index);
}
