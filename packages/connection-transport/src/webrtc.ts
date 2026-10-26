import { asLinkspanError, createOperationScope, LinkspanError, type ByteChannel, type CloseResult, type OperationOptions } from '@jokoagent/linkspan-core';
import { connectStreamBridge, createStreamBridgeHost, type StreamBridge, type StreamBridgeHost } from '@jokoagent/linkspan-core/stream';
import { endpointOrigin, isLoopbackEndpoint, normalizeEndpointPublicKey } from './trust.js';
import { createWebRtcPeer } from './webrtc-peer.js';

export const WEBRTC_DATA_LABEL = 'linkspan-http';
const MAXIMUM_SDP_BYTES = 65_536;

/** The fingerprint is supplied by the pinned Noise signaling endpoint. */
export function webRtcFingerprint(sdp: string): string {
  if (typeof sdp !== 'string' || new TextEncoder().encode(sdp).length > MAXIMUM_SDP_BYTES) throw new LinkspanError('protocol_error', 'The WebRTC description exceeds its boundary.');
  const values = sdp.split(/\r?\n/u).filter(line => line.startsWith('a=fingerprint:')).map(line => line.slice(14));
  if (values.length === 0 || values.some(value => !/^sha-256 (?:[a-f0-9]{2}:){31}[a-f0-9]{2}$/iu.test(value))
    || new Set(values.map(value => value.toUpperCase())).size !== 1) throw new LinkspanError('authentication_failed', 'Trusted signaling did not provide one complete SHA-256 WebRTC identity.');
  return values[0]!.slice(8).toUpperCase();
}

async function gather(peer: RTCPeerConnection, signal: AbortSignal): Promise<void> {
  if (peer.iceGatheringState === 'complete') return;
  const scope = createOperationScope({ signal, deadline: Date.now() + 10_000 });
  let check!: () => void;
  const ready = new Promise<void>(resolve => { check = () => { if (peer.iceGatheringState === 'complete') resolve(); }; peer.addEventListener('icegatheringstatechange', check); check(); });
  try { await scope.wait(ready); }
  finally { peer.removeEventListener('icegatheringstatechange', check); scope.dispose(); }
}

async function readAnswer(response: Response, signal: AbortSignal): Promise<{ type: 'answer'; sdp: string }> {
  if (!response.ok || response.body === null) {
    await response.body?.cancel().catch(() => undefined);
    throw new LinkspanError('unavailable', 'The node could not establish the selected WebRTC path.');
  }
  const reader = response.body.getReader(), parts: Uint8Array[] = []; let size = 0;
  const scope = createOperationScope({ signal });
  try {
    for (;;) {
      const part = await scope.wait(reader.read()); if (part.done) break;
      size += part.value.byteLength;
      if (size > MAXIMUM_SDP_BYTES) throw new LinkspanError('resource_exhausted', 'The WebRTC signaling reply exceeds its boundary.');
      parts.push(part.value);
    }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); scope.dispose(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw new LinkspanError('protocol_error', 'The WebRTC signaling reply is invalid.'); }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed) || Object.keys(parsed).join(',') !== 'answer') throw new LinkspanError('protocol_error', 'The WebRTC signaling reply is invalid.');
  const answer = (parsed as { answer?: unknown }).answer;
  if (answer === null || typeof answer !== 'object' || Array.isArray(answer) || Object.keys(answer).sort().join(',') !== 'sdp,type'
    || (answer as { type?: unknown }).type !== 'answer' || typeof (answer as { sdp?: unknown }).sdp !== 'string') throw new LinkspanError('protocol_error', 'The WebRTC signaling answer is invalid.');
  return answer as { type: 'answer'; sdp: string };
}

/** One authenticated HTTP request per RTC peer. Signaling carries no business key. */
export async function connectWebRtcEndpoint(input: OperationOptions & { readonly origin: string; readonly expectedPublicKey: string }): Promise<ByteChannel> {
  const origin = endpointOrigin(input.origin), expectedPublicKey = normalizeEndpointPublicKey(input.expectedPublicKey);
  if (new URL(origin).protocol !== 'https:' && !isLoopbackEndpoint(origin)) throw new LinkspanError('invalid_argument', 'WebRTC signaling requires HTTPS or the local loopback endpoint.');
  const scope = createOperationScope({ signal: input.signal, deadline: Math.min(input.deadline ?? Infinity, Date.now() + 15_000) });
  let peer: RTCPeerConnection | undefined;
  try {
    scope.check();
    const selected = await scope.wait(createWebRtcPeer({ iceServers: isLoopbackEndpoint(origin) ? [] : [{ urls: 'stun:stun.cloudflare.com:3478' }, { urls: 'stun:stun.l.google.com:19302' }] }).then(value => {
      if (scope.signal.aborted) value.close();
      return value;
    }));
    peer = selected;
    const dataChannel = selected.createDataChannel(WEBRTC_DATA_LABEL, { ordered: true });
    await scope.wait(selected.setLocalDescription(await scope.wait(selected.createOffer())));
    await gather(selected, scope.signal); scope.check();
    const sdp = selected.localDescription?.sdp;
    if (typeof sdp !== 'string') throw new LinkspanError('protocol_error', 'The local WebRTC description is unavailable.');
    webRtcFingerprint(sdp);
    const body = JSON.stringify({ offer: { type: 'offer', sdp } });
    if (new TextEncoder().encode(body).length > MAXIMUM_SDP_BYTES) throw new LinkspanError('resource_exhausted', 'The WebRTC signaling request exceeds its boundary.');
    const [{ connectWebSocket }, { createHttpFetch }, { openWebRtcChannel }] = await Promise.all([
      import('@jokoagent/linkspan-noise'), import('@jokoagent/linkspan-http'), import('@jokoagent/linkspan-webrtc')
    ]);
    scope.check();
    const endpoint = new URL('/_linkspan', origin); endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:';
    const secureFetch = createHttpFetch({ origin, connect: options => connectWebSocket({ ...options, url: endpoint.href, expectedPublicKey, allowInsecureWebSocket: endpoint.protocol === 'ws:' }) });
    const answer = await readAnswer(await scope.wait(secureFetch(`${origin}/_linkspan/webrtc`, { method: 'POST', body,
      headers: { 'content-type': 'application/json' }, redirect: 'error', cache: 'no-store', signal: scope.signal })), scope.signal);
    const expectedFingerprint = webRtcFingerprint(answer.sdp);
    await scope.wait(selected.setRemoteDescription(answer)); scope.check();
    const channel = await scope.wait(openWebRtcChannel({ peerConnection: selected, dataChannel, expectedFingerprint,
      ownsPeerConnection: true, signal: input.signal, deadline: Date.now() + 10_000 }));
    scope.check();
    return channel;
  } catch (error) { peer?.close(); throw asLinkspanError(error); }
  finally { scope.dispose(); }
}

/** The host is local trusted WebView code, never a public relay. */
export function createWebRtcBridgeHost(): StreamBridgeHost {
  return createStreamBridgeHost(async (args, options) => {
    if (args === null || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).sort().join(',') !== 'expectedPublicKey,origin') throw new LinkspanError('invalid_argument', 'The WebRTC bridge location is invalid.');
    const { origin, expectedPublicKey } = args as { origin: string; expectedPublicKey: string };
    const channel = await connectWebRtcEndpoint({ origin, expectedPublicKey, ...options });
    return { remoteEndpointId: normalizeEndpointPublicKey(expectedPublicKey), read: () => channel.receive(), write: bytes => channel.send(bytes), close: () => channel.close(), abort: reason => channel.abort(reason) };
  });
}

export async function connectWebRtcBridge(bridge: StreamBridge, origin: string, expectedPublicKey: string, options: OperationOptions): Promise<ByteChannel> {
  const carrier = await connectStreamBridge(bridge, { origin: endpointOrigin(origin), expectedPublicKey: normalizeEndpointPublicKey(expectedPublicKey) }, options);
  if (carrier.remoteEndpointId !== normalizeEndpointPublicKey(expectedPublicKey)) { carrier.abort(); throw new LinkspanError('identity_mismatch', 'The local WebRTC host did not confirm the expected node.'); }
  let finish!: (value: CloseResult) => void, ended = false;
  const closed = new Promise<CloseResult>(resolve => { finish = resolve; });
  const end = (error?: unknown) => { if (!ended) { ended = true; finish(error === undefined ? {} : { error: asLinkspanError(error) }); } };
  const abort = (reason?: unknown) => { end(reason ?? new LinkspanError('closed', 'The WebRTC bridge was closed.')); carrier.abort(reason); };
  const operation = async <T>(action: () => Promise<T>, parameters: OperationOptions = {}): Promise<T> => {
    const scope = createOperationScope(parameters);
    try { scope.check(); return await scope.wait(action()); } catch (error) { abort(error); throw asLinkspanError(error); } finally { scope.dispose(); }
  };
  return { closed, abort,
    send: (bytes, parameters) => operation(() => carrier.write(bytes), parameters),
    async receive(parameters) { const bytes = await operation(() => carrier.read(), parameters); if (bytes === null) end(); return bytes; },
    async close() { end(); await carrier.close(); }
  };
}
