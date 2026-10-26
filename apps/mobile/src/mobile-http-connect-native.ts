import { requireOptionalNativeModule } from 'expo';
import { Platform } from 'react-native';
import { LinkspanError, type LinkspanErrorCode } from '@jokoagent/linkspan-core';
import type { StreamBridge } from '@jokoagent/linkspan-core/stream';
import { linkspanNativeHttpConnectSelected } from './linkspan-runtime-assets';

interface NativeModule {
  isAvailable(): boolean;
  request(message: string, generation: number): Promise<string>;
  dispose(generation: number): Promise<void>;
}
const codes: readonly LinkspanErrorCode[] = ['invalid_argument', 'cancelled', 'deadline_exceeded', 'closed', 'transport_error', 'identity_mismatch', 'authentication_failed', 'protocol_error', 'resource_exhausted', 'unavailable', 'outcome_unknown'];
let foreground = true, generation = 0, active = false;
let retirement: Promise<void> = Promise.resolve(), retirementFailed = false;
const pending = new Set<(error: Error) => void>();
function nativeModule(): NativeModule | undefined {
  try { return requireOptionalNativeModule<NativeModule>('LinkspanHttpConnect') ?? undefined; } catch { return undefined; }
}
export function mobileHttpConnectNativeAvailable(): boolean {
  if (!linkspanNativeHttpConnectSelected || retirementFailed || !['android', 'ios'].includes(Platform.OS)) return false;
  try { return nativeModule()?.isAvailable() === true; } catch { return false; }
}
const retired = () => new LinkspanError('closed', 'The original native proxy connection retired. Reconnect while the app is active.');

/** Raw proxy TCP/TLS only. CONNECT and Noise authentication run in trusted JS. */
export const mobileHttpConnectNativeBridge: StreamBridge = {
  async request(message) {
    if (!foreground) throw retired();
    if (!mobileHttpConnectNativeAvailable()) throw new LinkspanError('unavailable', 'The native proxy transport was not selected for this app build.');
    if (pending.size >= 256 || pending.size >= 224 && !['abort', 'close'].includes(message.method)) throw new LinkspanError('resource_exhausted', 'The native proxy runtime is busy.');
    const json = JSON.stringify(message);
    if (json.length > 800_000) throw new LinkspanError('resource_exhausted', 'The native proxy frame exceeds its boundary.');
    const occurrence = generation, module = nativeModule()!;
    active = true;
    return new Promise((resolve, reject) => {
      const fail = (error: Error) => { pending.delete(fail); reject(error); };
      pending.add(fail);
      void retirement.then(() => {
        if (!foreground || generation !== occurrence) throw retired();
        if (retirementFailed) throw new LinkspanError('unavailable', 'The original native proxy could not be retired. Restart the app before reconnecting.');
        return module.request(json, occurrence);
      }).then(text => {
        if (!foreground || generation !== occurrence) throw retired();
        if (typeof text !== 'string' || text.length > 800_000) throw new LinkspanError('protocol_error', 'The native proxy reply is invalid.');
        let parsed: unknown;
        try { parsed = JSON.parse(text); } catch { throw new LinkspanError('protocol_error', 'The native proxy reply is invalid.'); }
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new LinkspanError('protocol_error', 'The native proxy reply is invalid.');
        const value = parsed as Record<string, unknown>;
        if (value['success'] !== true) throw new LinkspanError(codes.includes(value['code'] as LinkspanErrorCode) ? value['code'] as LinkspanErrorCode : 'transport_error', 'The native proxy connection failed.');
        pending.delete(fail); resolve(value['value']);
      }).catch(error => fail(!foreground || generation !== occurrence ? retired() : error instanceof LinkspanError ? error
        : new LinkspanError('transport_error', 'The native proxy connection stopped.')));
    });
  }
};
export function suspendMobileHttpConnectNative(): void {
  foreground = false; generation++;
  for (const reject of [...pending]) reject(retired());
  if (!active && !linkspanNativeHttpConnectSelected) return;
  active = false;
  const module = nativeModule(), occurrence = generation;
  retirement = retirement.then(async () => { await module?.dispose(occurrence); }).catch(() => { retirementFailed = true; });
}
export function resumeMobileHttpConnectNative(): void { foreground = true; }
