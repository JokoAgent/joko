export type { SpeechProtocol } from './protocol.js';
export type SpeechVoice = { id: string; name: string };
export type SpeechVoiceCatalog = { source: 'reference' | 'provider' | 'mixed' | 'manual'; voices: SpeechVoice[]; truncated?: boolean; customVoicesUnavailable?: boolean };
export function normalizeSpeechVoiceId(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value) ? value : undefined;
}
