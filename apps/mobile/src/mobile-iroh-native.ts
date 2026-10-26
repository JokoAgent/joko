import { requireOptionalNativeModule } from 'expo';
import { Platform } from 'react-native';
import { LinkspanError, type LinkspanErrorCode } from '@jokoagent/linkspan-core';
import type { StreamBridge } from '@jokoagent/linkspan-core/stream';
import { linkspanNativeIrohSelected } from './linkspan-runtime-assets';

interface NativeIrohModule {
  isAvailable(): boolean;
  request(message: string): Promise<string>;
  dispose(): Promise<void>;
}
let active = false;
let foreground = true;
let generation = 0;
function nativeModule(): NativeIrohModule | undefined {
  try { return requireOptionalNativeModule<NativeIrohModule>('LinkspanIroh') ?? undefined; }
  catch { return undefined; }
}

export function mobileIrohNativeAvailable(): boolean {
  if (!linkspanNativeIrohSelected) return false;
  const version = String(Platform.Version).split('.').map(Number);
  const supported = Platform.OS === 'android' ? Number(Platform.Version) >= 24
    : Platform.OS === 'ios' && (version[0]! > 16 || version[0] === 16 && version[1]! >= 4);
  if (!supported) return false;
  try { return nativeModule()?.isAvailable() === true; } catch { return false; }
}

/** Only a selected native-capable app build may call the embedded module. */
export const mobileIrohNativeBridge: StreamBridge = {
  async request(message) {
    if (!foreground) throw new LinkspanError('closed', 'The native iroh connection is suspended.');
    if (!mobileIrohNativeAvailable()) throw new LinkspanError('unavailable', 'Native iroh is unavailable in this app build or OS. Select the relay mode explicitly.');
    const module = nativeModule()!;
    const occurrence = generation;
    const current = () => {
      if (!foreground || occurrence !== generation) throw new LinkspanError('closed', 'The original native iroh connection was suspended.');
    };
    active = true;
    let text: string;
    try { text = await module.request(JSON.stringify(message)); }
    catch { current(); throw new LinkspanError('transport_error', 'The native iroh module stopped. Reconnect on its original node.'); }
    current();
    if (typeof text !== 'string') throw new LinkspanError('protocol_error', 'The native iroh reply is invalid.');
    if (text.length > 1_048_576) throw new LinkspanError('resource_exhausted', 'The native iroh reply exceeded its boundary.');
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { throw new LinkspanError('protocol_error', 'The native iroh reply is invalid.'); }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new LinkspanError('protocol_error', 'The native iroh reply is invalid.');
    const value = parsed as Record<string, unknown>;
    if (value['success'] === true) return value['value'];
    const codes: readonly LinkspanErrorCode[] = ['invalid_argument', 'cancelled', 'deadline_exceeded', 'closed', 'transport_error', 'identity_mismatch', 'authentication_failed', 'protocol_error', 'resource_exhausted', 'unavailable', 'outcome_unknown'];
    throw new LinkspanError(codes.includes(value['code'] as LinkspanErrorCode) ? value['code'] as LinkspanErrorCode : 'transport_error', 'The native iroh connection failed. Check the original node invitation.');
  }
};

export function suspendMobileIrohNative(): void {
  foreground = false;
  generation++;
  if (!active) return;
  active = false;
  try { void nativeModule()?.dispose().catch(() => undefined); } catch { /* Native teardown may already have completed. */ }
}
export function resumeMobileIrohNative(): void { foreground = true; }
