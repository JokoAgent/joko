import { createHash, randomUUID } from "node:crypto";

import { toPublicError, type PermissionMode, type PromptInput, type PublicError } from "@joko/core";
import {
  createWorkerCapacityController,
  type CollaborationSettings,
  type WorkerCapacityController,
  type WorkerCapacityLease
} from "@joko/runtime-governance";
import {
  AuthorizationError,
  OperationInProgressError,
  RevisionConflictError,
  StoreError,
  operationBodyHash,
  type CollaborationDispatchRecord,
  type CollaborationGoalRecord,
  type CollaborationGoalStatus,
  type CollaborationWorkerRecord,
  type MergeCollaborationDispatchesInput,
  type OperationalStore,
  type QueueItemRecord,
  type StoredRun
} from "@joko/store";

import type { EnqueueResult, SessionHost } from "./session-host.js";

export interface CollaborationGoalTreeView {
  readonly goal: CollaborationGoalRecord;
  readonly workers: readonly CollaborationWorkerRecord[];
  readonly queue: readonly {
    readonly dispatch: CollaborationDispatchRecord;
    readonly queueItem?: QueueItemRecord;
  }[];
  readonly focusedWorkerId?: string;
}

export interface CollaborationGoalAccessView {
  readonly goal: CollaborationGoalRecord;
  readonly role: "lead" | "worker";
  readonly workerId?: string;
}

export type CollaborationGoalManagerErrorCode =
  | "COLLABORATION_WORKER_CREATE_UNKNOWN"
  | "COLLABORATION_WORKER_WAKE_UNKNOWN"
  | "COLLABORATION_WORKER_STOP_UNKNOWN"
  | "COLLABORATION_WORKER_RELEASE_UNKNOWN"
  | "COLLABORATION_WORKER_ROUTE_UNAVAILABLE";

export type CollaborationInterruptStopOutcome = "stopped" | "not_running" | "unconfirmed" | "already_queued";

export class CollaborationGoalManagerError extends Error {
  constructor(readonly code: CollaborationGoalManagerErrorCode, message: string) {
    super(message);
    this.name = "CollaborationGoalManagerError";
  }
}

export interface CollaborationGoalManagerOptions {
  readonly store: OperationalStore;
  readonly sessionHost: Pick<
    SessionHost,
    "createServiceSession" | "enqueueServiceInput" | "resume" | "abort" |
    "closeIfActive" | "isSessionActive"
  >;
  readonly readSettings: () => CollaborationSettings;
  readonly now?: () => number;
  readonly idFactory?: () => string;
  readonly capacity?: WorkerCapacityController;
}

interface WorkerRouteInput {
  readonly targetId: string;
  readonly providerId?: string;
  readonly modelId?: string;
  readonly effort?: string;
  readonly fastMode: boolean;
  readonly permissionMode: PermissionMode;
  readonly planMode: boolean;
}

/** Owns Goal/lead/worker lifecycle and binds every lead message to the exact
 * durable worker Queue item before Backend dispatch can begin. */
export class CollaborationGoalManager {
  readonly #store: OperationalStore;
  readonly #sessionHost: CollaborationGoalManagerOptions["sessionHost"];
  readonly #readSettings: () => CollaborationSettings;
  readonly #now: () => number;
  readonly #idFactory: () => string;
  readonly #capacity: WorkerCapacityController;
  readonly #leases = new Map<string, WorkerCapacityLease>();
  readonly #locks = new Map<string, Promise<void>>();
  #unsubscribe?: () => void;
  #closed = false;

  constructor(options: CollaborationGoalManagerOptions) {
    this.#store = options.store;
    this.#sessionHost = options.sessionHost;
    this.#readSettings = options.readSettings;
    this.#now = options.now ?? Date.now;
    this.#idFactory = options.idFactory ?? randomUUID;
    this.#capacity = options.capacity ?? createWorkerCapacityController({
      readSettings: this.#readSettings,
      releaseIdleWorker: (lease) => this.#releaseIdleLease(lease),
      now: this.#now
    });
  }

  async initialize(): Promise<void> {
    this.#assertOpen();
    if (this.#unsubscribe !== undefined) return;
    this.#recoverInterruptedLifecycleEffects();
    const workers = this.#store.listCollaborationWorkers({ includeArchived: true });
    for (const worker of workers) {
      if (occupiesCapacity(worker)) this.#restoreLease(worker);
    }
    for (const worker of workers) {
      if (worker.status === "provisioning") {
        await this.#withLock(worker.id, () => this.#resumeProvisioning(worker.id, true)).catch(() => undefined);
      } else if (worker.status === "stopping") {
        await this.#withLock(worker.id, () => this.#resumeStop(worker.id, true)).catch(() => undefined);
      }
    }
    for (const worker of this.#store.listCollaborationWorkers()) {
      await this.#ensureInitialAssignment(worker.id).catch(() => undefined);
    }
    this.#recoverPreparingDispatches();
    for (const worker of this.#store.listCollaborationWorkers()) this.#reconcileWorker(worker.id);
    await this.#capacity.sweepIdle().catch(() => undefined);
    this.#unsubscribe = this.#store.subscribe((event) => {
      if (event.sessionId === undefined) return;
      const worker = this.#store.findCollaborationWorkerBySession(event.sessionId);
      if (worker === undefined) return;
      void this.#withLock(worker.id, async () => { this.#reconcileWorker(worker.id); }).catch(() => undefined);
    });
  }

  listGoals(options: {
    readonly leadSessionId?: string;
    readonly includeArchived?: boolean;
  } = {}): readonly CollaborationGoalRecord[] {
    this.#assertOpen();
    const statuses: readonly CollaborationGoalStatus[] | undefined = options.includeArchived === true
      ? undefined
      : ["active", "completed", "stopped", "failed"];
    return this.#store.listCollaborationGoals({
      ...(options.leadSessionId === undefined ? {} : { leadSessionId: options.leadSessionId }),
      ...(statuses === undefined ? {} : { statuses })
    });
  }

  listGoalAccessForSession(input: {
    readonly sessionId: string;
    readonly includeArchived?: boolean;
  }): readonly CollaborationGoalAccessView[] {
    this.#assertOpen();
    this.#store.getSession(input.sessionId);
    const worker = this.#store.findCollaborationWorkerBySession(input.sessionId);
    const led = this.listGoals({
      leadSessionId: input.sessionId,
      includeArchived: input.includeArchived
    });
    if (worker !== undefined && led.length > 0) {
      throw new StoreError("A collaboration Session cannot be both a lead and a worker.");
    }
    if (worker !== undefined) {
      const goal = this.#store.getCollaborationGoal(worker.goalId);
      if (goal.status === "archived" && input.includeArchived !== true) return [];
      return [{ goal, role: "worker", workerId: worker.id }];
    }
    return led.map((goal) => ({ goal, role: "lead" }));
  }

  getTreeForSession(goalId: string, viewerSessionId: string): CollaborationGoalTreeView {
    this.#assertOpen();
    const goal = this.#store.getCollaborationGoal(goalId);
    const worker = this.#store.findCollaborationWorkerBySession(viewerSessionId);
    if (goal.leadSessionId !== viewerSessionId && worker?.goalId !== goal.id) {
      throw new AuthorizationError("The Session does not belong to this collaboration Goal.");
    }
    return this.getTree(goal.id);
  }

  getTree(goalId: string): CollaborationGoalTreeView {
    this.#assertOpen();
    const goal = this.#store.getCollaborationGoal(goalId);
    for (const worker of this.#store.listCollaborationWorkers({ goalId, includeArchived: true })) {
      this.#reconcileWorker(worker.id);
    }
    return this.#tree(goal.id);
  }

  createGoal(input: {
    readonly operationId: string;
    readonly leadSessionId: string;
    readonly expectedSessionGeneration: number;
    readonly title: string;
    readonly objective: string;
    readonly maximumWorkers?: number;
  }): CollaborationGoalTreeView {
    this.#assertOpen();
    const goalId = collaborationId("goal", this.#idFactory());
    const execution = this.#store.runOperation(
      {
        id: input.operationId,
        kind: "create_collaboration_goal",
        body: { ...input, maximumWorkers: input.maximumWorkers ?? null }
      },
      (store) => ({
        goalId: store.createCollaborationGoal({
          id: goalId,
          leadId: collaborationId("lead", this.#idFactory()),
          leadSessionId: input.leadSessionId,
          expectedSessionGeneration: input.expectedSessionGeneration,
          title: input.title,
          objective: input.objective,
          ...(input.maximumWorkers === undefined ? {} : { maximumWorkers: input.maximumWorkers }),
          createdAt: this.#now()
        }).id
      })
    );
    return this.#tree(execution.value.goalId);
  }

  async setGoalStatus(input: {
    readonly operationId: string;
    readonly goalId: string;
    readonly callerLeadSessionId: string;
    readonly expectedRevision: bigint;
    readonly status: Exclude<CollaborationGoalStatus, "active">;
    readonly signal?: AbortSignal;
  }): Promise<CollaborationGoalTreeView> {
    return this.#withLock(`goal:${input.goalId}`, async () => {
      this.#assertOpen();
      const operation = {
        id: input.operationId,
        kind: "set_collaboration_goal_status",
        body: {
          operationId: input.operationId,
          goalId: input.goalId,
          callerLeadSessionId: input.callerLeadSessionId,
          expectedRevision: input.expectedRevision.toString(10),
          status: input.status
        }
      };
      if (this.#store.findOperation<{ readonly goalId: string }>(input.operationId) !== undefined) {
        const replay = this.#store.runOperation<{ readonly goalId: string }>(operation, () => {
          throw new StoreError("A persisted collaboration Goal status operation unexpectedly executed twice.");
        });
        return this.#tree(replay.value.goalId);
      }

      const current = this.#store.getCollaborationGoal(input.goalId);
      if (current.leadSessionId !== input.callerLeadSessionId) {
        throw new AuthorizationError("Only the collaboration Goal lead Session can change its status.");
      }
      if (current.revision !== input.expectedRevision) {
        throw new RevisionConflictError(
          "Collaboration Goal",
          current.id,
          input.expectedRevision,
          current.revision
        );
      }
      const transitionAllowed = current.status === input.status
        || (current.status === "active" && ["completed", "stopped", "failed"].includes(input.status))
        || (["completed", "stopped", "failed"].includes(current.status) && input.status === "archived");
      if (!transitionAllowed) {
        throw new StoreError(`A collaboration Goal cannot transition from ${current.status} to ${input.status}.`);
      }
      input.signal?.throwIfAborted();
      if (current.status !== input.status && input.status === "stopped") {
        await this.#retireGoalWorkers(input, true);
      } else if (current.status !== input.status && input.status === "archived") {
        await this.#retireGoalWorkers(input, false);
      }
      input.signal?.throwIfAborted();
      const execution = this.#store.runOperation(
        operation,
        (store) => ({
          goalId: store.updateCollaborationGoalStatus({
            goalId: input.goalId,
            callerLeadSessionId: input.callerLeadSessionId,
            expectedRevision: input.expectedRevision,
            status: input.status,
            updatedAt: this.#now()
          }).id
        })
      );
      return this.#tree(execution.value.goalId);
    });
  }

  async createWorker(input: {
    readonly operationId: string;
    readonly goalId: string;
    readonly callerLeadSessionId: string;
    readonly expectedGoalRevision: bigint;
    readonly parentWorkerId?: string;
    readonly label: string;
    readonly role: string;
    readonly assignment: string;
    readonly route: WorkerRouteInput;
  }): Promise<{ readonly tree: CollaborationGoalTreeView; readonly worker: CollaborationWorkerRecord }> {
    return this.#withLock(`goal:${input.goalId}`, async () => {
      this.#assertOpen();
      const existing = this.#store.findCollaborationWorkerByCreateOperation(input.operationId);
      if (existing !== undefined) {
        this.#assertWorkerOperationBody(input.operationId, createWorkerOperationBody(input));
        if (occupiesCapacity(existing)) this.#ensureRestoredLease(existing);
        const worker = existing.status === "provisioning"
          ? await this.#resumeProvisioning(existing.id, false)
          : this.#store.getCollaborationWorker(existing.id);
        const assigned = await this.#ensureInitialAssignment(worker.id);
        return { tree: this.#tree(assigned.goalId), worker: assigned };
      }

      const goal = this.#store.getCollaborationGoal(input.goalId);
      const target = this.#store.getTarget(input.route.targetId);
      const workerId = collaborationId("worker", this.#idFactory());
      const lease = await this.#capacity.acquire(goal.id, workerId);
      let reserved = false;
      try {
        const settings = this.#readSettings();
        const body = createWorkerOperationBody(input);
        const claim = this.#store.claimDeferredEffectOperation<{ readonly workerId: string }>(
          { id: input.operationId, kind: "create_collaboration_worker", body },
          (store) => {
            store.reserveCollaborationWorker({
              id: workerId,
              goalId: goal.id,
              callerLeadSessionId: input.callerLeadSessionId,
              expectedGoalRevision: input.expectedGoalRevision,
              createOperationId: input.operationId,
              backendId: target.descriptor.backendId,
              ...input.route,
              targetId: target.descriptor.id,
              ...(input.parentWorkerId === undefined ? {} : { parentWorkerId: input.parentWorkerId }),
              label: input.label,
              role: input.role,
              assignment: input.assignment,
              softLimit: settings.workerSoftLimit,
              hardLimit: settings.workerHardLimit,
              createdAt: this.#now()
            });
          }
        );
        if (!claim.claimed) {
          this.#capacity.release(lease.leaseId);
          const worker = this.#store.getCollaborationWorker(claim.value.workerId);
          this.#ensureRestoredLease(worker);
          return { tree: this.#tree(worker.goalId), worker };
        }
        reserved = true;
        this.#leases.set(workerId, lease);
        const worker = await this.#resumeProvisioning(workerId, false);
        const assigned = await this.#ensureInitialAssignment(worker.id);
        return { tree: this.#tree(assigned.goalId), worker: assigned };
      } catch (error) {
        if (!reserved) this.#capacity.release(lease.leaseId);
        throw error;
      }
    });
  }

  updateWorker(input: {
    readonly operationId: string;
    readonly workerId: string;
    readonly callerLeadSessionId: string;
    readonly expectedRevision: bigint;
    readonly label?: string;
    readonly role?: string;
    readonly assignment?: string;
  }): { readonly tree: CollaborationGoalTreeView; readonly worker: CollaborationWorkerRecord } {
    this.#assertOpen();
    const execution = this.#store.runOperation(
      {
        id: input.operationId,
        kind: "update_collaboration_worker",
        body: { ...input, expectedRevision: input.expectedRevision.toString(10) }
      },
      (store) => {
        const worker = store.updateCollaborationWorkerAssignment({
          workerId: input.workerId,
          callerLeadSessionId: input.callerLeadSessionId,
          expectedRevision: input.expectedRevision,
          ...(input.label === undefined ? {} : { label: input.label }),
          ...(input.role === undefined ? {} : { role: input.role }),
          ...(input.assignment === undefined ? {} : { assignment: input.assignment }),
          updatedAt: this.#now()
        });
        return { workerId: worker.id, goalId: worker.goalId };
      }
    );
    const worker = this.#store.getCollaborationWorker(execution.value.workerId);
    return { tree: this.#tree(execution.value.goalId), worker };
  }

  focusWorker(input: {
    readonly operationId: string;
    readonly goalId: string;
    readonly callerLeadSessionId: string;
    readonly workerId?: string;
    readonly expectedWorkerRevision?: bigint;
  }): CollaborationGoalTreeView {
    this.#assertOpen();
    const execution = this.#store.runOperation(
      {
        id: input.operationId,
        kind: "focus_collaboration_worker",
        body: {
          ...input,
          expectedWorkerRevision: input.expectedWorkerRevision?.toString(10) ?? null
        }
      },
      (store) => {
        store.focusCollaborationWorker({
          goalId: input.goalId,
          callerLeadSessionId: input.callerLeadSessionId,
          ...(input.workerId === undefined ? {} : { workerId: input.workerId }),
          ...(input.expectedWorkerRevision === undefined
            ? {}
            : { expectedWorkerRevision: input.expectedWorkerRevision }),
          updatedAt: this.#now()
        });
        return { goalId: input.goalId };
      }
    );
    return this.#tree(execution.value.goalId);
  }

  async wakeWorker(input: {
    readonly operationId: string;
    readonly workerId: string;
    readonly callerLeadSessionId: string;
    readonly expectedRevision: bigint;
    readonly expectedSessionGeneration: number;
  }): Promise<{ readonly tree: CollaborationGoalTreeView; readonly worker: CollaborationWorkerRecord }> {
    return this.#withLock(input.workerId, async () => {
      const operation = {
        id: input.operationId,
        kind: "wake_collaboration_worker",
        body: { ...input, expectedRevision: input.expectedRevision.toString(10) }
      };
      if (this.#store.findOperation<{ readonly workerId: string }>(input.operationId) !== undefined) {
        const replay = this.#store.runOperation<{ readonly workerId: string }>(operation, () => {
          throw new StoreError("A persisted collaboration worker wake operation unexpectedly executed twice.");
        });
        const worker = this.#store.getCollaborationWorker(replay.value.workerId);
        return { tree: this.#tree(worker.goalId), worker };
      }
      const current = this.#store.getCollaborationWorker(input.workerId);
      const currentGoal = this.#store.getCollaborationGoal(current.goalId);
      if (currentGoal.leadSessionId !== input.callerLeadSessionId) {
        throw new AuthorizationError("Only the collaboration Goal lead Session can wake a worker.");
      }
      if (currentGoal.status !== "active") {
        throw new StoreError("Only the active collaboration lead can wake a worker.");
      }
      assertWorkerRevision(current, input.expectedRevision);
      if (current.sessionGeneration !== input.expectedSessionGeneration) {
        throw new StoreError("The collaboration worker Session generation changed before wake.");
      }
      if (!current.runtimeReleased) {
        const execution = this.#store.runOperation<{ readonly workerId: string }>(
          operation,
          () => ({ workerId: current.id })
        );
        const worker = this.#store.getCollaborationWorker(execution.value.workerId);
        return { tree: this.#tree(worker.goalId), worker };
      }
      if (!["idle", "completed", "failed"].includes(current.status)) {
        throw new StoreError("Only an idle or settled collaboration worker can be woken.");
      }
      const lease = await this.#capacity.acquire(current.goalId, current.id);
      let effectClaimed = false;
      try {
        const claim = this.#store.claimDeferredEffectOperation<{ readonly workerId: string }>(
          operation,
          (store) => {
            const worker = store.getCollaborationWorker(input.workerId);
            assertWorkerRevision(worker, input.expectedRevision);
            const goal = store.getCollaborationGoal(worker.goalId);
            if (goal.leadSessionId !== input.callerLeadSessionId) {
              throw new AuthorizationError("Only the collaboration Goal lead Session can wake a worker.");
            }
            if (goal.status !== "active") {
              throw new StoreError("Only the active collaboration lead can wake a worker.");
            }
            if (worker.sessionId === undefined || worker.sessionGeneration !== input.expectedSessionGeneration) {
              throw new StoreError("The collaboration worker Session generation changed before wake.");
            }
            if (!worker.runtimeReleased || !["idle", "completed", "failed"].includes(worker.status)) {
              throw new StoreError("Only a released idle or settled collaboration worker can be woken.");
            }
            store.updateCollaborationWorkerState({
              workerId: worker.id,
              callerLeadSessionId: input.callerLeadSessionId,
              expectedRevision: worker.revision,
              expectedSessionGeneration: input.expectedSessionGeneration,
              status: worker.status === "completed" || worker.status === "failed" ? "idle" : worker.status,
              runtimeReleased: true,
              error: null,
              updatedAt: this.#now()
            });
          }
        );
        if (!claim.claimed) {
          const worker = this.#store.getCollaborationWorker(claim.value.workerId);
          if (!worker.runtimeReleased) this.#leases.set(worker.id, lease);
          else this.#capacity.release(lease.leaseId);
          return { tree: this.#tree(worker.goalId), worker };
        }
        effectClaimed = true;
        this.#leases.set(current.id, lease);
        const prepared = this.#store.getCollaborationWorker(current.id);
        if (prepared.sessionId === undefined) throw new StoreError("The collaboration worker has no Session.");
        await this.#sessionHost.resume(prepared.sessionId);
        const resumedSession = this.#store.getSession(prepared.sessionId);
        const resumedBackend = this.#store.getBackend(resumedSession.descriptor.backendId);
        const claimedOperation = this.#store.getOperation(input.operationId);
        const execution = this.#store.completeDeferredEffectOperation(
          input.operationId,
          claimedOperation.bodyHash,
          (store) => {
            const worker = store.getCollaborationWorker(current.id);
            const updated = store.updateCollaborationWorkerState({
              workerId: worker.id,
              callerLeadSessionId: input.callerLeadSessionId,
              expectedRevision: worker.revision,
              expectedSessionGeneration: worker.sessionGeneration,
              refreshedSessionGeneration: resumedSession.descriptor.binding.generation,
              refreshedBackendInstanceGeneration: resumedBackend.descriptor.instanceGeneration,
              status: "idle",
              runtimeReleased: false,
              error: null,
              updatedAt: this.#now()
            });
            return { workerId: updated.id };
          }
        );
        const worker = this.#store.getCollaborationWorker(execution.value.workerId);
        this.#capacity.markIdle(lease.leaseId);
        return { tree: this.#tree(worker.goalId), worker };
      } catch (error) {
        if (!effectClaimed) {
          this.#capacity.release(lease.leaseId);
          throw error;
        }
        const worker = this.#markWorkerUnknown(input.workerId, "COLLABORATION_WORKER_WAKE_UNKNOWN", error);
        throw new CollaborationGoalManagerError(
          "COLLABORATION_WORKER_WAKE_UNKNOWN",
          worker.lastError?.message ?? "Worker wake outcome could not be confirmed."
        );
      }
    });
  }

  async releaseWorker(input: {
    readonly operationId: string;
    readonly workerId: string;
    readonly callerLeadSessionId: string;
    readonly expectedRevision: bigint;
    readonly expectedSessionGeneration: number;
  }): Promise<{ readonly tree: CollaborationGoalTreeView; readonly worker: CollaborationWorkerRecord }> {
    return this.#withLock(input.workerId, async () => this.#releaseWorkerLocked(input));
  }

  async stopWorker(input: {
    readonly operationId: string;
    readonly workerId: string;
    readonly callerLeadSessionId: string;
    readonly expectedRevision: bigint;
    readonly expectedSessionGeneration?: number;
  }): Promise<{ readonly tree: CollaborationGoalTreeView; readonly worker: CollaborationWorkerRecord }> {
    return this.#withLock(input.workerId, async () => this.#stopWorkerLocked(input));
  }

  archiveWorker(input: {
    readonly operationId: string;
    readonly workerId: string;
    readonly callerLeadSessionId: string;
    readonly expectedRevision: bigint;
  }): { readonly tree: CollaborationGoalTreeView; readonly worker: CollaborationWorkerRecord } {
    this.#assertOpen();
    const execution = this.#store.runOperation(
      {
        id: input.operationId,
        kind: "archive_collaboration_worker",
        body: { ...input, expectedRevision: input.expectedRevision.toString(10) }
      },
      (store) => {
        const current = store.getCollaborationWorker(input.workerId);
        const goal = store.getCollaborationGoal(current.goalId);
        if (goal.status === "archived") {
          throw new StoreError("An archived collaboration Goal cannot archive another worker.");
        }
        const worker = store.updateCollaborationWorkerState({
          workerId: input.workerId,
          callerLeadSessionId: input.callerLeadSessionId,
          expectedRevision: input.expectedRevision,
          status: "archived",
          runtimeReleased: true,
          updatedAt: this.#now()
        });
        if (worker.sessionId !== undefined) {
          const session = store.getSession(worker.sessionId);
          if (!session.descriptor.archived) {
            store.updateSession(
              session.descriptor.id,
              { archived: true },
              session.revision,
              this.#now()
            );
          }
        }
        return { workerId: worker.id, goalId: worker.goalId };
      }
    );
    const lease = this.#leases.get(execution.value.workerId);
    if (lease !== undefined) this.#capacity.release(lease.leaseId);
    this.#leases.delete(execution.value.workerId);
    const worker = this.#store.getCollaborationWorker(execution.value.workerId);
    return { tree: this.#tree(execution.value.goalId), worker };
  }

  async sendMessage(input: {
    readonly operationId: string;
    readonly goalId: string;
    readonly workerId: string;
    readonly callerLeadSessionId: string;
    readonly expectedWorkerRevision: bigint;
    readonly expectedSessionGeneration: number;
    readonly message: string;
  }): Promise<{ readonly tree: CollaborationGoalTreeView; readonly dispatch: CollaborationDispatchRecord }> {
    return this.#withLock(input.workerId, async () => {
      const replay = this.#store.findCollaborationDispatchByOperation(input.operationId);
      if (replay !== undefined) {
        this.#assertDispatchReplay(replay, input);
        return { tree: this.#tree(replay.goalId), dispatch: replay };
      }
      let worker = this.#store.getCollaborationWorker(input.workerId);
      assertWorkerRevision(worker, input.expectedWorkerRevision);
      if (worker.goalId !== input.goalId || worker.sessionId === undefined) {
        throw new StoreError("The collaboration worker is not bound to the selected Goal.");
      }
      if (worker.runtimeReleased) throw new StoreError("Wake the collaboration worker before sending work.");
      if (worker.status === "completed") {
        worker = this.#store.updateCollaborationWorkerState({
          workerId: worker.id,
          callerLeadSessionId: input.callerLeadSessionId,
          expectedRevision: worker.revision,
          expectedSessionGeneration: input.expectedSessionGeneration,
          status: "idle",
          runtimeReleased: false,
          error: null,
          updatedAt: this.#now()
        });
      }
      const sessionId = worker.sessionId;
      if (sessionId === undefined) {
        throw new StoreError("The collaboration worker Session binding was lost before queue admission.");
      }
      const admittedWorker = worker;
      const execution = this.#sessionHost.enqueueServiceInput({
        operationId: input.operationId,
        sessionId,
        prompt: servicePrompt(input.message),
        source: "system",
        originSessionId: input.callerLeadSessionId,
        onAdmitted: (store, result) => {
          const dispatch = store.createCollaborationDispatch({
            goalId: input.goalId,
            workerId: input.workerId,
            callerLeadSessionId: input.callerLeadSessionId,
            expectedWorkerRevision: admittedWorker.revision,
            expectedSessionGeneration: input.expectedSessionGeneration,
            operationId: input.operationId,
            message: input.message,
            createdAt: this.#now()
          });
          store.bindCollaborationDispatchQueue({
            dispatchId: dispatch.id,
            expectedRevision: dispatch.revision,
            queueItemId: result.queueItemId,
            updatedAt: this.#now()
          });
        }
      });
      const dispatch = this.#store.findCollaborationDispatchByOperation(input.operationId);
      if (dispatch === undefined) {
        throw new CollaborationGoalManagerError(
          "COLLABORATION_WORKER_ROUTE_UNAVAILABLE",
          `Queue admission ${execution.value.queueItemId} has no collaboration dispatch binding.`
        );
      }
      const lease = this.#leases.get(worker.id);
      if (lease !== undefined) this.#capacity.markActive(lease.leaseId);
      return { tree: this.#tree(dispatch.goalId), dispatch };
    });
  }

  /** Persist the replacement as the next collaboration Queue item before asking
   * the Backend to stop the unfinished turn. A failed/unsupported abort never
   * drops the replacement and is reported explicitly to the caller. */
  async interruptWorker(input: {
    readonly operationId: string;
    readonly goalId: string;
    readonly workerId: string;
    readonly callerLeadSessionId: string;
    readonly expectedWorkerRevision: bigint;
    readonly expectedSessionGeneration: number;
    readonly message: string;
  }): Promise<{
    readonly tree: CollaborationGoalTreeView;
    readonly dispatch: CollaborationDispatchRecord;
    readonly stopOutcome: CollaborationInterruptStopOutcome;
  }> {
    return this.#withLock(input.workerId, async () => {
      const replay = this.#store.findCollaborationDispatchByOperation(input.operationId);
      if (replay !== undefined) {
        this.#assertDispatchReplay(replay, input);
        return { tree: this.#tree(replay.goalId), dispatch: replay, stopOutcome: "already_queued" };
      }
      const worker = this.#store.getCollaborationWorker(input.workerId);
      assertWorkerRevision(worker, input.expectedWorkerRevision);
      if (worker.goalId !== input.goalId || worker.sessionId === undefined) {
        throw new StoreError("The collaboration worker is not bound to the selected Goal.");
      }
      if (worker.runtimeReleased || ["provisioning", "stopping", "stopped", "archived"].includes(worker.status)) {
        throw new StoreError("The collaboration worker cannot be interrupted in its current state.");
      }
      if (worker.sessionGeneration !== input.expectedSessionGeneration) {
        throw new StoreError("The collaboration worker Session generation changed before interrupt.");
      }
      const goal = this.#store.getCollaborationGoal(worker.goalId);
      if (goal.leadSessionId !== input.callerLeadSessionId) {
        throw new AuthorizationError("Only the collaboration Goal lead Session can interrupt a worker.");
      }
      if (goal.status !== "active") {
        throw new StoreError("Only the active collaboration lead can interrupt a worker.");
      }
      const activeRunIds = activeRunsFor(this.#store, worker.sessionId)
        .filter((run) => run.descriptor.state !== "queued")
        .map((run) => run.descriptor.id);
      const pending = this.#store.listCollaborationDispatches({
        workerId: worker.id,
        statuses: ["queued"]
      }).flatMap((dispatch) => {
        if (dispatch.queueItemId === undefined) return [];
        const queueItem = this.#store.getQueueItem(dispatch.queueItemId);
        return queueItem.state === "accepted" ? [{ dispatch, queueItem }] : [];
      });
      const admittedWorker = worker;
      const execution = this.#sessionHost.enqueueServiceInput({
        operationId: input.operationId,
        sessionId: worker.sessionId,
        prompt: servicePrompt(input.message),
        source: "system",
        originSessionId: input.callerLeadSessionId,
        onAdmitted: (store, result) => {
          const replacement = store.createCollaborationDispatch({
            goalId: input.goalId,
            workerId: input.workerId,
            callerLeadSessionId: input.callerLeadSessionId,
            expectedWorkerRevision: admittedWorker.revision,
            expectedSessionGeneration: input.expectedSessionGeneration,
            operationId: input.operationId,
            message: input.message,
            createdAt: this.#now()
          });
          store.bindCollaborationDispatchQueue({
            dispatchId: replacement.id,
            expectedRevision: replacement.revision,
            queueItemId: result.queueItemId,
            updatedAt: this.#now()
          });
          for (const prior of pending) {
            const currentDispatch = store.getCollaborationDispatch(prior.dispatch.id);
            const currentQueue = store.getQueueItem(prior.queueItem.id);
            if (currentDispatch.status !== "queued" || currentQueue.state !== "accepted") continue;
            store.cancelCollaborationDispatch({
              dispatchId: currentDispatch.id,
              callerLeadSessionId: input.callerLeadSessionId,
              expectedDispatchRevision: currentDispatch.revision,
              expectedQueueRevision: currentQueue.revision,
              traceId: `collaboration:interrupt:${input.operationId}`,
              updatedAt: this.#now()
            });
          }
        }
      });
      const dispatch = this.#store.findCollaborationDispatchByOperation(input.operationId);
      if (dispatch === undefined) {
        throw new CollaborationGoalManagerError(
          "COLLABORATION_WORKER_ROUTE_UNAVAILABLE",
          `Queue admission ${execution.value.queueItemId} has no collaboration dispatch binding.`
        );
      }
      let stopOutcome: CollaborationInterruptStopOutcome = activeRunIds.length === 0 ? "not_running" : "stopped";
      for (const runId of activeRunIds) {
        try {
          await this.#sessionHost.abort(worker.sessionId, runId);
        } catch {
          stopOutcome = "unconfirmed";
        }
      }
      const lease = this.#leases.get(worker.id);
      if (lease !== undefined) this.#capacity.markActive(lease.leaseId);
      return { tree: this.#tree(dispatch.goalId), dispatch, stopOutcome };
    });
  }

  sendWorkerReport(input: {
    readonly operationId: string;
    readonly workerId: string;
    readonly callerWorkerSessionId: string;
    readonly expectedWorkerRevision: bigint;
    readonly expectedWorkerSessionGeneration: number;
    readonly message: string;
  }): EnqueueResult {
    this.#assertOpen();
    const worker = this.#store.getCollaborationWorker(input.workerId);
    if (worker.sessionId !== input.callerWorkerSessionId) {
      throw new AuthorizationError("The collaboration report caller is not the selected worker Session.");
    }
    assertWorkerRevision(worker, input.expectedWorkerRevision);
    if (worker.sessionGeneration !== input.expectedWorkerSessionGeneration) {
      throw new StoreError("The collaboration worker Session generation changed before reporting.");
    }
    const goal = this.#store.getCollaborationGoal(worker.goalId);
    if (goal.status !== "active") {
      throw new StoreError("A worker can report only while its collaboration Goal is active.");
    }
    const execution = this.#sessionHost.enqueueServiceInput({
      operationId: input.operationId,
      sessionId: goal.leadSessionId,
      prompt: servicePrompt(`[From ${worker.label}]\n${input.message}`),
      source: "system",
      originSessionId: worker.sessionId,
      onAdmitted: (store) => {
        const current = store.getCollaborationWorker(worker.id);
        const currentGoal = store.getCollaborationGoal(current.goalId);
        assertWorkerRevision(current, input.expectedWorkerRevision);
        if (currentGoal.id !== goal.id || currentGoal.leadSessionId !== goal.leadSessionId ||
            current.sessionId !== input.callerWorkerSessionId) {
          throw new AuthorizationError("The collaboration report authority changed before Queue admission.");
        }
        if (currentGoal.status !== "active" ||
            current.sessionGeneration !== input.expectedWorkerSessionGeneration) {
          throw new StoreError("The collaboration report state changed before Queue admission.");
        }
      }
    });
    return execution.value;
  }

  editDispatch(input: {
    readonly operationId: string;
    readonly dispatchId: string;
    readonly callerLeadSessionId: string;
    readonly expectedDispatchRevision: bigint;
    readonly expectedQueueRevision: bigint;
    readonly message: string;
  }): { readonly tree: CollaborationGoalTreeView; readonly dispatch: CollaborationDispatchRecord } {
    const execution = this.#store.runOperation(
      {
        id: input.operationId,
        kind: "edit_collaboration_dispatch",
        body: queueMutationBody(input)
      },
      (store) => {
        const dispatch = store.editCollaborationDispatch({
          ...input,
          traceId: `collaboration:${input.operationId}`,
          updatedAt: this.#now()
        });
        return { dispatchId: dispatch.id, goalId: dispatch.goalId };
      }
    );
    const dispatch = this.#store.getCollaborationDispatch(execution.value.dispatchId);
    return { tree: this.#tree(execution.value.goalId), dispatch };
  }

  cancelDispatch(input: {
    readonly operationId: string;
    readonly dispatchId: string;
    readonly callerLeadSessionId: string;
    readonly expectedDispatchRevision: bigint;
    readonly expectedQueueRevision: bigint;
  }): { readonly tree: CollaborationGoalTreeView; readonly dispatch: CollaborationDispatchRecord } {
    const execution = this.#store.runOperation(
      {
        id: input.operationId,
        kind: "cancel_collaboration_dispatch",
        body: queueMutationBody(input)
      },
      (store) => {
        const dispatch = store.cancelCollaborationDispatch({
          ...input,
          traceId: `collaboration:${input.operationId}`,
          updatedAt: this.#now()
        });
        return { dispatchId: dispatch.id, goalId: dispatch.goalId, workerId: dispatch.workerId };
      }
    );
    this.#reconcileWorker(execution.value.workerId);
    const dispatch = this.#store.getCollaborationDispatch(execution.value.dispatchId);
    return { tree: this.#tree(execution.value.goalId), dispatch };
  }

  mergeDispatches(input: {
    readonly operationId: string;
    readonly goalId: string;
    readonly workerId: string;
    readonly callerLeadSessionId: string;
    readonly dispatches: MergeCollaborationDispatchesInput["dispatches"];
  }): { readonly tree: CollaborationGoalTreeView; readonly dispatches: readonly CollaborationDispatchRecord[] } {
    const execution = this.#store.runOperation(
      {
        id: input.operationId,
        kind: "merge_collaboration_dispatches",
        body: {
          ...input,
          dispatches: input.dispatches.map((item) => ({
            dispatchId: item.dispatchId,
            expectedDispatchRevision: item.expectedDispatchRevision.toString(10),
            expectedQueueRevision: item.expectedQueueRevision.toString(10)
          }))
        }
      },
      (store) => ({
        goalId: input.goalId,
        dispatchIds: store.mergeCollaborationDispatches({
          goalId: input.goalId,
          workerId: input.workerId,
          callerLeadSessionId: input.callerLeadSessionId,
          dispatches: input.dispatches,
          traceId: `collaboration:${input.operationId}`,
          updatedAt: this.#now()
        }).map((dispatch) => dispatch.id)
      })
    );
    return {
      tree: this.#tree(execution.value.goalId),
      dispatches: execution.value.dispatchIds.map((id) => this.#store.getCollaborationDispatch(id))
    };
  }

  async #retireGoalWorkers(
    input: {
      readonly operationId: string;
      readonly goalId: string;
      readonly callerLeadSessionId: string;
      readonly signal?: AbortSignal;
    },
    stopBeforeArchive: boolean
  ): Promise<void> {
    for (const candidate of this.#store.listCollaborationWorkers({
      goalId: input.goalId,
      includeArchived: true
    })) {
      input.signal?.throwIfAborted();
      let worker = this.#store.getCollaborationWorker(candidate.id);
      if (worker.status === "archived") continue;
      if (stopBeforeArchive && worker.status !== "stopped") {
        worker = await this.#withLock(worker.id, async () => {
          const latest = this.#store.getCollaborationWorker(worker.id);
          if (latest.status === "archived" || latest.status === "stopped") return latest;
          return (await this.#stopWorkerLocked({
            operationId: serviceOperationId(`${input.operationId}:${latest.id}`, "goal-stop-worker"),
            workerId: latest.id,
            callerLeadSessionId: input.callerLeadSessionId,
            expectedRevision: latest.revision,
            ...(latest.sessionGeneration === undefined
              ? {}
              : { expectedSessionGeneration: latest.sessionGeneration })
          })).worker;
        });
      } else if (!stopBeforeArchive && !worker.runtimeReleased) {
        worker = await this.#withLock(worker.id, async () => {
          const latest = this.#store.getCollaborationWorker(worker.id);
          if (latest.runtimeReleased) return latest;
          if (latest.sessionGeneration === undefined || !["idle", "completed", "failed"].includes(latest.status)) {
            throw new StoreError("A collaboration Goal can archive only after every worker is terminal or idle.");
          }
          return (await this.#releaseWorkerLocked({
            operationId: serviceOperationId(`${input.operationId}:${latest.id}`, "goal-release-worker"),
            workerId: latest.id,
            callerLeadSessionId: input.callerLeadSessionId,
            expectedRevision: latest.revision,
            expectedSessionGeneration: latest.sessionGeneration
          })).worker;
        });
      }
      input.signal?.throwIfAborted();
      if (worker.status !== "archived") {
        this.archiveWorker({
          operationId: serviceOperationId(`${input.operationId}:${worker.id}`, "goal-archive-worker"),
          workerId: worker.id,
          callerLeadSessionId: input.callerLeadSessionId,
          expectedRevision: worker.revision
        });
      }
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    await Promise.allSettled([...this.#locks.values()]);
    this.#locks.clear();
    await this.#capacity.close();
    this.#leases.clear();
  }

  async #resumeProvisioning(workerId: string, recovering: boolean): Promise<CollaborationWorkerRecord> {
    let worker = this.#store.getCollaborationWorker(workerId);
    if (worker.status !== "provisioning") return worker;
    const goal = this.#store.getCollaborationGoal(worker.goalId);
    const sessionOperationId = serviceOperationId(worker.createOperationId, "session");
    const sessionOperation = this.#store.findOperation<{ readonly sessionId: string }>(sessionOperationId);
    if (sessionOperation?.status === "started") {
      worker = this.#markWorkerUnknown(worker.id, "COLLABORATION_WORKER_CREATE_UNKNOWN",
        new Error("Worker Session creation was interrupted before its outcome was confirmed."));
      if (!recovering) throw new CollaborationGoalManagerError(
        "COLLABORATION_WORKER_CREATE_UNKNOWN",
        worker.lastError?.message ?? "Worker Session creation is uncertain."
      );
      return worker;
    }
    if (sessionOperation?.status === "failed") {
      return this.#markWorkerFailed(worker.id, sessionOperation.error);
    }
    try {
      const created = await this.#sessionHost.createServiceSession({
        operationId: sessionOperationId,
        serviceKind: "collaboration",
        targetId: worker.targetId,
        title: `${goal.title} · ${worker.label}`,
        ...(worker.providerId === undefined ? {} : { providerId: worker.providerId }),
        ...(worker.modelId === undefined ? {} : { modelId: worker.modelId }),
        ...(worker.effort === undefined ? {} : { effort: worker.effort }),
        fastMode: worker.fastMode,
        permissionMode: worker.permissionMode,
        planMode: worker.planMode,
        appendSystemPrompt: workerSystemPrompt(goal, worker)
      });
      const operation = this.#store.getOperation(worker.createOperationId);
      const completed = this.#store.completeDeferredEffectOperation(
        worker.createOperationId,
        operation.bodyHash,
        (store) => {
          const current = store.getCollaborationWorker(workerId);
          const session = store.getSession(created.value.sessionId);
          const backend = store.getBackend(session.descriptor.backendId);
          const bound = store.bindCollaborationWorkerSession({
            workerId: current.id,
            callerLeadSessionId: goal.leadSessionId,
            expectedRevision: current.revision,
            sessionId: session.descriptor.id,
            expectedSessionGeneration: session.descriptor.binding.generation,
            expectedBackendInstanceGeneration: backend.descriptor.instanceGeneration,
            updatedAt: this.#now()
          });
          return { workerId: bound.id };
        }
      );
      worker = this.#store.getCollaborationWorker(completed.value.workerId);
      const lease = this.#leases.get(worker.id);
      if (lease !== undefined) this.#capacity.markIdle(lease.leaseId);
      return worker;
    } catch (error) {
      const effect = this.#store.findOperation(sessionOperationId);
      if (effect?.status === "started") {
        worker = this.#markWorkerUnknown(worker.id, "COLLABORATION_WORKER_CREATE_UNKNOWN", error);
      } else {
        worker = this.#markWorkerFailed(worker.id, error);
        const operation = this.#store.findOperation(worker.createOperationId);
        if (operation?.status === "started") {
          this.#store.failEffectOperation(operation.id, operation.bodyHash, error);
        }
      }
      if (!recovering) throw error;
      return worker;
    }
  }

  async #ensureInitialAssignment(workerId: string): Promise<CollaborationWorkerRecord> {
    let worker = this.#store.getCollaborationWorker(workerId);
    if (worker.sessionId === undefined || worker.sessionGeneration === undefined || worker.runtimeReleased || [
      "provisioning", "failed", "stopping", "stopped", "dispatch_unknown", "archived"
    ].includes(worker.status)) return worker;
    const operationId = serviceOperationId(worker.createOperationId, "initial-assignment");
    if (this.#store.findCollaborationDispatchByOperation(operationId) !== undefined) {
      return this.#reconcileWorker(worker.id);
    }
    const goal = this.#store.getCollaborationGoal(worker.goalId);
    await this.sendMessage({
      operationId,
      goalId: goal.id,
      workerId: worker.id,
      callerLeadSessionId: goal.leadSessionId,
      expectedWorkerRevision: worker.revision,
      expectedSessionGeneration: worker.sessionGeneration,
      message: worker.assignment
    });
    worker = this.#reconcileWorker(worker.id);
    return worker;
  }

  async #resumeStop(workerId: string, recovering: boolean): Promise<CollaborationWorkerRecord> {
    let worker = this.#store.getCollaborationWorker(workerId);
    if (worker.status !== "stopping") return worker;
    try {
      if (worker.sessionId !== undefined) {
        for (const dispatch of this.#store.listCollaborationDispatches({
          workerId: worker.id,
          statuses: ["queued"]
        })) {
          if (dispatch.queueItemId === undefined) continue;
          const queue = this.#store.getQueueItem(dispatch.queueItemId);
          if (["accepted", "dispatching", "backend_accepted", "dispatch_unknown"].includes(queue.state)) {
            this.#store.cancelCollaborationDispatch({
              dispatchId: dispatch.id,
              callerLeadSessionId: dispatch.callerLeadSessionId,
              expectedDispatchRevision: dispatch.revision,
              expectedQueueRevision: queue.revision,
              traceId: `collaboration:stop:${worker.id}`,
              updatedAt: this.#now()
            });
          }
        }
        const activeRuns = activeRunsFor(this.#store, worker.sessionId);
        const mustAbort = activeRuns.filter((run) => run.descriptor.state !== "queued");
        if (recovering && mustAbort.length > 0 && !this.#sessionHost.isSessionActive(worker.sessionId)) {
          throw new CollaborationGoalManagerError(
            "COLLABORATION_WORKER_STOP_UNKNOWN",
            "Worker stop was interrupted while native work remained active."
          );
        }
        for (const run of mustAbort) await this.#sessionHost.abort(worker.sessionId, run.descriptor.id);
        await this.#sessionHost.closeIfActive(worker.sessionId);
      }
      const operation = this.#store.getOperation(
        this.#findStartedWorkerOperation(worker.id, "stop_collaboration_worker")
      );
      const completed = this.#store.completeDeferredEffectOperation(
        operation.id,
        operation.bodyHash,
        (store) => {
          const current = store.getCollaborationWorker(workerId);
          if (current.sessionId !== undefined) {
            for (const run of activeRunsFor(store, current.sessionId)) {
              store.updateRunState({
                runId: run.descriptor.id,
                state: "aborted",
                endedAt: this.#now(),
                traceId: `collaboration:stop:${current.id}`,
                operationId: operation.id
              });
            }
          }
          const stopped = store.updateCollaborationWorkerState({
            workerId: current.id,
            callerLeadSessionId: store.getCollaborationGoal(current.goalId).leadSessionId,
            expectedRevision: current.revision,
            status: "stopped",
            runtimeReleased: true,
            error: null,
            updatedAt: this.#now()
          });
          return { workerId: stopped.id };
        }
      );
      worker = this.#store.getCollaborationWorker(completed.value.workerId);
      const lease = this.#leases.get(worker.id);
      if (lease !== undefined) this.#capacity.release(lease.leaseId);
      this.#leases.delete(worker.id);
      return worker;
    } catch (error) {
      worker = this.#markWorkerUnknown(worker.id, "COLLABORATION_WORKER_STOP_UNKNOWN", error);
      if (!recovering) throw error;
      return worker;
    }
  }

  async #stopWorkerLocked(input: {
    readonly operationId: string;
    readonly workerId: string;
    readonly callerLeadSessionId: string;
    readonly expectedRevision: bigint;
    readonly expectedSessionGeneration?: number;
  }): Promise<{ readonly tree: CollaborationGoalTreeView; readonly worker: CollaborationWorkerRecord }> {
    const claim = this.#store.claimDeferredEffectOperation<{ readonly workerId: string }>(
      {
        id: input.operationId,
        kind: "stop_collaboration_worker",
        body: {
          ...input,
          expectedRevision: input.expectedRevision.toString(10),
          expectedSessionGeneration: input.expectedSessionGeneration ?? null
        }
      },
      (store) => {
        const worker = store.getCollaborationWorker(input.workerId);
        assertWorkerRevision(worker, input.expectedRevision);
        const goal = store.getCollaborationGoal(worker.goalId);
        if (goal.status === "archived") {
          throw new StoreError("An archived collaboration Goal cannot stop a worker.");
        }
        store.updateCollaborationWorkerState({
          workerId: worker.id,
          callerLeadSessionId: input.callerLeadSessionId,
          expectedRevision: worker.revision,
          ...(input.expectedSessionGeneration === undefined
            ? {}
            : { expectedSessionGeneration: input.expectedSessionGeneration }),
          status: "stopping",
          runtimeReleased: false,
          error: null,
          updatedAt: this.#now()
        });
      }
    );
    if (!claim.claimed) {
      const worker = this.#store.getCollaborationWorker(claim.value.workerId);
      return { tree: this.#tree(worker.goalId), worker };
    }
    const worker = await this.#resumeStop(input.workerId, false);
    return { tree: this.#tree(worker.goalId), worker };
  }

  async #releaseWorkerLocked(input: {
    readonly operationId: string;
    readonly workerId: string;
    readonly callerLeadSessionId: string;
    readonly expectedRevision: bigint;
    readonly expectedSessionGeneration: number;
  }): Promise<{ readonly tree: CollaborationGoalTreeView; readonly worker: CollaborationWorkerRecord }> {
    const claim = this.#store.claimDeferredEffectOperation<{ readonly workerId: string }>(
      {
        id: input.operationId,
        kind: "release_collaboration_worker",
        body: { ...input, expectedRevision: input.expectedRevision.toString(10) }
      },
      (store) => {
        const worker = store.getCollaborationWorker(input.workerId);
        assertWorkerRevision(worker, input.expectedRevision);
        const goal = store.getCollaborationGoal(worker.goalId);
        if (goal.leadSessionId !== input.callerLeadSessionId) {
          throw new AuthorizationError("Only the collaboration lead can release a worker runtime.");
        }
        if (goal.status === "archived") {
          throw new StoreError("An archived collaboration Goal cannot release a worker runtime.");
        }
        if (worker.sessionId === undefined || worker.sessionGeneration !== input.expectedSessionGeneration) {
          throw new StoreError("The collaboration worker Session generation changed before release.");
        }
        if (worker.runtimeReleased) return;
        if (!["idle", "completed", "failed"].includes(worker.status)) {
          throw new StoreError("Only a proven-idle collaboration worker can release its runtime.");
        }
        if (activeRunsFor(store, worker.sessionId).length > 0 || store.listQueueItems({
          sessionId: worker.sessionId,
          states: ["accepted", "dispatching", "backend_accepted", "dispatch_unknown"]
        }).length > 0) {
          throw new StoreError("A collaboration worker with active work cannot release its runtime.");
        }
      }
    );
    if (!claim.claimed) {
      const worker = this.#store.getCollaborationWorker(claim.value.workerId);
      return { tree: this.#tree(worker.goalId), worker };
    }
    try {
      const worker = this.#store.getCollaborationWorker(input.workerId);
      if (worker.sessionId !== undefined) await this.#sessionHost.closeIfActive(worker.sessionId);
      const operation = this.#store.getOperation(input.operationId);
      const completed = this.#store.completeDeferredEffectOperation(
        operation.id,
        operation.bodyHash,
        (store) => {
          const current = store.getCollaborationWorker(input.workerId);
          const released = current.runtimeReleased
            ? current
            : store.updateCollaborationWorkerState({
                workerId: current.id,
                callerLeadSessionId: input.callerLeadSessionId,
                expectedRevision: current.revision,
                expectedSessionGeneration: input.expectedSessionGeneration,
                status: current.status,
                runtimeReleased: true,
                updatedAt: this.#now()
              });
          return { workerId: released.id };
        }
      );
      const released = this.#store.getCollaborationWorker(completed.value.workerId);
      const lease = this.#leases.get(released.id);
      if (lease !== undefined) this.#capacity.release(lease.leaseId);
      this.#leases.delete(released.id);
      return { tree: this.#tree(released.goalId), worker: released };
    } catch (error) {
      const worker = this.#markWorkerUnknown(input.workerId, "COLLABORATION_WORKER_RELEASE_UNKNOWN", error);
      throw new CollaborationGoalManagerError(
        "COLLABORATION_WORKER_RELEASE_UNKNOWN",
        worker.lastError?.message ?? "Worker runtime release could not be confirmed."
      );
    }
  }

  async #releaseIdleLease(lease: WorkerCapacityLease): Promise<void> {
    const worker = this.#store.findCollaborationWorker(lease.workerId);
    if (worker === undefined || worker.runtimeReleased || worker.sessionGeneration === undefined) {
      this.#leases.delete(lease.workerId);
      return;
    }
    const goal = this.#store.getCollaborationGoal(worker.goalId);
    await this.#withLock(worker.id, async () => {
      await this.#releaseWorkerLocked({
        operationId: serviceOperationId(`${worker.id}:${worker.revision.toString(10)}`, "idle-release"),
        workerId: worker.id,
        callerLeadSessionId: goal.leadSessionId,
        expectedRevision: worker.revision,
        expectedSessionGeneration: worker.sessionGeneration!
      });
    });
  }

  #recoverPreparingDispatches(): void {
    for (const dispatch of this.#store.listCollaborationDispatches({ statuses: ["preparing"] })) {
      const operation = this.#store.findOperation<EnqueueResult>(dispatch.operationId);
      if (operation?.status === "completed" && operation.response !== undefined) {
        this.#store.bindCollaborationDispatchQueue({
          dispatchId: dispatch.id,
          expectedRevision: dispatch.revision,
          queueItemId: operation.response.queueItemId,
          updatedAt: this.#now()
        });
      } else {
        this.#store.markCollaborationDispatchUnknown({
          dispatchId: dispatch.id,
          expectedRevision: dispatch.revision,
          updatedAt: this.#now()
        });
      }
    }
  }

  #recoverInterruptedLifecycleEffects(): void {
    for (const operation of this.#store.listOperations({ status: "started", limit: 100_000 })) {
      const code = operation.kind === "wake_collaboration_worker"
        ? "COLLABORATION_WORKER_WAKE_UNKNOWN" as const
        : operation.kind === "release_collaboration_worker"
          ? "COLLABORATION_WORKER_RELEASE_UNKNOWN" as const
          : undefined;
      if (code === undefined || !isRecord(operation.body)) continue;
      const workerId = operation.body["workerId"];
      if (typeof workerId !== "string") continue;
      const worker = this.#store.findCollaborationWorker(workerId);
      if (worker === undefined || worker.status === "archived" || worker.status === "stopped") continue;
      if (worker.status === "dispatch_unknown" && worker.lastError?.code === code) continue;
      this.#markWorkerUnknown(
        worker.id,
        code,
        new Error(`${operation.kind} was interrupted before its native outcome was confirmed.`)
      );
    }
  }

  #reconcileWorker(workerId: string): CollaborationWorkerRecord {
    let worker = this.#store.getCollaborationWorker(workerId);
    if (worker.status === "dispatch_unknown" && worker.lastError !== undefined
      && unresolvedWorkerEffectCode(worker.lastError.code)) return worker;
    if (worker.sessionId === undefined || worker.runtimeReleased || [
      "provisioning", "stopping", "stopped", "archived"
    ].includes(worker.status)) return worker;
    const queues = this.#store.listQueueItems({
      sessionId: worker.sessionId,
      states: ["accepted", "dispatching", "backend_accepted", "dispatch_unknown"]
    });
    const runs = activeRunsFor(this.#store, worker.sessionId);
    const unknown = queues.some((item) => item.state === "dispatch_unknown")
      || runs.some((run) => run.descriptor.state === "dispatch_unknown");
    const running = queues.some((item) => item.state === "dispatching" || item.state === "backend_accepted")
      || runs.some((run) => ["running", "waiting", "retrying"].includes(run.descriptor.state));
    const queued = queues.some((item) => item.state === "accepted")
      || runs.some((run) => run.descriptor.state === "queued");
    let status: CollaborationWorkerRecord["status"];
    let error: PublicError | null | undefined;
    if (unknown) {
      status = "dispatch_unknown";
    } else if (running) {
      status = "running";
    } else if (queued) {
      status = "queued";
    } else {
      const latest = this.#store.listRuns({ sessionId: worker.sessionId, limit: 1 })[0];
      status = latest?.descriptor.state === "completed"
        ? "completed"
        : latest?.descriptor.state === "failed"
          ? "failed"
          : "idle";
      error = latest?.descriptor.state === "failed" ? latest.descriptor.error ?? null : null;
    }
    const settled = status === "idle" || status === "completed" || status === "failed";
    if (worker.status !== status || (settled && worker.idleSince === undefined) ||
        (!settled && worker.idleSince !== undefined)) {
      try {
        worker = this.#store.updateCollaborationWorkerState({
          workerId: worker.id,
          expectedRevision: worker.revision,
          expectedSessionGeneration: worker.sessionGeneration,
          status,
          runtimeReleased: false,
          idleSince: settled ? this.#now() : null,
          ...(error === undefined ? {} : { error }),
          updatedAt: this.#now()
        });
      } catch {
        worker = this.#store.getCollaborationWorker(worker.id);
      }
    }
    const lease = this.#leases.get(worker.id);
    if (lease !== undefined) {
      if (settled) this.#capacity.markIdle(lease.leaseId);
      else this.#capacity.markActive(lease.leaseId);
    }
    return worker;
  }

  #tree(goalId: string): CollaborationGoalTreeView {
    const goal = this.#store.getCollaborationGoal(goalId);
    const workers = this.#store.listCollaborationWorkers({ goalId, includeArchived: true });
    const queue = this.#store.listCollaborationDispatches({ goalId }).map((dispatch) => {
      const queueItem = dispatch.queueItemId === undefined
        ? undefined
        : this.#store.getQueueItem(dispatch.queueItemId);
      return { dispatch, ...(queueItem === undefined ? {} : { queueItem }) };
    });
    return {
      goal,
      workers,
      queue,
      ...(() => {
        const focused = workers.find((worker) => worker.focused && worker.status !== "archived");
        return focused === undefined ? {} : { focusedWorkerId: focused.id };
      })()
    };
  }

  #restoreLease(worker: CollaborationWorkerRecord): WorkerCapacityLease {
    const lease = this.#capacity.restore({
      ownerId: worker.goalId,
      workerId: worker.id,
      state: ["idle", "completed", "failed"].includes(worker.status) ? "idle" : "active",
      acquiredAt: worker.createdAt,
      ...(worker.idleSince === undefined ? {} : { idleSince: worker.idleSince })
    });
    this.#leases.set(worker.id, lease);
    return lease;
  }

  #ensureRestoredLease(worker: CollaborationWorkerRecord): WorkerCapacityLease | undefined {
    if (!occupiesCapacity(worker)) return undefined;
    return this.#leases.get(worker.id) ?? this.#restoreLease(worker);
  }

  #markWorkerUnknown(workerId: string, code: string, error: unknown): CollaborationWorkerRecord {
    const current = this.#store.getCollaborationWorker(workerId);
    if (current.status === "archived" || current.status === "stopped") return current;
    return this.#store.updateCollaborationWorkerState({
      workerId: current.id,
      expectedRevision: current.revision,
      status: "dispatch_unknown",
      runtimeReleased: false,
      idleSince: null,
      error: collaborationPublicError(code, error, true),
      updatedAt: this.#now()
    });
  }

  #markWorkerFailed(workerId: string, error: unknown): CollaborationWorkerRecord {
    const current = this.#store.getCollaborationWorker(workerId);
    const failed = this.#store.updateCollaborationWorkerState({
      workerId: current.id,
      expectedRevision: current.revision,
      status: "failed",
      runtimeReleased: true,
      idleSince: this.#now(),
      error: collaborationPublicError("COLLABORATION_WORKER_CREATE_FAILED", error, false),
      updatedAt: this.#now()
    });
    const lease = this.#leases.get(workerId);
    if (lease !== undefined) this.#capacity.release(lease.leaseId);
    this.#leases.delete(workerId);
    return failed;
  }

  #findStartedWorkerOperation(workerId: string, kind: string): string {
    const operation = this.#store.listOperations({ status: "started", limit: 100_000 })
      .find((candidate) => candidate.kind === kind && isRecord(candidate.body)
        && candidate.body["workerId"] === workerId);
    if (operation === undefined) {
      throw new OperationInProgressError(`missing-${kind}-${workerId}`);
    }
    return operation.id;
  }

  #assertWorkerOperationBody(operationId: string, body: unknown): void {
    const operation = this.#store.getOperation(operationId);
    if (operation.bodyHash !== operationBodyHash(body)) {
      throw new StoreError(`Operation ${operationId} was reused with different collaboration input.`);
    }
  }

  #assertDispatchReplay(
    dispatch: CollaborationDispatchRecord,
    input: {
      readonly operationId: string;
      readonly goalId: string;
      readonly workerId: string;
      readonly callerLeadSessionId: string;
      readonly expectedSessionGeneration: number;
      readonly message: string;
    }
  ): void {
    const worker = this.#store.getCollaborationWorker(input.workerId);
    const goal = this.#store.getCollaborationGoal(input.goalId);
    const operation = this.#store.getOperation(input.operationId ?? dispatch.operationId);
    if (
      operation.kind !== "service_send_input" || operation.status !== "completed" ||
      dispatch.operationId !== operation.id || dispatch.goalId !== goal.id ||
      dispatch.workerId !== worker.id || dispatch.callerLeadSessionId !== input.callerLeadSessionId ||
      dispatch.message !== input.message || goal.leadSessionId !== input.callerLeadSessionId ||
      goal.status !== "active" || worker.sessionGeneration !== input.expectedSessionGeneration ||
      worker.sessionId === undefined || worker.runtimeReleased || worker.status === "archived"
    ) {
      throw new StoreError(`Operation ${operation.id} was reused with different collaboration input or authority.`);
    }
  }

  #withLock<T>(key: string, action: () => Promise<T>): Promise<T> {
    const predecessor = this.#locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = predecessor.catch(() => undefined).then(() => gate);
    this.#locks.set(key, tail);
    return predecessor.catch(() => undefined).then(action).finally(() => {
      release();
      if (this.#locks.get(key) === tail) this.#locks.delete(key);
    });
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("Collaboration Goal manager is closed.");
  }
}

function unresolvedWorkerEffectCode(code: string): boolean {
  return code === "COLLABORATION_WORKER_CREATE_UNKNOWN"
    || code === "COLLABORATION_WORKER_WAKE_UNKNOWN"
    || code === "COLLABORATION_WORKER_STOP_UNKNOWN"
    || code === "COLLABORATION_WORKER_RELEASE_UNKNOWN";
}

function activeRunsFor(store: OperationalStore, sessionId: string): StoredRun[] {
  return store.listRuns({ sessionId, activeOnly: true });
}

function occupiesCapacity(worker: CollaborationWorkerRecord): boolean {
  return !worker.runtimeReleased && !["stopped", "archived"].includes(worker.status);
}

function assertWorkerRevision(worker: CollaborationWorkerRecord, expected: bigint): void {
  if (worker.revision !== expected) {
    throw new RevisionConflictError("Collaboration worker", worker.id, expected, worker.revision);
  }
}

function collaborationId(prefix: string, seed: string): string {
  return `${prefix}:${seed}`.slice(0, 256);
}

function serviceOperationId(seed: string, kind: string): string {
  return `${kind}:${createHash("sha256").update(seed).digest("hex")}`;
}

function workerSystemPrompt(goal: CollaborationGoalRecord, worker: CollaborationWorkerRecord): string {
  return [
    "# Collaboration worker",
    `You are the durable worker ${JSON.stringify(worker.label)} with role ${JSON.stringify(worker.role)}.`,
    "Work only on assignments sent by the lead task. Preserve concrete evidence in this visible task and report concise results.",
    "# Goal",
    goal.objective,
    "# Initial assignment",
    worker.assignment
  ].join("\n\n");
}

function servicePrompt(text: string): PromptInput {
  return { text, images: [], files: [], mentions: [], disposition: "prompt" };
}

function createWorkerOperationBody(input: {
  readonly goalId: string;
  readonly callerLeadSessionId: string;
  readonly expectedGoalRevision: bigint;
  readonly parentWorkerId?: string;
  readonly label: string;
  readonly role: string;
  readonly assignment: string;
  readonly route: WorkerRouteInput;
}): unknown {
  return {
    ...input,
    expectedGoalRevision: input.expectedGoalRevision.toString(10),
    parentWorkerId: input.parentWorkerId ?? null
  };
}

function queueMutationBody(input: {
  readonly dispatchId: string;
  readonly callerLeadSessionId: string;
  readonly expectedDispatchRevision: bigint;
  readonly expectedQueueRevision: bigint;
  readonly message?: string;
}): unknown {
  return {
    ...input,
    expectedDispatchRevision: input.expectedDispatchRevision.toString(10),
    expectedQueueRevision: input.expectedQueueRevision.toString(10)
  };
}

function collaborationPublicError(code: string, error: unknown, stateMayHaveChanged: boolean): PublicError {
  return toPublicError(error, {
    code,
    phase: "collaboration",
    retryable: true,
    stateMayHaveChanged,
    recovery: stateMayHaveChanged
      ? "Inspect the durable worker and Queue state before retrying."
      : "Correct the worker route or retry the action."
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
