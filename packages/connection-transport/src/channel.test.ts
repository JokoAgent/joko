import { expect, it, vi } from 'vitest';
import { endpointConnector } from './channel.js';
import { LinkspanError } from '@jokoagent/linkspan-core';
import { installEndpointTransportPreparation, installHttpConnectClientBinding, observeEndpointTrustFailure, rememberEndpointTransport } from './trust.js';

const { connect } = vi.hoisted(() => ({ connect: vi.fn(async () => ({ closed: Promise.resolve({}) })) }));
const sdk = vi.hoisted(() => ({ iroh: vi.fn(async () => ({ closed: Promise.resolve({}) })), tailcat: vi.fn(async () => ({ closed: Promise.resolve({}) })) }));
vi.mock('@jokoagent/linkspan-noise', () => ({ connectWebSocket: connect }));
vi.mock('@jokoagent/linkspan-iroh', () => ({ connectIroh: sdk.iroh }));
vi.mock('@jokoagent/linkspan-tailcat', () => ({ connectTailcat: sdk.tailcat }));
const key = `ed25519:${'3'.repeat(64)}`;

it('captures the selected native CONNECT owner and pin without preparing another SDK or falling back to WSS', async () => {
  const origin = 'https://connect-channel.example', locator = { kind: 'http-connect' as const, proxyOrigin: 'http://proxy.example', authority: 'connect-channel.example:443' };
  const native = vi.fn(async () => ({ closed: Promise.resolve({}) } as never));
  const stop = installHttpConnectClientBinding({ connect: native }), prepare = vi.fn(async () => undefined), retire = installEndpointTransportPreparation(prepare);
  const before = connect.mock.calls.length;
  try {
    const open = endpointConnector(origin, key, 'http-connect', locator);
    stop();
    await open({ deadline: 1234 });
    expect(native).toHaveBeenLastCalledWith(locator, { expectedPublicKey: key, deadline: 1234 });
    const failed = vi.fn(), stopFailure = observeEndpointTrustFailure({ origin, endpointPublicKey: key }, failed);
    try {
      const nextStop = installHttpConnectClientBinding({ connect: native });
      try {
        native.mockRejectedValueOnce(new LinkspanError('identity_mismatch', 'wrong CONNECT endpoint key'));
        await expect(endpointConnector(origin, key, 'http-connect', locator)({})).rejects.toMatchObject({ code: 'identity_mismatch' });
        expect(failed).toHaveBeenCalledOnce();
      } finally { nextStop(); }
    } finally { stopFailure(); }
    expect(() => endpointConnector(origin, key, 'http-connect', { ...locator, authority: 'other.example:443' })).toThrow(/authority/u);
    expect(prepare).not.toHaveBeenCalled(); expect(connect.mock.calls.length).toBe(before);
  } finally { stop(); retire(); }
});

it('rejects CONNECT in a host without a native carrier before opening an HTTP path', async () => {
  const before = connect.mock.calls.length;
  await expect(endpointConnector('https://connect-browser.example', key, 'http-connect', { kind: 'http-connect', proxyOrigin: 'http://proxy.example', authority: 'connect-browser.example:443' })({})).rejects.toThrow(/native/u);
  expect(connect.mock.calls.length).toBe(before);
});

it('reports a rejected handshake to its current owner before any application channel is exposed', async () => {
  const owner = { origin: 'https://rejected-channel.example', endpointPublicKey: key }, failed = vi.fn();
  const stop = observeEndpointTrustFailure(owner, failed);
  try {
    connect.mockRejectedValueOnce(new LinkspanError('identity_mismatch', 'wrong key'));
    await expect(endpointConnector(owner.origin, key)({})).rejects.toMatchObject({ code: 'identity_mismatch' });
    expect(failed).toHaveBeenCalledOnce();
  } finally { stop(); }
});

it('keeps WSS by default and explicitly enables only the selected LAN carrier', async () => {
  await endpointConnector('https://node.example', key)({});
  expect(connect).toHaveBeenLastCalledWith({ url: 'wss://node.example/_linkspan', expectedPublicKey: key, allowInsecureWebSocket: false });
  for (const origin of ['http://192.168.10.20:4318', 'http://10.2.3.4:4318', 'http://[fd12::1]:4318', 'http://node.local:4318', 'http://peer.localhost:4318']) {
    await endpointConnector(origin, key)({});
    expect(connect).toHaveBeenLastCalledWith(expect.objectContaining({ expectedPublicKey: key, allowInsecureWebSocket: true }));
  }
  for (const origin of ['http://8.8.8.8', 'http://node.example', 'http://169.254.169.254', 'http://[fe80::1]', 'http://metadata', 'http://[fd00:ec2::254]']) {
    expect(() => endpointConnector(origin, key)).toThrow(/limited/u);
  }
});

it('does not load or open a carrier after cancellation', async () => {
  const abort = new AbortController(); abort.abort();
  const before = connect.mock.calls.length;
  await expect(endpointConnector('http://192.168.10.21', key)({ signal: abort.signal })).rejects.toThrow();
  expect(connect.mock.calls.length).toBe(before);
});

it('captures the selected SDK locator and authenticates both transport and application identities', async () => {
  const origin = 'https://sdk-channel.example';
  const first = { kind: 'iroh', ticket: 'first-private-ticket', endpointId: 'a'.repeat(64) } as const;
  rememberEndpointTransport(origin, key, first);
  const open = endpointConnector(origin, key, 'iroh');
  rememberEndpointTransport(origin, key, { ...first, ticket: 'replacement-ticket' });
  const calls = connect.mock.calls.length;
  await open({ deadline: 1234 });
  expect(sdk.iroh).toHaveBeenLastCalledWith({ ticket: 'first-private-ticket', expectedEndpointId: first.endpointId, expectedPublicKey: key, deadline: 1234 });
  expect(connect.mock.calls.length).toBe(calls);
  const failed = vi.fn(), stop = observeEndpointTrustFailure({ origin, endpointPublicKey: key }, failed);
  try {
    sdk.iroh.mockRejectedValueOnce(new LinkspanError('identity_mismatch', 'wrong SDK endpoint'));
    await expect(endpointConnector(origin, key, 'iroh')({})).rejects.toMatchObject({ code: 'identity_mismatch' });
    expect(failed).toHaveBeenCalledOnce();
    expect(sdk.tailcat).not.toHaveBeenCalled();
    expect(connect.mock.calls.length).toBe(calls);
  } finally { stop(); }
});

it('rejects expired or missing-key private relay material before loading a native runtime', async () => {
  const prepare = vi.fn(async () => undefined), stop = installEndpointTransportPreparation(prepare), before = sdk.iroh.mock.calls.length;
  const locator = { kind: 'iroh' as const, endpointId: 'b'.repeat(64), ticket: 'private-relay-ticket', clientEndpointId: 'd'.repeat(64), relayUrls: ['https://relay.example'], relayToken: 'private-relay-use', relayTokenExpiresAt: Date.now() + 60000 };
  try {
    await expect(endpointConnector('https://private-expired.example', key, 'iroh', { ...locator, clientKey: 'c'.repeat(64), relayTokenExpiresAt: Date.now() - 1 })({})).rejects.toThrow(/expired/u);
    await expect(endpointConnector('https://private-missing-key.example', key, 'iroh', locator)({})).rejects.toThrow(/original local iroh key/u);
    expect(prepare).not.toHaveBeenCalled(); expect(sdk.iroh.mock.calls.length).toBe(before);
  } finally { stop(); }
});
