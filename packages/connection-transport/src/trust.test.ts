import { describe, expect, it } from 'vitest';
import { LinkspanError } from '@jokoagent/linkspan-core';
import { assertTrustedEndpointServerId, endpointOrigin, formatTrustedNodeInvitation, isLoopbackEndpoint, normalizeEndpointPublicKey, parseTrustedNodeInvitation,
  captureEndpointTrustFailure, EndpointTrustError, isEndpointTrustError, observeEndpointTrustFailure, pairingVerificationOrigin, rememberEndpointTrust, replaceEndpointTrust, reportEndpointTrustFailure, requireEndpointTrust } from './trust.js';

const first = `ed25519:${'1'.repeat(64)}`;
const second = `ed25519:${'2'.repeat(64)}`;

describe('trusted endpoint inputs', () => {
  it('ignores a retired channel failure after another occurrence adopts the same pinned node', () => {
    const owner = { origin: 'https://late-channel.example', endpointPublicKey: first }, failures: Error[] = [];
    const retire = observeEndpointTrustFailure(owner, error => failures.push(error));
    const oldChannelFailed = captureEndpointTrustFailure(owner);
    retire();
    const next = observeEndpointTrustFailure(owner, error => failures.push(error));
    oldChannelFailed(new EndpointTrustError());
    expect(failures).toEqual([]);
    reportEndpointTrustFailure(owner, new EndpointTrustError());
    expect(failures).toHaveLength(1);
    next();
  });

  it('retires only matching active pins after a security failure and leaves ordinary outages retryable', () => {
    const owner = { origin: 'https://observer.example', endpointPublicKey: first };
    const failures: Error[] = [];
    const stop = observeEndpointTrustFailure(owner, error => failures.push(error));
    reportEndpointTrustFailure(owner, new LinkspanError('transport_error', 'ordinary outage'));
    reportEndpointTrustFailure({ ...owner, endpointPublicKey: second }, new LinkspanError('identity_mismatch', 'other owner'));
    expect(failures).toEqual([]);
    const securityFailure = new Error('Connect wrapper', { cause: new LinkspanError('authentication_failed', 'handshake rejected') });
    expect(isEndpointTrustError(securityFailure)).toBe(true);
    expect(isEndpointTrustError(new LinkspanError('transport_error', 'ordinary outage'))).toBe(false);
    reportEndpointTrustFailure(owner, securityFailure);
    reportEndpointTrustFailure(owner, securityFailure);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toBeInstanceOf(EndpointTrustError);
    const retired = observeEndpointTrustFailure(owner, error => failures.push(error));
    retired(); reportEndpointTrustFailure(owner, securityFailure);
    expect(failures).toHaveLength(1);
    stop();
  });

  it('uses the authenticated pairing verification locator without accepting URL secrets or arbitrary paths', () => {
    expect(pairingVerificationOrigin('https://published.trycloudflare.com/pair')).toBe('https://published.trycloudflare.com');
    for (const value of ['https://u:p@example.com/pair', 'https://example.com/pair?code=secret', 'https://example.com/other', 'data:secret']) {
      expect(() => pairingVerificationOrigin(value)).toThrow();
    }
  });
  it('rejects a certificate/address-only remote path before any connection can start', () => {
    expect(() => requireEndpointTrust({ origin: 'https://no-pin.example' })).toThrow(/public key/u);
    expect(() => requireEndpointTrust({ origin: 'https://192.168.10.20:4318' })).toThrow(/public key/u);
    expect(() => requireEndpointTrust({ origin: 'http://peer.localhost:4318' })).toThrow(/public key/u);
    expect(requireEndpointTrust({ origin: 'http://127.0.0.1:4318' })).toBeUndefined();
    expect(isLoopbackEndpoint('https://localhost.attacker.example')).toBe(false);
    expect(isLoopbackEndpoint('https://127.0.0.1.attacker.example')).toBe(false);
  });

  it('requires a pin for explicitly selected encrypted transports even at a loopback or private-LAN origin', () => {
    for (const origin of ['http://127.0.0.1:45981', 'http://192.168.11.25:45981']) {
      for (const transportKind of ['iroh', 'tailcat', 'webrtc', 'http-connect'] as const) {
        expect(() => requireEndpointTrust({ origin, transportKind })).toThrow(/public key/u);
      }
      expect(() => requireEndpointTrust({ origin, endpointTransport: { kind: 'http-connect', proxyOrigin: 'http://127.0.0.1:45890', authority: new URL(origin).host } })).toThrow(/public key/u);
      expect(requireEndpointTrust({ origin, transportKind: 'https' })).toBeUndefined();
    }
  });

  it('retains the restricted LAN HTTP mode while rejecting public, link-local and metadata targets', () => {
    for (const origin of ['http://192.168.10.20:4318', 'http://10.2.3.4:4318', 'http://[fd00::1234]:4318', 'http://node.local:4318']) {
      expect(requireEndpointTrust({ origin })).toBeUndefined();
    }
    for (const origin of ['http://8.8.8.8:4318', 'http://public.example', 'http://169.254.169.254', 'http://[fe80::1]', 'http://[fd00:ec2::254]', 'http://metadata', 'http://metadata.local', 'http://instance-data']) {
      expect(() => requireEndpointTrust({ origin })).toThrow(/public key/u);
    }
    const origin = 'http://192.168.10.21:4318';
    rememberEndpointTrust({ origin, endpointPublicKey: first });
    expect(requireEndpointTrust({ origin })).toBe(first);
    expect(() => requireEndpointTrust({ origin, endpointPublicKey: second })).toThrow(/conflicts/u);
  });

  it('keeps the complete pinned identity across repeated calls and rejects an unexpected key', () => {
    const origin = 'https://fixed-pin.example';
    expect(rememberEndpointTrust({ origin, endpointPublicKey: first })).toBe(first);
    expect(requireEndpointTrust({ origin })).toBe(first);
    expect(() => rememberEndpointTrust({ origin, endpointPublicKey: second })).toThrow(/conflicts/u);
    expect(requireEndpointTrust({ origin })).toBe(first);
    replaceEndpointTrust({ origin, endpointPublicKey: second });
    expect(() => requireEndpointTrust({ origin, endpointPublicKey: first })).toThrow(/conflicts/u);
    expect(requireEndpointTrust({ origin, endpointPublicKey: second })).toBe(second);
  });

  it('imports only the bounded public invitation shape and rejects secrets or unsafe addresses', () => {
    const invitation = { origin: 'https://invitation.example', endpointPublicKey: first, serverId: 'node-123' };
    expect(parseTrustedNodeInvitation(formatTrustedNodeInvitation(invitation))).toEqual({ version: 1, ...invitation });
    expect(() => parseTrustedNodeInvitation(JSON.stringify({ version: 1, ...invitation, authKey: 'secret' }))).toThrow(/invalid/u);
    expect(() => parseTrustedNodeInvitation(' '.repeat(32769))).toThrow(/large/u);
    for (const origin of ['https://u:p@example.com', 'https://example.com/path', 'https://example.com?secret=1', 'file:///tmp/x']) {
      expect(() => endpointOrigin(origin)).toThrow();
    }
    expect(() => normalizeEndpointPublicKey('ed25519:1234')).toThrow(/complete/u);
  });

  it('binds a trusted invitation to its expected node before a pairing code can be sent', () => {
    const origin = 'https://node-id.example';
    rememberEndpointTrust({ origin, endpointPublicKey: first, serverId: 'expected-node' });
    expect(() => assertTrustedEndpointServerId(origin, 'unexpected-node')).toThrow(/different node/u);
    expect(() => rememberEndpointTrust({ origin, endpointPublicKey: first, serverId: 'unexpected-node' })).toThrow(/different node/u);
    replaceEndpointTrust({ origin, endpointPublicKey: second, serverId: 'recovered-node' });
    expect(() => assertTrustedEndpointServerId(origin, 'recovered-node')).not.toThrow();
    expect(() => requireEndpointTrust({ origin, endpointPublicKey: first })).toThrow(/conflicts/u);
  });
});
