import { assertProviderGroupConfig, groupKey, type ProviderGroupConfig, type ProviderGroupKey, type ProviderGroupMember, type ProviderGroupSnapshot } from "@joko/store";
import type { SessionRuntimeProfile } from "./session-runtime-control.js";
import { ProviderGroupRouter, type ProviderGroupAssignment, type ProviderGroupPick } from "./provider-group-router.js";
import { decideProviderGroupFailure, describeProviderGroupFailure, providerGroupFailureSignals, PROVIDER_GROUP_SUPERSEDED_ERROR,
  ProviderGroupUnavailableError, type ProviderGroupFailureSignals } from "./provider-group-failure-policy.js";
import type { ProviderSharingDirectoryPort, ProviderSharingRecipient } from "./provider-sharing-ports.js";

export interface ProviderGroupSession {
  readonly sessionId: string; readonly profile: SessionRuntimeProfile; readonly agentKind: string;
  readonly logicalModelId?: string; readonly eligible: boolean; readonly dispatchUnknown: boolean;
}
export interface ProviderGroupRecoveryLease {
  isCurrent(): boolean;
}
export interface ProviderGroupSessionPort {
  read(sessionId: string): ProviderGroupSession | undefined;
  /** This must perform and adopt the existing native runtime handoff. A staged
   * intent alone is not a successful switch and must not commit the binding. */
  handoff(sessionId: string, profile: SessionRuntimeProfile, options: {
    readonly isCurrent: () => boolean; readonly beforeSend: boolean; readonly fresh?: boolean;
  }): Promise<"committed" | "unknown">;
  continue(sessionId: string, lease: ProviderGroupRecoveryLease, options: {
    readonly cause: string; readonly switched: boolean; readonly isCurrent: () => boolean;
  }): Promise<void>;
  status(sessionId: string, value: "switching" | "idle" | "unavailable"): void;
}
export interface ProviderGroupServiceOptions {
  readonly router: ProviderGroupRouter; readonly sessions: ProviderGroupSessionPort;
  readonly sharing?: ProviderSharingDirectoryPort;
  readonly ownedRecipients?: (group: ProviderGroupKey) => readonly ProviderSharingRecipient[];
  readonly sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  readonly log?: (event: Readonly<Record<string, unknown>>) => void;
}
export interface ProviderGroupStartInput {
  readonly sessionId: string; readonly profile: SessionRuntimeProfile; readonly agentKind: string;
  readonly logicalModelId?: string; readonly group?: ProviderGroupKey;
}
/** One owner runtime supplies management, task routing and failure handling.
 * There is no inference endpoint and no second native-history implementation. */
export class ProviderGroupService {
  readonly #epochs = new Map<string, number>();
  readonly #locks = new Map<string, Promise<unknown>>();
  readonly #reconnects = new Map<string, Map<string, { used: number; at: number }>>();
  readonly #closed = new AbortController();
  constructor(readonly options: ProviderGroupServiceOptions) {}
  get router(): ProviderGroupRouter { return this.options.router; }
  snapshot(group: ProviderGroupKey): ProviderGroupSnapshot { return this.router.store.snapshot(group); }
  list(): readonly ProviderGroupSnapshot[] { return this.router.store.list(); }
  async reconcileSharing(signal: AbortSignal): Promise<void> {
    const groups = new Map([...this.router.store.pendingCleanup(), ...this.router.store.list()].map(group => [groupKey(group), group]));
    for (const group of groups.values()) await this.#syncReshares(group, [], group.config?.members ?? [], signal);
  }
  async candidates(group: ProviderGroupKey, signal: AbortSignal): Promise<ReturnType<ProviderGroupRouter["directory"]["candidates"]>> {
    await this.router.directory.refresh(signal); return this.router.directory.candidates(group);
  }
  async update(group: ProviderGroupKey, config: ProviderGroupConfig | undefined, expectedRevision: bigint, signal: AbortSignal): Promise<ProviderGroupSnapshot> {
    if (config !== undefined) assertProviderGroupConfig(config);
    const previous = this.snapshot(group);
    if (config?.members.length) {
      const candidates = await this.candidates(group, signal);
      for (const member of config.members) {
        const actual = candidates.find(candidate => candidate.key === member.key);
        if (!actual || actual.backendId !== member.backendId || actual.nativeBackendId !== member.nativeBackendId || actual.providerId !== member.providerId || actual.nodeId !== member.nodeId || actual.kind !== member.kind
          || JSON.stringify(actual.received) !== JSON.stringify(member.received)) throw new Error("A Provider group member no longer matches its authorized source.");
        actual.assertCurrent();
      }
    }
    signal.throwIfAborted(); const snapshot = this.router.store.update(group, config, expectedRevision);
    // Configuration and release markers are already durable. Failures in the
    // original issuer's reshare bookkeeping must not resurrect removed members.
    await this.#syncReshares(group, previous.config?.members ?? [], snapshot.config?.members ?? [], signal).catch(() => {});
    return snapshot;
  }
  async assignBeforeStart(input: ProviderGroupStartInput, signal: AbortSignal): Promise<ProviderGroupAssignment | undefined> {
    if (this.router.store.bindingRecord(input.sessionId)?.released) return undefined;
    const group = input.group ?? { backendId: input.profile.backendId, providerId: input.profile.providerId };
    await this.router.prepare(group, this.#signal(signal));
    if (!this.snapshot(group).config) return undefined;
    return this.router.pick({ ...input, group, modelId: input.profile.modelId, ownTask: true }, this.#signal(signal));
  }
  async nextAfterStartFailure(input: ProviderGroupStartInput, previous: ProviderGroupAssignment, error: unknown, signal: AbortSignal): Promise<ProviderGroupAssignment | undefined> {
    const signals = providerGroupFailureSignals(error), decision = decideProviderGroupFailure(signals, "start");
    this.options.log?.(describeProviderGroupFailure(signals, decision)); previous.release();
    if (decision.action !== "switch" || !this.snapshot(previous.group).config?.autoSwitch) return undefined;
    this.router.markTried(input.sessionId, previous.member.key); this.router.cool(previous.group, previous.member, previous.profile.modelId, signals, decision);
    if (decision.connection && await this.#recoverConnection(input.sessionId, previous.group, previous.member, input, decision.connection, () => true, this.#signal(signal))) {
      // A failed start has no committed native effect; use a new exact selection
      // of this same recovered member, without widening the attempted set.
      this.router.unmarkTried(input.sessionId, previous.member.key);
    }
    return this.router.pick({ ...input, group: previous.group, modelId: input.profile.modelId, ownTask: true, fresh: true }, this.#signal(signal));
  }
  async resolveSwitchTarget(sessionId: string, group: ProviderGroupKey, profile: SessionRuntimeProfile, signal: AbortSignal): Promise<ProviderGroupAssignment> {
    const session = this.options.sessions.read(sessionId); if (!session?.eligible || session.dispatchUnknown) throw new ProviderGroupUnavailableError();
    return this.router.pick({ sessionId, group, profile, agentKind: session.agentKind, modelId: profile.modelId, ownTask: true,
      ...(session.logicalModelId === undefined ? {} : { logicalModelId: session.logicalModelId }), fresh: true }, this.#signal(signal));
  }
  beforeSend(sessionId: string, signal: AbortSignal): Promise<void> {
    return this.#serialize(sessionId, async () => {
      const session = this.options.sessions.read(sessionId); if (!session?.eligible) return;
      if (session.dispatchUnknown) throw unknownEffect();
      const existing = this.router.store.binding(sessionId);
      if (existing) await this.router.prepare(existing.group, this.#signal(signal));
      const binding = this.router.store.binding(sessionId);
      if (!binding) {
        // Explicitly released tasks are not implicitly adopted on a later send.
        if (this.router.store.bindingRecord(sessionId)?.released) return;
        const prepared = await this.assignBeforeStart(session, signal); if (!prepared) return;
        try { await this.#adopt(sessionId, prepared, true, this.#current(sessionId), signal); } finally { prepared.release(); }
        return;
      }
      const group = this.snapshot(binding.group); if (!group.config) return;
      const member = group.config.members.find(member => member.key === binding.memberKey); if (!member) return;
      const request = this.#request(session, true), status = await this.router.readMember(binding.group, member, request, this.#signal(signal));
      const cooling = this.router.store.cooling(binding.group, this.router.now()).some(row => row.memberKey === member.key && (row.modelId === undefined || row.modelId === status.model?.modelId));
      if (status.available && !cooling) {
        status.assertCurrent(); return;
      }
      if (!group.config.autoSwitch) throw new ProviderGroupUnavailableError();
      const current = this.#current(sessionId);
      if (!status.reachable && await this.#recoverConnection(sessionId, binding.group, member, session, "check", current, this.#signal(signal))) return;
      this.router.markTried(sessionId, member.key);
      await this.#switchCandidates(session, binding.group, current, true, this.#signal(signal));
    });
  }
  mayHandleTurnError(sessionId: string, signals: ProviderGroupFailureSignals): boolean {
    const session = this.options.sessions.read(sessionId), binding = this.router.store.binding(sessionId);
    return session?.eligible === true && !session.dispatchUnknown && binding !== undefined && this.snapshot(binding.group).config?.autoSwitch === true
      && decideProviderGroupFailure(signals, "run").action === "switch";
  }
  onTurnError(sessionId: string, signals: ProviderGroupFailureSignals, lease: ProviderGroupRecoveryLease, signal: AbortSignal): Promise<boolean> {
    return this.#serialize(sessionId, async () => {
      if (!this.mayHandleTurnError(sessionId, signals)) return false;
      const session = this.options.sessions.read(sessionId)!, binding = this.router.store.binding(sessionId)!;
      const group = this.snapshot(binding.group), member = group.config?.members.find(row => row.key === binding.memberKey);
      if (!member) return false;
      const decision = decideProviderGroupFailure(signals, "run"); if (decision.action !== "switch") return false;
      const current = this.#current(sessionId, lease), combined = this.#signal(signal); current();
      this.options.log?.(describeProviderGroupFailure(signals, decision)); this.options.sessions.status(sessionId, "switching");
      this.router.cool(binding.group, member, session.profile.modelId, signals, decision);
      try {
        if (decision.connection && await this.#recoverConnection(sessionId, binding.group, member, session, decision.connection, current, combined)) {
          current(); await this.options.sessions.continue(sessionId, lease, { cause: "reconnected", switched: false, isCurrent: () => isCurrent(current) }); return true;
        }
        current(); this.router.markTried(sessionId, member.key);
        await this.#switchCandidates(session, binding.group, current, false, combined);
        current(); await this.options.sessions.continue(sessionId, lease, { cause: decision.cause, switched: true, isCurrent: () => isCurrent(current) }); return true;
      } catch (error) {
        if (!isCurrent(current)) return true;
        if (providerGroupFailureSignals(error).stateMayHaveChanged) throw error;
        this.options.sessions.status(sessionId, "unavailable"); return false;
      } finally { if (isCurrent(current)) this.options.sessions.status(sessionId, "idle"); }
    });
  }
  noteUserAction(sessionId: string): void { this.#epochs.set(sessionId, (this.#epochs.get(sessionId) ?? 0) + 1); this.noteProgress(sessionId); }
  noteProgress(sessionId: string): void { this.router.clearTurn(sessionId); this.#reconnects.delete(sessionId); }
  turnStarted(sessionId: string): void {
    const binding = this.router.store.binding(sessionId); if (binding) {
      this.router.leases.started({ sessionId, memberKey: binding.memberKey, backendId: binding.backendId, providerId: binding.providerId });
      this.options.sessions.status(sessionId, "idle");
    }
  }
  turnSettled(sessionId: string, succeeded: boolean): void { this.router.leases.ended(sessionId); if (succeeded) this.noteProgress(sessionId); }
  release(sessionId: string): void { this.noteUserAction(sessionId); this.router.leases.ended(sessionId); this.router.store.release(sessionId); }
  async close(): Promise<void> { this.#closed.abort(); await Promise.allSettled(this.#locks.values()); this.router.leases.clear(); }
  async #switchCandidates(session: ProviderGroupSession, group: ProviderGroupKey, current: () => void, beforeSend: boolean, signal: AbortSignal): Promise<void> {
    const unreachable: ProviderGroupAssignment[] = [];
    for (;;) {
      current(); signal.throwIfAborted();
      let assignment: ProviderGroupAssignment;
      try { assignment = await this.router.pick({ ...session, group, modelId: session.profile.modelId, ownTask: true, fresh: true }, signal); }
      catch (error) {
        if (!(error instanceof ProviderGroupUnavailableError)) throw error;
        for (const pending of unreachable.splice(0)) {
          if (!await this.#recoverConnection(session.sessionId, group, pending.member, session, "lost", current, signal)) continue;
          try { await this.#adopt(session.sessionId, pending, beforeSend, current, signal); return; }
          catch (targetError) { current(); if (decideProviderGroupFailure(providerGroupFailureSignals(targetError), "target").action !== "switch") throw targetError; }
        }
        throw error;
      }
      try { current(); await this.#adopt(session.sessionId, assignment, beforeSend, current, signal); return; }
      catch (error) {
        current(); const signals = providerGroupFailureSignals(error), decision = decideProviderGroupFailure(signals, "target");
        this.options.log?.(describeProviderGroupFailure(signals, decision));
        if (decision.action !== "switch") throw error;
        if (decision.connection) unreachable.push(assignment);
        this.router.markTried(session.sessionId, assignment.member.key); this.router.cool(group, assignment.member, assignment.profile.modelId, signals, decision);
      } finally { assignment.release(); }
    }
  }
  async #adopt(sessionId: string, assignment: ProviderGroupAssignment, beforeSend: boolean, current: () => void, signal: AbortSignal): Promise<void> {
    current(); signal.throwIfAborted(); assignment.assertCurrent();
    const session = this.options.sessions.read(sessionId); if (!session || session.dispatchUnknown) throw unknownEffect();
    let nativeCommitted = false;
    const binding = this.router.store.binding(sessionId), fresh = binding !== undefined && binding.memberKey !== assignment.member.key && sameRoute(session.profile, assignment.profile);
    if (fresh || !sameRoute(session.profile, assignment.profile)) {
      const result = await this.options.sessions.handoff(sessionId, assignment.profile, { beforeSend, ...(fresh ? { fresh: true } : {}), isCurrent: () => isCurrent(current) && isCurrent(assignment.assertCurrent) });
      if (result === "unknown") throw unknownEffect();
      nativeCommitted = true;
    }
    try { current(); assignment.assertCurrent(); assignment.commit(); }
    catch (error) { if (nativeCommitted) throw unknownEffect(); throw error; }
  }
  async #recoverConnection(sessionId: string, group: ProviderGroupKey, member: ProviderGroupMember, input: Pick<ProviderGroupStartInput, "agentKind" | "profile" | "logicalModelId">,
    mode: "lost" | "check", current: () => void, signal: AbortSignal): Promise<boolean> {
    if (member.kind === "local") return false;
    const probe = async () => {
      current(); await this.router.directory.refresh(signal); current();
      const status = await this.router.readMember(group, member, { ...this.#request(input, true), fresh: true }, signal); current(); return status;
    };
    let status; try { status = await probe(); } catch { current(); }
    const nextAttempt = () => {
      const perMember = this.#reconnects.get(sessionId) ?? new Map<string, { used: number; at: number }>(); this.#reconnects.set(sessionId, perMember);
      const previous = perMember.get(member.key), used = previous && this.router.now() - previous.at < 30 * 60_000 ? previous.used : 0;
      if (used >= 5) return undefined;
      perMember.set(member.key, { used: used + 1, at: this.router.now() }); return used;
    };
    if (status?.reachable) return mode === "lost" && status.available && nextAttempt() !== undefined;
    for (;;) {
      const attempt = nextAttempt(); if (attempt === undefined) break;
      const delay = [3000, 6000, 12_000, 20_000, 20_000][attempt]!;
      await (this.options.sleep ?? abortableSleep)(delay, signal); current();
      try { status = await probe(); } catch { current(); continue; }
      if (status.reachable) return status.available;
    }
    this.options.log?.({ action: "connection-exhausted", sessionId, group: groupKey(group), memberKey: member.key }); return false;
  }
  #request(input: Pick<ProviderGroupStartInput, "agentKind" | "profile" | "logicalModelId">, fresh: boolean) {
    return { agentKind: input.agentKind, modelId: input.profile.modelId, ownTask: true, fresh,
      ...(input.logicalModelId === undefined ? {} : { logicalModelId: input.logicalModelId }) };
  }
  #current(sessionId: string, lease?: ProviderGroupRecoveryLease): () => void {
    const epoch = this.#epochs.get(sessionId) ?? 0;
    return () => { if (this.#closed.signal.aborted || (this.#epochs.get(sessionId) ?? 0) !== epoch || lease && !lease.isCurrent()) throw new Error(PROVIDER_GROUP_SUPERSEDED_ERROR); };
  }
  #signal(signal: AbortSignal): AbortSignal { return AbortSignal.any([signal, this.#closed.signal]); }
  #serialize<T>(sessionId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(sessionId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(action); this.#locks.set(sessionId, next);
    void next.finally(() => { if (this.#locks.get(sessionId) === next) this.#locks.delete(sessionId); }).catch(() => {}); return next;
  }
  async #syncReshares(group: ProviderGroupKey, previous: readonly ProviderGroupMember[], current: readonly ProviderGroupMember[], signal: AbortSignal): Promise<void> {
    const sharing = this.options.sharing; if (!sharing) return;
    const recipients = this.options.ownedRecipients?.(group) ?? [];
    const cleanup = this.snapshot(group).cleanup;
    await Promise.all([...new Map([...previous, ...cleanup.flatMap(intent => intent.removedMembers), ...current].filter(member => member.received).map(member => [member.key, member])).values()].map(async member => {
      await sharing.syncReshares(member.received!, current.some(row => row.key === member.key) ? recipients : [], signal);
    }));
    for (const intent of cleanup) this.router.store.acknowledgeCleanup(group, intent.id);
  }
}
function isCurrent(assertCurrent: () => void): boolean { try { assertCurrent(); return true; } catch { return false; } }
function sameRoute(a: SessionRuntimeProfile, b: SessionRuntimeProfile): boolean { return a.backendId === b.backendId && a.providerId === b.providerId && a.modelId === b.modelId && a.effort === b.effort && a.fastMode === b.fastMode; }
function unknownEffect(): Error & { stateMayHaveChanged: boolean } { return Object.assign(new Error("The native handoff effect needs inspection before continuing."), { stateMayHaveChanged: true }); }
function abortableSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted(); return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, milliseconds); timer.unref(); signal.addEventListener("abort", abort, { once: true });
  });
}
