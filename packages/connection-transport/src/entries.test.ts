import { describe, expect, it, vi } from 'vitest';
import type { ListConnectionEntriesResponse } from '@joko/contracts';
import { connectionEntryCandidates, connectionEntryOwnerKey, entryReadiness, initialConnectionEntries, mergeConnectionEntryDirectory,
  parseSavedConnectionEntries, resolvePreparedConnection, acceptInvitedConnectionEntry, activeConnectionEntry, prepareEntryAndSave, type SavedConnectionEntries } from './entries.js';

const probes = vi.hoisted(() => ({ calls: [] as { origin: string; auth: string | null; method: string }[], bad: new Set<string>(), failures: new Map<string, Error>() }));
vi.mock('./index.js', async () => {
  const { createRouterTransport, ConnectError, Code } = await import('@connectrpc/connect');
  const { ConnectionService } = await import('@joko/contracts');
  return { createConnectTransport: (options: { baseUrl: string }) => createRouterTransport(router => router.service(ConnectionService, {
    getServerInfo: (_request, context) => {
      probes.calls.push({ origin: options.baseUrl, auth: context.requestHeader.get('authorization'), method: 'identity' });
      return { server: { serverId: probes.bad.has(options.baseUrl) ? 'intruder' : 'home' } };
    },
    prepareConnectionEntry: () => ({ serverId: 'home', endpointPublicKey: `ed25519:${'a'.repeat(64)}`,
      entry: { entryId: 'private', origin: 'https://private.example', transportKind: 'iroh' },
      locator: { case: 'iroh', value: { endpointId: 'c'.repeat(64), ticket: 'renewed-iroh-ticket' } } }),
    getDevice: (request, context) => {
      probes.calls.push({ origin: options.baseUrl, auth: context.requestHeader.get('authorization'), method: 'device' });
      if (context.requestHeader.get('authorization') === 'Bearer revoked') throw new ConnectError('revoked', Code.PermissionDenied);
      return { device: { deviceId: request.deviceId } };
    }
  }), { transport: { interceptors: [next => request => {
    // A carrier error occurs on the client side. Throwing it in a service
    // handler instead serializes an Internal RPC response and loses its cause.
    if (request.method.name === 'GetDevice' && probes.failures.has(options.baseUrl)) {
      probes.calls.push({ origin: options.baseUrl, auth: request.header.get('authorization'), method: 'device' });
      throw probes.failures.get(options.baseUrl)!;
    }
    return next(request);
  }] } }) };
});
const owner = { profileId: 'profile', deviceId: 'device', serverId: 'home', endpointPublicKey: `ed25519:${'a'.repeat(64)}` };
const initial = () => initialConnectionEntries(owner, { origin: 'https://home.example' });
const two = (): SavedConnectionEntries => ({ ...initial(), backupIds: ['relay'], entries: [...initial().entries,
  { id: 'relay', name: 'Relay', provider: 'cloudflare', kind: 'https', origin: 'https://relay.example', published: true, prepared: true }] });
describe('saved node entrances', () => {
  it('retains each entrance’s iroh mode when renewal receives the opposite build default', async () => {
    probes.bad.clear(); probes.failures.clear();
    for (const mode of ['native', 'relay'] as const) {
      const saved: SavedConnectionEntries = { ...initial(), entries: [...initial().entries, {
        id: 'private', name: 'Private', provider: 'iroh', kind: 'iroh', origin: 'https://private.example', published: true, prepared: true,
        requestId: '11111111-1111-4111-8111-111111111111', clientPrivateKey: 'd'.repeat(64), clientPublicKey: 'e'.repeat(64),
        transport: { kind: 'iroh', endpointId: 'c'.repeat(64), ticket: 'original-iroh-ticket', clientKey: 'd'.repeat(64), clientEndpointId: 'e'.repeat(64), mobileMode: mode }
      }] };
      const write = vi.fn(async (_value: SavedConnectionEntries) => {});
      const next = await prepareEntryAndSave(owner, saved, 'private', saved.entries[0]!, 'same-device-secret',
        { read: async () => saved, write }, new AbortController().signal, { renew: true, uuid: () => '22222222-2222-4222-8222-222222222222', irohMode: mode === 'native' ? 'relay' : 'native' });
      const entry = next.entries[1]!;
      expect(entry).toMatchObject({ irohMode: mode, requestId: '22222222-2222-4222-8222-222222222222', clientPublicKey: 'e'.repeat(64), prepared: true });
      expect(entry.transport).toMatchObject({ mobileMode: mode, ticket: 'renewed-iroh-ticket' });
      expect(parseSavedConnectionEntries(next, owner).entries[1]?.transport).toMatchObject({ mobileMode: mode });
      expect(write.mock.calls[0]?.[0].entries[1]).toMatchObject({ irohMode: mode, prepared: false });
    }
  });
  it('continues to an allowed backup when the verified preferred entrance loses the authorization reply', async () => {
    const { ConnectError, Code } = await import('@connectrpc/connect');
    const { LinkspanError } = await import('@jokoagent/linkspan-core');
    for (const failure of [new ConnectError('Connection reset', Code.Unavailable), new ConnectError('Timed out', Code.DeadlineExceeded),
      new Error('Transport failed', { cause: new LinkspanError('transport_error', 'Link lost') }), new DOMException('Timed out', 'TimeoutError')]) {
      probes.calls = []; probes.bad.clear(); probes.failures.set('https://home.example', failure);
      try {
        const save = vi.fn(async (_next: SavedConnectionEntries) => undefined);
        const result = await resolvePreparedConnection(owner, two(), async () => 'same-device-secret', () => true, new AbortController().signal, undefined, save);
        expect(result.entry.id).toBe('relay'); expect(result.saved.preferredId).toBe('saved');
        expect(save.mock.calls[0]?.[0].entries[0]?.verification).toBe('unreachable');
        expect(probes.calls.map(call => [call.origin, call.method])).toEqual([
          ['https://home.example', 'identity'], ['https://home.example', 'device'], ['https://relay.example', 'identity'], ['https://relay.example', 'device']]);
        expect(probes.calls.filter(call => call.method === 'device').every(call => call.auth === 'Bearer same-device-secret')).toBe(true);
      } finally { probes.failures.clear(); }
    }
  });
  it('keeps trust, malformed-response and authentication failures terminal during authorization', async () => {
    const { ConnectError, Code } = await import('@connectrpc/connect');
    const { EndpointTrustError } = await import('./trust.js');
    for (const failure of [new ConnectError('revoked', Code.Unauthenticated), new ConnectError('invalid response', Code.DataLoss), new EndpointTrustError()]) {
      probes.calls = []; probes.bad.clear(); probes.failures.set('https://home.example', failure);
      try {
        await expect(resolvePreparedConnection(owner, two(), async () => 'secret', () => true, new AbortController().signal)).rejects.toThrow();
        expect(probes.calls.some(call => call.origin === 'https://relay.example')).toBe(false);
      } finally { probes.failures.clear(); }
    }
  });
  it('preserves the device owner across addresses and rejects another node or device cache', () => {
    expect(parseSavedConnectionEntries(two(), owner).owner).toBe(connectionEntryOwnerKey(owner));
    expect(() => parseSavedConnectionEntries(two(), { ...owner, deviceId: 'other' })).toThrow();
    expect(() => parseSavedConnectionEntries(two(), { ...owner, endpointPublicKey: `ed25519:${'b'.repeat(64)}` })).toThrow();
  });
  it('never allows newly advertised routes automatically or overwrites the preferred entrance', () => {
    const response: ListConnectionEntriesResponse = { $typeName: 'joko.v1.ListConnectionEntriesResponse', serverId: owner.serverId, endpointPublicKey: owner.endpointPublicKey,
      revision: 'revision', entries: [{ $typeName: 'joko.v1.NodeConnectionEntry', requiresClientIdentity: true, requiresServerSetup: false, entryId: 'new', provider: 'iroh', displayName: 'iroh', origin: 'https://new.example', transportKind: 'iroh' }] };
    const next = mergeConnectionEntryDirectory(two(), owner, response);
    expect(next.preferredId).toBe('saved'); expect(next.backupIds).toEqual(['relay']);
    expect(connectionEntryCandidates(next, () => true).map(e => e.id)).toEqual(['saved']);
    expect(next.entries.find(e => e.id === 'new')?.prepared).toBe(false);
    expect(() => mergeConnectionEntryDirectory(two(), owner, { ...response, serverId: 'same-name-different-node' })).toThrow();
  });
  it('uses only prepared allowed alternatives, leaving the preference unchanged', async () => {
    probes.calls = []; probes.bad = new Set(['https://home.example']);
    const readKey = vi.fn(async () => 'device-secret'), saved = two();
    const result = await resolvePreparedConnection(owner, saved, readKey, () => true, new AbortController().signal);
    expect(result.entry.id).toBe('relay'); expect(saved.preferredId).toBe('saved');
    expect(readKey).toHaveBeenCalledTimes(1);
    expect(probes.calls.filter(c => c.origin === 'https://home.example')).toEqual([{ origin: 'https://home.example', auth: null, method: 'identity' }]);
    expect(probes.calls.at(-1)?.auth).toBe('Bearer device-secret');
    probes.calls = [];
    await expect(resolvePreparedConnection(owner, { ...saved, backupIds: [] }, readKey, () => true, new AbortController().signal)).rejects.toThrow();
    expect(probes.calls.some(c => c.origin === 'https://relay.example')).toBe(false);
  });
  it('does not try another route when the original device authorization was revoked', async () => {
    probes.calls = []; probes.bad.clear();
    await expect(resolvePreparedConnection(owner, two(), async () => 'revoked', () => true, new AbortController().signal)).rejects.toThrow(/revoked/u);
    expect(probes.calls.some(c => c.origin === 'https://relay.example')).toBe(false);
  });
  it('filters unsupported, unprepared and expired routes and respects abort before reading credentials', async () => {
    expect(entryReadiness(two().entries[1]!, () => false)).toBe('unsupported');
    expect(entryReadiness({ ...two().entries[1]!, prepared: false }, () => true)).toBe('unprepared');
    const controller = new AbortController(); controller.abort(); const read = vi.fn(async () => 'secret');
    await expect(resolvePreparedConnection(owner, two(), read, () => true, controller.signal)).rejects.toThrow();
    expect(read).not.toHaveBeenCalled();
  });
  it('isolates a conflicting candidate in protected state before using a prepared backup', async () => {
    probes.bad = new Set(['https://home.example']); probes.calls = [];
    const save = vi.fn(async (_saved: SavedConnectionEntries) => undefined);
    const result = await resolvePreparedConnection(owner, two(), async () => 'secret', () => true, new AbortController().signal, undefined, save);
    expect(result.saved.entries[0]?.verification).toBe('identity-conflict');
    expect(connectionEntryCandidates(result.saved, () => true).map(entry => entry.id)).toEqual(['relay']);
    expect(save.mock.calls[0]?.[0].entries[0]?.verification).toBe('identity-conflict');
    expect(result.saved.preferredId).toBe('saved');
  });
  it('accepts a new entrance for the same full identity without changing its device or preferences', () => {
    const invitation = { ...owner, origin: 'https://new-entrance.example' };
    const next = acceptInvitedConnectionEntry(owner, two(), invitation, 'first');
    expect(next.saved.owner).toBe(two().owner); expect(next.saved.preferredId).toBe('saved'); expect(next.saved.backupIds).toEqual(['relay']);
    const again = acceptInvitedConnectionEntry(owner, next.saved, invitation, 'second');
    expect(again.entryId).toBe(next.entryId); expect(again.saved.entries.filter(entry => entry.origin === invitation.origin)).toHaveLength(1);
    expect(() => acceptInvitedConnectionEntry(owner, two(), { ...invitation, endpointPublicKey: `ed25519:${'b'.repeat(64)}` }, 'bad')).toThrow();
  });
  it('identifies entrances with the same origin and carrier by their saved entry ID', () => {
    const saved = { ...two(), entries: [...two().entries, { ...two().entries[1]!, id: 'other-relay' }] };
    expect(activeConnectionEntry(saved, { origin: 'https://relay.example', entryId: 'other-relay' })?.id).toBe('other-relay');
  });
});
