import { createHash } from "node:crypto";
import type { AdapterContext } from "@joko/core";
import { inputHandoffPresentation, parseInputHandoffSubmission, type HandoffDriver, type InputHandoffDecision,
  type InputHandoffHolder, type InputHandoffPicture, type InputHandoffSnapshot, type InputHandoffSubmission } from "@joko/contracts";
import type { CredentialManager } from "../credential-manager.js";
import { AskpassHost, type AskpassHostDeps } from "./askpass/host.js";
import { InputHandoffService, type InputHandoffStartRequest, type TerminalPromptRequest } from "./service.js";
import type { LiveHandoffWindow } from "./session.js";

export interface InputHandoffTaskIdentity { readonly sessionId: string; readonly targetId: string; readonly generation: number }
export interface InputHandoffTaskScope extends InputHandoffTaskIdentity { readonly assertCurrent: () => void }
export interface InputHandoffOwner {
  readonly connectionId: string; readonly deviceId: string; readonly local?: true;
  readonly assertCurrent: () => void; readonly onRevoked?: (listener: () => void) => () => void;
}
export interface InputHandoffNativePort {
  createDriver(assertCurrent: () => void): { readonly driver: HandoffDriver; readonly hostPid: number } | null;
}
export interface InputHandoffCoordinatorOptions {
  readonly credentials: Pick<CredentialManager, "createUploadTicket" | "consumeServiceInput" | "retireServiceInput">;
  /** Captures owner, current Session/Target, generation and local/review policy. */
  readonly captureScope: (identity: InputHandoffTaskIdentity) => InputHandoffTaskScope;
  readonly isDisabledForSession: (sessionId: string) => Promise<boolean>;
  readonly native: InputHandoffNativePort;
  readonly continueAgent: (scope: InputHandoffTaskScope, requestId: string, metadata: string) => Promise<void>;
  readonly publish?: (sessionId: string, snapshot: InputHandoffSnapshot | undefined) => void;
  readonly notifyOwner?: (sessionId: string, snapshot: InputHandoffSnapshot) => void;
  readonly liveViewAvailable?: () => boolean;
  readonly describeDevice?: (deviceId: string) => Omit<InputHandoffHolder, "local" | "deviceId">;
  readonly askpass?: Pick<AskpassHostDeps, "platform" | "uid" | "probe" | "tmpRoot" | "baseEnv">;
}
interface LiveOwner { readonly owner: InputHandoffOwner; window?: LiveHandoffWindow; unlisten?: () => void }
interface RequestScope { readonly scope: InputHandoffTaskScope; native?: { readonly driver: HandoffDriver; readonly hostPid: number }; operationOwner?: () => void; liveOwners?: Map<string, LiveOwner> }
interface InputTicket { readonly requestId: string; readonly revision: number; readonly connectionId: string; readonly purpose: string; readonly digest: string; readonly expiresAt: number; readonly scope: InputHandoffTaskScope; unlisten?: () => void }

/** Values and native bindings remain process-local. Only owner-safe structure
 * is queried; continuation goes through the original durable task Queue. */
export class InputHandoffCoordinator {
  readonly #service: InputHandoffService;
  readonly #askpass: AskpassHost;
  readonly #sessions = new Map<string, RequestScope>();
  readonly #requests = new Map<string, RequestScope>();
  readonly #shellScopes = new Map<string, InputHandoffTaskScope>();
  readonly #tickets = new Map<string, InputTicket>();
  readonly #sweep: ReturnType<typeof setInterval>;
  #closed = false;
  constructor(readonly options: InputHandoffCoordinatorOptions) {
    this.#service = new InputHandoffService({
      createDriver: sessionId => this.#sessions.get(sessionId)?.native?.driver ?? null,
      hostPid: 0, hostPidFor: sessionId => this.#sessions.get(sessionId)?.native?.hostPid ?? 0,
      remoteInputAvailable: () => true,
      liveViewAvailable: options.liveViewAvailable,
      describeDevice: options.describeDevice,
      broadcast: (_channel, raw) => {
        const value = raw as { sessionId?: string; requestId?: string; request?: InputHandoffSnapshot };
        if (!value.sessionId) return;
        if (value.request) {
          const entry = this.#sessions.get(value.sessionId);
          if (entry && !this.#requests.has(value.request.requestId)) this.#requests.set(value.request.requestId, entry);
        }
        options.publish?.(value.sessionId, value.request);
      },
      notifyOwner: options.notifyOwner,
      onClosed: (_sessionId, requestId) => { this.#releaseLiveOwners(this.#requests.get(requestId)); this.#requests.delete(requestId); this.#retireRequestTickets(requestId); },
      continueAgent: async (_sessionId, requestId, metadata) => {
        const entry = this.#requests.get(requestId); if (!entry) return;
        this.#assert(entry.scope); await options.continueAgent(entry.scope, requestId, metadata); this.#assert(entry.scope);
      }
    });
    this.#askpass = new AskpassHost({ ...options.askpass, isDisabledForSession: options.isDisabledForSession,
      startTerminalPrompt: request => this.#startTerminal(request) });
    this.#sweep = setInterval(() => this.#purge(), 1_000); this.#sweep.unref();
  }
  async initialize(): Promise<void> { await this.#askpass.prepare(); }
  async start(identity: InputHandoffTaskIdentity, request: Omit<InputHandoffStartRequest, "sessionId">) {
    if (this.#service.hasPending(identity.sessionId)) return { ok: false as const, errorCode: "HANDOFF_ACTIVE", message: "An input handoff is already pending in this task." };
    const scope = this.options.captureScope(identity); this.#assert(scope);
    if (await this.options.isDisabledForSession(identity.sessionId).catch(() => true)) return { ok: false as const, errorCode: "DISABLED_BY_OWNER", message: "The owner disabled input handoff for this Partner." };
    this.#assert(scope);
    const entry: RequestScope = { scope };
    const native = this.options.native.createDriver(() => { this.#assert(scope); entry.operationOwner?.(); });
    if (native) entry.native = native;
    this.#sessions.set(scope.sessionId, entry);
    const result = this.#service.start({ ...request, sessionId: scope.sessionId });
    if (result.ok) this.#requests.set(result.requestId, entry); else if (this.#sessions.get(scope.sessionId) === entry) this.#sessions.delete(scope.sessionId);
    return result;
  }
  /** Called only by injected Adapter ports; never a model/client environment. */
  envFor(context: AdapterContext): Readonly<Record<string, string>> {
    if (this.#closed || context.hostedExecution || context.target.remoteWorkspace || context.runtimePolicy === "review_read_only") return {};
    const identity = { sessionId: context.sessionId, targetId: context.target.id, generation: context.generation };
    let scope: InputHandoffTaskScope | undefined;
    try { scope = this.options.captureScope(identity); } catch { /* Session is committed after native creation. */ }
    const assertCurrent = () => {
      if (this.#closed) throw new Error("Input handoff has closed.");
      scope ??= this.options.captureScope(identity);
      this.#assert(scope); this.#shellScopes.set(context.sessionId, scope);
    };
    return this.#askpass.envFor(context.sessionId, JSON.stringify(identity), assertCurrent);
  }
  list(sessionId: string): readonly InputHandoffSnapshot[] {
    this.#purge(); return this.#service.currentSnapshots(sessionId).filter(snapshot => {
      const entry = this.#requests.get(snapshot.requestId); if (!entry) return false;
      try { this.#assert(entry.scope); return true; } catch { return false; }
    });
  }
  taskSummaries(): readonly { readonly sessionId: string; readonly generation: number; readonly snapshot: InputHandoffSnapshot }[] {
    this.#purge();
    return [...this.#requests].flatMap(([requestId, entry]) => {
      try { this.#assert(entry.scope); } catch { return []; }
      const snapshot = this.#service.currentSnapshots(entry.scope.sessionId).find(value => value.requestId === requestId);
      return snapshot && !snapshot.terminal ? [{ sessionId: entry.scope.sessionId, generation: entry.scope.generation, snapshot }] : [];
    });
  }
  async decide(requestId: string, decision: InputHandoffDecision, owner: InputHandoffOwner): Promise<boolean> {
    owner.assertCurrent(); const entry = this.#request(requestId);
    if (entry.operationOwner) return false;
    const current = () => owner.assertCurrent(); entry.operationOwner = current;
    try { return await this.#service.resolve(requestId, decision, this.#actor(owner)); }
    finally { if (entry.operationOwner === current) delete entry.operationOwner; }
  }
  beginSubmission(requestId: string, revision: number, digest: string, owner: InputHandoffOwner) {
    owner.assertCurrent(); this.#purge(); const entry = this.#request(requestId), step = this.#step(requestId, revision, digest);
    this.#retireRequestTickets(requestId, owner.connectionId);
    const purpose = `input-handoff:${requestId}:${revision}`;
    const ticket = this.options.credentials.createUploadTicket({ kind: "header_secret", connectionId: owner.connectionId, maximumBytes: 65_536, servicePurpose: purpose });
    const captured: InputTicket = { requestId, revision, digest: presentationDigest(step), connectionId: owner.connectionId, purpose, expiresAt: ticket.expiresAt, scope: entry.scope };
    this.#tickets.set(ticket.credentialUploadTicketId, captured);
    try {
      captured.unlisten = owner.onRevoked?.(() => this.#retireTicket(ticket.credentialUploadTicketId, captured));
      owner.assertCurrent(); this.#assert(entry.scope); return ticket;
    } catch (error) { this.#retireTicket(ticket.credentialUploadTicketId, captured); throw error; }
  }
  async submit(requestId: string, revision: number, ticketId: string, owner: InputHandoffOwner): Promise<boolean> {
    owner.assertCurrent(); this.#purge(); const ticket = this.#tickets.get(ticketId);
    if (!ticket || ticket.requestId !== requestId || ticket.revision !== revision || ticket.connectionId !== owner.connectionId) return false;
    let submission: InputHandoffSubmission | undefined, entry: RequestScope | undefined;
    const current = () => owner.assertCurrent();
    try {
      entry = this.#request(requestId); this.#assert(ticket.scope); this.#step(requestId, revision, ticket.digest);
      if (entry.operationOwner) return false;
      entry.operationOwner = current;
      const raw = this.options.credentials.consumeServiceInput({ credentialUploadTicketId: ticketId, connectionId: owner.connectionId, kind: "header_secret", servicePurpose: ticket.purpose });
      submission = parseInputHandoffSubmission(JSON.parse(raw));
      if (submission.expectedRevision !== revision) return false;
      owner.assertCurrent(); this.#assert(ticket.scope);
      return await this.#service.submit(requestId, submission, this.#actor(owner));
    } finally {
      if (submission) for (const key of Object.keys(submission.values)) delete submission.values[key];
      if (entry?.operationOwner === current) delete entry.operationOwner;
      this.#retireTicket(ticketId, ticket);
    }
  }
  picture(requestId: string, revision: number, digest: string, owner: InputHandoffOwner): InputHandoffPicture | null {
    owner.assertCurrent(); this.#request(requestId); this.#step(requestId, revision, digest); return this.#service.picture(requestId, revision);
  }
  authorizeLiveView(requestId: string, revision: number, digest: string, owner: InputHandoffOwner): boolean {
    owner.assertCurrent(); const entry = this.#request(requestId), step = this.#step(requestId, revision, digest);
    if (!step.liveView || step.terminal || !entry.native) return false;
    entry.liveOwners ??= new Map(); entry.liveOwners.get(owner.deviceId)?.unlisten?.();
    const live: LiveOwner = { owner }; entry.liveOwners.set(owner.deviceId, live);
    live.unlisten = owner.onRevoked?.(() => { if (entry.liveOwners?.get(owner.deviceId) === live) entry.liveOwners.delete(owner.deviceId); });
    try { owner.assertCurrent(); this.#assert(entry.scope); return true; }
    catch (error) { live.unlisten?.(); if (entry.liveOwners.get(owner.deviceId) === live) entry.liveOwners.delete(owner.deviceId); throw error; }
  }
  async liveWindow(requestId: string, controllerDeviceId: string): Promise<LiveHandoffWindow | null> {
    const entry = this.#request(requestId), live = entry.liveOwners?.get(controllerDeviceId);
    if (!live || entry.operationOwner || !this.#service.isCurrent(requestId)) return null;
    const current = () => live.owner.assertCurrent(); current(); entry.operationOwner = current;
    try {
      const window = await this.#service.liveWindow(requestId); this.#request(requestId); current();
      if (entry.liveOwners?.get(controllerDeviceId) !== live || !window) return null;
      live.window = window; return window;
    } finally { if (entry.operationOwner === current) delete entry.operationOwner; }
  }
  isLiveViewCurrent(requestId: string, controllerDeviceId: string, windowId: number, processId: number): boolean {
    try {
      const live = this.#request(requestId).liveOwners?.get(controllerDeviceId); live?.owner.assertCurrent();
      return !!live?.window && live.window.windowId === windowId && live.window.pid === processId && this.#service.isCurrent(requestId);
    } catch { return false; }
  }
  isCurrent(requestId: string): boolean { try { this.#request(requestId); return this.#service.isCurrent(requestId); } catch { return false; } }
  liveViewEnded(requestId: string, controllerDeviceId?: string): void {
    const entry = this.#requests.get(requestId);
    if (controllerDeviceId && !entry?.liveOwners?.has(controllerDeviceId)) return;
    if (this.isCurrent(requestId)) this.#service.liveViewEnded(requestId);
  }
  cleanupSession(sessionId: string): void {
    this.#service.cleanupForSession(sessionId); this.#sessions.delete(sessionId); this.#shellScopes.delete(sessionId);
    for (const [id, entry] of this.#requests) if (entry.scope.sessionId === sessionId) { this.#releaseLiveOwners(entry); this.#retireRequestTickets(id); this.#requests.delete(id); }
  }
  async close(): Promise<void> {
    if (this.#closed) return; this.#closed = true; clearInterval(this.#sweep); this.#service.cleanupAll();
    for (const [id, ticket] of this.#tickets) this.#retireTicket(id, ticket);
    for (const entry of this.#requests.values()) this.#releaseLiveOwners(entry);
    this.#requests.clear(); this.#sessions.clear(); this.#shellScopes.clear(); await this.#askpass.close();
  }
  #startTerminal(request: TerminalPromptRequest) {
    const scope = this.#shellScopes.get(request.sessionId); if (!scope) return { ok: false as const };
    try { this.#assert(scope); } catch { return { ok: false as const }; }
    if (this.#service.hasPending(request.sessionId)) return { ok: false as const };
    const entry: RequestScope = { scope }; this.#sessions.set(request.sessionId, entry);
    const result = this.#service.startTerminalPrompt(request); if (result.ok) this.#requests.set(result.requestId, entry); return result;
  }
  #step(requestId: string, revision: number, digest: string): InputHandoffSnapshot {
    const step = this.#service.actionable(requestId, revision);
    if (!step || !/^[a-f0-9]{64}$/u.test(digest) || presentationDigest(step) !== digest) throw new Error("Input handoff presentation changed."); return step;
  }
  #request(id: string): RequestScope { const entry = this.#requests.get(id); if (!entry) throw new Error("Input handoff is unavailable."); this.#assert(entry.scope); return entry; }
  #assert(scope: InputHandoffTaskScope): void { if (this.#closed) throw new Error("Input handoff has closed."); scope.assertCurrent(); }
  #actor(owner: InputHandoffOwner): InputHandoffHolder { return owner.local ? { local: true } : { deviceId: owner.deviceId }; }
  #releaseLiveOwners(entry: RequestScope | undefined): void { for (const live of entry?.liveOwners?.values() ?? []) live.unlisten?.(); entry?.liveOwners?.clear(); }
  #retireRequestTickets(requestId: string, connectionId?: string): void { for (const [id, ticket] of this.#tickets) if (ticket.requestId === requestId && (connectionId === undefined || ticket.connectionId === connectionId)) this.#retireTicket(id, ticket); }
  #retireTicket(id: string, ticket: InputTicket): void {
    if (this.#tickets.get(id) !== ticket) return; this.#tickets.delete(id); ticket.unlisten?.();
    this.options.credentials.retireServiceInput({ credentialUploadTicketId: id, connectionId: ticket.connectionId, servicePurpose: ticket.purpose });
  }
  #purge(): void {
    for (const [id, ticket] of this.#tickets) { try { this.#assert(ticket.scope); if (ticket.expiresAt > Date.now()) continue; } catch {} this.#retireTicket(id, ticket); }
    for (const [sessionId, entry] of this.#sessions) { try { this.#assert(entry.scope); } catch { this.cleanupSession(sessionId); } }
  }
}
export function presentationDigest(snapshot: InputHandoffSnapshot): string { return createHash("sha256").update(JSON.stringify(inputHandoffPresentation(snapshot))).digest("hex"); }
