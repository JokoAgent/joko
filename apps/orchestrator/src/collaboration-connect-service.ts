import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, type HandlerContext, type ServiceImpl } from "@connectrpc/connect";
import * as contract from "@joko/contracts";
import { WorkerHardLimitError } from "@joko/runtime-governance";
import type {
  CollaborationDispatchRecord,
  CollaborationDispatchStatus,
  CollaborationGoalRecord,
  CollaborationGoalStatus,
  CollaborationWorkerRecord,
  CollaborationWorkerStatus
} from "@joko/store";
import {
  AuthorizationError,
  InvalidStateTransitionError,
  NotFoundError,
  OperationConflictError,
  OperationInProgressError,
  OperationPreviouslyFailedError,
  RevisionConflictError,
  StaleGenerationError,
  StoreError
} from "@joko/store";

import {
  CollaborationGoalManager,
  CollaborationGoalManagerError,
  type CollaborationGoalTreeView,
  type CollaborationInterruptStopOutcome
} from "./collaboration-goal-manager.js";
import {
  fromProtoRevision,
  toProtoErrorInfo,
  toProtoQueueItem,
  toProtoRevision,
  toProtoTimestamp
} from "./proto-mapper.js";

export function createCollaborationConnectService(
  manager: CollaborationGoalManager | undefined,
  authenticate: (context: HandlerContext) => unknown
): ServiceImpl<typeof contract.CollaborationService> {
  const owner = (): CollaborationGoalManager => {
    if (manager === undefined) {
      throw new ConnectError("Collaboration Goals are unavailable.", Code.Unimplemented);
    }
    return manager;
  };

  return {
    listCollaborationGoals: (request, context) => {
      authenticate(context);
      return collaborationRpc(() => create(contract.ListCollaborationGoalsResponseSchema, {
        access: owner().listGoalAccessForSession({
          sessionId: request.sessionId,
          includeArchived: request.includeArchived
        }).map((entry) => create(contract.CollaborationGoalAccessSchema, {
          goal: toProtoGoal(entry.goal),
          role: entry.role === "lead"
            ? contract.CollaborationSessionRole.LEAD
            : contract.CollaborationSessionRole.WORKER,
          ...(entry.workerId === undefined ? {} : { workerId: entry.workerId })
        }))
      }));
    },
    getCollaborationGoal: (request, context) => {
      authenticate(context);
      return collaborationRpc(() => create(contract.GetCollaborationGoalResponseSchema, {
        tree: toProtoTree(owner().getTreeForSession(request.goalId, request.viewerSessionId))
      }));
    },
    createCollaborationGoal: (request, context) => {
      authenticate(context);
      return collaborationRpc(() => create(contract.CreateCollaborationGoalResponseSchema, {
        tree: toProtoTree(owner().createGoal({
          operationId: request.operationId,
          leadSessionId: request.leadSessionId,
          expectedSessionGeneration: safeNumber(
            request.expectedSessionGeneration,
            "expected_session_generation"
          ),
          title: request.title,
          objective: request.objective,
          ...(request.maximumWorkers === undefined ? {} : { maximumWorkers: request.maximumWorkers })
        }))
      }));
    },
    setCollaborationGoalStatus: async (request, context) => {
      authenticate(context);
      return collaborationRpc(async () => create(contract.SetCollaborationGoalStatusResponseSchema, {
        tree: toProtoTree(await owner().setGoalStatus({
          operationId: request.operationId,
          goalId: request.goalId,
          callerLeadSessionId: request.callerLeadSessionId,
          expectedRevision: fromProtoRevision(request.expectedRevision, "expected_revision"),
          status: fromProtoGoalTerminalStatus(request.status),
          signal: context.signal
        }))
      }));
    },
    createCollaborationWorker: async (request, context) => {
      authenticate(context);
      return collaborationRpc(async () => {
        const result = await owner().createWorker({
          operationId: request.operationId,
          goalId: request.goalId,
          callerLeadSessionId: request.callerLeadSessionId,
          expectedGoalRevision: fromProtoRevision(request.expectedGoalRevision, "expected_goal_revision"),
          ...(request.parentWorkerId === undefined ? {} : { parentWorkerId: request.parentWorkerId }),
          label: request.label,
          role: request.role,
          assignment: request.assignment,
          route: {
            targetId: request.targetId,
            ...(request.providerId === undefined ? {} : { providerId: request.providerId }),
            ...(request.modelId === undefined ? {} : { modelId: request.modelId }),
            ...(request.effort === undefined ? {} : { effort: request.effort }),
            fastMode: request.fastMode,
            permissionMode: fromProtoPermissionMode(request.permissionMode),
            planMode: request.planMode
          }
        });
        return create(contract.CreateCollaborationWorkerResponseSchema, {
          tree: toProtoTree(result.tree),
          worker: toProtoWorker(result.worker)
        });
      });
    },
    updateCollaborationWorker: (request, context) => {
      authenticate(context);
      return collaborationRpc(() => {
        const result = owner().updateWorker({
          operationId: request.operationId,
          workerId: request.workerId,
          callerLeadSessionId: request.callerLeadSessionId,
          expectedRevision: fromProtoRevision(request.expectedRevision, "expected_revision"),
          ...(request.label === undefined ? {} : { label: request.label }),
          ...(request.role === undefined ? {} : { role: request.role }),
          ...(request.assignment === undefined ? {} : { assignment: request.assignment })
        });
        return create(contract.UpdateCollaborationWorkerResponseSchema, {
          tree: toProtoTree(result.tree),
          worker: toProtoWorker(result.worker)
        });
      });
    },
    focusCollaborationWorker: (request, context) => {
      authenticate(context);
      return collaborationRpc(() => create(contract.FocusCollaborationWorkerResponseSchema, {
        tree: toProtoTree(owner().focusWorker({
          operationId: request.operationId,
          goalId: request.goalId,
          callerLeadSessionId: request.callerLeadSessionId,
          ...(request.workerId === undefined ? {} : { workerId: request.workerId }),
          ...(request.expectedWorkerRevision === undefined
            ? {}
            : {
                expectedWorkerRevision: fromProtoRevision(
                  request.expectedWorkerRevision,
                  "expected_worker_revision"
                )
              })
        }))
      }));
    },
    wakeCollaborationWorker: async (request, context) => {
      authenticate(context);
      return collaborationRpc(async () => {
        const result = await owner().wakeWorker({
          operationId: request.operationId,
          workerId: request.workerId,
          callerLeadSessionId: request.callerLeadSessionId,
          expectedRevision: fromProtoRevision(request.expectedRevision, "expected_revision"),
          expectedSessionGeneration: safeNumber(
            request.expectedSessionGeneration,
            "expected_session_generation"
          )
        });
        return create(contract.WakeCollaborationWorkerResponseSchema, {
          tree: toProtoTree(result.tree),
          worker: toProtoWorker(result.worker)
        });
      });
    },
    stopCollaborationWorker: async (request, context) => {
      authenticate(context);
      return collaborationRpc(async () => {
        const result = await owner().stopWorker({
          operationId: request.operationId,
          workerId: request.workerId,
          callerLeadSessionId: request.callerLeadSessionId,
          expectedRevision: fromProtoRevision(request.expectedRevision, "expected_revision"),
          ...(request.expectedSessionGeneration === undefined
            ? {}
            : {
                expectedSessionGeneration: safeNumber(
                  request.expectedSessionGeneration,
                  "expected_session_generation"
                )
              })
        });
        return create(contract.StopCollaborationWorkerResponseSchema, {
          tree: toProtoTree(result.tree),
          worker: toProtoWorker(result.worker)
        });
      });
    },
    releaseCollaborationWorker: async (request, context) => {
      authenticate(context);
      return collaborationRpc(async () => {
        const result = await owner().releaseWorker({
          operationId: request.operationId,
          workerId: request.workerId,
          callerLeadSessionId: request.callerLeadSessionId,
          expectedRevision: fromProtoRevision(request.expectedRevision, "expected_revision"),
          expectedSessionGeneration: safeNumber(
            request.expectedSessionGeneration,
            "expected_session_generation"
          )
        });
        return create(contract.ReleaseCollaborationWorkerResponseSchema, {
          tree: toProtoTree(result.tree),
          worker: toProtoWorker(result.worker)
        });
      });
    },
    archiveCollaborationWorker: (request, context) => {
      authenticate(context);
      return collaborationRpc(() => {
        const result = owner().archiveWorker({
          operationId: request.operationId,
          workerId: request.workerId,
          callerLeadSessionId: request.callerLeadSessionId,
          expectedRevision: fromProtoRevision(request.expectedRevision, "expected_revision")
        });
        return create(contract.ArchiveCollaborationWorkerResponseSchema, {
          tree: toProtoTree(result.tree),
          worker: toProtoWorker(result.worker)
        });
      });
    },
    sendCollaborationWorkerMessage: async (request, context) => {
      authenticate(context);
      return collaborationRpc(async () => {
        const result = await owner().sendMessage({
          operationId: request.operationId,
          goalId: request.goalId,
          workerId: request.workerId,
          callerLeadSessionId: request.callerLeadSessionId,
          expectedWorkerRevision: fromProtoRevision(
            request.expectedWorkerRevision,
            "expected_worker_revision"
          ),
          expectedSessionGeneration: safeNumber(
            request.expectedSessionGeneration,
            "expected_session_generation"
          ),
          message: request.message
        });
        return create(contract.SendCollaborationWorkerMessageResponseSchema, {
          tree: toProtoTree(result.tree),
          dispatch: toProtoDispatch(result.dispatch)
        });
      });
    },
    interruptCollaborationWorker: async (request, context) => {
      authenticate(context);
      return collaborationRpc(async () => {
        const result = await owner().interruptWorker({
          operationId: request.operationId,
          goalId: request.goalId,
          workerId: request.workerId,
          callerLeadSessionId: request.callerLeadSessionId,
          expectedWorkerRevision: fromProtoRevision(
            request.expectedWorkerRevision,
            "expected_worker_revision"
          ),
          expectedSessionGeneration: safeNumber(
            request.expectedSessionGeneration,
            "expected_session_generation"
          ),
          message: request.message
        });
        return create(contract.InterruptCollaborationWorkerResponseSchema, {
          tree: toProtoTree(result.tree),
          dispatch: toProtoDispatch(result.dispatch),
          stopOutcome: toProtoInterruptStopOutcome(result.stopOutcome)
        });
      });
    },
    editCollaborationDispatch: (request, context) => {
      authenticate(context);
      return collaborationRpc(() => {
        const result = owner().editDispatch({
          operationId: request.operationId,
          dispatchId: request.dispatchId,
          callerLeadSessionId: request.callerLeadSessionId,
          expectedDispatchRevision: fromProtoRevision(
            request.expectedDispatchRevision,
            "expected_dispatch_revision"
          ),
          expectedQueueRevision: fromProtoRevision(
            request.expectedQueueRevision,
            "expected_queue_revision"
          ),
          message: request.message
        });
        return create(contract.EditCollaborationDispatchResponseSchema, {
          tree: toProtoTree(result.tree),
          dispatch: toProtoDispatch(result.dispatch)
        });
      });
    },
    cancelCollaborationDispatch: (request, context) => {
      authenticate(context);
      return collaborationRpc(() => {
        const result = owner().cancelDispatch({
          operationId: request.operationId,
          dispatchId: request.dispatchId,
          callerLeadSessionId: request.callerLeadSessionId,
          expectedDispatchRevision: fromProtoRevision(
            request.expectedDispatchRevision,
            "expected_dispatch_revision"
          ),
          expectedQueueRevision: fromProtoRevision(
            request.expectedQueueRevision,
            "expected_queue_revision"
          )
        });
        return create(contract.CancelCollaborationDispatchResponseSchema, {
          tree: toProtoTree(result.tree),
          dispatch: toProtoDispatch(result.dispatch)
        });
      });
    },
    mergeCollaborationDispatches: (request, context) => {
      authenticate(context);
      return collaborationRpc(() => {
        const result = owner().mergeDispatches({
          operationId: request.operationId,
          goalId: request.goalId,
          workerId: request.workerId,
          callerLeadSessionId: request.callerLeadSessionId,
          dispatches: request.dispatches.map((candidate, index) => ({
            dispatchId: candidate.dispatchId,
            expectedDispatchRevision: fromProtoRevision(
              candidate.expectedDispatchRevision,
              `dispatches[${index}].expected_dispatch_revision`
            ),
            expectedQueueRevision: fromProtoRevision(
              candidate.expectedQueueRevision,
              `dispatches[${index}].expected_queue_revision`
            )
          }))
        });
        return create(contract.MergeCollaborationDispatchesResponseSchema, {
          tree: toProtoTree(result.tree),
          dispatches: result.dispatches.map(toProtoDispatch)
        });
      });
    }
  };
}

export function toProtoCollaborationGoalTree(view: CollaborationGoalTreeView): contract.CollaborationGoalTree {
  return toProtoTree(view);
}

function toProtoTree(view: CollaborationGoalTreeView): contract.CollaborationGoalTree {
  const workers = new Map(view.workers.map((worker) => [worker.id, worker]));
  return create(contract.CollaborationGoalTreeSchema, {
    goal: toProtoGoal(view.goal),
    workers: view.workers.map(toProtoWorker),
    queue: view.queue.map((entry, index) => {
      const worker = workers.get(entry.dispatch.workerId);
      return create(contract.CollaborationQueueEntrySchema, {
        dispatch: toProtoDispatch(entry.dispatch),
        ...(entry.queueItem === undefined || worker?.sessionGeneration === undefined
          ? {}
          : {
              queueItem: toProtoQueueItem(entry.queueItem, {
                backendId: worker.backendId,
                targetId: worker.targetId,
                source: "system",
                generation: worker.sessionGeneration
              }, BigInt(index))
            })
      });
    }),
    ...(view.focusedWorkerId === undefined ? {} : { focusedWorkerId: view.focusedWorkerId })
  });
}

function toProtoGoal(goal: CollaborationGoalRecord): contract.CollaborationGoal {
  return create(contract.CollaborationGoalSchema, {
    goalId: goal.id,
    leadId: goal.leadId,
    leadSessionId: goal.leadSessionId,
    backendId: goal.backendId,
    targetId: goal.targetId,
    sessionGeneration: BigInt(goal.sessionGeneration),
    backendInstanceGeneration: BigInt(goal.backendInstanceGeneration),
    title: goal.title,
    objective: goal.objective,
    ...(goal.maximumWorkers === undefined ? {} : { maximumWorkers: goal.maximumWorkers }),
    status: toProtoGoalStatus(goal.status),
    ...(goal.lastError === undefined ? {} : { error: toProtoErrorInfo(goal.lastError) }),
    createdAt: toProtoTimestamp(goal.createdAt),
    updatedAt: toProtoTimestamp(goal.updatedAt),
    ...(goal.completedAt === undefined ? {} : { completedAt: toProtoTimestamp(goal.completedAt) }),
    revision: toProtoRevision(goal.revision)
  });
}

function toProtoWorker(worker: CollaborationWorkerRecord): contract.CollaborationWorker {
  return create(contract.CollaborationWorkerSchema, {
    workerId: worker.id,
    goalId: worker.goalId,
    ...(worker.parentWorkerId === undefined ? {} : { parentWorkerId: worker.parentWorkerId }),
    ...(worker.sessionId === undefined ? {} : { sessionId: worker.sessionId }),
    route: create(contract.CollaborationWorkerRouteSchema, {
      backendId: worker.backendId,
      targetId: worker.targetId,
      ...(worker.providerId === undefined ? {} : { providerId: worker.providerId }),
      ...(worker.modelId === undefined ? {} : { modelId: worker.modelId }),
      ...(worker.effort === undefined ? {} : { effort: worker.effort }),
      fastMode: worker.fastMode,
      permissionMode: toProtoPermissionMode(worker.permissionMode),
      planMode: worker.planMode
    }),
    ...(worker.sessionGeneration === undefined
      ? {}
      : { sessionGeneration: BigInt(worker.sessionGeneration) }),
    ...(worker.backendInstanceGeneration === undefined
      ? {}
      : { backendInstanceGeneration: BigInt(worker.backendInstanceGeneration) }),
    label: worker.label,
    role: worker.role,
    assignment: worker.assignment,
    status: toProtoWorkerStatus(worker.status),
    focused: worker.focused,
    runtimeReleased: worker.runtimeReleased,
    softLimitWarning: worker.softLimitWarning,
    ...(worker.idleSince === undefined ? {} : { idleSince: toProtoTimestamp(worker.idleSince) }),
    ...(worker.lastError === undefined ? {} : { error: toProtoErrorInfo(worker.lastError) }),
    createdAt: toProtoTimestamp(worker.createdAt),
    updatedAt: toProtoTimestamp(worker.updatedAt),
    revision: toProtoRevision(worker.revision)
  });
}

function toProtoDispatch(dispatch: CollaborationDispatchRecord): contract.CollaborationDispatch {
  return create(contract.CollaborationDispatchSchema, {
    dispatchId: dispatch.id,
    goalId: dispatch.goalId,
    workerId: dispatch.workerId,
    callerLeadSessionId: dispatch.callerLeadSessionId,
    operationId: dispatch.operationId,
    ...(dispatch.queueItemId === undefined ? {} : { queueItemId: dispatch.queueItemId }),
    message: dispatch.message,
    status: toProtoDispatchStatus(dispatch.status),
    ...(dispatch.mergedIntoDispatchId === undefined
      ? {}
      : { mergedIntoDispatchId: dispatch.mergedIntoDispatchId }),
    createdAt: toProtoTimestamp(dispatch.createdAt),
    updatedAt: toProtoTimestamp(dispatch.updatedAt),
    revision: toProtoRevision(dispatch.revision)
  });
}

function toProtoGoalStatus(status: CollaborationGoalStatus): contract.CollaborationGoalStatus {
  if (status === "active") return contract.CollaborationGoalStatus.ACTIVE;
  if (status === "completed") return contract.CollaborationGoalStatus.COMPLETED;
  if (status === "stopped") return contract.CollaborationGoalStatus.STOPPED;
  if (status === "failed") return contract.CollaborationGoalStatus.FAILED;
  return contract.CollaborationGoalStatus.ARCHIVED;
}

function fromProtoGoalTerminalStatus(
  status: contract.CollaborationGoalStatus
): Exclude<CollaborationGoalStatus, "active"> {
  if (status === contract.CollaborationGoalStatus.COMPLETED) return "completed";
  if (status === contract.CollaborationGoalStatus.STOPPED) return "stopped";
  if (status === contract.CollaborationGoalStatus.FAILED) return "failed";
  if (status === contract.CollaborationGoalStatus.ARCHIVED) return "archived";
  throw new ConnectError("A terminal collaboration Goal status is required.", Code.InvalidArgument);
}

function toProtoWorkerStatus(status: CollaborationWorkerStatus): contract.CollaborationWorkerStatus {
  if (status === "provisioning") return contract.CollaborationWorkerStatus.PROVISIONING;
  if (status === "idle") return contract.CollaborationWorkerStatus.IDLE;
  if (status === "queued") return contract.CollaborationWorkerStatus.QUEUED;
  if (status === "running") return contract.CollaborationWorkerStatus.RUNNING;
  if (status === "completed") return contract.CollaborationWorkerStatus.COMPLETED;
  if (status === "failed") return contract.CollaborationWorkerStatus.FAILED;
  if (status === "stopping") return contract.CollaborationWorkerStatus.STOPPING;
  if (status === "stopped") return contract.CollaborationWorkerStatus.STOPPED;
  if (status === "dispatch_unknown") return contract.CollaborationWorkerStatus.DISPATCH_UNKNOWN;
  return contract.CollaborationWorkerStatus.ARCHIVED;
}

function toProtoDispatchStatus(status: CollaborationDispatchStatus): contract.CollaborationDispatchStatus {
  if (status === "preparing") return contract.CollaborationDispatchStatus.PREPARING;
  if (status === "queued") return contract.CollaborationDispatchStatus.QUEUED;
  if (status === "merged") return contract.CollaborationDispatchStatus.MERGED;
  if (status === "cancelled") return contract.CollaborationDispatchStatus.CANCELLED;
  return contract.CollaborationDispatchStatus.DISPATCH_UNKNOWN;
}

function toProtoInterruptStopOutcome(
  outcome: CollaborationInterruptStopOutcome
): contract.CollaborationInterruptStopOutcome {
  switch (outcome) {
    case "stopped": return contract.CollaborationInterruptStopOutcome.STOPPED;
    case "not_running": return contract.CollaborationInterruptStopOutcome.NOT_RUNNING;
    case "unconfirmed": return contract.CollaborationInterruptStopOutcome.UNCONFIRMED;
    case "already_queued": return contract.CollaborationInterruptStopOutcome.ALREADY_QUEUED;
  }
}

function fromProtoPermissionMode(value: contract.PermissionMode): "ask" | "auto" | "bypassPermissions" {
  if (value === contract.PermissionMode.ASK) return "ask";
  if (value === contract.PermissionMode.AUTO) return "auto";
  if (value === contract.PermissionMode.BYPASS_PERMISSIONS) return "bypassPermissions";
  throw new ConnectError("A collaboration worker permission mode is required.", Code.InvalidArgument);
}

function toProtoPermissionMode(value: "ask" | "auto" | "bypassPermissions"): contract.PermissionMode {
  if (value === "ask") return contract.PermissionMode.ASK;
  if (value === "auto") return contract.PermissionMode.AUTO;
  return contract.PermissionMode.BYPASS_PERMISSIONS;
}

async function collaborationRpc<T>(effect: () => Promise<T>): Promise<T>;
function collaborationRpc<T>(effect: () => T): T;
function collaborationRpc<T>(effect: () => T | Promise<T>): T | Promise<T> {
  try {
    const result = effect();
    return result instanceof Promise
      ? result.catch((error: unknown) => { throw collaborationConnectError(error); })
      : result;
  } catch (error) {
    throw collaborationConnectError(error);
  }
}

function collaborationConnectError(error: unknown): unknown {
  if (error instanceof ConnectError) return error;
  if (error instanceof WorkerHardLimitError) {
    return new ConnectError(error.message, Code.ResourceExhausted);
  }
  if (error instanceof CollaborationGoalManagerError) {
    return new ConnectError(
      error.message,
      error.code === "COLLABORATION_WORKER_ROUTE_UNAVAILABLE"
        ? Code.FailedPrecondition
        : Code.Aborted
    );
  }
  if (error instanceof NotFoundError) return new ConnectError(error.message, Code.NotFound);
  if (error instanceof OperationConflictError) return new ConnectError(error.message, Code.AlreadyExists);
  if (error instanceof OperationPreviouslyFailedError || error instanceof InvalidStateTransitionError) {
    return new ConnectError(error.message, Code.FailedPrecondition);
  }
  if (error instanceof OperationInProgressError || error instanceof RevisionConflictError
    || error instanceof StaleGenerationError) {
    return new ConnectError(error.message, Code.Aborted);
  }
  if (error instanceof AuthorizationError) return new ConnectError(error.message, Code.Unauthenticated);
  if (error instanceof StoreError) return new ConnectError(error.message, Code.InvalidArgument);
  return error;
}

function safeNumber(value: bigint, field: string): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ConnectError(`${field} is outside the supported range.`, Code.InvalidArgument);
  }
  return Number(value);
}
