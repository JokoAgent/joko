import { mobileIrohNativeAvailable } from './mobile-iroh-native';
import { mobileHttpConnectNativeAvailable } from './mobile-http-connect-native';
import { linkspanRuntimeAssets, linkspanWebRtcRuntimeAssets } from './linkspan-runtime-assets';
import type { EndpointTransportKind } from '@joko/connection-transport/trust';

export function mobileEntrySupported(kind: EndpointTransportKind): boolean {
  return kind === 'https' || kind === 'webrtc' && linkspanWebRtcRuntimeAssets !== undefined
    || kind === 'iroh' && (mobileIrohNativeAvailable() || linkspanRuntimeAssets.iroh !== undefined)
    || kind === 'tailcat' && linkspanRuntimeAssets.tailcat !== undefined || kind === 'http-connect' && mobileHttpConnectNativeAvailable();
}
export function mobileEntryIrohMode(): 'native' | 'relay' {
  return linkspanRuntimeAssets.iroh === undefined && mobileIrohNativeAvailable() ? 'native' : 'relay';
}
