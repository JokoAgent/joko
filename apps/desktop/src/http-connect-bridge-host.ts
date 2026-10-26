import { normalizeEndpointTransport } from '@joko/connection-transport/trust';
import { createStreamBridgeHost, type StreamBridgeHost } from '@jokoagent/linkspan-core/stream';
import { connectHttpConnectStream } from '@jokoagent/linkspan-http-connect/node';

/** Main owns proxy TCP/TLS; the trusted renderer authenticates the inner Noise
 * stream before its existing HTTP/RPC adapter can submit application data. */
export function createDesktopHttpConnectBridgeHost(): StreamBridgeHost {
  return createStreamBridgeHost(async (args, options) => {
    if (args === null || typeof args !== 'object' || Array.isArray(args)) throw new TypeError('Invalid HTTP CONNECT carrier.');
    const address = normalizeEndpointTransport({ ...args, kind: 'http-connect' });
    if (address.kind !== 'http-connect') throw new TypeError('Invalid HTTP CONNECT carrier.');
    const carrier = await connectHttpConnectStream({ proxyOrigin: address.proxyOrigin, authority: address.authority, ...options });
    return { remoteEndpointId: address.authority, read: () => carrier.read(), write: bytes => carrier.write(bytes),
      close: () => carrier.close(), abort: reason => carrier.abort(reason) };
  });
}
