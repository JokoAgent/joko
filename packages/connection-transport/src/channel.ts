import type { ByteChannel, OperationOptions } from '@jokoagent/linkspan-core';
import { isPrivateLanDiscoveryHost } from '@joko/contracts';
import { captureEndpointTrustFailure, endpointOrigin, isLoopbackEndpoint } from './trust.js';
import { assertEndpointTransportReady, assertHttpConnectOrigin, localHttpConnectClientBinding, localIrohClientBinding, localTailcatClientBinding, localWebRtcClientBinding, normalizeEndpointTransport, prepareEndpointTransportRuntime, trustedEndpointTransport, type EndpointTransport, type EndpointTransportKind } from './endpoint-transport.js';

export function endpointConnector(origin: string, expectedPublicKey: string, transportKind?: EndpointTransportKind, privateLocator?: EndpointTransport): (options: OperationOptions) => Promise<ByteChannel> {
  const transport = privateLocator === undefined ? trustedEndpointTransport(origin, expectedPublicKey, transportKind) : normalizeEndpointTransport(privateLocator);
  const irohBinding = localIrohClientBinding();
  const tailcatBinding = localTailcatClientBinding();
  const webRtcBinding = localWebRtcClientBinding();
  const httpConnectBinding = localHttpConnectClientBinding();
  if (transport !== undefined && transportKind !== undefined && transport.kind !== transportKind) throw new Error('The private locator belongs to another connection transport.');
  if (transport?.kind === 'http-connect') assertHttpConnectOrigin(transport, origin);
  if (transport !== undefined) return async options => {
    options.signal?.throwIfAborted();
    const failed = captureEndpointTrustFailure({ origin, endpointPublicKey: expectedPublicKey });
    try {
      assertEndpointTransportReady(transport);
      if (transport.kind === 'http-connect') {
        const channel = httpConnectBinding === undefined
          ? await (await import('./http-connect.js')).connectHttpConnectEndpoint(transport, { ...options, expectedPublicKey })
          : await httpConnectBinding.connect(transport, { ...options, expectedPublicKey });
        void channel.closed.then(result => { if (result.error) failed(result.error); });
        return channel;
      }
      if (transport.kind === 'webrtc') {
        const channel = webRtcBinding === undefined
          ? await (await import('./webrtc.js')).connectWebRtcEndpoint({ origin, expectedPublicKey, ...options })
          : await webRtcBinding.connect(origin, expectedPublicKey, options);
        void channel.closed.then(result => { if (result.error) failed(result.error); });
        return channel;
      }
      await prepareEndpointTransportRuntime(transport.kind);
      options.signal?.throwIfAborted();
      const channel = transport.kind === 'iroh'
        ? irohBinding !== undefined ? await irohBinding.connect(transport, { ...options, expectedPublicKey })
        : await import('@jokoagent/linkspan-iroh').then(({ connectIroh }) => connectIroh({ ticket: transport.ticket, expectedEndpointId: transport.endpointId, expectedPublicKey,
          ...(transport.clientKey === undefined ? {} : { clientKey: transport.clientKey }), ...(transport.relayUrls === undefined ? {} : { relayUrls: transport.relayUrls }),
          ...(transport.relayToken === undefined ? {} : { relayToken: transport.relayToken, relayTokenExpiresAt: transport.relayTokenExpiresAt }), ...options }))
        : tailcatBinding !== undefined ? await tailcatBinding.connect(transport, { ...options, expectedPublicKey })
        : await import('@jokoagent/linkspan-tailcat').then(({ connectTailcat }) => connectTailcat({ address: transport.address, expectedEndpointId: transport.endpointId, port: transport.port, expectedPublicKey,
          ...(transport.clientKey === undefined ? {} : { clientKey: transport.clientKey }), ...(transport.derpMapUrl === undefined ? {} : { derpMapUrl: transport.derpMapUrl }), ...options }));
      void channel.closed.then(result => { if (result.error) failed(result.error); });
      return channel;
    } catch (error) { failed(error); throw error; }
  };
  const endpoint = new URL('/_linkspan', endpointOrigin(origin));
  const loopbackAlias = endpoint.hostname.toLowerCase().replace(/\.$/u, '').endsWith('.localhost');
  if (endpoint.protocol === 'http:' && !isLoopbackEndpoint(origin) && !isPrivateLanDiscoveryHost(endpoint.hostname) && !loopbackAlias) {
    throw new Error('HTTP carriers are limited to an explicitly selected loopback or private-LAN endpoint.');
  }
  endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:';
  return async options => {
    options.signal?.throwIfAborted();
    const { connectWebSocket } = await import('@jokoagent/linkspan-noise');
    options.signal?.throwIfAborted();
    const failed = captureEndpointTrustFailure({ origin, endpointPublicKey: expectedPublicKey });
    try {
      const channel = await connectWebSocket({ url: endpoint.href, expectedPublicKey,
        allowInsecureWebSocket: endpoint.protocol === 'ws:', ...options });
      void channel.closed.then(result => { if (result.error) failed(result.error); });
      return channel;
    } catch (error) { failed(error); throw error; }
  };
}
