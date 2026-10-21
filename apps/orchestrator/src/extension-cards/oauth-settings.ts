import { randomUUID } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import { timestampFromMs } from "@bufbuild/protobuf/wkt";
import { ExtensionOAuthStateSchema, ExtensionOAuthFlowSchema, ExtensionAuthorizationPhase as Phase, ExtensionAuthorizationFailure as Failure } from "@joko/contracts";
import type { CredentialManager } from "../credential-manager.js";
import type { ExtensionCatalogManager } from "../extension-catalog.js";
import { ExtensionOAuthAccounts, ExtensionOAuthError, type ExtensionOAuthCapture } from "./oauth-accounts.js";
import type { ExtensionOAuthCallback, ExtensionOAuthOffer } from "./oauth-flow.js";

interface Owner { readonly connectionId: string; readonly assertCurrent: () => void; readonly onRevoked: (listener: () => void) => () => void }
interface Input { readonly capture: ExtensionOAuthCapture; readonly connectionId: string; readonly expiresAt: number }
interface Flow {
  readonly id: string; readonly capture: ExtensionOAuthCapture; readonly owner: Owner; readonly abort: AbortController;
  readonly expiresAt: number; readonly unsubscribe: () => void;
  phase: Phase; failure: Failure; offer?: ExtensionOAuthOffer; callback?: (value: ExtensionOAuthCallback) => void;
  inputTicket?: string; settledAt?: number; task: Promise<void>;
}
const CLIENT_PURPOSE = "extension-oauth-client";
const callbackPurpose = (id: string) => `extension-oauth-callback:${id}`;

/** Settings own protected inputs and original Connection lifetimes. No callback
 * code, client secret, access token or refresh token enters public RPC state. */
export class ExtensionOAuthSettings {
  readonly #inputs = new Map<string, Input>(); readonly #flows = new Map<string, Flow>();
  readonly #unsubscribe: () => void; #stopped = false;
  constructor(private readonly options: { readonly accounts: ExtensionOAuthAccounts; readonly credentials: CredentialManager; readonly catalog: ExtensionCatalogManager }) {
    this.#unsubscribe = options.catalog.onAuthorityChanged(() => {
      for (const flow of this.#flows.values()) if (active(flow)) {
        try { this.#assertFlow(flow); } catch { this.#cancel(flow, Failure.INVALID_CONFIG); }
      }
    });
  }
  get(extensionId: string) {
    const state = this.options.accounts.get(extensionId);
    return create(ExtensionOAuthStateSchema, { extensionId, revision: { value: state.revision }, slots: state.slots.map(slot => ({ ...slot,
      accounts: slot.accounts.map(({ id, status, createdAt, ...account }) => ({ ...account, accountId: id, expired: status === "expired", createdAt: timestampFromMs(createdAt) })) })) });
  }
  #capture(extensionId: string, key: string, revision: bigint) {
    if (this.#stopped) throw new ExtensionOAuthError("CANCELLED");
    this.#purge(); return this.options.accounts.capture(extensionId, key, revision);
  }
  beginClient(extensionId: string, key: string, revision: bigint, connectionId: string) {
    const capture = this.#capture(extensionId, key, revision);
    if (this.#inputs.size >= 64) throw new ExtensionOAuthError("INVALID_CONFIG");
    const ticket = this.options.credentials.createUploadTicket({ kind: "oauth", maximumBytes: 2_048, servicePurpose: CLIENT_PURPOSE, connectionId });
    this.#inputs.set(ticket.credentialUploadTicketId, { capture, connectionId, expiresAt: ticket.expiresAt }); return ticket;
  }
  async commitClient(extensionId: string, ticketId: string, owner: Owner) {
    this.#purge(); const input = this.#inputs.get(ticketId);
    if (!input || input.connectionId !== owner.connectionId || input.capture.extensionId !== extensionId) throw new ExtensionOAuthError("INVALID_CONFIG");
    try {
      owner.assertCurrent(); this.options.accounts.assertCurrent(input.capture);
      const value: unknown = JSON.parse(this.options.credentials.consumeServiceInput({ credentialUploadTicketId: ticketId, connectionId: owner.connectionId, kind: "oauth", servicePurpose: CLIENT_PURPOSE }));
      await this.options.accounts.setClient(input.capture, value, owner.assertCurrent); return this.get(extensionId);
    } finally { this.#inputs.delete(ticketId); this.options.credentials.retireServiceInput({ credentialUploadTicketId: ticketId, connectionId: owner.connectionId, servicePurpose: CLIENT_PURPOSE }); }
  }
  async change(extensionId: string, key: string, revision: bigint, action: { readonly kind: "remove" | "default"; readonly id: string } | { readonly kind: "clear" }, owner: Owner) {
    const capture = this.#capture(extensionId, key, revision); owner.assertCurrent();
    if (action.kind === "clear") await this.options.accounts.clearClient(capture, owner.assertCurrent);
    else await this.options.accounts.change(capture, action.id, action.kind, owner.assertCurrent);
    return this.get(extensionId);
  }
  start(extensionId: string, key: string, revision: bigint, scopes: readonly string[], owner: Owner) {
    const capture = this.#capture(extensionId, key, revision); owner.assertCurrent();
    if (this.#flows.size >= 64) throw new ExtensionOAuthError("INVALID_CONFIG");
    const id = randomUUID(), abort = new AbortController();
    const flow: Flow = { id, capture, owner, abort, expiresAt: Date.now() + 300_000, phase: Phase.PREPARING, failure: Failure.UNSPECIFIED,
      unsubscribe: owner.onRevoked(() => this.#cancel(flow, Failure.CANCELLED)), task: Promise.resolve() };
    this.#flows.set(id, flow);
    flow.task = this.options.accounts.connect(capture, { signal: abort.signal, assertCurrent: () => this.#assertFlow(flow), ...(scopes.length ? { scopes } : {}),
      authorize: async (offer, signal) => {
        this.#assertFlow(flow); flow.offer = offer; flow.phase = Phase.AUTHORIZING;
        return await new Promise<ExtensionOAuthCallback>((resolve, reject) => {
          const stop = () => reject(signal.reason);
          flow.callback = value => { signal.removeEventListener("abort", stop); resolve(value); };
          signal.addEventListener("abort", stop, { once: true });
          if (signal.aborted) stop();
        });
      }
    }).then(() => { this.#assertFlow(flow); flow.phase = Phase.COMPLETE; }, error => {
      flow.phase = Phase.FAILED; if (flow.failure === Failure.UNSPECIFIED) flow.failure = failure(error);
    }).finally(() => { flow.settledAt = Date.now(); delete flow.offer; delete flow.callback; flow.unsubscribe(); this.#retireCallback(flow); });
    // A late caller revocation cannot turn a fulfilled authorization into an
    // unhandled promise rejection or leave a controller callback waiting.
    flow.task = flow.task.catch(() => { flow.phase = Phase.FAILED; flow.failure = Failure.CANCELLED; });
    return this.#view(flow);
  }
  #assertFlow(flow: Flow): void {
    if (this.#stopped) throw new ExtensionOAuthError("CANCELLED");
    flow.abort.signal.throwIfAborted(); flow.owner.assertCurrent(); this.options.accounts.assertCurrent(flow.capture);
  }
  #owned(id: string, connectionId: string): Flow {
    this.#purge(); const flow = this.#flows.get(id);
    if (!flow || flow.owner.connectionId !== connectionId) throw new ExtensionOAuthError("INVALID_CONFIG");
    flow.owner.assertCurrent();
    if (active(flow)) this.#assertFlow(flow);
    return flow;
  }
  getFlow(id: string, connectionId: string) { return this.#view(this.#owned(id, connectionId)); }
  beginCallback(id: string, connectionId: string) {
    const flow = this.#owned(id, connectionId);
    if (flow.phase !== Phase.AUTHORIZING || !flow.offer || !flow.callback || flow.inputTicket) throw new ExtensionOAuthError("INVALID_CONFIG");
    const ticket = this.options.credentials.createUploadTicket({ kind: "oauth", maximumBytes: 12_288, connectionId, servicePurpose: callbackPurpose(id) });
    flow.inputTicket = ticket.credentialUploadTicketId; return ticket;
  }
  completeCallback(id: string, ticketId: string, connectionId: string) {
    const flow = this.#owned(id, connectionId);
    if (flow.phase !== Phase.AUTHORIZING || flow.inputTicket !== ticketId || !flow.offer || !flow.callback) throw new ExtensionOAuthError("INVALID_CONFIG");
    try {
      const value: unknown = JSON.parse(this.options.credentials.consumeServiceInput({ credentialUploadTicketId: ticketId, connectionId, kind: "oauth", servicePurpose: callbackPurpose(id) }));
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
      const input = value as Record<string, unknown>;
      if (Object.keys(input).some(key => !["state", "code", "error"].includes(key)) || input.state !== flow.offer.state
        || (typeof input.code === "string") === (typeof input.error === "string") || typeof input.code === "string" && (!input.code || input.code.length > 8_192)
        || typeof input.error === "string" && (!input.error || input.error.length > 256)) throw new Error();
      this.#assertFlow(flow); flow.phase = Phase.EXCHANGING;
      const callback = flow.callback; delete flow.callback; delete flow.offer;
      callback({ state: input.state as string, ...(typeof input.code === "string" ? { code: input.code } : { error: "access_denied" }) });
      return this.#view(flow);
    } catch { this.#cancel(flow, Failure.INVALID_CONFIG); throw new ExtensionOAuthError("INVALID_CONFIG"); }
    finally { this.#retireCallback(flow); }
  }
  cancelFlow(id: string, connectionId: string) { const flow = this.#owned(id, connectionId); if (active(flow)) this.#cancel(flow, Failure.CANCELLED); return this.#view(flow); }
  #retireCallback(flow: Flow) {
    if (!flow.inputTicket) return;
    this.options.credentials.retireServiceInput({ credentialUploadTicketId: flow.inputTicket, connectionId: flow.owner.connectionId, servicePurpose: callbackPurpose(flow.id) });
    delete flow.inputTicket;
  }
  #cancel(flow: Flow, code: Failure) {
    flow.phase = Phase.FAILED; flow.failure = code; delete flow.offer; delete flow.callback;
    flow.abort.abort(); this.#retireCallback(flow);
  }
  #view(flow: Flow) { return create(ExtensionOAuthFlowSchema, { flowId: flow.id, extensionId: flow.capture.extensionId, slotKey: flow.capture.key,
    phase: flow.phase, failure: flow.failure, expiresAt: timestampFromMs(flow.expiresAt), ...(flow.offer ? { authorization: { ...flow.offer, corsOrigins: [...flow.offer.corsOrigins], corsHosts: [...flow.offer.corsHosts] } } : {}) }); }
  #purge() {
    const now = Date.now();
    for (const [id, input] of this.#inputs) if (input.expiresAt <= now) {
      this.options.credentials.retireServiceInput({ credentialUploadTicketId: id, connectionId: input.connectionId, servicePurpose: CLIENT_PURPOSE }); this.#inputs.delete(id);
    }
    for (const [id, flow] of this.#flows) {
      if (active(flow) && flow.expiresAt <= now) this.#cancel(flow, Failure.TIMEOUT);
      if (flow.settledAt !== undefined && now - flow.settledAt >= 60_000) this.#flows.delete(id);
    }
  }
  async dispose() {
    if (this.#stopped) return; this.#stopped = true; this.#unsubscribe();
    for (const flow of this.#flows.values()) if (active(flow)) this.#cancel(flow, Failure.CANCELLED);
    await Promise.allSettled([...this.#flows.values()].map(flow => flow.task)); this.#flows.clear();
    for (const [id, input] of this.#inputs) this.options.credentials.retireServiceInput({ credentialUploadTicketId: id, connectionId: input.connectionId, servicePurpose: CLIENT_PURPOSE });
    this.#inputs.clear();
  }
}
function active(flow: Flow) { return flow.phase !== Phase.COMPLETE && flow.phase !== Phase.FAILED; }
function failure(error: unknown): Failure { return error instanceof ExtensionOAuthError ? Failure[error.code] : Failure.EXCHANGE_FAILED; }
