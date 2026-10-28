import { createClient, type Interceptor } from '@connectrpc/connect';
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import { createConnectTransport, EndpointTrustError, normalizeEndpointPublicKey, requireEndpointTrust } from '@joko/connection-transport/node';
import { ConnectionService, DesktopVoiceConversationService, DesktopVoiceConversationAction, ControlDesktopVoiceConversationRequestSchema, ControlDesktopVoiceConversationResponseSchema } from '@joko/contracts';
import { DESKTOP_HOST_AUTHORIZATION_HEADER } from '@joko/contracts/desktop-bootstrap';
import type { DesktopManagedOrchestratorConnection } from './channels.js';

/** Only Main obtains the domain-separated bootstrap key. The top-level UI
 * exchanges generated message bytes; neither host nor Connection secrets cross IPC. */
export class DesktopVoiceConversationHost {
  #connection?: DesktopManagedOrchestratorConnection;
  #lifetime = new AbortController();
  readonly #windows = new Map<string, { readonly serverId: string; readonly sessionId: string; readonly sessionGeneration: bigint; readonly callId: string }>();
  constructor(readonly options: { readonly readAuthKey: (profileId: string) => Promise<string | undefined>;
    readonly readHostKey: (profileId: string) => Promise<string | undefined>;
    readonly dictationActive?: () => boolean;
    readonly isAuthorityCurrent: (connection: DesktopManagedOrchestratorConnection) => boolean | Promise<boolean> }) {}
  setConnection(connection: DesktopManagedOrchestratorConnection | undefined): void {
    if (JSON.stringify(connection) === JSON.stringify(this.#connection)) return;
    this.#lifetime.abort(); this.#lifetime = new AbortController(); this.#connection = connection; this.#windows.clear();
  }
  close(): void { this.setConnection(undefined); }
  get active(): boolean { return this.#windows.size > 0; }
  retireAll(): void { for (const id of this.#windows.keys()) this.retireWindow(id); }
  retireWindow(windowId: string): void {
    const original = this.#windows.get(windowId); this.#windows.delete(windowId);
    if (!original) return;
    const request = create(ControlDesktopVoiceConversationRequestSchema, { ...original, action: DesktopVoiceConversationAction.END });
    void this.request(original.serverId, windowId, toBinary(ControlDesktopVoiceConversationRequestSchema, request), () => {}).catch(() => undefined);
  }
  async request(serverId: string, windowId: string, bytes: Uint8Array, assertDocument: () => void): Promise<Uint8Array> {
    const connection = this.#connection, signal = this.#lifetime.signal;
    if (!connection || connection.serverId !== serverId || bytes.byteLength > 128 * 1024) throw new Error('Local voice host is unavailable.');
    const assertCurrent = async () => {
      signal.throwIfAborted(); assertDocument();
      if (connection !== this.#connection || !await this.options.isAuthorityCurrent(connection)) throw new Error('Local voice owner retired.');
    };
    await assertCurrent();
    const request = fromBinary(ControlDesktopVoiceConversationRequestSchema, bytes); request.windowId = windowId;
    if (request.action === DesktopVoiceConversationAction.START && this.options.dictationActive?.()) throw new Error('Dictation already owns audio.');
    if (request.action === DesktopVoiceConversationAction.START) this.#windows.set(windowId, { serverId, sessionId: request.sessionId, sessionGeneration: request.sessionGeneration, callId: request.callId });
    const endpointPublicKey = connection.endpointPublicKey === undefined ? requireEndpointTrust({ origin: connection.origin }) : normalizeEndpointPublicKey(connection.endpointPublicKey);
    const publicTransport = createConnectTransport({ baseUrl: connection.origin, endpointPublicKey, httpVersion: '1.1', defaultTimeoutMs: 5_000 });
    const identity = await createClient(ConnectionService, publicTransport).getServerInfo({}, { signal }); await assertCurrent();
    if (identity.server?.serverId !== serverId) throw new EndpointTrustError('Local voice node identity changed.');
    const auth = await this.options.readAuthKey(connection.profileId), host = await this.options.readHostKey(connection.profileId); await assertCurrent();
    if (!auth || !host) throw new Error('Local voice host authorization is unavailable.');
    const authorize: Interceptor = next => async input => {
      await assertCurrent(); input.header.set('authorization', `Bearer ${auth}`); input.header.set(DESKTOP_HOST_AUTHORIZATION_HEADER, `Bearer ${host}`);
      return next(input);
    };
    const client = createClient(DesktopVoiceConversationService, createConnectTransport({ baseUrl: connection.origin, endpointPublicKey,
      httpVersion: '1.1', defaultTimeoutMs: 65_000, interceptors: [authorize] }));
    const response = await client.controlDesktopVoiceConversation(request, { signal }); await assertCurrent();
    if (request.action === DesktopVoiceConversationAction.START && response.call?.callId === request.callId) this.#windows.set(windowId,
      { serverId, sessionId: request.sessionId, sessionGeneration: request.sessionGeneration, callId: request.callId });
    if (request.action === DesktopVoiceConversationAction.SNAPSHOT && !response.call) this.#windows.delete(windowId);
    if (request.action === DesktopVoiceConversationAction.END && this.#windows.get(windowId)?.callId === request.callId) this.#windows.delete(windowId);
    return toBinary(ControlDesktopVoiceConversationResponseSchema, response);
  }
}
