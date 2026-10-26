import { compressionBrotli, compressionGzip, createConnectTransport as createNodeTransport, type ConnectTransportOptions } from '@connectrpc/connect-node';
import { createTransport } from '@connectrpc/connect/protocol-connect';
import { validateReadWriteMaxBytes } from '@connectrpc/connect/protocol';
import { endpointConnector } from './channel.js';
import './node-runtime.js';
import { endpointOrigin, normalizeEndpointPublicKey, requireEndpointTrust, type EndpointTrust } from './trust.js';
export * from './trust.js';

export function createConnectTransport(options: ConnectTransportOptions & Omit<EndpointTrust, 'origin'>) {
  const { endpointPublicKey, transportKind, endpointTransport, serverId: _serverId, ...rest } = options;
  const origin = endpointOrigin(options.baseUrl);
  const key = endpointPublicKey === undefined ? requireEndpointTrust({ origin, transportKind, endpointTransport }) : normalizeEndpointPublicKey(endpointPublicKey);
  if (key === undefined) return createNodeTransport(rest);
  const connect = endpointConnector(origin, key, transportKind, endpointTransport);
  let loaded: Promise<ReturnType<typeof import('@jokoagent/linkspan-http')['createHttpClient']>> | undefined;
  // The Node factory always creates its own HTTP client. Use the published
  // protocol transport so every business byte goes through the pinned channel.
  return createTransport({ ...rest,
    ...validateReadWriteMaxBytes(rest.readMaxBytes, rest.writeMaxBytes, rest.compressMinBytes),
    useBinaryFormat: rest.useBinaryFormat ?? true,
    interceptors: rest.interceptors ?? [],
    sendCompression: rest.sendCompression ?? null,
    acceptCompression: rest.acceptCompression ?? [compressionGzip, compressionBrotli],
    httpClient: async request => {
      request.signal?.throwIfAborted();
      loaded ??= import('@jokoagent/linkspan-http').then(({ createHttpClient }) => createHttpClient({ origin, connect }));
      const client = await loaded;
      request.signal?.throwIfAborted();
      return client(request);
    } });
}
