import type { HttpConnectClientBinding } from '@joko/connection-transport/trust';
import { mobileHttpConnectNativeBridge } from './mobile-http-connect-native';

// Metro replaces this module with an unavailable stub when it is not selected.
export const connectMobileHttpConnect: HttpConnectClientBinding['connect'] = async (location, options) => {
  const [{ connectStreamBridge }, { negotiateHttpConnect }, { connectStream }] = await Promise.all([
    import('@jokoagent/linkspan-core/stream'), import('@jokoagent/linkspan-http-connect'), import('@jokoagent/linkspan-noise')
  ]);
  const raw = await connectStreamBridge(mobileHttpConnectNativeBridge, { proxyOrigin: location.proxyOrigin }, options);
  try {
    const carrier = await negotiateHttpConnect(raw, { authority: location.authority, ...options });
    return await connectStream(carrier, options);
  } catch (error) { raw.abort(error); throw error; }
};
