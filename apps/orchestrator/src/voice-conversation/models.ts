import type { DesktopSpeechModel, DesktopSpeechSelection } from '@joko/contracts';
import { create } from '@bufbuild/protobuf';
import { DesktopSpeechModelSchema } from '@joko/contracts';
import type { OperationalStore } from '@joko/store';
import type { CredentialModelRoute, ModelRouteCatalog } from '../personalization-inference.js';
import { SPEECH_PROTOCOLS, isCosyVoiceHttpModel, isQwenAudioHttpModel, isQwenHttpModel, isSpeechSpeedSupported, type SpeechProtocol } from './protocol.js';
import type { SpeechConnection } from './speech.js';
import { normalizeSpeechVoiceId } from './types.js';

export interface SpeechSelection {
  readonly backendId: string; readonly providerId: string; readonly modelId: string;
  readonly protocol: string; readonly voice: string; readonly speed?: number;
}
export function speechModelKey(value: Pick<DesktopSpeechSelection, 'backendId' | 'providerId' | 'modelId'>): string {
  return JSON.stringify([value.backendId, value.providerId, value.modelId]);
}

function endpointProtocol(base: URL, model: string): SpeechProtocol | undefined {
  if (base.protocol !== 'https:' || base.port) return undefined;
  if (base.hostname === 'api.elevenlabs.io') return 'elevenlabs';
  if (['api.minimax.io', 'api.minimax.cn', 'api.minimaxi.com', 'api.minimax.chat', 'api-uw.minimax.io'].includes(base.hostname)) return 'minimax';
  if (base.hostname === 'api.openai.com') return 'openai';
  if (['dashscope.aliyuncs.com', 'dashscope-intl.aliyuncs.com'].includes(base.hostname) && isQwenHttpModel(model)) return 'qwen-tts';
  const workspace = /^[a-z0-9-]+\.(cn-beijing|ap-southeast-1)\.maas\.aliyuncs\.com$/.exec(base.hostname);
  if (workspace && (isQwenAudioHttpModel(model) || workspace[1] === 'cn-beijing' && isCosyVoiceHttpModel(model))) return 'dashscope-tts';
  return undefined;
}
function apiBase(raw: string): URL {
  const url = new URL(raw);
  if (url.username || url.password || url.search || url.hash || !['http:', 'https:'].includes(url.protocol)
    || url.protocol === 'http:' && !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)) throw new Error('model_unavailable');
  return url;
}
function supportedEndpoint(route: CredentialModelRoute): boolean {
  try {
    const base = apiBase(route.baseUrl);
    if (/(?:^|\.)aliyuncs\.com$/.test(base.hostname) && !endpointProtocol(base, route.modelId)) return false;
    return true;
  } catch { return false; }
}

/** Explicitly configured, enabled BYOK routes only. A catalog row is a choice,
 * never execution proof; custom proxies require an explicit speech protocol. */
export class SpeechModelCatalog {
  constructor(readonly store: OperationalStore, readonly routes: ModelRouteCatalog) {}
  list(): DesktopSpeechModel[] {
    return this.routes.list().filter(value => value.credentialRoute).flatMap(value => {
      const route = this.routes.resolve(value);
      if (!route || !supportedEndpoint(route)) return [];
      const descriptor = this.store.getBackend(value.backendId).descriptor;
      const model = descriptor.models.find(model => model.providerId === value.providerId && model.modelId === value.modelId);
      const protocol = endpointProtocol(apiBase(route.baseUrl), route.modelId);
      return [create(DesktopSpeechModelSchema, { ...value, displayName: model?.displayName ?? value.modelId,
        providerName: descriptor.providers?.find(provider => provider.providerId === value.providerId)?.displayName ?? value.providerId,
        ...(protocol ? { protocol } : {}), protocolLocked: protocol !== undefined })];
    });
  }
  resolve(selection: DesktopSpeechSelection | SpeechSelection): { connection: SpeechConnection; generationId: string; assertCurrent(): void } {
    if (!selection.backendId || !selection.providerId || !selection.modelId || !SPEECH_PROTOCOLS.includes(selection.protocol as SpeechProtocol)
      || !normalizeSpeechVoiceId(selection.voice)) throw new Error('model_unavailable');
    const route = this.routes.resolve({ backendId: selection.backendId, providerId: selection.providerId, modelId: selection.modelId });
    if (!route || !supportedEndpoint(route)) throw new Error('model_unavailable');
    const base = apiBase(route.baseUrl), fixed = endpointProtocol(base, route.modelId);
    const protocol = fixed ?? selection.protocol as SpeechProtocol;
    if (fixed && fixed !== selection.protocol || !isSpeechSpeedSupported(route.modelId, protocol, selection.speed)) throw new Error('model_unavailable');
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(route.headers)) {
      if (!['authorization', 'x-api-key', 'xi-api-key', 'cookie', 'host', 'content-type', 'content-length', 'connection', 'chatgpt-account-id', 'openai-account-id'].includes(key.toLowerCase())) headers[key] = value;
    }
    const secret = route.authorization?.replace(/^Bearer /, '') ?? route.headers['x-api-key'];
    if (secret) headers[protocol === 'elevenlabs' ? 'xi-api-key' : 'authorization'] = protocol === 'elevenlabs' ? secret : `Bearer ${secret}`;
    if (fixed && fixed !== 'openai') base.pathname = protocol === 'qwen-tts' || protocol === 'dashscope-tts' ? '/api/v1' : '/v1';
    else if (!base.pathname || base.pathname === '/') base.pathname = '/v1';
    const assertCurrent = () => {
      if (this.routes.resolve({ backendId: route.backendId, providerId: route.providerId, modelId: route.modelId })?.generationId !== route.generationId) throw new Error('connection_changed');
    };
    assertCurrent();
    return { connection: { baseUrl: base.toString().replace(/\/+$/, ''), headers, protocol }, generationId: route.generationId, assertCurrent };
  }
}
