import { createHash, randomUUID } from "node:crypto";

import type { EventPayload, PublicError } from "@joko/core";
import {
  InvalidStateTransitionError,
  RevisionConflictError,
  StaleGenerationError,
  StoreError,
  type ObjectiveLimits,
  type ObjectiveRecord,
  type ObjectiveStatus,
  type OperationalStore,
  type PersistedEvent,
  type QueueItemRecord,
  type StoredRun
} from "@joko/store";

import { buildFirstObjectiveDirective, buildObjectiveContinuationDirective } from "./objective-directive.js";
import { parseObjectiveVerdict } from "./objective-verdict.js";
import {
  clearProviderRateLimit,
  currentProviderRateLimit,
  providerRateLimitFromError,
  providerRateLimitSettingKey
} from "./provider-rate-limit.js";
import type { EnqueueResult, SessionHost } from "./session-host.js";

const EVENT_PAGE_SIZE = 1_000;
const DISPATCH_REJECTION_MAXIMUM = 4;
const DISPATCH_REJECTION_BASE_DELAY_MS = 500;
const DISPATCH_REJECTION_MAX_DELAY_MS = 4_000;
const OVERLOAD_RESUME_DELAY_MS = 60_000;
const OVERLOAD_MAXIMUM = 3;
const DEFAULT_NO_PROGRESS_TURN_LIMIT = 3;

type ObjectiveSessionHost = Pick<
  SessionHost,
  "enqueueServiceInput" | "requestQueueDrain" | "abort" | "isSessionActive"
>;

export interface ObjectiveManagerOptions {
  readonly store: OperationalStore;
  readonly sessionHost: ObjectiveSessionHost;
  readonly now?: () => number;
}

export interface SetObjectiveInput extends ObjectiveLimits {
  readonly operationId: string;
  readonly sessionId: string;
  readonly text: string;
  readonly expectedSessionGeneration?: number;
}

export interface UpdateObjectiveMutationInput {
  readonly operationId: string;
  readonly sessionId: string;
  readonly expectedRevision: bigint;
  readonly expectedOwnerGeneration: number;
  readonly text?: string;
  readonly tokenBudget?: number | null;
  readonly maximumTurns?: number | null;
  readonly noProgressTurnLimit?: number | null;
}

export interface ObjectiveFenceInput {
  readonly operationId: string;
  readonly sessionId: string;
  readonly expectedRevision: bigint;
  readonly expectedOwnerGeneration: number;
}

export interface PauseObjectiveInput extends ObjectiveFenceInput {
  readonly reason?: string;
}

export type ObjectiveListener = (objective: ObjectiveRecord | undefined) => void;

interface PendingInspection {
  readonly queue?: QueueItemRecord;
  readonly run?: StoredRun;
  readonly clear: boolean;
  readonly abortRunId?: string;
  readonly unknown: boolean;
}

interface TurnEvidence {
  readonly assistantText: string;
  readonly sawToolUse: boolean;
  readonly tokens: number;
}

/** Single-Session autonomous Objective owner. Collaboration Goals are not part of this lifecycle. */
export class ObjectiveManager {
  readonly #store: OperationalStore;
  readonly #sessionHost: ObjectiveSessionHost;
  readonly #now: () => number;
  readonly #locks = new Map<string, Promise<void>>();
  readonly #listeners = new Map<string, Set<ObjectiveListener>>();
  readonly #usageTimers = new Map<string, { readonly at: number; readonly timer: NodeJS.Timeout }>();
  readonly #dispatchTimers = new Map<string, NodeJS.Timeout>();
  #unsubscribe?: () => void;
  #closed = false;

  constructor(options: ObjectiveManagerOptions) {
    this.#store = options.store;
    this.#sessionHost = options.sessionHost;
    this.#now = options.now ?? Date.now;
  }

  async initialize(): Promise<void> {
    this.#assertOpen();
    if (this.#unsubscribe !== undefined) return;
    this.#unsubscribe = this.#store.subscribe((event) => {
      if (event.sessionId === "") return;
      if (this.#store.findObjective(event.sessionId) === undefined) return;
      void this.#reconcile(event.sessionId, false);
    });
    for (const objective of this.#store.listObjectives()) {
      await this.#reconcile(
        objective.sessionId,
        objectiveSessionEligible(this.#store, objective.sessionId)
      );
    }
  }

  get(sessionId: string): ObjectiveRecord | undefined {
    this.#assertOpen();
    this.#store.getSession(sessionId);
    return this.#store.findObjective(sessionId);
  }

  subscribe(sessionId: string, listener: ObjectiveListener): () => void {
    this.#assertOpen();
    this.#store.getSession(sessionId);
    const listeners = this.#listeners.get(sessionId) ?? new Set<ObjectiveListener>();
    listeners.add(listener);
    this.#listeners.set(sessionId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.#listeners.delete(sessionId);
    };
  }

  async set(input: SetObjectiveInput): Promise<ObjectiveRecord> {
    let abortRunId: string | undefined;
    await this.#withLock(input.sessionId, async () => {
      this.#assertOpen();
      const execution = this.#store.runOperation(
        {
          id: input.operationId,
          kind: "set_objective",
          body: {
            sessionId: input.sessionId,
            text: input.text,
            tokenBudget: input.tokenBudget ?? null,
            maximumTurns: input.maximumTurns ?? null,
            noProgressTurnLimit: input.noProgressTurnLimit ?? DEFAULT_NO_PROGRESS_TURN_LIMIT,
            expectedSessionGeneration: input.expectedSessionGeneration ?? null
          }
        },
        (store) => {
          const previous = store.findObjective(input.sessionId);
          const pending = previous === undefined ? undefined : inspectPending(store, previous);
          if (pending?.queue?.state === "accepted") {
            cancelAcceptedObjectivePending(store, pending, `objective:set:${input.operationId}`, this.#now());
          }
          let objective = store.putObjective({
            sessionId: input.sessionId,
            text: input.text,
            ...(input.tokenBudget === undefined ? {} : { tokenBudget: input.tokenBudget }),
            ...(input.maximumTurns === undefined ? {} : { maximumTurns: input.maximumTurns }),
            noProgressTurnLimit: input.noProgressTurnLimit ?? DEFAULT_NO_PROGRESS_TURN_LIMIT,
            ...(input.expectedSessionGeneration === undefined
              ? {}
              : { expectedSessionGeneration: input.expectedSessionGeneration }),
            updatedAt: this.#now()
          });
          if (pending !== undefined && clearsAfterKnownCancellation(pending)) {
            objective = store.updateObjective({
              sessionId: objective.sessionId,
              expectedRevision: objective.revision,
              expectedOwnerGeneration: objective.ownerGeneration,
              clearPending: true,
              updatedAt: this.#now()
            });
          } else if (pending?.unknown === true) {
            objective = store.updateObjective({
              sessionId: objective.sessionId,
              expectedRevision: objective.revision,
              expectedOwnerGeneration: objective.ownerGeneration,
              status: "dispatch_unknown",
              updatedAt: this.#now()
            });
          }
          appendObjectiveLifecycle(
            store,
            objective,
            previous === undefined ? "started" : "replaced",
            this.#now()
          );
          abortRunId = pending?.abortRunId;
          return { sessionId: objective.sessionId };
        }
      );
      if (execution.replayed) abortRunId = undefined;
    });
    if (abortRunId !== undefined) await this.#abortOwned(input.sessionId, abortRunId);
    this.#publish(input.sessionId);
    await this.#reconcile(input.sessionId, true);
    return this.#store.getObjective(input.sessionId);
  }

  async update(input: UpdateObjectiveMutationInput): Promise<ObjectiveRecord> {
    let abortRunId: string | undefined;
    await this.#withLock(input.sessionId, async () => {
      this.#assertOpen();
      const execution = this.#store.runOperation(
        {
          id: input.operationId,
          kind: "update_objective",
          body: {
            sessionId: input.sessionId,
            expectedRevision: input.expectedRevision.toString(10),
            expectedOwnerGeneration: input.expectedOwnerGeneration,
            text: input.text ?? null,
            tokenBudget: input.tokenBudget === undefined ? "unchanged" : input.tokenBudget,
            maximumTurns: input.maximumTurns === undefined ? "unchanged" : input.maximumTurns,
            noProgressTurnLimit: input.noProgressTurnLimit === undefined
              ? "unchanged"
              : input.noProgressTurnLimit
          }
        },
        (store) => {
          const current = store.getObjective(input.sessionId);
          assertObjectiveFence(current, input.expectedRevision, input.expectedOwnerGeneration);
          if (current.status === "complete" && input.text !== undefined) {
            throw new InvalidStateTransitionError("objective", "complete", "active");
          }
          const pending = inspectPending(store, current);
          const limitTransition = objectiveLimitTransition(current, input);
          if (limitTransition.status === "active") assertObjectiveSessionEligible(store, input.sessionId);
          if (pending.queue?.state === "accepted") {
            cancelAcceptedObjectivePending(store, pending, `objective:update:${input.operationId}`, this.#now());
          }
          const updated = store.updateObjective({
            sessionId: input.sessionId,
            expectedRevision: current.revision,
            expectedOwnerGeneration: current.ownerGeneration,
            ...(input.text === undefined ? {} : { text: input.text }),
            ...(input.tokenBudget === undefined ? {} : { tokenBudget: input.tokenBudget }),
            ...(input.maximumTurns === undefined ? {} : { maximumTurns: input.maximumTurns }),
            ...(input.noProgressTurnLimit === undefined
              ? {}
              : { noProgressTurnLimit: input.noProgressTurnLimit }),
            ...(pending.unknown && limitTransition.status === "active"
              ? { status: "dispatch_unknown" as const, lastReason: "objective dispatch outcome is unknown" }
              : limitTransition.changed
                ? { status: limitTransition.status, lastReason: limitTransition.reason }
                : {}),
            ...(limitTransition.status === "usage_limited" ? {} : { usageResetAt: null }),
            ...(limitTransition.resetNoProgress ? { noProgressTurns: 0 } : {}),
            advanceOwnerGeneration: true,
            ...(clearsAfterKnownCancellation(pending) ? { clearPending: true } : {}),
            updatedAt: this.#now()
          });
          if (current.status === "usage_limited" && updated.status === "active") {
            clearObjectiveProviderLimit(store, input.sessionId);
          }
          appendObjectiveLifecycle(store, updated, "replaced", this.#now(), updated.lastReason);
          if (current.status === "active") abortRunId = pending.abortRunId;
          return { sessionId: updated.sessionId };
        }
      );
      if (execution.replayed) abortRunId = undefined;
    });
    if (abortRunId !== undefined) await this.#abortOwned(input.sessionId, abortRunId);
    this.#publish(input.sessionId);
    await this.#reconcile(input.sessionId, true);
    return this.#store.getObjective(input.sessionId);
  }

  async pause(input: PauseObjectiveInput): Promise<ObjectiveRecord> {
    await this.#withLock(input.sessionId, async () => {
      this.#assertOpen();
      this.#store.runOperation(
        {
          id: input.operationId,
          kind: "pause_objective",
          body: {
            sessionId: input.sessionId,
            expectedRevision: input.expectedRevision.toString(10),
            expectedOwnerGeneration: input.expectedOwnerGeneration,
            reason: input.reason?.trim() || null
          }
        },
        (store) => {
          const current = store.getObjective(input.sessionId);
          assertObjectiveFence(current, input.expectedRevision, input.expectedOwnerGeneration);
          const pending = inspectPending(store, current);
          if (pending.queue?.state === "accepted") {
            cancelAcceptedObjectivePending(store, pending, `objective:pause:${input.operationId}`, this.#now());
          }
          const updated = store.updateObjective({
            sessionId: input.sessionId,
            expectedRevision: current.revision,
            expectedOwnerGeneration: current.ownerGeneration,
            status: "paused",
            usageResetAt: null,
            lastReason: input.reason?.trim() || "paused by user",
            advanceOwnerGeneration: true,
            ...(clearsAfterKnownCancellation(pending) ? { clearPending: true } : {}),
            updatedAt: this.#now()
          });
          appendObjectiveLifecycle(store, updated, "paused", this.#now(), updated.lastReason);
          return { sessionId: input.sessionId };
        }
      );
    });
    this.#cancelUsageTimer(input.sessionId);
    this.#cancelDispatchTimer(input.sessionId);
    this.#publish(input.sessionId);
    return this.#store.getObjective(input.sessionId);
  }

  async resume(input: ObjectiveFenceInput): Promise<ObjectiveRecord> {
    await this.#withLock(input.sessionId, async () => {
      this.#assertOpen();
      this.#store.runOperation(
        {
          id: input.operationId,
          kind: "resume_objective",
          body: {
            sessionId: input.sessionId,
            expectedRevision: input.expectedRevision.toString(10),
            expectedOwnerGeneration: input.expectedOwnerGeneration
          }
        },
        (store) => {
          const current = store.getObjective(input.sessionId);
          assertObjectiveFence(current, input.expectedRevision, input.expectedOwnerGeneration);
          if (!["paused", "blocked", "usage_limited"].includes(current.status)) {
            throw new InvalidStateTransitionError("objective", current.status, "active");
          }
          assertObjectiveSessionEligible(store, input.sessionId);
          clearObjectiveProviderLimit(store, input.sessionId);
          const updated = store.updateObjective({
            sessionId: input.sessionId,
            expectedRevision: current.revision,
            expectedOwnerGeneration: current.ownerGeneration,
            status: "active",
            usageResetAt: null,
            noProgressTurns: 0,
            dispatchRejections: 0,
            lastReason: null,
            advanceOwnerGeneration: true,
            updatedAt: this.#now()
          });
          appendObjectiveLifecycle(store, updated, "resumed", this.#now(), updated.lastReason);
          return { sessionId: input.sessionId };
        }
      );
    });
    this.#cancelUsageTimer(input.sessionId);
    this.#publish(input.sessionId);
    await this.#kick(input.sessionId, true);
    return this.#store.getObjective(input.sessionId);
  }

  async clear(input: ObjectiveFenceInput): Promise<void> {
    let abortRunId: string | undefined;
    await this.#withLock(input.sessionId, async () => {
      this.#assertOpen();
      const execution = this.#store.runOperation(
        {
          id: input.operationId,
          kind: "clear_objective",
          body: {
            sessionId: input.sessionId,
            expectedRevision: input.expectedRevision.toString(10),
            expectedOwnerGeneration: input.expectedOwnerGeneration
          }
        },
        (store) => {
          const current = store.getObjective(input.sessionId);
          assertObjectiveFence(current, input.expectedRevision, input.expectedOwnerGeneration);
          const pending = inspectPending(store, current);
          if (pending.queue?.state === "accepted") {
            cancelAcceptedObjectivePending(store, pending, `objective:clear:${input.operationId}`, this.#now());
          }
          store.clearObjective({
            sessionId: input.sessionId,
            expectedRevision: current.revision,
            expectedOwnerGeneration: current.ownerGeneration
          });
          appendObjectiveLifecycle(store, current, "cleared", this.#now(), current.lastReason, false);
          abortRunId = pending.abortRunId;
          return { sessionId: input.sessionId };
        }
      );
      if (execution.replayed) abortRunId = undefined;
    });
    this.#cancelUsageTimer(input.sessionId);
    this.#cancelDispatchTimer(input.sessionId);
    if (abortRunId !== undefined) await this.#abortOwned(input.sessionId, abortRunId);
    this.#publish(input.sessionId);
  }

  /** Runs inside SessionHost's user Queue admission transaction. */
  onUserInputAdmitted(store: OperationalStore, result: EnqueueResult): void {
    if (this.#closed || store !== this.#store) return;
    const current = store.findObjective(result.sessionId);
    if (current === undefined || !["active", "dispatch_unknown"].includes(current.status)) return;
    const pending = inspectPending(store, current);
    if (pending.queue?.state === "accepted") {
      cancelAcceptedObjectivePending(store, pending, `objective:user-input:${result.runId}`, this.#now());
    }
    const updated = store.updateObjective({
      sessionId: current.sessionId,
      expectedRevision: current.revision,
      expectedOwnerGeneration: current.ownerGeneration,
      expectedSessionGeneration: current.sessionGeneration,
      status: "paused",
      lastReason: "paused: user sent a message during the objective",
      advanceOwnerGeneration: true,
      ...(clearsAfterKnownCancellation(pending) ? { clearPending: true } : {}),
      updatedAt: this.#now()
    });
    appendObjectiveLifecycle(store, updated, "paused", this.#now(), updated.lastReason);
  }

  async onRunSettled(input: {
    readonly sessionId: string;
    readonly runId: string;
    readonly outcome: "completed" | "aborted" | "failed";
  }): Promise<void> {
    if (this.#closed) return;
    const current = this.#store.findObjective(input.sessionId);
    if (current?.pendingRunId !== input.runId) return;
    await this.#reconcile(input.sessionId, true);
  }

  resumeOnOpen(sessionId: string): void {
    if (this.#closed) return;
    if (!objectiveSessionEligible(this.#store, sessionId)) return;
    void this.#reconcile(sessionId, true);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    for (const entry of this.#usageTimers.values()) clearTimeout(entry.timer);
    this.#usageTimers.clear();
    for (const timer of this.#dispatchTimers.values()) clearTimeout(timer);
    this.#dispatchTimers.clear();
    await Promise.allSettled([...this.#locks.values()]);
    this.#listeners.clear();
  }

  async #reconcile(sessionId: string, activate: boolean): Promise<void> {
    if (this.#closed) return;
    let kick = false;
    await this.#withLock(sessionId, async () => {
      const current = this.#store.findObjective(sessionId);
      if (current === undefined) return;
      if (current.status === "usage_limited") this.#scheduleUsageResume(current);
      else this.#cancelUsageTimer(sessionId);
      if (current.pendingRunId === undefined) {
        kick = current.status === "active" && (activate || this.#sessionHost.isSessionActive(sessionId));
        return;
      }

      const pending = inspectPending(this.#store, current);
      if (pending.unknown) {
        if (current.pendingOwnerGeneration !== current.ownerGeneration || current.status !== "active") return;
        this.#store.transaction((store) => {
          const updated = store.updateObjective({
              sessionId,
              expectedRevision: current.revision,
              expectedOwnerGeneration: current.ownerGeneration,
              status: "dispatch_unknown",
              usageResetAt: null,
              lastReason: "objective dispatch outcome is unknown",
              updatedAt: this.#now()
            });
          appendObjectiveLifecycle(store, updated, "dispatch_unknown", this.#now(), updated.lastReason);
        });
        return;
      }
      if (pending.queue?.state === "accepted") {
        this.#sessionHost.requestQueueDrain(sessionId);
        return;
      }
      if (pending.run === undefined || !terminalRunState(pending.run.descriptor.state)) return;
      kick = this.#settlePending(current, pending.run);
    });
    this.#publish(sessionId);
    if (kick) await this.#kick(sessionId, true);
  }

  #settlePending(snapshot: ObjectiveRecord, run: StoredRun): boolean {
    const current = this.#store.findObjective(snapshot.sessionId);
    if (current === undefined || current.pendingRunId !== run.descriptor.id) return false;
    if (
      current.pendingOwnerGeneration !== current.ownerGeneration ||
      !["active", "dispatch_unknown"].includes(current.status)
    ) {
      const reconcilesReplacement = current.pendingOwnerGeneration !== current.ownerGeneration &&
        current.status === "dispatch_unknown";
      let updated!: ObjectiveRecord;
      this.#store.transaction((store) => {
        updated = store.updateObjective({
          sessionId: current.sessionId,
          expectedRevision: current.revision,
          expectedOwnerGeneration: current.ownerGeneration,
          ...(reconcilesReplacement
            ? { status: "active" as const, lastReason: "prior dispatch settled; resuming replacement" }
            : {}),
          clearPending: true,
          updatedAt: this.#now()
        });
        if (reconcilesReplacement) {
          appendObjectiveLifecycle(store, updated, "resumed", this.#now(), updated.lastReason);
        }
      });
      return updated.status === "active" && updated.pendingRunId === undefined;
    }

    const turnsUsed = current.turnsUsed + 1;
    const evidence = readTurnEvidence(this.#store, current.sessionId, run);
    const tokensUsed = current.tokensUsed + evidence.tokens;
    const verdict = parseObjectiveVerdict(evidence.assistantText);
    let status: ObjectiveStatus = "active";
    let reason: string | null = verdict?.reason || null;
    let noProgressTurns = current.noProgressTurns;
    let usageResetAt: number | null = null;
    let dispatchRejections = 0;

    if (run.descriptor.state === "aborted") {
      status = "paused";
      reason = "paused: stopped by user";
    } else if (run.descriptor.state === "failed") {
      const error = run.descriptor.error;
      const limit = error === undefined ? undefined : providerRateLimitFromError(error, this.#now());
      const overload = error !== undefined && isOverload(error);
      if (limit !== undefined) {
        status = "usage_limited";
        reason = "usage limit reached";
        usageResetAt = limit.resetsAt ?? null;
      } else if (overload && current.dispatchRejections + 1 < OVERLOAD_MAXIMUM) {
        status = "usage_limited";
        reason = "upstream capacity is temporarily unavailable";
        usageResetAt = this.#now() + OVERLOAD_RESUME_DELAY_MS;
        dispatchRejections = current.dispatchRejections + 1;
      } else {
        status = "blocked";
        reason = overload
          ? "repeated upstream capacity failures blocked the objective"
          : `turn failed: ${error?.message ?? "unknown error"}`;
      }
    } else if (verdict?.status === "complete") {
      status = "complete";
      reason = verdict.reason || "objective achieved";
    } else if (verdict?.status === "blocked") {
      status = "blocked";
      reason = verdict.reason || "agent reported blocked";
    } else {
      noProgressTurns = evidence.sawToolUse ? 0 : current.noProgressTurns + 1;
      if (current.tokenBudget !== undefined && tokensUsed >= current.tokenBudget) {
        status = "budget_limited";
        reason = `token budget reached (${tokensUsed}/${current.tokenBudget})`;
      } else if (current.maximumTurns !== undefined && turnsUsed >= current.maximumTurns) {
        status = "budget_limited";
        reason = `maximum turns reached (${turnsUsed}/${current.maximumTurns})`;
      } else if (
        current.noProgressTurnLimit !== undefined &&
        noProgressTurns >= current.noProgressTurnLimit
      ) {
        status = "paused";
        reason = `paused: ${noProgressTurns} turns with no tool use`;
      }
    }

    const refinedObjective = safeRefinedObjective(verdict?.refinedObjective);
    let updated!: ObjectiveRecord;
    this.#store.transaction((store) => {
      updated = store.updateObjective({
        sessionId: current.sessionId,
        expectedRevision: current.revision,
        expectedOwnerGeneration: current.ownerGeneration,
        status,
        usageResetAt,
        turnsUsed,
        tokensUsed,
        noProgressTurns,
        dispatchRejections,
        lastReason: reason === null ? null : safeObjectiveReason(reason, "objective turn settled"),
        ...(status === "active" && refinedObjective !== undefined
          ? { text: refinedObjective }
          : {}),
        clearPending: true,
        updatedAt: this.#now()
      });
      const action = lifecycleActionForSettlement(updated.status);
      if (action !== undefined) {
        appendObjectiveLifecycle(store, updated, action, this.#now(), updated.lastReason);
      }
    });
    if (updated.status === "usage_limited") this.#scheduleUsageResume(updated);
    return updated.status === "active";
  }

  async #kick(sessionId: string, activate: boolean): Promise<void> {
    if (this.#closed) return;
    let admitted = false;
    await this.#withLock(sessionId, async () => {
      const current = this.#store.findObjective(sessionId);
      if (current === undefined || current.status !== "active" || current.pendingRunId !== undefined) return;
      if (!activate && !this.#sessionHost.isSessionActive(sessionId)) return;
      if (!objectiveSessionEligible(this.#store, sessionId)) {
        this.#store.transaction((store) => {
          const updated = store.updateObjective({
            sessionId,
            expectedRevision: current.revision,
            expectedOwnerGeneration: current.ownerGeneration,
            status: "paused",
            lastReason: "paused: task is not eligible for autonomous continuation",
            advanceOwnerGeneration: true,
            updatedAt: this.#now()
          });
          appendObjectiveLifecycle(store, updated, "paused", this.#now(), updated.lastReason);
        });
        return;
      }
      const providerLimit = objectiveProviderLimit(this.#store, sessionId, this.#now());
      if (providerLimit?.limited === true) {
        let limited!: ObjectiveRecord;
        this.#store.transaction((store) => {
          limited = store.updateObjective({
            sessionId,
            expectedRevision: current.revision,
            expectedOwnerGeneration: current.ownerGeneration,
            status: "usage_limited",
            usageResetAt: providerLimit.resetsAt ?? null,
            lastReason: "usage limit reached",
            updatedAt: this.#now()
          });
          appendObjectiveLifecycle(store, limited, "limited", this.#now(), limited.lastReason);
        });
        if (limited.usageResetAt !== undefined) this.#scheduleUsageResume(limited);
        return;
      }
      const preflight = budgetPreflight(current);
      if (preflight !== undefined) {
        this.#store.transaction((store) => {
          const updated = store.updateObjective({
            sessionId,
            expectedRevision: current.revision,
            expectedOwnerGeneration: current.ownerGeneration,
            status: "budget_limited",
            lastReason: preflight,
            updatedAt: this.#now()
          });
          appendObjectiveLifecycle(store, updated, "limited", this.#now(), updated.lastReason);
        });
        return;
      }
      const operationId = objectiveTurnOperationId(current);
      const prompt = current.turnsUsed === 0
        ? buildFirstObjectiveDirective(current.text, { maximumTurns: current.maximumTurns })
        : buildObjectiveContinuationDirective(current.text, current.lastReason);
      try {
        this.#sessionHost.enqueueServiceInput({
          operationId,
          sessionId,
          source: "system",
          prompt: {
            text: prompt,
            images: [],
            files: [],
            mentions: [],
            disposition: "prompt",
            objectiveContinuation: {
              ownerGeneration: current.ownerGeneration,
              turn: current.turnsUsed + 1
            }
          },
          onAdmitted: (store, result) => {
            const owner = store.getObjective(sessionId);
            assertObjectiveFence(owner, current.revision, current.ownerGeneration);
            if (owner.status !== "active" || owner.pendingRunId !== undefined) {
              throw new StoreError("Objective dispatch ownership changed before Queue admission.");
            }
            store.updateObjective({
              sessionId,
              expectedRevision: owner.revision,
              expectedOwnerGeneration: owner.ownerGeneration,
              expectedSessionGeneration: owner.sessionGeneration,
              pending: {
                ownerGeneration: owner.ownerGeneration,
                operationId,
                runId: result.runId,
                attemptId: result.attemptId,
                queueItemId: result.queueItemId
              },
              updatedAt: this.#now()
            });
          }
        });
        admitted = true;
        this.#cancelDispatchTimer(sessionId);
      } catch (error) {
        const owner = this.#store.findObjective(sessionId);
        if (
          owner === undefined || owner.revision !== current.revision ||
          owner.ownerGeneration !== current.ownerGeneration || owner.pendingRunId !== undefined
        ) return;
        const attempts = Math.min(DISPATCH_REJECTION_MAXIMUM, owner.dispatchRejections + 1);
        const blocked = attempts >= DISPATCH_REJECTION_MAXIMUM;
        this.#store.transaction((store) => {
          const updated = store.updateObjective({
            sessionId,
            expectedRevision: owner.revision,
            expectedOwnerGeneration: owner.ownerGeneration,
            status: blocked ? "blocked" : "active",
            dispatchRejections: attempts,
            lastReason: blocked
              ? "objective dispatch was rejected repeatedly"
              : `objective dispatch was rejected: ${safeErrorMessage(error)}`,
            updatedAt: this.#now()
          });
          if (blocked) appendObjectiveLifecycle(store, updated, "blocked", this.#now(), updated.lastReason);
        });
        if (!blocked) this.#scheduleDispatchRetry(sessionId, attempts);
      }
    });
    this.#publish(sessionId);
    if (admitted) await this.#reconcile(sessionId, true);
  }

  #scheduleUsageResume(objective: ObjectiveRecord): void {
    if (objective.usageResetAt === undefined || objective.status !== "usage_limited") {
      this.#cancelUsageTimer(objective.sessionId);
      return;
    }
    const existing = this.#usageTimers.get(objective.sessionId);
    if (existing?.at === objective.usageResetAt) return;
    if (existing !== undefined) clearTimeout(existing.timer);
    const delay = Math.max(0, Math.min(2_147_483_647, objective.usageResetAt - this.#now()));
    const timer = setTimeout(() => {
      this.#usageTimers.delete(objective.sessionId);
      void this.#autoResumeUsage(objective.sessionId, objective.ownerGeneration, objective.usageResetAt!);
    }, delay);
    this.#usageTimers.set(objective.sessionId, { at: objective.usageResetAt, timer });
  }

  async #autoResumeUsage(sessionId: string, ownerGeneration: number, resetAt: number): Promise<void> {
    if (this.#closed) return;
    let resumed = false;
    await this.#withLock(sessionId, async () => {
      const current = this.#store.findObjective(sessionId);
      if (
        current === undefined || current.status !== "usage_limited" ||
        current.ownerGeneration !== ownerGeneration || current.usageResetAt !== resetAt
      ) return;
      if (resetAt > this.#now()) {
        this.#scheduleUsageResume(current);
        return;
      }
      if (!objectiveSessionEligible(this.#store, sessionId)) return;
      const operationId = objectiveInternalOperationId("usage-resume", current, String(resetAt));
      this.#store.runOperation(
        {
          id: operationId,
          kind: "resume_objective_after_usage_limit",
          body: { sessionId, ownerGeneration, resetAt }
        },
        (store) => {
          const owner = store.getObjective(sessionId);
          if (
            owner.status !== "usage_limited" || owner.ownerGeneration !== ownerGeneration ||
            owner.usageResetAt !== resetAt
          ) throw new StoreError("Objective usage-resume authority changed.");
          const updated = store.updateObjective({
            sessionId,
            expectedRevision: owner.revision,
            expectedOwnerGeneration: owner.ownerGeneration,
            status: "active",
            usageResetAt: null,
            noProgressTurns: 0,
            lastReason: "usage limit reset; resuming objective",
            advanceOwnerGeneration: true,
            updatedAt: this.#now()
          });
          appendObjectiveLifecycle(store, updated, "resumed", this.#now(), updated.lastReason);
          return { sessionId };
        }
      );
      resumed = true;
    });
    if (!resumed) return;
    this.#publish(sessionId);
    await this.#kick(sessionId, true);
  }

  #scheduleDispatchRetry(sessionId: string, attempts: number): void {
    this.#cancelDispatchTimer(sessionId);
    const delay = Math.min(
      DISPATCH_REJECTION_MAX_DELAY_MS,
      DISPATCH_REJECTION_BASE_DELAY_MS * (2 ** Math.max(0, attempts - 1))
    );
    const timer = setTimeout(() => {
      this.#dispatchTimers.delete(sessionId);
      void this.#kick(sessionId, true);
    }, delay);
    this.#dispatchTimers.set(sessionId, timer);
  }

  #cancelUsageTimer(sessionId: string): void {
    const current = this.#usageTimers.get(sessionId);
    if (current !== undefined) clearTimeout(current.timer);
    this.#usageTimers.delete(sessionId);
  }

  #cancelDispatchTimer(sessionId: string): void {
    const timer = this.#dispatchTimers.get(sessionId);
    if (timer !== undefined) clearTimeout(timer);
    this.#dispatchTimers.delete(sessionId);
  }

  async #abortOwned(sessionId: string, runId: string): Promise<void> {
    try {
      await this.#sessionHost.abort(sessionId, runId);
    } catch {
      // Clearing/replacing the durable Objective is authoritative. The exact
      // Run remains in Run/Queue history when Backend cancellation is unconfirmed.
    }
  }

  #publish(sessionId: string): void {
    const listeners = this.#listeners.get(sessionId);
    if (listeners === undefined) return;
    const value = this.#store.findObjective(sessionId);
    for (const listener of [...listeners]) {
      try { listener(value); } catch { /* A watcher cannot roll back durable state. */ }
    }
  }

  async #withLock<T>(sessionId: string, action: () => Promise<T> | T): Promise<T> {
    const prior = this.#locks.get(sessionId) ?? Promise.resolve();
    const result = prior.catch(() => undefined).then(action);
    const tail = result.then(() => undefined, () => undefined);
    this.#locks.set(sessionId, tail);
    try {
      return await result;
    } finally {
      if (this.#locks.get(sessionId) === tail) this.#locks.delete(sessionId);
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new StoreError("Objective manager is closed.");
  }
}

function inspectPending(store: OperationalStore, objective: ObjectiveRecord): PendingInspection {
  if (
    objective.pendingRunId === undefined || objective.pendingQueueItemId === undefined ||
    objective.pendingAttemptId === undefined || objective.pendingOperationId === undefined ||
    objective.pendingOwnerGeneration === undefined
  ) return { clear: objective.pendingRunId !== undefined, unknown: objective.pendingRunId !== undefined };
  let queue: QueueItemRecord;
  let run: StoredRun;
  let attemptRunId: string;
  let attemptGeneration: number;
  let currentSessionGeneration: number;
  try {
    queue = store.getQueueItem(objective.pendingQueueItemId);
    run = store.getRun(objective.pendingRunId);
    const attempt = store.getAttempt(objective.pendingAttemptId).descriptor;
    attemptRunId = attempt.runId;
    attemptGeneration = attempt.generation;
    currentSessionGeneration = store.getSession(objective.sessionId).descriptor.binding.generation;
  } catch {
    return { clear: false, unknown: true };
  }
  const matches = queue.sessionId === objective.sessionId && queue.runId === run.descriptor.id &&
    queue.attemptId === objective.pendingAttemptId && queue.operationId === objective.pendingOperationId &&
    run.descriptor.sessionId === objective.sessionId && attemptRunId === run.descriptor.id;
  if (!matches) return { queue, run, clear: false, unknown: true };
  const unknown = !terminalRunState(run.descriptor.state) &&
    (queue.state === "dispatch_unknown" || run.descriptor.state === "dispatch_unknown");
  if (unknown) return { queue, run, clear: false, unknown: true };
  if (
    !terminalRunState(run.descriptor.state) &&
    (attemptGeneration !== objective.sessionGeneration || currentSessionGeneration !== objective.sessionGeneration)
  ) {
    // Session activation advances its durable generation after Queue claim and
    // before SessionHost atomically renews the exact Attempt. Only that narrow
    // same-Attempt dispatch window is recoverable; every other mismatch fails
    // closed as an unknown dispatch outcome.
    const awaitingExactAttemptRenewal = queue.state === "dispatching" &&
      currentSessionGeneration === objective.sessionGeneration &&
      attemptGeneration < objective.sessionGeneration;
    if (!awaitingExactAttemptRenewal) return { queue, run, clear: false, unknown: true };
  }
  const clear = ["cancelled", "completed", "failed"].includes(queue.state) ||
    terminalRunState(run.descriptor.state);
  const abortRunId = ["dispatching", "backend_accepted"].includes(queue.state) &&
    !terminalRunState(run.descriptor.state)
      ? run.descriptor.id
      : undefined;
  return { queue, run, clear, ...(abortRunId === undefined ? {} : { abortRunId }), unknown: false };
}

function clearsAfterKnownCancellation(pending: PendingInspection): boolean {
  return pending.clear || pending.queue?.state === "accepted";
}

function cancelAcceptedObjectivePending(
  store: OperationalStore,
  pending: PendingInspection,
  traceId: string,
  at: number
): void {
  if (pending.queue?.state !== "accepted") return;
  store.cancelQueueItem({
    queueItemId: pending.queue.id,
    expectedRevision: pending.queue.revision,
    traceId,
    at
  });
  const attemptId = pending.queue.attemptId;
  if (attemptId !== undefined && store.getAttempt(attemptId).descriptor.endedAt === undefined) {
    store.finishAttempt(attemptId);
  }
}

function assertObjectiveFence(
  objective: ObjectiveRecord,
  expectedRevision: bigint,
  expectedOwnerGeneration: number
): void {
  if (objective.revision !== expectedRevision || objective.ownerGeneration !== expectedOwnerGeneration) {
    if (objective.ownerGeneration !== expectedOwnerGeneration) {
      throw new StaleGenerationError(expectedOwnerGeneration, objective.ownerGeneration);
    }
    throw new RevisionConflictError("Objective", objective.sessionId, expectedRevision, objective.revision);
  }
}

interface ObjectiveLimitTransition {
  readonly status: ObjectiveStatus;
  readonly reason: string | null;
  readonly changed: boolean;
  readonly resetNoProgress: boolean;
}

function objectiveLimitTransition(
  current: ObjectiveRecord,
  input: Pick<UpdateObjectiveMutationInput, "text" | "tokenBudget" | "maximumTurns" | "noProgressTurnLimit">
): ObjectiveLimitTransition {
  const tokenBudget = input.tokenBudget === undefined ? current.tokenBudget : input.tokenBudget ?? undefined;
  const maximumTurns = input.maximumTurns === undefined ? current.maximumTurns : input.maximumTurns ?? undefined;
  const noProgressTurnLimit = input.noProgressTurnLimit === undefined
    ? current.noProgressTurnLimit
    : input.noProgressTurnLimit ?? undefined;
  const textChanged = input.text !== undefined && input.text.trim() !== current.text;
  const noProgressTurns = textChanged ? 0 : current.noProgressTurns;
  const noProgressPaused = current.status === "paused" &&
    /^paused: \d+ turns with no tool use$/u.test(current.lastReason ?? "");
  const textRecovers = textChanged && ["active", "paused", "blocked", "usage_limited"].includes(current.status);
  if (current.status !== "active" && current.status !== "budget_limited" && !noProgressPaused && !textRecovers) {
    return { status: current.status, reason: current.lastReason ?? null, changed: false, resetNoProgress: false };
  }
  if (tokenBudget !== undefined && current.tokensUsed >= tokenBudget) {
    return {
      status: "budget_limited",
      reason: `token budget reached (${current.tokensUsed}/${tokenBudget})`,
      changed: current.status !== "budget_limited" || current.lastReason !== `token budget reached (${current.tokensUsed}/${tokenBudget})`,
      resetNoProgress: textChanged
    };
  }
  if (maximumTurns !== undefined && current.turnsUsed >= maximumTurns) {
    return {
      status: "budget_limited",
      reason: `maximum turns reached (${current.turnsUsed}/${maximumTurns})`,
      changed: current.status !== "budget_limited" || current.lastReason !== `maximum turns reached (${current.turnsUsed}/${maximumTurns})`,
      resetNoProgress: textChanged
    };
  }
  if (noProgressTurnLimit !== undefined && noProgressTurns >= noProgressTurnLimit) {
    return {
      status: "paused",
      reason: `paused: ${noProgressTurns} turns with no tool use`,
      changed: current.status !== "paused" || current.lastReason !== `paused: ${noProgressTurns} turns with no tool use`,
      resetNoProgress: textChanged
    };
  }
  if (current.status === "budget_limited" || noProgressPaused) {
    return { status: "active", reason: "objective limits updated; resuming", changed: true, resetNoProgress: textChanged };
  }
  if (textRecovers) {
    return { status: "active", reason: null, changed: true, resetNoProgress: true };
  }
  return { status: current.status, reason: current.lastReason ?? null, changed: false, resetNoProgress: false };
}

function terminalRunState(state: StoredRun["descriptor"]["state"]): boolean {
  return state === "completed" || state === "aborted" || state === "failed";
}

function readTurnEvidence(store: OperationalStore, sessionId: string, run: StoredRun): TurnEvidence {
  const events: PersistedEvent[] = [];
  let beforeCursor: bigint | undefined;
  for (;;) {
    const page = store.listEvents({
      sessionId,
      order: "desc",
      limit: EVENT_PAGE_SIZE,
      ...(beforeCursor === undefined ? {} : { beforeCursor })
    });
    if (page.length === 0) break;
    for (const event of page) {
      if (event.runId === run.descriptor.id) events.push(event);
    }
    const oldest = page.at(-1)!;
    if (oldest.emittedAt < run.descriptor.createdAt || page.length < EVENT_PAGE_SIZE) break;
    beforeCursor = oldest.globalCursor;
  }
  events.sort((left, right) => left.globalCursor < right.globalCursor ? -1 : left.globalCursor > right.globalCursor ? 1 : 0);
  const assistant: string[] = [];
  let sawToolUse = false;
  let assistantUsage: Extract<EventPayload, { readonly type: "usage" }>["usage"] | undefined;
  let genericUsage: Extract<EventPayload, { readonly type: "usage" }>["usage"] | undefined;
  for (const event of events) {
    if (event.payload.type === "message_complete" && event.payload.role === "assistant") {
      assistant.push(event.payload.blocks.flatMap((block) => block.kind === "text" ? [block.text] : []).join("\n"));
      if (event.payload.usage !== undefined) assistantUsage = event.payload.usage;
    } else if (event.payload.type === "tool_start") {
      sawToolUse = true;
    } else if (event.payload.type === "usage") {
      genericUsage = event.payload.usage;
    }
  }
  return {
    assistantText: assistant.join("\n"),
    sawToolUse,
    tokens: Math.max(0, (assistantUsage ?? genericUsage)?.totalTokens ?? 0)
  };
}

function budgetPreflight(objective: ObjectiveRecord): string | undefined {
  if (objective.tokenBudget !== undefined && objective.tokensUsed >= objective.tokenBudget) {
    return `token budget reached (${objective.tokensUsed}/${objective.tokenBudget})`;
  }
  if (objective.maximumTurns !== undefined && objective.turnsUsed >= objective.maximumTurns) {
    return `maximum turns reached (${objective.turnsUsed}/${objective.maximumTurns})`;
  }
  return undefined;
}

function safeRefinedObjective(value: string | undefined): string | undefined {
  if (value === undefined || value.includes("\0")) return undefined;
  const normalized = value.trim();
  if (normalized === "" || [...normalized].length > 32_000) return undefined;
  return normalized;
}

function safeObjectiveReason(value: string, fallback: string): string {
  const normalized = value.replace(/\0/gu, " ").replace(/\s+/gu, " ").trim() || fallback;
  return [...normalized].slice(0, 2_048).join("");
}

function objectiveSessionEligible(store: OperationalStore, sessionId: string): boolean {
  const session = store.getSession(sessionId).descriptor;
  return session.deletedAt === undefined && !session.archived && store.findSessionRuntimePolicy(sessionId) === undefined;
}

function assertObjectiveSessionEligible(store: OperationalStore, sessionId: string): void {
  if (!objectiveSessionEligible(store, sessionId)) {
    throw new StoreError("An Objective requires an active, non-isolated product task.");
  }
}

function objectiveProviderLimit(store: OperationalStore, sessionId: string, now: number) {
  const session = store.getSession(sessionId).descriptor;
  if (session.providerId === undefined) return undefined;
  return currentProviderRateLimit(store.findSetting(
    "service",
    "orchestrator",
    providerRateLimitSettingKey(session.backendId, session.providerId)
  )?.value, now);
}

function clearObjectiveProviderLimit(store: OperationalStore, sessionId: string): void {
  const session = store.getSession(sessionId).descriptor;
  clearProviderRateLimit(store, session.backendId, session.providerId);
}

type ObjectiveLifecycleAction = Extract<EventPayload, { readonly type: "objective_lifecycle" }>["action"];

function appendObjectiveLifecycle(
  store: OperationalStore,
  objective: ObjectiveRecord,
  action: ObjectiveLifecycleAction,
  at: number,
  reason?: string,
  includeStatus = true
): void {
  const session = store.getSession(objective.sessionId).descriptor;
  store.appendEvent({
    id: randomUUID(),
    backendId: session.backendId,
    targetId: session.targetId,
    sessionId: objective.sessionId,
    generation: session.binding.generation,
    emittedAt: at,
    traceId: `objective:${objective.ownerGeneration}:${action}:${objective.revision.toString(10)}`,
    payload: {
      type: "objective_lifecycle",
      action,
      ...(includeStatus ? { status: objective.status } : {}),
      ownerGeneration: objective.ownerGeneration,
      turnsUsed: objective.turnsUsed,
      tokensUsed: objective.tokensUsed,
      elapsedMs: Math.max(0, at - objective.startedAt),
      ...(action === "started" || action === "replaced" ? { objectiveText: objective.text } : {}),
      ...(reason === undefined || reason.trim() === "" ? {} : { reason: safeObjectiveReason(reason, "objective state changed") })
    }
  });
}

function lifecycleActionForSettlement(status: ObjectiveStatus): ObjectiveLifecycleAction | undefined {
  switch (status) {
    case "complete": return "completed";
    case "blocked": return "blocked";
    case "budget_limited":
    case "usage_limited": return "limited";
    case "paused": return "paused";
    case "dispatch_unknown": return "dispatch_unknown";
    case "active": return undefined;
  }
}

function objectiveTurnOperationId(objective: ObjectiveRecord): string {
  return objectiveInternalOperationId(
    "turn",
    objective,
    `${objective.turnsUsed + 1}:${objective.dispatchRejections + 1}`
  );
}

function objectiveInternalOperationId(kind: string, objective: ObjectiveRecord, suffix: string): string {
  const digest = createHash("sha256")
    .update(`${kind}\0${objective.sessionId}\0${objective.ownerGeneration}\0${suffix}`)
    .digest("hex");
  return `objective-${kind}-${digest}`;
}

function isOverload(error: PublicError): boolean {
  return error.code === "UPSTREAM_OVERLOAD";
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim() !== "") return error.message.slice(0, 512);
  return "unknown admission failure";
}
