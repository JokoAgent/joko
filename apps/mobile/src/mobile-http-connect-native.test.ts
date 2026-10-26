import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ selected: true, platform: 'ios', module: undefined as undefined | {
  isAvailable: ReturnType<typeof vi.fn>; request: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn>
} }));
vi.mock('expo', () => ({ requireOptionalNativeModule: () => state.module }));
vi.mock('react-native', () => ({ Platform: { get OS() { return state.platform; } } }));
vi.mock('./linkspan-runtime-assets', () => ({ get linkspanNativeHttpConnectSelected() { return state.selected; } }));
let binding: typeof import('./mobile-http-connect-native');
const message = { method: 'connect' as const, streamId: 'a'.repeat(32), args: { proxyOrigin: 'https://proxy.example:8443' } };
beforeEach(async () => {
  vi.resetModules(); state.selected = true; state.platform = 'ios';
  state.module = { isAvailable: vi.fn(() => true), request: vi.fn(async () => JSON.stringify({ success: true, value: { remoteEndpointId: message.args.proxyOrigin } })), dispose: vi.fn(async () => undefined) };
  binding = await import('./mobile-http-connect-native');
});
afterEach(async () => { binding.suspendMobileHttpConnectNative(); await Promise.resolve(); await Promise.resolve(); });

it('requires the explicitly delivered native module and never substitutes a WebView or another transport', async () => {
  expect(binding.mobileHttpConnectNativeAvailable()).toBe(true);
  state.selected = false; expect(binding.mobileHttpConnectNativeAvailable()).toBe(false);
  await expect(binding.mobileHttpConnectNativeBridge.request(message)).rejects.toMatchObject({ code: 'unavailable' });
  expect(state.module!.request).not.toHaveBeenCalled();
  state.selected = true; state.platform = 'web'; expect(binding.mobileHttpConnectNativeAvailable()).toBe(false);
  state.platform = 'android'; state.module = undefined; expect(binding.mobileHttpConnectNativeAvailable()).toBe(false);
});

it('preserves stable native errors while hiding raw proxy diagnostics', async () => {
  await expect(binding.mobileHttpConnectNativeBridge.request(message)).resolves.toEqual({ remoteEndpointId: message.args.proxyOrigin });
  expect(state.module!.request).toHaveBeenCalledWith(JSON.stringify(message), 0);
  state.module!.request.mockResolvedValueOnce(JSON.stringify({ success: false, code: 'authentication_failed', message: 'PRIVATE-PROXY-SECRET' }));
  await expect(binding.mobileHttpConnectNativeBridge.request(message)).rejects.toMatchObject({ code: 'authentication_failed', message: expect.not.stringContaining('PRIVATE-PROXY-SECRET') });
  state.module!.request.mockRejectedValueOnce(new Error('PRIVATE-NATIVE-STACK'));
  await expect(binding.mobileHttpConnectNativeBridge.request(message)).rejects.toMatchObject({ code: 'transport_error', message: expect.not.stringContaining('PRIVATE-NATIVE-STACK') });
  state.module!.request.mockResolvedValueOnce('not JSON');
  await expect(binding.mobileHttpConnectNativeBridge.request(message)).rejects.toMatchObject({ code: 'protocol_error' });
});

it('rejects a background request immediately and ignores its late native reply after foreground resumes', async () => {
  let reply!: (value: string) => void;
  state.module!.request.mockImplementationOnce(() => new Promise<string>(resolve => { reply = resolve; }));
  const request = binding.mobileHttpConnectNativeBridge.request(message), rejected = expect(request).rejects.toMatchObject({ code: 'closed' });
  await vi.waitFor(() => expect(state.module!.request).toHaveBeenCalledOnce());
  binding.suspendMobileHttpConnectNative(); await rejected;
  await expect(binding.mobileHttpConnectNativeBridge.request(message)).rejects.toMatchObject({ code: 'closed' });
  binding.resumeMobileHttpConnectNative();
  reply(JSON.stringify({ success: true, value: { bytes: [99] } }));
  await expect(binding.mobileHttpConnectNativeBridge.request(message)).resolves.toEqual({ remoteEndpointId: message.args.proxyOrigin });
});

it('waits for the original native disposal before admitting a new foreground stream', async () => {
  await binding.mobileHttpConnectNativeBridge.request(message);
  let complete!: () => void;
  state.module!.dispose.mockImplementationOnce(() => new Promise<void>(resolve => { complete = resolve; }));
  binding.suspendMobileHttpConnectNative();
  await vi.waitFor(() => expect(state.module!.dispose).toHaveBeenCalledOnce());
  binding.resumeMobileHttpConnectNative();
  const next = binding.mobileHttpConnectNativeBridge.request({ ...message, streamId: 'b'.repeat(32) });
  await Promise.resolve(); expect(state.module!.request).toHaveBeenCalledOnce();
  complete(); await next; expect(state.module!.request).toHaveBeenCalledTimes(2);
});

it('refuses a replacement stream when native disposal failed', async () => {
  await binding.mobileHttpConnectNativeBridge.request(message);
  state.module!.dispose.mockRejectedValueOnce(new Error('PRIVATE-CLOSE-FAILURE'));
  binding.suspendMobileHttpConnectNative(); binding.resumeMobileHttpConnectNative();
  await expect(binding.mobileHttpConnectNativeBridge.request(message)).rejects.toMatchObject({ code: 'unavailable' });
  expect(state.module!.request).toHaveBeenCalledOnce();
});
