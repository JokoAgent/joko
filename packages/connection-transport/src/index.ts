import { createConnectTransport as createWebTransport, type ConnectTransportOptions } from '@connectrpc/connect-web';
import { endpointConnector } from './channel.js';
import { endpointOrigin, normalizeEndpointPublicKey, requireEndpointTrust, type EndpointTrust } from './trust.js';
export * from './trust.js';

export function createConnectionFetch(input: EndpointTrust): typeof globalThis.fetch {
  const origin = endpointOrigin(input.origin);
  const key = input.endpointPublicKey === undefined ? requireEndpointTrust(input) : normalizeEndpointPublicKey(input.endpointPublicKey);
  if (key === undefined) return (url, init) => {
    if (new URL(typeof url === 'string' || url instanceof URL ? url : url.url, origin).origin !== origin) throw new Error('The request endpoint changed.');
    return globalThis.fetch(url, { ...init, redirect: 'error' });
  };
  const connect = endpointConnector(origin, key, input.transportKind, input.endpointTransport);
  let loaded: Promise<typeof globalThis.fetch> | undefined;
  return async (url, init) => {
    const signal = init?.signal ?? (typeof Request !== 'undefined' && url instanceof Request ? url.signal : undefined);
    signal?.throwIfAborted();
    loaded ??= import('@jokoagent/linkspan-http').then(({ createHttpFetch }) => createHttpFetch({ origin, connect }));
    const fetcher = await loaded;
    signal?.throwIfAborted();
    return fetcher(url, init);
  };
}

export function createConnectTransport(options: ConnectTransportOptions & Omit<EndpointTrust, 'origin'>) {
  const { endpointPublicKey, transportKind, endpointTransport, serverId: _serverId, ...rest } = options;
  return createWebTransport({ ...rest, fetch: createConnectionFetch({ origin: options.baseUrl, endpointPublicKey, transportKind, endpointTransport }) });
}
