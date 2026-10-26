import { createClient } from '@connectrpc/connect';
import { ConnectionService } from '@joko/contracts';
import { LinkspanError } from '@jokoagent/linkspan-core';
import { expect, it, vi } from 'vitest';

const spies = vi.hoisted(() => ({ raw: vi.fn(() => { throw new Error('Unexpected raw Node transport.'); }), factory: vi.fn(), request: vi.fn() }));
vi.mock('@connectrpc/connect-node', async () => ({ ...await vi.importActual<typeof import('@connectrpc/connect-node')>('@connectrpc/connect-node'), createConnectTransport: spies.raw }));
vi.mock('@jokoagent/linkspan-http', () => ({ createHttpClient: spies.factory }));
import { createConnectTransport } from './node.js';
import { replaceEndpointTrust, trustedEndpointPublicKey } from './trust.js';

it('uses the verified universal HTTP client for Node RPC and never replaces it with raw HTTP', async () => {
  replaceEndpointTrust({ origin: 'https://node-pinned.example', endpointPublicKey: `ed25519:${'9'.repeat(64)}` });
  spies.factory.mockReturnValue(spies.request);
  spies.request.mockRejectedValue(new LinkspanError('identity_mismatch', 'The endpoint key did not match.'));
  const client = createClient(ConnectionService, createConnectTransport({ baseUrl: 'https://node-pinned.example',
    endpointPublicKey: `ed25519:${'6'.repeat(64)}`, httpVersion: '1.1',
    interceptors: [next => request => { request.header.set('authorization', 'Bearer test-only'); return next(request); }] }));
  await expect(client.getServerInfo({})).rejects.toThrow(/endpoint key/u);
  expect(spies.factory).toHaveBeenCalledOnce();
  expect(spies.request).toHaveBeenCalledOnce();
  expect(spies.request.mock.calls[0]![0].header.get('authorization')).toBe('Bearer test-only');
  expect(spies.raw).not.toHaveBeenCalled();
  expect(trustedEndpointPublicKey('https://node-pinned.example')).toBe(`ed25519:${'9'.repeat(64)}`);
});

it('preserves the selected private LAN HTTP mode without permitting public HTTP or remote HTTPS without trust', () => {
  const transport = {} as ReturnType<typeof createConnectTransport>;
  spies.raw.mockImplementationOnce(() => transport as never);
  expect(createConnectTransport({ baseUrl: 'http://192.168.20.50:4318', httpVersion: '1.1' })).toBe(transport);
  for (const baseUrl of ['http://203.0.113.20', 'http://169.254.169.254', 'https://untrusted-node.example']) {
    expect(() => createConnectTransport({ baseUrl, httpVersion: '1.1' })).toThrow(/trusted endpoint public key/u);
  }
  const calls = spies.raw.mock.calls.length;
  replaceEndpointTrust({ origin: 'http://192.168.20.51:4318', endpointPublicKey: `ed25519:${'8'.repeat(64)}` });
  createConnectTransport({ baseUrl: 'http://192.168.20.51:4318', httpVersion: '1.1' });
  expect(spies.raw.mock.calls).toHaveLength(calls);
});
