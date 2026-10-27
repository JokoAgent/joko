import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createServerAccessRuntime, ServerAccessMedia } from './server-access-runtime.js';
import { LinkspanRemoteDesktopTurnConfiguration } from './linkspan-turn-configuration.js';
import type { OrchestratorApplication } from './application.js';
import type { AccessRecord } from './server-access-manager.js';
import { accessCapabilities } from './server-access-configuration.js';
import type { OrchestratorConfig } from './config.js';

const ports = vi.hoisted(() => ({ ingress: vi.fn(), publish: vi.fn() }));
vi.mock('./linkspan-server.js', async original => ({ ...await original<typeof import('./linkspan-server.js')>(), createLinkspanIngress: ports.ingress }));
vi.mock('./linkspan-provider-connector.js', () => ({ startManagedProviderConnector: ports.publish }));
afterEach(() => { vi.restoreAllMocks(); vi.resetAllMocks(); });

it('recognizes installed ESM connector and TURN entry points without initializing them', async () => {
  const capabilities = await accessCapabilities({ tls: { certificatePath: 'configured-cert', privateKeyPath: 'configured-key' } } as OrchestratorConfig);
  const selected = [
    ['ssh', 'tcp'], ['ngrok', 'http'], ['localtunnel', 'http'], ['dev-tunnels', 'http'], ['pinggy', 'ssh-http'],
    ['cloudflare', 'turn'], ['twilio', 'turn'], ['coturn', 'turn']
  ];
  for (const [provider, mode] of selected) expect(capabilities.find(value => value.provider === provider && value.mode === mode)).toMatchObject({ state: 'ready', issue: '' });
});

it('serializes media preparation and preserves the configured external ICE broker', async () => {
  let finish!: () => void;
  const initialized = new Promise<void>(resolve => { finish = resolve; });
  const initialize = vi.spyOn(LinkspanRemoteDesktopTurnConfiguration.prototype, 'initialize').mockImplementationOnce(() => initialized).mockResolvedValue(undefined);
  const close = vi.spyOn(LinkspanRemoteDesktopTurnConfiguration.prototype, 'close').mockResolvedValue(undefined);
  const options = { config: {}, store: { listSettingsByKeyPrefix: () => [] }, fallbackIce: { getConfiguration: async () => [] } } as unknown as ConstructorParameters<typeof ServerAccessMedia>[0];
  const media = new ServerAccessMedia(options);
  const record: AccessRecord = { entryId: 'relay', name: 'Relay', provider: 'coturn', mode: 'turn', revision: '1', enabled: true, state: 'starting', fields: {}, configuredSecrets: [] };
  const material = { fields: { keyId: 'owned', apiToken: 'private', urls: 'turn:relay.example:3478' } };
  const first = media.start(record, material);
  await expect(media.start({ ...record, entryId: 'other' }, material)).rejects.toThrow('media_singleton');
  expect(initialize).toHaveBeenCalledOnce(); finish(); const handle = await first;
  await handle.close(); expect(close).toHaveBeenCalledOnce();
  const external = new ServerAccessMedia({ ...options, config: { ...options.config, remoteDesktopIce: { url: 'https://ice.example', tokenPath: '/private/token' } } });
  await expect(external.start(record, material)).rejects.toThrow('external_ice_config');
  expect(initialize).toHaveBeenCalledTimes(2);
});

it('retains the configured TLS listener for healthy publishers and serializes last-close with a new acquisition', async () => {
  const root = await mkdtemp(join(tmpdir(), 'joko-access-runtime-'));
  const certificatePath = join(root, 'certificate.pem'), privateKeyPath = join(root, 'private.pem');
  await writeFile(certificatePath, 'fixture certificate'); await writeFile(privateKeyPath, 'fixture private key', { mode: 0o600 });
  let releaseClose!: () => void;
  const closing = new Promise<void>(resolve => { releaseClose = resolve; });
  const closeFirst = vi.fn(() => closing), listen = vi.fn(async () => 'https://127.0.0.1:4329'), closeNext = vi.fn(async () => {});
  ports.ingress.mockReturnValueOnce({ listen, close: closeFirst }).mockReturnValue({ listen, close: closeNext });
  ports.publish.mockImplementation(async () => ({ publicOrigin: 'https://relay.example', close: vi.fn(async () => {}) }));
  const app = { config: { dataDirectory: root, publicOrigin: 'https://node.example', tls: { certificatePath, privateKeyPath }, linkspan: { port: 4329 } } } as OrchestratorApplication;
  const runtime = createServerAccessRuntime(app, 'http://127.0.0.1:4328');
  const record = (entryId: string): AccessRecord => ({ entryId, name: entryId, provider: 'ngrok', mode: 'http', revision: '1', enabled: true, state: 'starting', fields: {}, configuredSecrets: [] });
  const material = { fields: { authtoken: 'fixture-publisher' } }, signal = new AbortController().signal;
  try {
    const healthy = await runtime.start(record('healthy'), material, signal);
    expect(ports.publish).toHaveBeenCalledWith(app, expect.objectContaining({ id: 'healthy', displayName: 'healthy' }), expect.anything());
    ports.publish.mockRejectedValueOnce(new Error('candidate rejected'));
    await expect(runtime.start(record('candidate'), material, signal)).rejects.toThrow('candidate rejected');
    expect(closeFirst).not.toHaveBeenCalled(); expect(ports.ingress).toHaveBeenCalledOnce();
    expect(listen).toHaveBeenCalledWith({ host: '127.0.0.1', port: 4329 });
    const retirement = healthy.close(); await vi.waitFor(() => expect(closeFirst).toHaveBeenCalledOnce());
    const next = runtime.start(record('next'), material, signal);
    await Promise.resolve(); expect(ports.ingress).toHaveBeenCalledOnce();
    releaseClose(); await retirement; const handle = await next;
    expect(ports.ingress).toHaveBeenCalledTimes(2); await handle.close(); expect(closeNext).toHaveBeenCalledOnce();
  } finally { releaseClose(); await rm(root, { recursive: true, force: true }); }
});
