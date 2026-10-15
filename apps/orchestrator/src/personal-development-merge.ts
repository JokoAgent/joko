import { createHash } from "node:crypto";
import { resolve } from "node:path";

import { PersonalDevelopmentError, type PersonalDevelopmentOwner } from "@joko/personal-development";
import { operationBodyHash, type OperationalStore, type SessionLifecycleCleanupRecord } from "@joko/store";

import { PERSONAL_DEVELOPMENT_SCOPE, readPersonalDevelopmentPurpose, savePersonalDevelopmentPurpose } from "./personal-development-purpose.js";
import type { SessionHost } from "./session-host.js";

type MergeHost = Pick<SessionHost, "registerTarget" | "createServiceSession" | "enqueueServiceInput" | "preparePersonalDevelopmentClose" | "isSessionActive"
  | "isPrivateSessionCreationClosed" | "releasePrivateSessionCreationReceipt" | "preparePersonalDevelopmentMergeCompletion">;
export interface PersonalMergeSession {
  readonly format: 1; readonly ownerId: string; readonly mergeId: string; readonly targetId: string; readonly backendId: string;
  readonly creationOperationId: string; readonly sessionId?: string; readonly leaseId?: string;
  readonly status: "creating" | "editing" | "ending" | "retired" | "ended" | "unknown";
}
export interface PersonalMergeOperation {
  readonly id: string; readonly inputHash: string; readonly status: "running" | "succeeded" | "failed" | "cancelled" | "unknown";
  readonly kind: "source-merge-session"; readonly stage: string; readonly startedAt: number; readonly finishedAt?: number; readonly error?: string;
}
const hash = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 40);
const invalid = () => new PersonalDevelopmentError("INVALID_ARGUMENT");

/** The package owns the candidate and its source-use pin. This owner only
 * supplies a normal visible Session/Queue and exact native retirement proof. */
export class PersonalDevelopmentMergeCoordinator {
  readonly #flights = new Set<Promise<void>>();
  #closed = false;
  constructor(readonly options: { readonly store: OperationalStore; readonly owner: PersonalDevelopmentOwner; readonly host: MergeHost;
    readonly ownerId: string; readonly assertAvailable: () => void; readonly closeTerminals: (sessionId: string) => Promise<void>;
    readonly publish: () => void }) {}
  #key(kind: "merge" | "merge-operation", id: string): string { return `${kind}:${this.options.ownerId}:${id}`; }
  #save(kind: "merge" | "merge-operation", id: string, value: PersonalMergeSession | PersonalMergeOperation, publish = true): void {
    this.options.store.setSetting("service", PERSONAL_DEVELOPMENT_SCOPE, this.#key(kind, id), JSON.parse(JSON.stringify(value)));
    if (publish) this.options.publish();
  }
  sessions(): readonly PersonalMergeSession[] {
    return this.options.store.listSettings("service", PERSONAL_DEVELOPMENT_SCOPE).filter(item => item.key.startsWith(`merge:${this.options.ownerId}:`)).map(item => {
      const value = item.value as PersonalMergeSession;
      if (value?.format !== 1 || value.ownerId !== this.options.ownerId || this.#key("merge", value.mergeId) !== item.key
        || !["creating", "editing", "ending", "retired", "ended", "unknown"].includes(value.status)) throw new PersonalDevelopmentError("STATE_INVALID");
      return value;
    });
  }
  operations(): readonly PersonalMergeOperation[] {
    return this.options.store.listSettings("service", PERSONAL_DEVELOPMENT_SCOPE).filter(item => item.key.startsWith(`merge-operation:${this.options.ownerId}:`)).map(item => {
      const value = item.value as PersonalMergeOperation;
      if (this.#key("merge-operation", value.id) !== item.key || value.kind !== "source-merge-session"
        || !["running", "succeeded", "failed", "cancelled", "unknown"].includes(value.status)) throw new PersonalDevelopmentError("STATE_INVALID");
      return value;
    });
  }
  initialize(): void {
    for (const operation of this.operations()) if (operation.status === "running") this.#save("merge-operation", operation.id,
      { ...operation, status: "unknown", stage: "recovery-required", error: "PROCESS_UNKNOWN" });
    for (const session of this.sessions()) if (session.status !== "ended" && session.status !== "retired") {
      if (session.sessionId !== undefined) {
        const purpose = readPersonalDevelopmentPurpose(this.options.store, session.sessionId);
        if (purpose?.merge?.id === session.mergeId) savePersonalDevelopmentPurpose(this.options.store, { ...purpose, editing: "unknown" });
      }
      this.#save("merge", session.mergeId, { ...session, status: "unknown" });
    }
  }
  busy(): boolean { return this.sessions().some(item => ["creating", "editing", "ending", "unknown"].includes(item.status)); }
  run(input: { readonly action: "start" | "resolve" | "adopt" | "cancel"; readonly targetId?: string; readonly operationId: string }): string {
    this.options.assertAvailable();
    const inputHash = operationBodyHash(input);
    const previous = this.operations().find(item => item.id === input.operationId);
    if (previous !== undefined) { if (previous.inputHash !== inputHash) throw invalid(); return previous.id; }
    const merge = this.options.owner.snapshot().merge;
    if (input.action !== "start" && (merge === undefined || !["ready", "conflict"].includes(merge.status))) throw invalid();
    let backendId: string | undefined;
    if (input.action === "start" || input.action === "resolve") {
      if (!input.targetId) throw invalid();
      const target = this.options.store.getTarget(input.targetId).descriptor;
      if (!target.trusted || target.remoteWorkspace !== undefined) throw new PersonalDevelopmentError("OWNER_CHANGED");
      backendId = target.backendId;
    }
    const operation: PersonalMergeOperation = { id: input.operationId, inputHash, kind: "source-merge-session", status: "running", stage: "admitted", startedAt: Date.now() };
    this.#save("merge-operation", operation.id, operation);
    const flight = this.#execute(input, backendId, merge?.id).then(() => {
      this.#save("merge-operation", operation.id, { ...operation, status: "succeeded", stage: "completed", finishedAt: Date.now() });
    }).catch(error => {
      this.#save("merge-operation", operation.id, { ...operation, status: error instanceof PersonalDevelopmentError
        ? error.code === "PROCESS_UNKNOWN" ? "unknown" : error.code === "CANCELLED" ? "cancelled" : "failed" : "unknown",
        stage: "failed", error: error instanceof PersonalDevelopmentError ? error.code : "PROCESS_UNKNOWN", finishedAt: Date.now() });
    }).finally(() => this.#flights.delete(flight));
    this.#flights.add(flight); return operation.id;
  }
  async #execute(input: { readonly action: "start" | "resolve" | "adopt" | "cancel"; readonly targetId?: string; readonly operationId: string }, backendId?: string, mergeId?: string,
    completedRun?: { readonly runId: string; readonly generation: number }): Promise<void> {
    if (input.action === "start") {
      await this.options.owner.mergeSource({ action: "start", operationId: input.operationId });
      const merge = this.options.owner.snapshot().merge;
      if (merge?.id === input.operationId && merge.status === "conflict") await this.#create(merge.id, merge.candidate, backendId!, input.operationId);
      else if (merge?.id === input.operationId && merge.status === "ready") await this.options.owner.mergeSource({ action: "adopt", expectedMergeId: merge.id, operationId: `merge-ready-${hash(merge.id)}` });
      return;
    }
    let session = this.sessions().find(item => item.mergeId === mergeId);
    if (session?.sessionId !== undefined && session.status !== "retired" && session.status !== "ended") {
      const stored = this.options.store.listSessions({ includeArchived: true, includeDeleted: true }).find(item => item.descriptor.id === session!.sessionId);
      if (stored !== undefined && (stored.descriptor.archived || stored.descriptor.deletedAt !== undefined)) {
        const cleanup = this.options.store.findLatestSessionLifecycleCleanup(session.sessionId);
        if (cleanup?.state !== "completed" || !cleanup.closeCompleted || !cleanup.nativeCompleted || cleanup.createdAt < stored.descriptor.createdAt
          || this.options.host.isSessionActive(session.sessionId)) throw new PersonalDevelopmentError("PROCESS_UNKNOWN");
        await this.options.closeTerminals(session.sessionId);
        const after = this.options.store.getSession(session.sessionId), afterCleanup = this.options.store.getSessionLifecycleCleanup(cleanup.operationId);
        if (after.revision !== stored.revision || afterCleanup.revision !== cleanup.revision) throw new PersonalDevelopmentError("OWNER_CHANGED");
        await this.settleSessionLifecycle(cleanup);
        session = this.sessions().find(item => item.mergeId === mergeId);
      }
    }
    if (input.action === "resolve") {
      const merge = this.options.owner.snapshot().merge;
      if (merge === undefined || merge.id !== mergeId || !["ready", "conflict"].includes(merge.status)) throw new PersonalDevelopmentError("OWNER_CHANGED");
      if (session?.status === "unknown") throw new PersonalDevelopmentError("PROCESS_UNKNOWN");
      if (session?.status === "editing") return;
      const purpose = session?.sessionId === undefined ? undefined : readPersonalDevelopmentPurpose(this.options.store, session.sessionId);
      const existing = session?.sessionId === undefined ? undefined : this.options.store.listSessions({ includeArchived: true, includeDeleted: true })
        .find(item => item.descriptor.id === session.sessionId)?.descriptor;
      if (session?.status === "retired" && purpose?.phase === "adopted" && existing !== undefined && !existing.archived && existing.deletedAt === undefined) {
        const target = this.options.store.getTarget(existing.targetId);
        if (purpose.targetRevision !== target.revision.toString() || purpose.backendGeneration !== this.options.store.getBackend(existing.backendId).descriptor.instanceGeneration
          || purpose.binding?.opaqueRef !== existing.binding.opaqueRef || purpose.binding.nativeSessionId !== existing.binding.nativeSessionId
          || target.descriptor.remoteWorkspace !== undefined || resolve(target.descriptor.workspaceRoot) !== resolve(merge.candidate)) throw new PersonalDevelopmentError("OWNER_CHANGED");
        const { value: lease } = await this.options.owner.acquireMergeResolution({ mergeId: session.mergeId, sessionId: existing.id });
        savePersonalDevelopmentPurpose(this.options.store, { ...purpose, editing: "editing", merge: { id: merge.id, directory: lease.directory, leaseId: lease.leaseId } });
        this.#save("merge", merge.id, { ...session, leaseId: lease.leaseId, status: "editing" });
        this.options.host.enqueueServiceInput({ operationId: `merge-resume-input-${hash(input.operationId)}`, sessionId: existing.id, source: "system",
          prompt: { text: "Continue resolving the existing source merge conflicts. Inspect the retained Git state; do not restart the merge or create a commit. Verify the resolution and explain the result.", images: [], files: [], mentions: [], disposition: "prompt" } });
      } else await this.#create(merge.id, merge.candidate, backendId!, input.operationId);
      return;
    }
    if (session !== undefined && session.status !== "retired" && session.status !== "ended") await this.#retire(session, completedRun);
    try {
      await this.options.owner.mergeSource({ action: input.action, expectedMergeId: mergeId!, operationId: input.operationId });
    } catch (error) {
      // An unresolved merge is still editable after its known writer retires.
      if (session?.sessionId !== undefined && error instanceof PersonalDevelopmentError && error.code !== "PROCESS_UNKNOWN") {
        const { value: lease } = await this.options.owner.acquireMergeResolution({ mergeId: session.mergeId, sessionId: session.sessionId });
        const purpose = readPersonalDevelopmentPurpose(this.options.store, session.sessionId);
        if (purpose?.merge?.id !== session.mergeId || resolve(purpose.merge.directory) !== resolve(lease.directory)) throw new PersonalDevelopmentError("OWNER_CHANGED");
        savePersonalDevelopmentPurpose(this.options.store, { ...purpose, editing: "editing", merge: { ...purpose.merge, leaseId: lease.leaseId } });
        this.#save("merge", session.mergeId, { ...session, leaseId: lease.leaseId, status: "editing" });
      }
      throw error;
    }
    if (session?.sessionId !== undefined) this.#archive(session);
  }
  async #create(mergeId: string, directory: string, backendId: string, requestOperationId: string): Promise<void> {
    const targetId = `personal-merge-target-${hash(`${this.options.ownerId}:${mergeId}:${backendId}`)}`;
    const creationOperationId = `personal-merge-create-${hash(`${mergeId}:${requestOperationId}`)}`;
    let intent: PersonalMergeSession = { format: 1, ownerId: this.options.ownerId, mergeId, targetId, backendId, creationOperationId, status: "creating" };
    this.#save("merge", mergeId, intent);
    const assertScope = () => {
      if (this.#closed) throw new PersonalDevelopmentError("OWNER_CHANGED"); this.options.assertAvailable();
      const current = this.options.owner.snapshot().merge;
      if (current?.id !== mergeId || current.candidate !== directory || !["ready", "conflict"].includes(current.status)) throw new PersonalDevelopmentError("SOURCE_CHANGED");
    };
    try {
      assertScope(); await this.options.host.registerTarget({ id: targetId, backendId, displayName: "Merge source updates", workspaceRoot: directory,
        managed: true, trusted: true }, { kind: "personal_development", ownerId: this.options.ownerId });
      const target = this.options.store.getTarget(targetId);
      const result = await this.options.host.createServiceSession({ operationId: creationOperationId, serviceKind: "personal_development", targetId,
        title: "Merge source updates", fastMode: false, permissionMode: "ask", planMode: false, assertServiceScope: assertScope,
        appendSystemPrompt: "Resolve the existing source merge conflicts only in this task's managed checkout. Inspect Git status and both sides, preserving personal changes and upstream fixes. Do not restart merge, rebase, or reset; do not choose ours/theirs for all files, edit another checkout, switch branches, commit, or push. Stage resolved files, run the relevant checks, explain preserved behavior and verification, and finish the turn. The service verifies the original personal baseline and adopts the result after this task's writers retire. Do not build or switch the application.",
        onPreparing: (store, preparing) => {
          intent = { ...intent, sessionId: preparing.sessionId }; this.#save("merge", mergeId, intent, false);
          savePersonalDevelopmentPurpose(store, { format: 1, taskId: `merge-${hash(mergeId)}`, ownerId: this.options.ownerId,
            creationOperationId, sessionId: preparing.sessionId, targetId, targetRevision: preparing.target.revision.toString(), backendId,
            backendGeneration: preparing.backendGeneration, phase: "creating", editing: "preparing", merge: { id: mergeId, directory } });
        },
        beforeNativeCreation: async sessionId => {
          assertScope(); const { value: lease } = await this.options.owner.acquireMergeResolution({ mergeId, sessionId }); assertScope();
          if (resolve(lease.directory) !== resolve(directory)) throw new PersonalDevelopmentError("OWNER_CHANGED");
          intent = { ...intent, leaseId: lease.leaseId }; this.#save("merge", mergeId, intent);
          const purpose = readPersonalDevelopmentPurpose(this.options.store, sessionId);
          if (purpose?.merge?.id !== mergeId) throw new PersonalDevelopmentError("OWNER_CHANGED");
          savePersonalDevelopmentPurpose(this.options.store, { ...purpose, merge: { ...purpose.merge, leaseId: lease.leaseId } });
        },
        onAdmitted: (store, session) => {
          assertScope(); const purpose = readPersonalDevelopmentPurpose(store, session.descriptor.id);
          if (purpose === undefined || purpose.merge?.leaseId !== intent.leaseId || !intent.leaseId || target.revision !== store.getTarget(targetId).revision
            || session.descriptor.worktree !== undefined || resolve(store.getTarget(session.descriptor.targetId).descriptor.workspaceRoot) !== resolve(directory)) throw new PersonalDevelopmentError("OWNER_CHANGED");
          savePersonalDevelopmentPurpose(store, { ...purpose, phase: "adopted", editing: "editing", binding: session.descriptor.binding });
        } });
      this.options.host.enqueueServiceInput({ operationId: `personal-merge-input-${hash(`${mergeId}:${requestOperationId}`)}`, sessionId: result.value.sessionId, source: "system",
        prompt: { text: "Resolve the existing source merge conflicts, preserve the personal changes and upstream fixes, verify the resolution, and explain the result. Do not restart the merge or create a commit.", images: [], files: [], mentions: [], disposition: "prompt" } });
      this.#save("merge", mergeId, { ...intent, sessionId: result.value.sessionId, status: "editing" });
    } catch (error) {
      if (intent.sessionId !== undefined && this.options.host.isPrivateSessionCreationClosed(creationOperationId, intent.sessionId)) {
        const resolution = this.options.owner.snapshot().merge?.resolution;
        const leaseId = intent.leaseId ?? (resolution?.sessionId === intent.sessionId ? resolution.leaseId : undefined);
        if (leaseId !== undefined) await this.options.owner.releaseMergeResolution({ mergeId, sessionId: intent.sessionId, leaseId, outcome: "retired" });
        this.options.host.releasePrivateSessionCreationReceipt(creationOperationId, intent.sessionId);
        this.#save("merge", mergeId, { ...intent, status: "retired" });
      } else this.#save("merge", mergeId, { ...intent, status: "unknown" });
      throw error;
    }
  }
  async #retire(session: PersonalMergeSession, completedRun?: { readonly runId: string; readonly generation: number }): Promise<void> {
    if (session.sessionId === undefined || session.leaseId === undefined) throw new PersonalDevelopmentError("PROCESS_UNKNOWN");
    const purpose = readPersonalDevelopmentPurpose(this.options.store, session.sessionId);
    if (purpose?.merge?.id !== session.mergeId || purpose.merge.leaseId !== session.leaseId || purpose.phase !== "adopted") throw new PersonalDevelopmentError("PROCESS_UNKNOWN");
    this.#save("merge", session.mergeId, { ...session, status: "ending" });
    savePersonalDevelopmentPurpose(this.options.store, { ...purpose, editing: "ending" });
    try {
      if (completedRun === undefined) await this.options.host.preparePersonalDevelopmentClose(session.sessionId);
      else await this.options.host.preparePersonalDevelopmentMergeCompletion(session.sessionId, completedRun.runId, completedRun.generation);
      await this.options.closeTerminals(session.sessionId);
      if (this.options.host.isSessionActive(session.sessionId)) throw new PersonalDevelopmentError("PROCESS_UNKNOWN");
      await this.options.owner.releaseMergeResolution({ mergeId: session.mergeId, sessionId: session.sessionId, leaseId: session.leaseId, outcome: "retired" });
      savePersonalDevelopmentPurpose(this.options.store, { ...purpose, editing: "completed" });
      this.#save("merge", session.mergeId, { ...session, status: "retired" });
    } catch (error) {
      await this.options.owner.releaseMergeResolution({ mergeId: session.mergeId, sessionId: session.sessionId, leaseId: session.leaseId, outcome: "unknown" }).catch(() => undefined);
      this.#save("merge", session.mergeId, { ...session, status: "unknown" }); throw error;
    }
  }
  onRunSettled(input: { readonly sessionId: string; readonly runId: string; readonly outcome: "completed" | "aborted" | "failed" }): void {
    if (this.#closed || input.outcome !== "completed") return;
    const session = this.sessions().find(item => item.sessionId === input.sessionId && item.status === "editing");
    if (session === undefined) return;
    const run = this.options.store.getRun(input.runId).descriptor;
    if (run.activeAttemptId === undefined) return;
    const generation = this.options.store.getAttempt(run.activeAttemptId).descriptor.generation;
    if (generation !== this.options.store.getSession(input.sessionId).descriptor.binding.generation
      || this.options.store.listQueueItems({ sessionId: input.sessionId, states: ["accepted", "dispatching", "backend_accepted", "dispatch_unknown"], limit: 500 })
        .some(item => item.runId !== input.runId)) return;
    const id = `merge-complete-${hash(`${session.mergeId}:${input.runId}`)}`;
    if (this.operations().some(item => item.id === id)) return;
    const operation: PersonalMergeOperation = { id, inputHash: operationBodyHash(input), kind: "source-merge-session", status: "running", stage: "checking-resolution", startedAt: Date.now() };
    this.#save("merge-operation", id, operation);
    const flight = this.#execute({ action: "adopt", operationId: id }, undefined, session.mergeId, { runId: input.runId, generation }).then(() => {
      this.#save("merge-operation", id, { ...operation, status: "succeeded", stage: "completed", finishedAt: Date.now() });
    }).catch(error => {
      this.#save("merge-operation", id, { ...operation, status: error instanceof PersonalDevelopmentError && error.code !== "PROCESS_UNKNOWN" ? "failed" : "unknown",
        stage: "resolution-retained", error: error instanceof PersonalDevelopmentError ? error.code : "PROCESS_UNKNOWN", finishedAt: Date.now() });
    }).finally(() => this.#flights.delete(flight));
    this.#flights.add(flight);
  }
  #archive(session: PersonalMergeSession): void {
    const sessionId = session.sessionId!; const operationId = `personal-merge-end-${hash(session.mergeId)}`;
    const purpose = readPersonalDevelopmentPurpose(this.options.store, sessionId);
    if (purpose?.merge?.id !== session.mergeId) throw new PersonalDevelopmentError("OWNER_CHANGED");
    if (purpose.phase === "creating") {
      savePersonalDevelopmentPurpose(this.options.store, { ...purpose, editing: "ended" });
      this.#save("merge", session.mergeId, { ...session, status: "ended" }); return;
    }
    this.options.store.transaction(store => {
      savePersonalDevelopmentPurpose(store, { ...purpose, editing: "ending", endingOperationId: operationId });
      const cleanup = store.findSessionLifecycleCleanup(operationId) ?? store.prepareSessionLifecycleCleanup({ operationId, sessionId, disposition: "archive" });
      if (cleanup.state !== "completed") { store.advanceSessionLifecycleCleanup({ operationId, phase: "close" }); store.finalizeSessionLifecycleCleanup({ operationId }); }
      savePersonalDevelopmentPurpose(store, { ...purpose, editing: "ended", endingOperationId: operationId });
    });
    this.#save("merge", session.mergeId, { ...session, status: "ended" });
  }
  async settleSessionLifecycle(cleanup: SessionLifecycleCleanupRecord): Promise<void> {
    const session = this.sessions().find(item => item.sessionId === cleanup.sessionId);
    const purpose = readPersonalDevelopmentPurpose(this.options.store, cleanup.sessionId);
    const stored = this.options.store.getSession(cleanup.sessionId).descriptor;
    if (session === undefined || purpose?.phase !== "adopted" || purpose.merge?.id !== session.mergeId
      || purpose.merge.leaseId !== session.leaseId || session.leaseId === undefined
      || purpose.binding?.opaqueRef !== stored.binding.opaqueRef || purpose.binding.nativeSessionId !== stored.binding.nativeSessionId
      || purpose.targetRevision !== this.options.store.getTarget(stored.targetId).revision.toString()
      || !cleanup.closeCompleted || !cleanup.nativeCompleted || this.options.host.isSessionActive(cleanup.sessionId)) throw new PersonalDevelopmentError("PROCESS_UNKNOWN");
    if (session.status !== "retired" && session.status !== "ended") await this.options.owner.releaseMergeResolution({ mergeId: session.mergeId,
      sessionId: cleanup.sessionId, leaseId: session.leaseId, outcome: "retired" });
    savePersonalDevelopmentPurpose(this.options.store, { ...purpose, editing: "ended", endingOperationId: cleanup.operationId });
    this.#save("merge", session.mergeId, { ...session, status: "retired" });
  }
  async dispose(): Promise<void> {
    this.#closed = true; await Promise.allSettled([...this.#flights]);
    await Promise.allSettled(this.sessions().filter(session => session.status === "editing").map(session => this.#retire(session)));
  }
}
