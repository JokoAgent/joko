import type { DesktopSpeechModel, DesktopSpeechSelection } from '@joko/contracts';
import { create } from '@bufbuild/protobuf';
import { DesktopSpeechModelSchema } from '@joko/contracts';
import type { OperationalStore } from '@joko/store';
import type { CredentialModelRoute, ModelRouteCatalog } from '../personalization-inference.js';
import { SPEECH_PROTOCOLS, isCosyVoiceHttpModel, isQwenAudioHttpModel, isQwenHttpModel, isSpeechSpeedSupported, type SpeechProtocol } from './protocol.js';
import type { SpeechConnection } from './speech.js';
import { normalizeSpeechVoiceId } from './types.js';
import { isRealtimeProtocol, officialRealtimeProtocol, type RealtimeProtocol } from './realtime-protocol.js';

export interface RealtimeConnection {
  readonly url: string; readonly headers: Readonly<Record<string, string>>; readonly protocol: RealtimeProtocol;
}

export interface SpeechSelection {
  readonly backendId: string; readonly providerId: string; readonly modelId: string;
  readonly protocol: string; readonly voice: string; readonly speed?: number;
}
export function speechModelKey(value: Pick<DesktopSpeechSelection, 'backendId' | 'providerId' | 'modelId'>): string {
  return JSON.stringify([value.backendId, value.providerId, value.modelId]);
}

function endpointProtocol(base: URL, model: string): SpeechProtocol | undefined {
  if (base.protocol !== 'https:' || base.port) return undefined;
  if (openRouterSpeechBaseUrl(base.toString())) return 'openai';
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

/** Only the official API roots define the OpenAI speech endpoint. */
export function openRouterSpeechBaseUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.origin === 'https://openrouter.ai' && !url.username && !url.password && !url.search && !url.hash
      && ['/api', '/api/v1'].includes(url.pathname.replace(/\/+$/, ''))) return `${url.origin}/api/v1`;
  } catch { /* An invalid or custom root does not establish a speech protocol. */ }
  return undefined;
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
  realtimeModels(): DesktopSpeechModel[] {
    return this.routes.list({ purpose: 'audio_realtime' }).filter(row => row.credentialRoute).flatMap(row => {
      const route = this.routes.resolve(row, { purpose: 'audio_realtime' });
      if (!route?.authorization && !route?.headers['x-api-key']) return [];
      const protocol = officialRealtimeProtocol(apiBase(route.baseUrl), row.modelId);
      return [create(DesktopSpeechModelSchema, { ...row, displayName: row.displayName ?? row.modelId, providerName: row.providerName ?? row.providerId,
        ...(protocol ? { protocol } : {}), protocolLocked: !!protocol, speedSupport: { case: 'speedUnsupported', value: true } })];
    });
  }
  resolveRealtime(selection: SpeechSelection): { connection: RealtimeConnection; assertCurrent(): void } {
    const route = this.routes.resolve(selection, { purpose: 'audio_realtime' });
    if (!route || !isRealtimeProtocol(selection.protocol) || selection.speed !== undefined || !normalizeSpeechVoiceId(selection.voice)) throw new Error('model_unavailable');
    const url = apiBase(route.baseUrl), fixed = officialRealtimeProtocol(url, selection.modelId);
    if ((fixed && fixed !== selection.protocol) || !fixed && (url.hostname === 'api.openai.com' || url.hostname.endsWith('.aliyuncs.com'))) throw new Error('model_unavailable');
    const authorization = route.authorization ?? (route.headers['x-api-key'] ? 'Bearer ' + route.headers['x-api-key'] : undefined);
    if (!authorization) throw new Error('model_unavailable');
    const headers = Object.fromEntries(Object.entries(route.headers).filter(([name]) =>
      !/^(authorization|proxy-authorization|cookie|host|connection|content-type|content-length|upgrade|sec-websocket-.*|x-api-key|api-key|xi-api-key|openai-beta|chatgpt-account-id|openai-account-id|originator|session_id)$/i.test(name)));
    url.pathname = fixed === 'qwen-audio-realtime' ? '/api-ws/v1/realtime' : (url.pathname.replace(/\/+$/, '') || '/v1') + '/realtime';
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'; url.searchParams.set('model', selection.modelId);
    return { connection: { url: url.href, headers: { ...headers, authorization }, protocol: selection.protocol }, assertCurrent: () => {
      const generation = this.routes.realtimeGeneration ? this.routes.realtimeGeneration(selection)
        : this.routes.resolve(selection, { purpose: 'audio_realtime' })?.generationId;
      if (generation !== route.generationId) throw new Error('connection_changed');
    } };
  }
  list(): DesktopSpeechModel[] {
    return this.routes.list({ purpose: 'audio_speech' }).filter(value => value.credentialRoute).flatMap(value => {
      const route = this.routes.resolve(value, { purpose: 'audio_speech' });
      if (!route || !supportedEndpoint(route)) return [];
      const descriptor = this.store.getBackend(value.backendId).descriptor;
      const model = descriptor.models.find(model => model.providerId === value.providerId && model.modelId === value.modelId);
      const protocol = endpointProtocol(apiBase(route.baseUrl), route.modelId);
      return [create(DesktopSpeechModelSchema, { ...value, displayName: value.displayName ?? model?.displayName ?? value.modelId,
        providerName: value.providerName ?? descriptor.providers?.find(provider => provider.providerId === value.providerId)?.displayName ?? value.providerId,
        ...(protocol ? { protocol } : {}), protocolLocked: protocol !== undefined,
        ...(openRouterSpeechBaseUrl(route.baseUrl) ? { speedSupport: { case: 'speedUnsupported' as const, value: true } } : {}) })];
    });
  }
  resolve(selection: DesktopSpeechSelection | SpeechSelection): { connection: SpeechConnection; generationId: string; assertCurrent(): void } {
    if (!selection.backendId || !selection.providerId || !selection.modelId || !SPEECH_PROTOCOLS.includes(selection.protocol as SpeechProtocol)
      || !normalizeSpeechVoiceId(selection.voice)) throw new Error('model_unavailable');
    const route = this.routes.resolve({ backendId: selection.backendId, providerId: selection.providerId, modelId: selection.modelId }, { purpose: 'audio_speech' });
    if (!route || !supportedEndpoint(route)) throw new Error('model_unavailable');
    const base = apiBase(route.baseUrl), fixed = endpointProtocol(base, route.modelId);
    const protocol = fixed ?? selection.protocol as SpeechProtocol;
    const speedRange = openRouterSpeechBaseUrl(route.baseUrl) ? null : undefined;
    if (fixed && fixed !== selection.protocol || !isSpeechSpeedSupported(route.modelId, protocol, selection.speed, speedRange)) throw new Error('model_unavailable');
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(route.headers)) {
      if (!['authorization', 'x-api-key', 'xi-api-key', 'cookie', 'host', 'content-type', 'content-length', 'connection', 'chatgpt-account-id', 'openai-account-id', 'anthropic-version', 'anthropic-beta', 'anthropic-dangerous-direct-browser-access'].includes(key.toLowerCase())) headers[key] = value;
    }
    const secret = route.authorization?.replace(/^Bearer /, '') ?? route.headers['x-api-key'];
    if (secret) headers[protocol === 'elevenlabs' ? 'xi-api-key' : 'authorization'] = protocol === 'elevenlabs' ? secret : `Bearer ${secret}`;
    if (openRouterSpeechBaseUrl(base.toString())) base.pathname = '/api/v1';
    else if (fixed && fixed !== 'openai') base.pathname = protocol === 'qwen-tts' || protocol === 'dashscope-tts' ? '/api/v1' : '/v1';
    else if (!base.pathname || base.pathname === '/') base.pathname = '/v1';
    const assertCurrent = () => {
      if (this.routes.resolve({ backendId: route.backendId, providerId: route.providerId, modelId: route.modelId }, { purpose: 'audio_speech' })?.generationId !== route.generationId) throw new Error('connection_changed');
    };
    assertCurrent();
    return { connection: { baseUrl: base.toString().replace(/\/+$/, ''), headers, protocol,
      ...(speedRange === undefined ? {} : { speedRange }) }, generationId: route.generationId, assertCurrent };
  }
}
