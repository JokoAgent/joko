import type { SpeechProtocol, SpeechSpeedRange } from '../protocol.js';

export type SpeechConnection = {
  baseUrl: string;
  headers: Record<string, string>;
  protocol: SpeechProtocol;
  speedRange?: SpeechSpeedRange;
};
export type SpeechInput = { modelId: string; voice: string; text: string; speed?: number };
export type SpeechRequest = { url: URL; body: string; headers?: Record<string, string>; encoding?: 'mp3' };

/** PCM adapters produce pull-driven 24 kHz, 16-bit LE mono audio.
 * A request can instead name a complete encoded speech response. */
export type SpeechAdapter = {
  contentTypes: readonly string[];
  request(prefix: string, input: SpeechInput): SpeechRequest;
  pcm(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array>;
};
