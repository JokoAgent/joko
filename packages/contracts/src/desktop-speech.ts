import { create } from '@bufbuild/protobuf';
import { DesktopSpeechSelectionSchema, type DesktopSpeechModel, type DesktopSpeechSelection } from './gen/joko/v1/desktop_voice_conversation_pb.js';

/** Local Desktop voice UI contract. No credentials, raw paths or remote invoke access. */
export const SPEECH_PROTOCOLS = [
  'openai',
  'elevenlabs',
  'minimax',
  'qwen-tts',
  'dashscope-tts',
] as const;
export type SpeechProtocol = (typeof SPEECH_PROTOCOLS)[number];
export type SpeechSpeedRange = { min: number; max: number } | null;

/** Native synthesis limits, shared by settings and Main. Compatible proxies must
 * implement their selected protocol; this is not a claim about gateway forwarding.
 * Eleven v3 currently excludes speed: https://elevenlabs.io/docs/eleven-creative/playground/text-to-speech#speed
 */
export function speechSpeedRange(modelId: string, protocol?: SpeechProtocol, routeRange?: SpeechSpeedRange): SpeechSpeedRange {
  if (routeRange !== undefined) return routeRange;
  switch (protocol) {
    case 'elevenlabs':
      return /(?:^|\/)eleven_v3(?:_|$)/i.test(modelId) ? null : { min: 0.7, max: 1.2 };
    case 'dashscope-tts':
    case 'minimax':
      return { min: 0.5, max: 2 };
    case 'openai':
      if (modelId === 'qwen/qwen-audio-3.1-tts-plus') return { min: 0.5, max: 2 };
      return { min: 0.25, max: 4 };
    default:
      return null;
  }
}

export function isSpeechSpeedSupported(
  modelId: string,
  protocol: SpeechProtocol,
  speed: number | undefined,
  routeRange?: SpeechSpeedRange,
): boolean {
  if (speed === undefined) return true;
  const range = speechSpeedRange(modelId, protocol, routeRange);
  return !!range && Number.isFinite(speed) && speed >= range.min && speed <= range.max;
}

/** Reconcile an explicit choice when the user changes models, without storing
 * a default for companions that have never customized speed. */
export function resolveSpeechSpeed(
  modelId: string,
  protocol: SpeechProtocol | undefined,
  speed?: number,
  routeRange?: SpeechSpeedRange,
) {
  const range = speechSpeedRange(modelId, protocol, routeRange);
  return range && speed !== undefined && Number.isFinite(speed)
    ? Math.min(range.max, Math.max(range.min, speed))
    : undefined;
}

/** Preserve the distinction between protocol defaults and an explicit route limit. */
export function desktopSpeechModelSpeedRange(model: DesktopSpeechModel | undefined): SpeechSpeedRange | undefined {
  const support = model?.speedSupport;
  if (support?.case === 'speedUnsupported') return null;
  if (support?.case !== 'speedRange') return undefined;
  const { min, max } = support.value;
  return Number.isFinite(min) && Number.isFinite(max) && min > 0 && max >= min ? { min, max } : null;
}

/** Project a saved choice against its current route without saving inferred defaults. */
export function reconcileDesktopSpeechSelection(selection: DesktopSpeechSelection | undefined, models: readonly DesktopSpeechModel[]): DesktopSpeechSelection | undefined {
  if (selection === undefined) return undefined;
  const model = models.find(value => value.backendId === selection.backendId && value.providerId === selection.providerId && value.modelId === selection.modelId);
  if (model === undefined) return selection;
  const speed = resolveSpeechSpeed(selection.modelId, selection.protocol as SpeechProtocol, selection.speed, desktopSpeechModelSpeedRange(model));
  return create(DesktopSpeechSelectionSchema, { ...selection, speed });
}

/** Qwen3-TTS HTTP limits each request to 600 characters. UTF-16 length is
 * conservative for supplementary characters; transport never splits a surrogate. */
export function speechTextLimit(protocol: SpeechProtocol): number | undefined {
  return protocol === 'qwen-tts' ? 600 : undefined;
}

/** Verified HTTP model IDs, not a general family/prefix classifier. Realtime,
 * cloning and future models require their own documented execution contract. */
export function isQwenHttpModel(id: string): boolean {
  return id === 'qwen3-tts-flash';
}
export function isQwenAudioHttpModel(id: string): boolean {
  return [
    'qwen-audio-3.1-tts-flash',
    'qwen-audio-3.0-tts-plus',
    'qwen-audio-3.0-tts-flash',
  ].includes(id);
}
export function isCosyVoiceHttpModel(id: string): boolean {
  return [
    'cosyvoice-v2',
    'cosyvoice-v3-plus',
    'cosyvoice-v3-flash',
    'cosyvoice-v3.5-plus',
    'cosyvoice-v3.5-flash',
  ].includes(id);
}
