import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OperationalStore } from '@joko/store';
import { afterEach, expect, it, vi } from 'vitest';
import type { OrchestratorApplication } from './application.js';
import { connectionEntryDirectory } from './connection-entries.js';
import { startLinkspanSdkIngress } from './linkspan-sdk-server.js';

const sdk = vi.hoisted(() => ({ listen: vi.fn() }));
vi.mock('@jokoagent/linkspan-iroh/node', () => ({ listenIroh: sdk.listen, IROH_LIMITS: {} }));
vi.mock('@jokoagent/linkspan-iroh-node', () => ({ configureIrohRuntime: vi.fn() }));
vi.mock('@joko/remote-ssh', async original => ({ ...await original<typeof import('@joko/remote-ssh')>(), inspectKeyDirectoryPermissions: vi.fn(async () => {}) }));
afterEach(() => { vi.clearAllMocks(); });

it.each([false, true])('journals SDK retirement only after cleanup, retaining failed handles for retry (fail=%s)', async failFirst => {
  const root = await mkdtemp(join(tmpdir(), 'joko-sdk-retirement-'));
  const workspace = join(root, 'workspace'), invitationDirectory = join(root, 'invitations');
  await mkdir(workspace); await mkdir(invitationDirectory);
  const store = new OperationalStore(':memory:');
  const app = { store, serverId: randomUUID(), linkspanIdentity: { publicKey: `ed25519:${'a'.repeat(64)}` },
    config: { publicOrigin: 'https://node.example', workspace: { root: workspace } } } as OrchestratorApplication;
  let resolve!: () => void, reject!: (error: Error) => void, attempts = 0, closing: Promise<void> | undefined;
  const gate = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  const close = () => {
    if (closing) return closing;
    const pending = ++attempts === 1 ? gate : Promise.resolve(); closing = pending;
    void pending.catch(() => { if (closing === pending) closing = undefined; }); return pending;
  };
  sdk.listen.mockImplementation(async ({ signal }: { signal: AbortSignal }) => {
    signal.addEventListener('abort', () => { void close().catch(() => {}); }, { once: true });
    return { endpointId: 'b'.repeat(64), ticket: 'private-ticket-for-the-original-endpoint', close,
      accept: () => signal.aborted ? Promise.resolve(null) : new Promise<null>(done => signal.addEventListener('abort', () => done(null), { once: true })) };
  });
  const entry = { id: 'owned', connector: { provider: 'iroh' as const, secretKeyHex: 'c'.repeat(64), relayUrls: [], invitationDirectory } };
  const input = { backendOrigin: 'http://127.0.0.1:4318', signal: new AbortController().signal };
  let handle: Awaited<ReturnType<typeof startLinkspanSdkIngress>> | undefined;
  const journal = () => store.findSetting<{ state: string; requestId: string }>('service', 'orchestrator', 'runtime.linkspan.sdk.owned')!.value;
  try {
    handle = await startLinkspanSdkIngress(app, entry, input);
    const original = journal(); expect(original.state).toBe('active');
    const pending = handle.close(); expect(handle.close()).toBe(pending);
    let retired = false; void pending.then(() => { retired = true; }, () => {});
    await Promise.resolve(); expect(retired).toBe(false); expect(journal()).toEqual(original); expect(attempts).toBe(1);
    expect(connectionEntryDirectory(app).entries.some(value => value.entryId === 'linkspan:owned')).toBe(false);
    await expect(startLinkspanSdkIngress(app, entry, input)).rejects.toThrow('owning process');
    if (failFirst) {
      const rejected = expect(pending).rejects.toThrow('native cleanup failed'); reject(new Error('native cleanup failed')); await rejected;
      expect(journal()).toEqual(original); expect(sdk.listen).toHaveBeenCalledOnce();
      await expect(startLinkspanSdkIngress(app, entry, input)).rejects.toThrow('owning process');
      await handle.close(); expect(attempts).toBe(2);
    } else { resolve(); await pending; expect(attempts).toBe(1); }
    expect(journal()).toEqual({ ...original, state: 'closed' }); await handle.close();
    expect(sdk.listen).toHaveBeenCalledOnce();
  } finally { resolve(); await handle?.close(); store.close(); await rm(root, { recursive: true, force: true }); }
});
