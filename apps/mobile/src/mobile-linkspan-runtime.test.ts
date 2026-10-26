import { expect, it, vi } from 'vitest';
vi.mock('@joko/connection-transport/trust', () => ({ installEndpointTransportPreparation: vi.fn(), installHttpConnectClientBinding: vi.fn(), installIrohClientBinding: vi.fn(), installWebRtcClientBinding: vi.fn() }));
vi.mock('./mobile-iroh-native', () => ({ mobileIrohNativeAvailable: () => false, mobileIrohNativeBridge: { request: vi.fn() } }));
vi.mock('./mobile-http-connect-native', () => ({ mobileHttpConnectNativeBridge: { request: vi.fn() } }));
import { MobileLinkspanRuntime } from './mobile-linkspan-runtime';

it('loads only the requested native runtime and keeps locator secrets out of its public snapshot', async () => {
  const runtime = new MobileLinkspanRuntime();
  const request = { method: 'connect' as const, streamId: 'private-stream', args: { address: 'PRIVATE-PSK' } };
  const pending = runtime.request('tailcat', request);
  const [surface] = runtime.snapshot();
  expect(surface?.kind).toBe('tailcat');
  expect(JSON.stringify(runtime.snapshot())).not.toContain('PRIVATE-PSK');
  const send = vi.fn(), dispose = vi.fn(); runtime.ready(surface!, send, dispose);
  expect(send).toHaveBeenCalledWith(1, request);
  runtime.settle(surface!, 1, true, { connected: true });
  await expect(pending).resolves.toEqual({ connected: true });
  runtime.suspend(); expect(runtime.snapshot()).toEqual([]); expect(dispose).toHaveBeenCalledOnce();
});

it('retires pending streams on background and ignores replies from an old renderer occurrence', async () => {
  const runtime = new MobileLinkspanRuntime();
  const first = runtime.request('iroh', { method: 'connect', streamId: 'stream-a' });
  const rejected = expect(first).rejects.toThrow(/suspended/u);
  const [old] = runtime.snapshot(); runtime.suspend(); await rejected;
  await expect(runtime.request('iroh', { method: 'abort', streamId: 'stream-a' })).rejects.toThrow(/suspended/u);
  expect(runtime.snapshot()).toEqual([]); runtime.resume();
  const next = runtime.request('iroh', { method: 'connect', streamId: 'stream-b' });
  const [current] = runtime.snapshot();
  const oldSend = vi.fn(); runtime.ready(old!, oldSend);
  runtime.settle(old!, 2, true, { bytes: [99] });
  expect(oldSend).not.toHaveBeenCalled();
  runtime.ready(current!, () => {}); runtime.settle(current!, 2, true, { bytes: [1], done: false });
  await expect(next).resolves.toEqual({ bytes: [1], done: false });
  runtime.suspend();
});

it('retires the selected WebRTC engine with the original renderer on background', async () => {
  const runtime = new MobileLinkspanRuntime();
  const pending = runtime.request('webrtc', { method: 'connect', streamId: 'rtc-request', args: { origin: 'https://trusted.example', expectedPublicKey: 'private-pin-context' } });
  const rejected = expect(pending).rejects.toThrow(/suspended/u);
  const [surface] = runtime.snapshot(); expect(surface!.kind).toBe('webrtc');
  expect(JSON.stringify(runtime.snapshot())).not.toContain('private-pin-context');
  runtime.ready(surface!, () => {}, vi.fn()); runtime.suspend(); await rejected;
  expect(runtime.snapshot()).toEqual([]);
});

it('preserves only stable error codes and rejects oversized native frames', async () => {
  const runtime = new MobileLinkspanRuntime();
  await expect(runtime.request('iroh', { method: 'write', streamId: 'stream', args: 'secret'.repeat(200_000) })).rejects.toThrow(/large/u);
  expect(runtime.snapshot()).toEqual([]);
  const result = runtime.request('iroh', { method: 'connect', streamId: 'stream' });
  runtime.settle(runtime.snapshot()[0]!, 1, false, undefined, 'identity_mismatch');
  await expect(result).rejects.toMatchObject({ name: 'LinkspanError', code: 'identity_mismatch' });
  runtime.suspend();
});

it('retires requests when an attached or newly ready renderer cannot accept a message', async () => {
  const runtime = new MobileLinkspanRuntime();
  const queued = runtime.request('tailcat', { method: 'identity', streamId: '0'.repeat(32) });
  const rejected = expect(queued).rejects.toThrow(/renderer stopped/u);
  runtime.ready(runtime.snapshot()[0]!, () => { throw new Error('renderer missing'); });
  await rejected; expect(runtime.snapshot()).toEqual([]);
  const first = runtime.request('iroh', { method: 'connect', streamId: 'stream-one' });
  const [surface] = runtime.snapshot();
  let rendererPresent = true;
  runtime.ready(surface!, () => { if (!rendererPresent) throw new Error('renderer gone'); }); runtime.settle(surface!, 2, true, { done: true }); await first;
  runtime.ready(surface!, () => { throw new Error('cannot replace the live renderer'); });
  rendererPresent = false;
  const attached = runtime.request('iroh', { method: 'read', streamId: 'stream-two' });
  await expect(attached).rejects.toThrow(/renderer stopped/u);
  expect(runtime.snapshot()).toEqual([]);
  await expect(runtime.request('iroh', { method: 'abort', streamId: 'stream-one' })).resolves.toBeUndefined();
  await expect(runtime.request('iroh', { method: 'read', streamId: 'stream-one' })).rejects.toMatchObject({ code: 'closed' });
  expect(runtime.snapshot()).toEqual([]);
});
