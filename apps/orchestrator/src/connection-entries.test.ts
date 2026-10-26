import { describe, expect, it } from 'vitest';
import { OperationalStore } from '@joko/store';
import { connectionEntryDirectory, prepareConnectionEntry, publishConnectionEntry } from './connection-entries.js';
import type { OrchestratorApplication } from './application.js';
describe('live node entrance directory', () => {
  it('publishes only live handles, keeps private locators out of summaries, and retires the exact handle', async () => {
    const store = new OperationalStore(':memory:');
    const app = { store, serverId: 'home', config: { publicOrigin: 'https://home.example' }, linkspanIdentity: { publicKey: `ed25519:${'a'.repeat(64)}` } } as OrchestratorApplication;
    try {
      store.setSetting('service', 'orchestrator', 'runtime.linkspan.quick', { state: 'active', publicOrigin: 'https://stale.example' });
      expect(connectionEntryDirectory(app).entries).toHaveLength(1);
      const retire = publishConnectionEntry(store, { id: 'linkspan:relay', provider: 'tailcat', origin: 'https://home.example',
        allowPrivateAddressPairing: true, transport: { kind: 'tailcat', endpointId: `nodekey:${'c'.repeat(64)}`, address: 'tcPRIVATE', port: 443 } });
      expect(JSON.stringify(connectionEntryDirectory(app))).not.toContain('tcPRIVATE');
      const result = await prepareConnectionEntry(app, { entryId: 'linkspan:relay', requestId: crypto.randomUUID(),
        clientPublicKey: `nodekey:${'b'.repeat(64)}`, connectionId: 'device-connection', signal: new AbortController().signal, assertCurrent() {} });
      expect(result.locator.case).toBe('tailcat');
      retire(); expect(connectionEntryDirectory(app).entries).toHaveLength(1);
      await expect(prepareConnectionEntry(app, { entryId: 'linkspan:relay', requestId: crypto.randomUUID(), clientPublicKey: '', connectionId: 'c', signal: new AbortController().signal, assertCurrent() {} })).rejects.toThrow();
    } finally { store.close(); }
  });
});
