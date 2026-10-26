import { expect, it, vi } from 'vitest';
import { createIrohClientIdentity, endpointHttpConnectAuthority, endpointTransportForNewDevice, normalizeEndpointTransport, rememberEndpointTransport, selectEndpointTransport, trustedEndpointTransport, trustedEndpointTransportKind } from './endpoint-transport.js';
import { formatTrustedNodeInvitation, parseTrustedNodeInvitation, rememberEndpointTrust, trustedEndpointPublicKey } from './trust.js';

const publicKey = `ed25519:${'a'.repeat(64)}`;
const iroh = { kind: 'iroh', endpointId: 'b'.repeat(64), ticket: 'trusted-iroh-ticket' } as const;
const tailcat = { kind: 'tailcat', endpointId: `nodekey:${'c'.repeat(64)}`, address: 'tcPrivate-address-with-psk', port: 4318 } as const;
it('binds a CONNECT invitation to the exact node authority with canonical default ports and IPv6', () => {
  for (const [origin, authority] of [['https://connect-node.example', 'connect-node.example:443'], ['http://connect-node.example', 'connect-node.example:80'], ['https://[::1]:4318', '[::1]:4318']]) {
    const transport = { kind: 'http-connect' as const, proxyOrigin: 'https://proxy.example:8443', authority: authority! };
    expect(endpointHttpConnectAuthority(origin!)).toBe(authority);
    const invitation = { origin: origin!, endpointPublicKey: publicKey, serverId: 'connect-node', endpointTransport: transport };
    const parsed = parseTrustedNodeInvitation(formatTrustedNodeInvitation(invitation));
    rememberEndpointTrust(parsed);
    expect(trustedEndpointTransport(origin!, publicKey, 'http-connect')).toEqual(transport);
    expect(endpointTransportForNewDevice(transport)).toEqual(transport);
  }
});

it('rejects proxy secrets, header injection and target changes before recording any node trust', () => {
  const origin = 'https://connect-rejected.example', transport = { kind: 'http-connect' as const, proxyOrigin: 'http://proxy.example', authority: 'different.example:443' };
  const input = { origin, endpointPublicKey: publicKey, endpointTransport: transport };
  expect(() => formatTrustedNodeInvitation(input)).toThrow(/authority/u);
  expect(() => parseTrustedNodeInvitation(JSON.stringify({ version: 1, ...input }))).toThrow(/authority/u);
  expect(() => rememberEndpointTrust(input)).toThrow(/authority/u);
  expect(trustedEndpointPublicKey(origin)).toBeUndefined();
  for (const proxyOrigin of ['http://proxy.example/', 'http://u:p@proxy.example', 'http://proxy.example/path', 'http://proxy.example?q=secret', 'file:///proxy', 'http://proxy.example\r\nX: bad']) {
    expect(() => normalizeEndpointTransport({ ...transport, proxyOrigin })).toThrow();
  }
  for (const authority of ['target.example', 'target.example:0', 'target.example:00443', 'target.example:65536', 'target.example:443\r\nAuthorization: secret', 'target.example/path:443', 'user@target.example:443', 'TARGET.example:443', '::1:443', 'a_b.test:443', 'target.test.:443', `${'a'.repeat(64)}.example:443`]) {
    expect(() => normalizeEndpointTransport({ ...transport, authority })).toThrow();
  }
  expect(() => normalizeEndpointTransport({ ...transport, headers: { authorization: 'secret' } })).toThrow();
});
it('retains a WebRTC choice with its trusted node identity and no provider locator or copied device key', () => {
  const origin = 'https://webrtc-invitation.example', transport = { kind: 'webrtc' } as const;
  const invitation = parseTrustedNodeInvitation(formatTrustedNodeInvitation({ origin, endpointPublicKey: publicKey, endpointTransport: transport }));
  rememberEndpointTrust(invitation);
  expect(trustedEndpointTransportKind(origin, publicKey)).toBe('webrtc');
  expect(trustedEndpointTransport(origin, publicKey)).toEqual(transport);
  expect(endpointTransportForNewDevice(transport)).toEqual(transport);
  expect(() => normalizeEndpointTransport({ kind: 'webrtc', endpointId: 'platform-supplied' })).toThrow();
});
vi.mock('@jokoagent/linkspan-iroh', () => ({ createIrohIdentity: async () => ({ privateKey: '4'.repeat(64), publicKey: '5'.repeat(64) }) }));

it('imports the bounded private SDK locator together with the independently trusted node key', () => {
  const invitation = { origin: 'https://sdk-invitation.example', serverId: 'node-sdk', endpointPublicKey: publicKey, endpointTransport: tailcat };
  const parsed = parseTrustedNodeInvitation(formatTrustedNodeInvitation(invitation));
  expect(parsed).toEqual({ version: 1, ...invitation });
  rememberEndpointTrust(parsed);
  expect(trustedEndpointTransportKind(parsed.origin, publicKey)).toBe('tailcat');
  expect(trustedEndpointTransport(parsed.origin, publicKey)).toEqual(tailcat);
  for (const value of [{ ...tailcat, authKey: 'not-a-locator' }, { ...tailcat, port: 0 }, { ...tailcat, endpointId: 'unverified' }, { ...tailcat, address: 'https://untrusted-locator.example' }, { ...iroh, endpointId: 'A'.repeat(64) }, { ...iroh, ticket: 'too-short' }, { ...iroh, ticket: 'x'.repeat(8193) }]) {
    expect(() => normalizeEndpointTransport(value)).toThrow();
  }
});

it('retains each explicitly selected backend and does not turn a later selection into fallback', () => {
  const origin = 'https://sdk-selections.example';
  rememberEndpointTransport(origin, publicKey, iroh);
  const captured = trustedEndpointTransport(origin, publicKey, 'iroh');
  rememberEndpointTransport(origin, publicKey, tailcat);
  expect(trustedEndpointTransport(origin, publicKey)).toEqual(tailcat);
  expect(captured).toEqual(iroh);
  expect(trustedEndpointTransport(origin, publicKey, 'iroh')).toEqual(iroh);
  selectEndpointTransport(origin, publicKey, 'https');
  expect(trustedEndpointTransport(origin, publicKey)).toBeUndefined();
  expect(trustedEndpointTransport(origin, publicKey, 'tailcat')).toEqual(tailcat);
  expect(() => trustedEndpointTransport(origin, `ed25519:${'d'.repeat(64)}`, 'tailcat')).toThrow(/unavailable/u);
  expect(normalizeEndpointTransport({ ...iroh, relayUrls: [], mobileMode: 'native' })).toMatchObject({ relayUrls: [], mobileMode: 'native' });
  expect(() => normalizeEndpointTransport({ ...iroh, relayUrls: [], clientEndpointId: '5'.repeat(64), relayToken: 'no-relay-cannot-use-lease', relayTokenExpiresAt: Date.now() + 60000 })).toThrow();
});

it('does not copy an existing device private key into another device invitation', () => {
  const privateLocator = { ...tailcat, clientKey: `privkey:${'e'.repeat(64)}` };
  expect(normalizeEndpointTransport(privateLocator)).toEqual(privateLocator);
  expect(endpointTransportForNewDevice(privateLocator)).toEqual(tailcat);
  expect(() => normalizeEndpointTransport({ ...tailcat, clientKey: 'nodekey:public-is-not-private' })).toThrow();
});

it('binds a relay lease to the local client key and strips it from a new-device invitation', async () => {
  const origin = 'https://iroh-lease.example';
  await expect(createIrohClientIdentity(origin, publicKey, iroh)).resolves.toEqual({ publicKey: '5'.repeat(64) });
  const lease = { ...iroh, clientEndpointId: '5'.repeat(64), relayUrls: ['https://relay.example'], relayToken: 'private-client-lease', relayTokenExpiresAt: Date.now() + 60_000 };
  rememberEndpointTransport(origin, publicKey, lease);
  const local = trustedEndpointTransport(origin, publicKey, 'iroh');
  expect(local).toEqual({ ...lease, clientKey: '4'.repeat(64) });
  expect(endpointTransportForNewDevice(local)).toEqual({ ...iroh, relayUrls: lease.relayUrls });
  rememberEndpointTransport('https://lease-relocated.example', publicKey, lease);
  expect(trustedEndpointTransport('https://lease-relocated.example', publicKey, 'iroh')).toEqual(local);
  expect(() => rememberEndpointTransport(origin, publicKey, { ...lease, clientKey: '7'.repeat(64) })).toThrow(/conflicts/u);
  expect(trustedEndpointTransport(origin, publicKey, 'iroh')).toEqual(local);
  rememberEndpointTransport('https://lease-missing-key.example', publicKey, { ...lease, clientEndpointId: '6'.repeat(64) });
  expect(() => trustedEndpointTransport('https://lease-missing-key.example', publicKey, 'iroh')).toThrow(/original local/u);
  rememberEndpointTransport(origin, publicKey, { ...lease, relayTokenExpiresAt: Date.now() - 1 });
  expect(() => trustedEndpointTransport(origin, publicKey, 'iroh')).toThrow(/expired/u);
});

it('does not publish partial node trust when its private transport input was rejected', () => {
  const origin = 'https://invalid-sdk-trust.example';
  expect(() => rememberEndpointTrust({ origin, endpointPublicKey: publicKey, endpointTransport: { ...iroh, endpointId: 'invalid' } })).toThrow();
  expect(trustedEndpointPublicKey(origin)).toBeUndefined();
});

it('creates B key before receiving any invitation and binds its pending private key only after explicit node trust', async () => {
  const pin = `ed25519:${'9'.repeat(64)}`, origin = 'https://first-recipient-invitation.example';
  await expect(createIrohClientIdentity()).resolves.toEqual({ publicKey: '5'.repeat(64) });
  const lease = { ...iroh, clientEndpointId: '5'.repeat(64), relayUrls: ['https://relay.example'], relayToken: 'B-restricted-relay', relayTokenExpiresAt: Date.now() + 60000 };
  rememberEndpointTransport(origin, pin, lease);
  expect(() => trustedEndpointTransport(origin, pin, 'iroh')).toThrow(/original local/u);
  rememberEndpointTrust({ origin, endpointPublicKey: pin, serverId: 'node', endpointTransport: lease });
  expect(trustedEndpointTransport(origin, pin, 'iroh')).toEqual({ ...lease, clientKey: '4'.repeat(64) });
  const otherPin = `ed25519:${'8'.repeat(64)}`;
  rememberEndpointTrust({ origin: 'https://other-recipient-node.example', endpointPublicKey: otherPin, serverId: 'other', endpointTransport: lease });
  expect(() => trustedEndpointTransport('https://other-recipient-node.example', otherPin, 'iroh')).toThrow(/original local/u);
});
