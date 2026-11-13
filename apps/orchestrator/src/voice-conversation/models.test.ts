import { expect, it } from 'vitest';
import type { OperationalStore } from '@joko/store';
import type { ModelRouteCatalog } from '../personalization-inference.js';
import { SpeechModelCatalog } from './models.js';

it.each(['/api', '/api/', '/api/v1', '/api/v1/'])('uses the official speech root for an OpenRouter %s chat route', path => {
  const selection = { backendId: 'pi', providerId: 'openrouter', modelId: 'openai/tts-1', protocol: 'openai', voice: 'alloy' };
  let generationId = 'original';
  const route = { ...selection, generationId, api: 'anthropic-messages' as const, baseUrl: `https://openrouter.ai${path}`,
    authorization: 'Bearer speech-secret', headers: { 'anthropic-version': '2023-06-01', 'Anthropic-Beta': 'messages', 'HTTP-Referer': 'https://joko.test' }, supportsImages: false };
  const routes: ModelRouteCatalog = { list: () => [{ ...selection, credentialRoute: true, supportsImages: false }],
    resolve: () => ({ ...route, generationId }) };
  const store = { getBackend: () => ({ descriptor: { models: [], providers: [] } }) } as unknown as OperationalStore;
  const catalog = new SpeechModelCatalog(store, routes);
  expect(catalog.list()[0]).toMatchObject({ protocol: 'openai', protocolLocked: true });
  const resolved = catalog.resolve(selection);
  expect(resolved.connection).toMatchObject({ baseUrl: 'https://openrouter.ai/api/v1', protocol: 'openai',
    headers: { authorization: 'Bearer speech-secret', 'HTTP-Referer': 'https://joko.test' } });
  expect(Object.keys(resolved.connection.headers).some(key => key.toLowerCase().startsWith('anthropic-'))).toBe(false);
  expect(route.baseUrl).toBe(`https://openrouter.ai${path}`);
  generationId = 'replacement';
  expect(resolved.assertCurrent).toThrow('connection_changed');
});

it.each(['https://openrouter.ai/custom/api', 'https://proxy.test/api', 'https://openrouter.ai:8443/api'])('preserves an explicitly selected custom speech root %s', baseUrl => {
  const selection = { backendId: 'pi', providerId: 'custom', modelId: 'tts', protocol: 'openai', voice: 'alloy' };
  const routes: ModelRouteCatalog = { list: () => [{ ...selection, credentialRoute: true, supportsImages: false }],
    resolve: () => ({ ...selection, baseUrl, generationId: 'original', api: 'openai-completions', headers: {}, supportsImages: false }) };
  const store = { getBackend: () => ({ descriptor: { models: [], providers: [] } }) } as unknown as OperationalStore;
  const catalog = new SpeechModelCatalog(store, routes);
  expect(catalog.list()[0]?.protocolLocked).toBe(false);
  expect(catalog.resolve(selection).connection.baseUrl).toBe(baseUrl);
});
