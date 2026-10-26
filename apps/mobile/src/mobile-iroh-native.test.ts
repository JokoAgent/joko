import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ platform: { OS: 'ios', Version: '16.4' as string | number }, module: undefined as undefined | { isAvailable: ReturnType<typeof vi.fn>; request: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> } }));
vi.mock('expo', () => ({ requireOptionalNativeModule: () => state.module }));
vi.mock('react-native', () => ({ Platform: state.platform }));
vi.mock('./linkspan-runtime-assets', () => ({ linkspanNativeIrohSelected: true, linkspanRuntimeAssets: {} }));
import { mobileIrohNativeAvailable, mobileIrohNativeBridge, resumeMobileIrohNative, suspendMobileIrohNative } from './mobile-iroh-native';
const message = { method: 'identity' as const, streamId: '0'.repeat(32) };
beforeEach(() => {
  state.platform.OS = 'ios'; state.platform.Version = '16.4';
  state.module = { isAvailable: vi.fn(() => true), request: vi.fn(async () => JSON.stringify({ success: true, value: { publicKey: 'a'.repeat(64) } })), dispose: vi.fn(async () => undefined) };
  resumeMobileIrohNative();
});
afterEach(() => { suspendMobileIrohNative(); });

it('requires both the native app capability and a supported OS, without loading a relay fallback', async () => {
  expect(mobileIrohNativeAvailable()).toBe(true);
  state.platform.Version = '16.3'; expect(mobileIrohNativeAvailable()).toBe(false);
  await expect(mobileIrohNativeBridge.request(message)).rejects.toMatchObject({ code: 'unavailable' });
  expect(state.module!.request).not.toHaveBeenCalled();
  state.platform.OS = 'android'; state.platform.Version = 24; expect(mobileIrohNativeAvailable()).toBe(true);
  state.platform.Version = 23; expect(mobileIrohNativeAvailable()).toBe(false);
  state.platform.Version = 24; state.module = undefined; expect(mobileIrohNativeAvailable()).toBe(false);
});

it('preserves safe native error codes and never returns a raw provider error or private locator', async () => {
  await expect(mobileIrohNativeBridge.request(message)).resolves.toEqual({ publicKey: 'a'.repeat(64) });
  state.module!.request.mockResolvedValueOnce(JSON.stringify({ success: false, code: 'identity_mismatch', message: 'PRIVATE-LOCATOR' }));
  const failure = await mobileIrohNativeBridge.request(message).catch(error => error as Error);
  expect(failure).toMatchObject({ code: 'identity_mismatch' }); expect(String(failure)).not.toContain('PRIVATE-LOCATOR');
  state.module!.request.mockRejectedValueOnce(new Error('PRIVATE-NATIVE-KEY'));
  await expect(mobileIrohNativeBridge.request(message)).rejects.toMatchObject({ code: 'transport_error', message: expect.not.stringContaining('PRIVATE-NATIVE-KEY') });
});

it('disposes the current native engine in the background and rejects late cleanup until the app resumes', async () => {
  await mobileIrohNativeBridge.request(message);
  const module = state.module!;
  suspendMobileIrohNative(); expect(module.dispose).toHaveBeenCalledOnce();
  await expect(mobileIrohNativeBridge.request({ method: 'abort', streamId: '1'.repeat(32) })).rejects.toMatchObject({ code: 'closed' });
  expect(module.request).toHaveBeenCalledOnce();
  resumeMobileIrohNative(); await mobileIrohNativeBridge.request(message); expect(module.request).toHaveBeenCalledTimes(2);
});

it('rejects a retired native reply after background and foreground replace the engine', async () => {
  let finish!: (value: string) => void;
  state.module!.request.mockImplementationOnce(() => new Promise<string>(resolve => { finish = resolve; }));
  const pending = mobileIrohNativeBridge.request(message);
  const retired = expect(pending).rejects.toMatchObject({ code: 'closed' });
  suspendMobileIrohNative(); resumeMobileIrohNative();
  await expect(mobileIrohNativeBridge.request(message)).resolves.toEqual({ publicKey: 'a'.repeat(64) });
  finish(JSON.stringify({ success: true, value: { publicKey: 'b'.repeat(64) } }));
  await retired;
});
