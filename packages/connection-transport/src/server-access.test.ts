import { randomUUID } from 'node:crypto';
import { createClient, createRouterTransport, ConnectError, Code } from '@connectrpc/connect';
import { ServerAccessService } from '@joko/contracts';
import { expect, it, vi } from 'vitest';
import { serverAccessClient } from './server-access.js';

it('queries the same accepted request after response loss and remount without resubmitting credentials', async () => {
  const requestId = randomUUID(), owner = `node:${randomUUID()}`;
  const save = vi.fn(() => { throw new ConnectError('response lost', Code.Unavailable); });
  const read = vi.fn((request: { requestId: string }) => ({ serverId: 'node', operationState: request.requestId === requestId ? 'completed' : '' }));
  const rpc = createClient(ServerAccessService, createRouterTransport(router => router.service(ServerAccessService, { saveServerAccessEntry: save, getServerAccessSettings: read })));
  const api = serverAccessClient(rpc, () => {}, owner), input = { requestId, entryId: 'entry', expectedRevision: '', name: 'Entry', provider: 'iroh', mode: 'relay', fields: { servicesApiSecret: 'never-persist-this' } };
  await expect(api.save(input)).rejects.toThrow('response lost');
  await expect(api.save({ ...input, requestId: randomUUID() })).rejects.toThrow('query_original_operation');
  const reopened = serverAccessClient(rpc, () => {}, owner);
  expect((await reopened.read()).operationState).toBe('completed');
  expect(read).toHaveBeenLastCalledWith(expect.objectContaining({ requestId }), expect.anything());
  expect(save).toHaveBeenCalledOnce();
  await serverAccessClient(rpc, () => {}, `other:${randomUUID()}`).read();
  expect(read).toHaveBeenLastCalledWith(expect.objectContaining({ requestId: '' }), expect.anything());
});

it('fences both dispatch and a late read against the verified connection owner', async () => {
  let current = true;
  const rpc = createClient(ServerAccessService, createRouterTransport(router => router.service(ServerAccessService, {
    getServerAccessSettings: async () => { current = false; return { serverId: 'old-node' }; }
  })));
  const assertCurrent = () => { if (!current) throw new Error('owner_changed'); };
  const api = serverAccessClient(rpc, assertCurrent, randomUUID());
  await expect(api.read()).rejects.toThrow('owner_changed');
  await expect(api.change({ requestId: randomUUID(), entryId: 'entry', expectedRevision: '1', action: 'start', confirmDisconnection: false, confirmResourceId: '' })).rejects.toThrow('owner_changed');
});
