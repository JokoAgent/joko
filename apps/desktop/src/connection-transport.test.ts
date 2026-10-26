import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { desktopEndpointTrust } from './connection-transport.js';

it('reads only the protected SDK locator before an endpoint proof and binds its backend', async () => {
  const owner = { profileId: 'original-profile', serverId: 'node', origin: 'https://desktop-transport.example', endpointPublicKey: `ed25519:${'1'.repeat(64)}`, transportKind: 'iroh' as const };
  const locator = { kind: 'iroh', ticket: 'private-iroh-ticket', endpointId: '2'.repeat(64) };
  const read = vi.fn(async () => JSON.stringify({ owner: JSON.stringify([owner.profileId, owner.origin, owner.serverId, owner.endpointPublicKey, owner.transportKind]), transport: locator }));
  await expect(desktopEndpointTrust(owner, read)).resolves.toEqual({ endpointPublicKey: owner.endpointPublicKey, transportKind: 'iroh', endpointTransport: locator });
  expect(read).toHaveBeenCalledOnce();
  expect(read).toHaveBeenCalledWith(`transport_${createHash('sha256').update(owner.profileId).digest('hex')}`);
  expect(read).not.toHaveBeenCalledWith(owner.profileId);
  await expect(desktopEndpointTrust({ ...owner, transportKind: 'tailcat' }, read)).rejects.toThrow(/owner/u);
  await expect(desktopEndpointTrust({ ...owner, origin: 'https://changed-owner.example' }, read)).rejects.toThrow(/owner/u);
});

it('uses an HTTP selection without retrieving any SDK secret', async () => {
  const read = vi.fn();
  await expect(desktopEndpointTrust({ origin: 'http://127.0.0.1:4318', profileId: 'local' }, read)).resolves.toEqual({ endpointPublicKey: undefined, transportKind: 'https' });
  expect(read).not.toHaveBeenCalled();
});

it('retains the WebRTC choice and full node pin without reading a provider locator or business key', async () => {
  const read = vi.fn(), endpointPublicKey = `ed25519:${'5'.repeat(64)}`;
  await expect(desktopEndpointTrust({ origin: 'https://node.example', profileId: 'rtc', endpointPublicKey, transportKind: 'webrtc' }, read))
    .resolves.toEqual({ endpointPublicKey, transportKind: 'webrtc', endpointTransport: { kind: 'webrtc' } });
  expect(read).not.toHaveBeenCalled();
});
