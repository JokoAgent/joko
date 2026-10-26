import { installEndpointTransportPreparation, installHttpConnectClientBinding, installIrohClientBinding, installWebRtcClientBinding } from '@joko/connection-transport/trust';
import { LinkspanError, type LinkspanErrorCode } from '@jokoagent/linkspan-core';
import { mobileIrohNativeAvailable, mobileIrohNativeBridge } from './mobile-iroh-native';
import { linkspanRuntimeAssets, linkspanWebRtcRuntimeAssets } from './linkspan-runtime-assets';
import { connectMobileHttpConnect } from './mobile-http-connect-client';

export type MobileLinkspanBackend = 'iroh' | 'tailcat' | 'webrtc';
export interface MobileLinkspanSurface { readonly kind: MobileLinkspanBackend; readonly occurrence: number }
interface RuntimeRequest { readonly method: 'connect' | 'read' | 'write' | 'close' | 'abort' | 'identity'; readonly streamId: string; readonly args?: unknown }
interface Pending { readonly resolve: (value: unknown) => void; readonly reject: (error: Error) => void }
interface Surface {
  readonly view: MobileLinkspanSurface;
  readonly pending: Map<number, Pending>;
  send?: (id: number, request: RuntimeRequest) => void;
  dispose?: () => void;
  readonly waiting: Map<number, RuntimeRequest>;
  timer?: ReturnType<typeof setTimeout>;
}

/** Private RPC queues never enter the React snapshot or a diagnostics projection. */
export class MobileLinkspanRuntime {
  constructor(private readonly available: (kind: MobileLinkspanBackend) => boolean = () => true) {}
  readonly #surfaces = new Map<MobileLinkspanBackend, Surface>();
  readonly #listeners = new Set<() => void>();
  #snapshot: readonly MobileLinkspanSurface[] = [];
  #sequence = 0;
  #request = 0;
  #active = true;
  readonly subscribe = (listener: () => void): (() => void) => { this.#listeners.add(listener); return () => { this.#listeners.delete(listener); }; };
  readonly snapshot = (): readonly MobileLinkspanSurface[] => this.#snapshot;

  request(kind: MobileLinkspanBackend, request: RuntimeRequest): Promise<unknown> {
    if (!this.#active) return Promise.reject(new LinkspanError('closed', 'The native connection is suspended. Reconnect when the app is active.'));
    if (!this.available(kind)) return Promise.reject(new LinkspanError('unavailable', 'This relay runtime was not selected for this app build.'));
    if (!['connect', 'read', 'write', 'close', 'abort', 'identity'].includes(request.method) || typeof request.streamId !== 'string' || request.streamId.length < 1 || request.streamId.length > 256
      || request.method === 'identity' && (request.streamId !== '0'.repeat(32) || request.args !== undefined)) {
      return Promise.reject(new Error('The native connection request is invalid.'));
    }
    if (JSON.stringify(request).length > 1_048_576) return Promise.reject(new Error('The native connection frame is too large.'));
    let surface = this.#surfaces.get(kind);
    if (surface === undefined) {
      if (request.method === 'close' || request.method === 'abort') return Promise.resolve(undefined);
      if (request.method !== 'connect' && request.method !== 'identity') return Promise.reject(new LinkspanError('closed', 'The original native connection runtime was retired.'));
      surface = { view: { kind, occurrence: ++this.#sequence }, pending: new Map(), waiting: new Map() };
      this.#surfaces.set(kind, surface);
      const current = surface;
      current.timer = setTimeout(() => this.fail(current.view, 'The native connection runtime did not start.'), 30_000);
      this.#publish();
    }
    const control = request.method === 'abort' || request.method === 'close';
    if (surface.pending.size >= 512 || !control && surface.pending.size >= 384) return Promise.reject(new Error('The native connection runtime is busy.'));
    const id = ++this.#request, current = surface;
    return new Promise((resolve, reject) => {
      current.pending.set(id, { resolve, reject });
      if (current.send !== undefined) {
        try { current.send(id, request); }
        catch { this.fail(current.view, 'The native connection renderer stopped.'); }
      } else current.waiting.set(id, request);
    });
  }

  ready(view: MobileLinkspanSurface, send: (id: number, request: RuntimeRequest) => void, dispose?: () => void): void {
    const current = this.#current(view);
    if (current === undefined || current.send !== undefined) return;
    clearTimeout(current.timer); current.timer = undefined;
    current.send = send;
    current.dispose = dispose;
    for (const [id, request] of current.waiting) {
      try { send(id, request); }
      catch { this.fail(current.view, 'The native connection renderer stopped.'); return; }
    }
    current.waiting.clear();
  }

  settle(view: MobileLinkspanSurface, id: number, success: boolean, result?: unknown, code?: unknown): void {
    const current = this.#current(view), pending = current?.pending.get(id);
    if (pending === undefined) return;
    current!.pending.delete(id); current!.waiting.delete(id);
    if (success) pending.resolve(result); else {
      const codes: readonly LinkspanErrorCode[] = ['invalid_argument', 'cancelled', 'deadline_exceeded', 'closed', 'transport_error', 'identity_mismatch', 'authentication_failed', 'protocol_error', 'resource_exhausted', 'unavailable', 'outcome_unknown'];
      pending.reject(new LinkspanError(codes.includes(code as LinkspanErrorCode) ? code as LinkspanErrorCode : 'transport_error', 'The native secure connection failed. Reconnect using its original trusted invitation.'));
    }
  }

  fail(view: MobileLinkspanSurface, message = 'The native connection runtime stopped.'): void {
    const current = this.#current(view);
    if (current === undefined) return;
    this.#surfaces.delete(view.kind); clearTimeout(current.timer);
    try { current.dispose?.(); } catch { /* The renderer may already have terminated. */ }
    for (const pending of current.pending.values()) pending.reject(new Error(message));
    current.pending.clear(); current.waiting.clear(); current.send = undefined; current.dispose = undefined;
    this.#publish();
  }

  resume(): void { this.#active = true; }
  suspend(): void { this.#active = false; for (const current of [...this.#surfaces.values()]) this.fail(current.view, 'The native connection was suspended. Reconnect when the app is active.'); }
  #current(view: MobileLinkspanSurface): Surface | undefined { const surface = this.#surfaces.get(view.kind); return surface?.view.occurrence === view.occurrence ? surface : undefined; }
  #publish(): void { this.#snapshot = [...this.#surfaces.values()].map(surface => surface.view); for (const notify of this.#listeners) notify(); }
}

export const mobileLinkspanRuntime = new MobileLinkspanRuntime(kind => kind === 'webrtc' ? linkspanWebRtcRuntimeAssets !== undefined : linkspanRuntimeAssets[kind] !== undefined);
installHttpConnectClientBinding({ connect: connectMobileHttpConnect });
installWebRtcClientBinding({ async connect(origin, expectedPublicKey, options) {
  const { connectWebRtcBridge } = await import('@joko/connection-transport/webrtc');
  return connectWebRtcBridge({ request: message => mobileLinkspanRuntime.request('webrtc', message) }, origin, expectedPublicKey, options);
} });
const prepared = new Map<MobileLinkspanBackend, Promise<void>>();
const irohClients = new Map<'native' | 'relay', Promise<ReturnType<typeof import('@jokoagent/linkspan-iroh/bridge')['createIrohBridgeClient']>>>();
function irohClient(mode: 'native' | 'relay') {
  if (mode === 'native' && !mobileIrohNativeAvailable()) throw new LinkspanError('unavailable', 'Native iroh is unavailable in this app build or OS. Select relay mode explicitly.');
  let pending = irohClients.get(mode);
  if (pending === undefined) {
    pending = import('@jokoagent/linkspan-iroh/bridge').then(({ createIrohBridgeClient }) => createIrohBridgeClient(mode === 'native' ? mobileIrohNativeBridge : { request: message => mobileLinkspanRuntime.request('iroh', message) }));
    irohClients.set(mode, pending);
    void pending.catch(() => { if (irohClients.get(mode) === pending) irohClients.delete(mode); });
  }
  return pending;
}
installIrohClientBinding({
  async createIdentity(mode) { return (await irohClient(mode)).createIrohIdentity(); },
  async connect(transport, options) {
    if (transport.mobileMode !== 'native' && transport.relayUrls?.length === 0) throw new LinkspanError('unavailable', 'This invitation disables relays. Select an available native UDP mode explicitly.');
    return (await irohClient(transport.mobileMode ?? 'relay')).connectIroh({ ...options, ticket: transport.ticket, expectedEndpointId: transport.endpointId,
      ...(transport.clientKey === undefined ? {} : { clientKey: transport.clientKey }), ...(transport.relayUrls === undefined ? {} : { relayUrls: transport.relayUrls }),
      ...(transport.relayToken === undefined ? {} : { relayToken: transport.relayToken, relayTokenExpiresAt: transport.relayTokenExpiresAt }) });
  }
});
installEndpointTransportPreparation(kind => {
  if (kind === 'iroh') return Promise.resolve();
  let pending = prepared.get(kind);
  if (pending !== undefined) return pending;
  pending = import('@jokoagent/linkspan-tailcat/bridge').then(({ installTailcatBridge }) => { installTailcatBridge({ request: request => mobileLinkspanRuntime.request(kind, request) }); });
  prepared.set(kind, pending);
  void pending.catch(() => { if (prepared.get(kind) === pending) prepared.delete(kind); });
  return pending;
});
