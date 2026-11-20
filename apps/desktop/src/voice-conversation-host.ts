import { createClient, type Interceptor } from '@connectrpc/connect';
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import { createConnectTransport, EndpointTrustError, normalizeEndpointPublicKey, requireEndpointTrust } from '@joko/connection-transport/node';
import { ConnectionService, DesktopVoiceConversationService, DesktopVoiceConversationAction, ControlDesktopVoiceConversationRequestSchema, ControlDesktopVoiceConversationResponseSchema } from '@joko/contracts';
import { DESKTOP_HOST_AUTHORIZATION_HEADER } from '@joko/contracts/desktop-bootstrap';
import type { DesktopManagedOrchestratorConnection } from './channels.js';

interface WindowVoiceLease {
  readonly serverId: string;
  readonly sessionId: string;
  readonly sessionGeneration: bigint;
  readonly callId: string;
  readonly operationId: string;
  readonly playbackOnly: boolean;
  pending: boolean;
}

/** Only Main obtains the domain-separated bootstrap key. The top-level UI
 * exchanges generated message bytes; neither host nor Connection secrets cross IPC. */
export class DesktopVoiceConversationHost {
  #connection?: DesktopManagedOrchestratorConnection;
  #lifetime = new AbortController();
  readonly #windows = new Map<string, WindowVoiceLease>();
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
    const { sessionId, sessionGeneration, callId, operationId, playbackOnly } = original;
    const request = create(ControlDesktopVoiceConversationRequestSchema, {
      sessionId, sessionGeneration, callId, operationId, playbackOnly, action: DesktopVoiceConversationAction.END
    });
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
    const previous = this.#windows.get(windowId);
    const previousWasPending = previous?.pending === true;
    let starting: WindowVoiceLease | undefined;
    if (request.action === DesktopVoiceConversationAction.START) {
      if (this.options.dictationActive?.()) throw new Error('Dictation already owns audio.');
      starting = { serverId, sessionId: request.sessionId, sessionGeneration: request.sessionGeneration, callId: request.callId,
        operationId: request.operationId, playbackOnly: request.playbackOnly, pending: true };
      this.#windows.set(windowId, starting);
    }
    let offered = false;
    try {
      const endpointPublicKey = connection.endpointPublicKey === undefined ? requireEndpointTrust({ origin: connection.origin }) : normalizeEndpointPublicKey(connection.endpointPublicKey);
      const publicTransport = createConnectTransport({ baseUrl: connection.origin, endpointPublicKey, httpVersion: '1.1', defaultTimeoutMs: 5_000 });
      const identity = await createClient(ConnectionService, publicTransport).getServerInfo({}, { signal }); await assertCurrent();
      if (identity.server?.serverId !== serverId) throw new EndpointTrustError('Local voice node identity changed.');
      const auth = await this.options.readAuthKey(connection.profileId), host = await this.options.readHostKey(connection.profileId); await assertCurrent();
      if (!auth || !host) throw new Error('Local voice host authorization is unavailable.');
      const authorize: Interceptor = next => async input => {
        await assertCurrent(); input.header.set('authorization', `Bearer ${auth}`); input.header.set(DESKTOP_HOST_AUTHORIZATION_HEADER, `Bearer ${host}`);
        offered = true;
        return next(input);
      };
      const client = createClient(DesktopVoiceConversationService, createConnectTransport({ baseUrl: connection.origin, endpointPublicKey,
        httpVersion: '1.1', defaultTimeoutMs: 65_000, interceptors: [authorize] }));
      const response = await client.controlDesktopVoiceConversation(request, { signal }); await assertCurrent();
      if (previous && this.#windows.get(windowId) === previous && request.sessionId === previous.sessionId
        && request.sessionGeneration === previous.sessionGeneration) {
        if (request.action === DesktopVoiceConversationAction.SNAPSHOT && !response.call && !previousWasPending
          && (!request.callId || request.callId === previous.callId)) this.#windows.delete(windowId);
        if (request.action === DesktopVoiceConversationAction.END && previous.callId === request.callId) this.#windows.delete(windowId);
      }
      return toBinary(ControlDesktopVoiceConversationResponseSchema, response);
    } finally {
      if (starting) {
        starting.pending = false;
        if (!offered && this.#windows.get(windowId) === starting) this.#windows.delete(windowId);
      }
    }
  }
}
