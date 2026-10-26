import { installHttpConnectClientBinding, installIrohClientBinding, installTailcatClientBinding } from '@joko/connection-transport/trust';
import type { LinkspanErrorCode } from '@jokoagent/linkspan-core';
import type { StreamBridge } from '@jokoagent/linkspan-core/stream';

export function installDesktopLinkspanBindings(api: JokoDesktopApi['linkspan'] = window.jokoDesktop?.linkspan): () => void {
  if (api === undefined) return () => {};
  const bridge = (kind: 'iroh' | 'tailcat' | 'http-connect'): StreamBridge => ({
    async request(message) {
      const { LinkspanError } = await import('@jokoagent/linkspan-core');
      let reply: unknown;
      try { reply = await api.request(kind, message); }
      catch { throw new LinkspanError('transport_error', 'The original Desktop connection host stopped.'); }
      if (reply !== null && typeof reply === 'object' && !Array.isArray(reply)) {
        const value = reply as Record<string, unknown>;
        if (value['success'] === true) return value['value'];
        const codes: readonly LinkspanErrorCode[] = ['invalid_argument', 'cancelled', 'deadline_exceeded', 'closed', 'transport_error', 'identity_mismatch', 'authentication_failed', 'protocol_error', 'resource_exhausted', 'unavailable', 'outcome_unknown'];
        if (value['success'] === false && codes.includes(value['code'] as LinkspanErrorCode)) throw new LinkspanError(value['code'] as LinkspanErrorCode, 'The Desktop secure connection failed.');
      }
      throw new LinkspanError('protocol_error', 'The Desktop secure connection reply is invalid.');
    }
  });
  let iroh: Promise<ReturnType<typeof import('@jokoagent/linkspan-iroh/bridge')['createIrohBridgeClient']>> | undefined;
  let tailcat: Promise<ReturnType<typeof import('@jokoagent/linkspan-tailcat/bridge')['createTailcatBridgeClient']>> | undefined;
  const irohClient = () => iroh ??= import('@jokoagent/linkspan-iroh/bridge').then(({ createIrohBridgeClient }) => createIrohBridgeClient(bridge('iroh')));
  const tailcatClient = () => tailcat ??= import('@jokoagent/linkspan-tailcat/bridge').then(({ createTailcatBridgeClient }) => createTailcatBridgeClient(bridge('tailcat')));
  const stopIroh = installIrohClientBinding({
    async createIdentity() { return (await irohClient()).createIrohIdentity(); },
    async connect(transport, options) { return (await irohClient()).connectIroh({ ...options, ticket: transport.ticket, expectedEndpointId: transport.endpointId,
      ...(transport.clientKey === undefined ? {} : { clientKey: transport.clientKey }), ...(transport.relayUrls === undefined ? {} : { relayUrls: transport.relayUrls }),
      ...(transport.relayToken === undefined ? {} : { relayToken: transport.relayToken, relayTokenExpiresAt: transport.relayTokenExpiresAt }) }); }
  });
  const stopTailcat = installTailcatClientBinding({
    async createIdentity() { return (await tailcatClient()).createTailcatIdentity(); },
    async connect(transport, options) { return (await tailcatClient()).connectTailcat({ ...options, address: transport.address, expectedEndpointId: transport.endpointId, port: transport.port,
      ...(transport.clientKey === undefined ? {} : { clientKey: transport.clientKey }), ...(transport.derpMapUrl === undefined ? {} : { derpMapUrl: transport.derpMapUrl }) }); }
  });
  const stopHttpConnect = installHttpConnectClientBinding({
    async connect(transport, options) {
      const [{ connectStreamBridge }, { connectStream }] = await Promise.all([
        import('@jokoagent/linkspan-core/stream'), import('@jokoagent/linkspan-noise')
      ]);
      const carrier = await connectStreamBridge(bridge('http-connect'), { proxyOrigin: transport.proxyOrigin, authority: transport.authority }, options);
      try { return await connectStream(carrier, options); }
      catch (error) { carrier.abort(error); throw error; }
    }
  });
  return () => { stopIroh(); stopTailcat(); stopHttpConnect(); };
}
