// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { createIrohClientIdentity, createTailcatClientIdentity, localHttpConnectClientBinding } from '@joko/connection-transport/trust';
import { installDesktopLinkspanBindings } from './desktop-linkspan-binding.js';
const factories = vi.hoisted(() => ({ iroh: vi.fn(), tailcat: vi.fn(), noise: vi.fn() }));
vi.mock('@jokoagent/linkspan-iroh/bridge', () => ({ createIrohBridgeClient: factories.iroh }));
vi.mock('@jokoagent/linkspan-tailcat/bridge', () => ({ createTailcatBridgeClient: factories.tailcat }));
vi.mock('@jokoagent/linkspan-noise', () => ({ connectStream: factories.noise }));

it('keeps CONNECT carrier replies separate from pinned Noise and aborts only its original stream after verification fails', async () => {
  const locator = { kind: 'http-connect' as const, proxyOrigin: 'https://proxy.example:8443', authority: 'desktop-connect.example:443' };
  const request = vi.fn(async (_kind: string, message: { method: string }) => ({ success: true as const, value: message.method === 'connect' ? { remoteEndpointId: locator.authority } : undefined }));
  const stop = installDesktopLinkspanBindings({ request }), options = { expectedPublicKey: `ed25519:${'c'.repeat(64)}` };
  const failure = new Error('Pinned Noise rejected this carrier.');
  factories.noise.mockRejectedValueOnce(failure);
  try {
    await expect(localHttpConnectClientBinding()!.connect(locator, options)).rejects.toBe(failure);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    const first = request.mock.calls[0]!;
    expect(first[0]).toBe('http-connect');
    expect(first[1]).toMatchObject({ method: 'connect', args: { proxyOrigin: locator.proxyOrigin, authority: locator.authority } });
    expect(JSON.stringify(first)).not.toContain(options.expectedPublicKey);
    expect(request.mock.calls[1]).toEqual(['http-connect', { method: 'abort', streamId: (first[1] as unknown as { streamId: string }).streamId }]);
    expect(factories.noise).toHaveBeenLastCalledWith(expect.objectContaining({ remoteEndpointId: locator.authority }), options);
  } finally { stop(); }
  expect(localHttpConnectClientBinding()).toBeUndefined();
});

it('registers Desktop bindings without loading a backend, then returns only the selected device public key', async () => {
  factories.iroh.mockImplementation(bridge => ({ createIrohIdentity: () => bridge.request({ method: 'identity', streamId: '0'.repeat(32) }) }));
  factories.tailcat.mockImplementation(bridge => ({ createTailcatIdentity: () => bridge.request({ method: 'identity', streamId: '0'.repeat(32) }) }));
  const request = vi.fn(async (kind: string) => ({ success: true as const, value: kind === 'iroh'
    ? { privateKey: '1'.repeat(64), publicKey: '2'.repeat(64) }
    : { privateKey: `privkey:${'3'.repeat(64)}`, publicKey: `nodekey:${'4'.repeat(64)}` } }));
  const stop = installDesktopLinkspanBindings({ request });
  try {
    expect(request).not.toHaveBeenCalled(); expect(factories.iroh).not.toHaveBeenCalled(); expect(factories.tailcat).not.toHaveBeenCalled();
    await expect(createIrohClientIdentity()).resolves.toEqual({ publicKey: '2'.repeat(64) });
    expect(factories.tailcat).not.toHaveBeenCalled();
    const locator = { kind: 'tailcat' as const, address: 'tcPrivate-node-address', endpointId: `nodekey:${'a'.repeat(64)}`, port: 4318 };
    await expect(createTailcatClientIdentity('https://desktop-private-key.example', `ed25519:${'b'.repeat(64)}`, locator)).resolves.toEqual({ publicKey: `nodekey:${'4'.repeat(64)}` });
    expect(request.mock.calls.map(call => call[0])).toEqual(['iroh', 'tailcat']);
    request.mockResolvedValueOnce({ success: false, code: 'identity_mismatch', message: 'PRIVATE-UPSTREAM-TEXT' } as never);
    const failure = await createIrohClientIdentity().catch(error => error as Error);
    expect(failure).toMatchObject({ code: 'identity_mismatch' }); expect(String(failure)).not.toContain('PRIVATE-UPSTREAM-TEXT');
  } finally { stop(); }
});
