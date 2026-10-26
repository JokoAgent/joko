import { afterEach, describe, expect, it, vi } from 'vitest';
const spies = vi.hoisted(() => ({ connect: vi.fn(), factory: vi.fn(), fetcher: vi.fn() }));
vi.mock('@jokoagent/linkspan-noise', () => ({ connectWebSocket: spies.connect }));
vi.mock('@jokoagent/linkspan-http', () => ({ createHttpFetch: spies.factory }));
import { createConnectionFetch, createConnectTransport } from './index.js';
import { replaceEndpointTrust, trustedEndpointPublicKey } from './trust.js';

afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); });
describe('selected connection backend loading', () => {
  it('uses the explicitly selected restricted LAN HTTP path without initializing the secure backend', async () => {
    const direct = vi.fn(async () => new Response('restricted LAN'));
    vi.stubGlobal('fetch', direct);
    const fetcher = createConnectionFetch({ origin: 'http://192.168.14.20:4318' });
    expect(await (await fetcher('http://192.168.14.20:4318/joko.v1.ConnectionService/GetServerInfo')).text()).toBe('restricted LAN');
    expect(direct).toHaveBeenCalledWith('http://192.168.14.20:4318/joko.v1.ConnectionService/GetServerInfo', { redirect: 'error' });
    expect(spies.factory).not.toHaveBeenCalled();
    expect(spies.connect).not.toHaveBeenCalled();
    expect(() => fetcher('https://other.example/v1/blobs/upload/ticket')).toThrow(/endpoint changed/u);
  });

  it('keeps an explicitly captured owner pin independent of another owner in the process cache', async () => {
    const origin = 'https://native-recovery.example', oldKey = `ed25519:${'7'.repeat(64)}`, replacement = `ed25519:${'8'.repeat(64)}`;
    replaceEndpointTrust({ origin, endpointPublicKey: oldKey });
    spies.factory.mockImplementation((options: { connect: (options: {}) => Promise<unknown> }) => async () => {
      await options.connect({}); return new Response('verified');
    });
    spies.connect.mockResolvedValue({ closed: Promise.resolve({}) });
    await createConnectionFetch({ origin, endpointPublicKey: replacement })(`${origin}/v1/credentials/upload/test`);
    expect(spies.connect).toHaveBeenLastCalledWith(expect.objectContaining({ expectedPublicKey: replacement }));
    expect(trustedEndpointPublicKey(origin)).toBe(oldKey);
  });
  it('does not initialize a backend for a saved configuration or client factory', () => {
    const origin = 'https://lazy.example', endpointPublicKey = `ed25519:${'3'.repeat(64)}`;
    createConnectionFetch({ origin, endpointPublicKey });
    createConnectTransport({ baseUrl: origin, endpointPublicKey });
    expect(spies.factory).not.toHaveBeenCalled();
    expect(spies.connect).not.toHaveBeenCalled();
  });

  it('passes the captured endpoint pin to the backend only when the selected path is used', async () => {
    const origin = 'https://selected.example', endpointPublicKey = `ed25519:${'4'.repeat(64)}`;
    spies.factory.mockImplementation((options: { connect: (options: { signal?: AbortSignal }) => Promise<unknown> }) => async (_input: unknown, init?: RequestInit) => {
      await options.connect({ signal: init?.signal ?? undefined });
      return new Response('inside');
    });
    spies.connect.mockResolvedValue({ closed: Promise.resolve({}) });
    const direct = vi.fn(); vi.stubGlobal('fetch', direct);
    const fetcher = createConnectionFetch({ origin, endpointPublicKey });
    const response = await fetcher(`${origin}/v1/blobs/download/ticket/secret`);
    expect(await response.text()).toBe('inside');
    expect(spies.connect).toHaveBeenCalledWith(expect.objectContaining({ url: 'wss://selected.example/_linkspan', expectedPublicKey: endpointPublicKey }));
    expect(direct).not.toHaveBeenCalled();
  });

  it('does not fall back to plaintext when the authenticated backend fails', async () => {
    const direct = vi.fn(); vi.stubGlobal('fetch', direct);
    spies.factory.mockImplementation(() => async () => { throw new Error('identity mismatch'); });
    await expect(createConnectionFetch({ origin: 'https://rejected.example', endpointPublicKey: `ed25519:${'5'.repeat(64)}` })('https://rejected.example/joko.v1.EventService/GetSnapshot')).rejects.toThrow(/identity/u);
    expect(direct).not.toHaveBeenCalled();
  });
});
