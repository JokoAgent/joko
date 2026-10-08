import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, type HandlerContext, type ServiceImpl } from "@connectrpc/connect";
import * as contract from "@joko/contracts";
import {
  InvalidStateTransitionError,
  NotFoundError,
  OperationConflictError,
  OperationInProgressError,
  OperationPreviouslyFailedError,
  RevisionConflictError,
  StaleGenerationError,
  StoreClosedError,
  StoreError,
  type ObjectiveRecord,
  type ObjectiveStatus
} from "@joko/store";

import { ObjectiveManager } from "./objective-manager.js";
import { fromProtoRevision, toProtoEntityVersion, toProtoTimestamp } from "./proto-mapper.js";

export interface ObjectiveRpcOwner {
  readonly connectionId: string;
}

export function createObjectiveConnectService(
  manager: ObjectiveManager | undefined,
  authenticate: (context: HandlerContext) => ObjectiveRpcOwner,
  onRevoked?: (connectionId: string, listener: () => void) => () => void
): ServiceImpl<typeof contract.ObjectiveService> {
  const owner = (): ObjectiveManager => {
    if (manager === undefined) throw new ConnectError("Objectives are unavailable.", Code.Unimplemented);
    return manager;
  };
  return {
    getObjective: (request, context) => objectiveRpc(() => {
      authenticate(context);
      const objective = owner().get(request.sessionId);
      return create(contract.GetObjectiveResponseSchema, {
        ...(objective === undefined ? {} : { objective: toProtoObjective(objective) })
      });
    }),

    watchObjective: async function* (request, context) {
      const connection = authenticate(context);
      const currentOwner = owner();
      const revoked = new AbortController();
      const signal = onRevoked === undefined
        ? context.signal
        : AbortSignal.any([context.signal, revoked.signal]);
      const stopRevocation = onRevoked?.(connection.connectionId, () => revoked.abort()) ?? (() => undefined);
      const queue = new ObjectiveProjectionQueue(signal);
      const unsubscribe = currentOwner.subscribe(request.sessionId, (objective) => queue.push(objective));
      const afterRevision = request.afterRevision === undefined
        ? undefined
        : fromProtoRevision(request.afterRevision, "after_revision");
      let lastRevision = afterRevision;
      let lastPresent = afterRevision !== undefined;
      try {
        queue.push(currentOwner.get(request.sessionId));
        currentOwner.resumeOnOpen(request.sessionId);
        while (!signal.aborted) {
          const objective = await queue.next();
          if (objective === undefined) {
            if (lastPresent || lastRevision === undefined) {
              yield create(contract.WatchObjectiveResponseSchema, { cleared: true });
              lastPresent = false;
            }
            continue;
          }
          if (lastRevision !== undefined && objective.revision <= lastRevision) continue;
          lastRevision = objective.revision;
          lastPresent = true;
          yield create(contract.WatchObjectiveResponseSchema, { objective: toProtoObjective(objective) });
        }
      } finally {
        unsubscribe();
        stopRevocation();
        queue.close();
      }
    },

    setObjective: async (request, context) => objectiveRpc(async () => {
      authenticate(context);
      const limits = request.limits;
      const objective = await owner().set({
        operationId: request.requestId,
        sessionId: request.sessionId,
        text: request.text,
        ...(limits?.tokenBudget === undefined ? {} : { tokenBudget: safeNumber(limits.tokenBudget, "limits.token_budget") }),
        ...(limits?.maximumTurns === undefined ? {} : { maximumTurns: limits.maximumTurns }),
        ...(limits?.noProgressTurnLimit === undefined ? {} : { noProgressTurnLimit: limits.noProgressTurnLimit }),
        ...(request.expectedSessionGeneration === undefined
          ? {}
          : { expectedSessionGeneration: safeNumber(request.expectedSessionGeneration, "expected_session_generation") })
      });
      return create(contract.SetObjectiveResponseSchema, { objective: toProtoObjective(objective) });
    }),

    updateObjective: async (request, context) => objectiveRpc(async () => {
      authenticate(context);
      const objective = await owner().update({
        operationId: request.requestId,
        sessionId: request.sessionId,
        expectedRevision: fromProtoRevision(request.expectedRevision, "expected_revision"),
        expectedOwnerGeneration: safeNumber(request.expectedOwnerGeneration, "expected_owner_generation"),
        ...(request.text === undefined ? {} : { text: request.text }),
        ...optionalBigIntUpdate(request.tokenBudgetUpdate, "token_budget"),
        ...optionalNumberUpdate(request.maximumTurnsUpdate),
        ...optionalNoProgressUpdate(request.noProgressTurnLimitUpdate)
      });
      return create(contract.UpdateObjectiveResponseSchema, { objective: toProtoObjective(objective) });
    }),

    pauseObjective: async (request, context) => objectiveRpc(async () => {
      authenticate(context);
      const objective = await owner().pause({
        operationId: request.requestId,
        sessionId: request.sessionId,
        expectedRevision: fromProtoRevision(request.expectedRevision, "expected_revision"),
        expectedOwnerGeneration: safeNumber(request.expectedOwnerGeneration, "expected_owner_generation"),
        ...(request.reason.trim() === "" ? {} : { reason: request.reason })
      });
      return create(contract.PauseObjectiveResponseSchema, { objective: toProtoObjective(objective) });
    }),

    resumeObjective: async (request, context) => objectiveRpc(async () => {
      authenticate(context);
      const objective = await owner().resume({
        operationId: request.requestId,
        sessionId: request.sessionId,
        expectedRevision: fromProtoRevision(request.expectedRevision, "expected_revision"),
        expectedOwnerGeneration: safeNumber(request.expectedOwnerGeneration, "expected_owner_generation")
      });
      return create(contract.ResumeObjectiveResponseSchema, { objective: toProtoObjective(objective) });
    }),

    clearObjective: async (request, context) => objectiveRpc(async () => {
      authenticate(context);
      await owner().clear({
        operationId: request.requestId,
        sessionId: request.sessionId,
        expectedRevision: fromProtoRevision(request.expectedRevision, "expected_revision"),
        expectedOwnerGeneration: safeNumber(request.expectedOwnerGeneration, "expected_owner_generation")
      });
      return create(contract.ClearObjectiveResponseSchema, { cleared: true });
    })
  };
}

export function toProtoObjective(objective: ObjectiveRecord): contract.Objective {
  return create(contract.ObjectiveSchema, {
    sessionId: objective.sessionId,
    text: objective.text,
    status: toProtoObjectiveStatus(objective.status),
    ...(objective.tokenBudget === undefined ? {} : { tokenBudget: BigInt(objective.tokenBudget) }),
    ...(objective.maximumTurns === undefined ? {} : { maximumTurns: objective.maximumTurns }),
    ...(objective.noProgressTurnLimit === undefined ? {} : { noProgressTurnLimit: objective.noProgressTurnLimit }),
    turnsUsed: objective.turnsUsed,
    tokensUsed: BigInt(objective.tokensUsed),
    noProgressTurns: objective.noProgressTurns,
    lastReason: objective.lastReason ?? "",
    ownerGeneration: BigInt(objective.ownerGeneration),
    sessionGeneration: BigInt(objective.sessionGeneration),
    ...(objective.pendingRunId === undefined ? {} : { pendingRunId: objective.pendingRunId }),
    ...(objective.pendingQueueItemId === undefined ? {} : { pendingQueueItemId: objective.pendingQueueItemId }),
    startedAt: toProtoTimestamp(objective.startedAt),
    ...(objective.usageResetAt === undefined ? {} : { usageResetAt: toProtoTimestamp(objective.usageResetAt) }),
    version: toProtoEntityVersion(objective.revision, objective.ownerGeneration, objective.updatedAt)
  });
}

function toProtoObjectiveStatus(status: ObjectiveStatus): contract.ObjectiveStatus {
  switch (status) {
    case "active": return contract.ObjectiveStatus.ACTIVE;
    case "paused": return contract.ObjectiveStatus.PAUSED;
    case "blocked": return contract.ObjectiveStatus.BLOCKED;
    case "complete": return contract.ObjectiveStatus.COMPLETE;
    case "budget_limited": return contract.ObjectiveStatus.BUDGET_LIMITED;
    case "usage_limited": return contract.ObjectiveStatus.USAGE_LIMITED;
    case "dispatch_unknown": return contract.ObjectiveStatus.DISPATCH_UNKNOWN;
  }
}

function optionalBigIntUpdate(
  update: contract.UpdateObjectiveRequest["tokenBudgetUpdate"],
  field: string
): { readonly tokenBudget?: number | null } {
  if (update.case === "tokenBudget") return { tokenBudget: safeNumber(update.value, field) };
  if (update.case === "clearTokenBudget") {
    if (!update.value) throw new ConnectError(`clear_${field} must be true when present.`, Code.InvalidArgument);
    return { tokenBudget: null };
  }
  return {};
}

function optionalNumberUpdate(
  update: contract.UpdateObjectiveRequest["maximumTurnsUpdate"]
): { readonly maximumTurns?: number | null } {
  if (update.case === "maximumTurns") return { maximumTurns: update.value };
  if (update.case === "clearMaximumTurns") {
    if (!update.value) throw new ConnectError("clear_maximum_turns must be true when present.", Code.InvalidArgument);
    return { maximumTurns: null };
  }
  return {};
}

function optionalNoProgressUpdate(
  update: contract.UpdateObjectiveRequest["noProgressTurnLimitUpdate"]
): { readonly noProgressTurnLimit?: number | null } {
  if (update.case === "noProgressTurnLimit") return { noProgressTurnLimit: update.value };
  if (update.case === "clearNoProgressTurnLimit") {
    if (!update.value) throw new ConnectError("clear_no_progress_turn_limit must be true when present.", Code.InvalidArgument);
    return { noProgressTurnLimit: null };
  }
  return {};
}

function safeNumber(value: bigint, field: string): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ConnectError(`${field} is outside the supported integer range.`, Code.InvalidArgument);
  }
  return Number(value);
}

async function objectiveRpc<T>(action: () => T | Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof ConnectError) throw error;
    if (error instanceof OperationConflictError) throw new ConnectError(error.message, Code.AlreadyExists);
    if (error instanceof OperationInProgressError || error instanceof RevisionConflictError || error instanceof StaleGenerationError) {
      throw new ConnectError(error.message, Code.Aborted);
    }
    if (error instanceof OperationPreviouslyFailedError || error instanceof InvalidStateTransitionError) {
      throw new ConnectError(error.message, Code.FailedPrecondition);
    }
    if (error instanceof NotFoundError) throw new ConnectError(error.message, Code.NotFound);
    if (error instanceof StoreClosedError) throw new ConnectError(error.message, Code.Unavailable);
    if (error instanceof StoreError) throw new ConnectError(error.message, Code.InvalidArgument);
    throw error;
  }
}

class ObjectiveProjectionQueue {
  readonly #signal: AbortSignal;
  #value: ObjectiveRecord | undefined;
  #hasValue = false;
  #wake?: () => void;
  #closed = false;

  constructor(signal: AbortSignal) {
    this.#signal = signal;
  }

  push(value: ObjectiveRecord | undefined): void {
    if (this.#closed) return;
    this.#value = value;
    this.#hasValue = true;
    this.#wake?.();
    this.#wake = undefined;
  }

  async next(): Promise<ObjectiveRecord | undefined> {
    while (!this.#hasValue && !this.#closed && !this.#signal.aborted) {
      await new Promise<void>((resolve) => {
        const wake = (): void => {
          this.#signal.removeEventListener("abort", wake);
          resolve();
        };
        this.#wake = wake;
        this.#signal.addEventListener("abort", wake, { once: true });
      });
    }
    if (this.#closed || this.#signal.aborted) throw new ConnectError("Objective watch was cancelled.", Code.Canceled);
    this.#hasValue = false;
    return this.#value;
  }

  close(): void {
    this.#closed = true;
    this.#wake?.();
    this.#wake = undefined;
  }
}
