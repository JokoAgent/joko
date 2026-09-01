import { randomUUID } from "node:crypto";

import { create } from "@bufbuild/protobuf";
import type { Client } from "@connectrpc/connect";
import {
  AbortRunMutationSchema,
  ArchiveSessionMutationSchema,
  CloneSessionMutationSchema,
  CompactSessionMutationSchema,
  CreateScheduleMutationSchema,
  CreateSessionMutationSchema,
  EditQueueItemMutationSchema,
  EventService,
  EntityKind,
  ExportSessionMutationSchema,
  ForkSessionMutationSchema,
  InputContentSchema,
  InputPartSchema,
  InteractionResolutionSchema,
  ManualRecurrenceSchema,
  ModelKeySchema,
  ModelSelectionSchema,
  NavigateSessionBranchMutationSchema,
  OperationMutationSchema,
  OperationService,
  PermissionDecisionKind,
  PermissionMode,
  PermissionResolutionSchema,
  PinSessionMutationSchema,
  PauseQueueMutationSchema,
  QueuePlacementSchema,
  QueueDeliveryMode,
  ReorderQueueItemMutationSchema,
  RenameSessionMutationSchema,
  ResolveInteractionMutationSchema,
  RestartBackendMutationSchema,
  ResumeQueueMutationSchema,
  RetryRunMutationSchema,
  ScheduleExecutionSnapshotSchema,
  ScheduleInputSchema,
  ScheduleMisfirePolicy,
  ScheduleOverlapPolicy,
  ScheduleRecurrenceSchema,
  SendInputMutationSchema,
  SessionExportFormat,
  SetSessionPermissionMutationSchema,
  SetSessionPlanModeMutationSchema,
  SetQueueInteractionLockMutationSchema,
  SetQueueItemEditLockMutationSchema,
  TriggerScheduleMutationSchema,
  type Event,
  type EventCursor,
  type Operation,
  type OperationMutation,
  type QueueItem,
  type QueueControl
} from "@joko/contracts";

export type OperationClient = Client<typeof OperationService>;

export async function submit(
  client: OperationClient,
  connectionId: string,
  mutation: OperationMutation,
  operationId: string = randomUUID()
): Promise<Operation> {
  const response = await client.submitOperation({ operationId, connectionId, mutation });
  if (response.operation === undefined) throw new Error("Orchestrator returned no Operation.");
  return response.operation;
}

export function createSessionMutation(input: {
  readonly backendId: string;
  readonly targetId: string;
  readonly displayName?: string;
  readonly permissionMode?: PermissionMode;
  readonly planMode?: boolean;
  readonly providerId?: string;
  readonly modelId?: string;
  readonly effortId?: string;
  readonly fastMode?: boolean;
}): OperationMutation {
  if ((input.providerId === undefined) !== (input.modelId === undefined)) {
    throw new Error("E2E model selection requires both providerId and modelId.");
  }
  return create(OperationMutationSchema, {
    payload: {
      case: "createSession",
      value: create(CreateSessionMutationSchema, {
        backendId: input.backendId,
        targetId: input.targetId,
        displayName: input.displayName ?? "E2E task",
        permissionMode: input.permissionMode ?? PermissionMode.ASK,
        planMode: input.planMode ?? false,
        ...(input.providerId === undefined || input.modelId === undefined
          ? {}
          : {
              model: create(ModelSelectionSchema, {
                model: create(ModelKeySchema, {
                  providerId: input.providerId,
                  modelId: input.modelId
                }),
                effortId: input.effortId ?? "off",
                fastMode: input.fastMode ?? false
              })
            })
      })
    }
  });
}

export function sendInputMutation(
  sessionId: string,
  text: string,
  deliveryMode: QueueDeliveryMode = QueueDeliveryMode.PROMPT
): OperationMutation {
  return create(OperationMutationSchema, {
    payload: {
      case: "sendInput",
      value: create(SendInputMutationSchema, {
        sessionId,
        deliveryMode,
        input: textInput(text)
      })
    }
  });
}

export function abortRunMutation(runId: string): OperationMutation {
  return create(OperationMutationSchema, {
    payload: { case: "abortRun", value: create(AbortRunMutationSchema, { runId }) }
  });
}

export function pauseQueueMutation(control: QueueControl, reason = "E2E dispatch hold"): OperationMutation {
  if (control.version?.revision === undefined) throw new Error("Queue control has no entity version.");
  return create(OperationMutationSchema, {
    preconditions: [{
      entity: { kind: EntityKind.QUEUE_CONTROL, id: control.sessionId },
      expectedRevision: { value: control.version.revision.value },
      expectedGeneration: control.version.generation
    }],
    payload: {
      case: "pauseQueue",
      value: create(PauseQueueMutationSchema, { sessionId: control.sessionId, reason })
    }
  });
}

export function resumeQueueMutation(control: QueueControl): OperationMutation {
  if (control.version?.revision === undefined) throw new Error("Queue control has no entity version.");
  return create(OperationMutationSchema, {
    preconditions: [{
      entity: { kind: EntityKind.QUEUE_CONTROL, id: control.sessionId },
      expectedRevision: { value: control.version.revision.value },
      expectedGeneration: control.version.generation
    }],
    payload: {
      case: "resumeQueue",
      value: create(ResumeQueueMutationSchema, { sessionId: control.sessionId })
    }
  });
}

export function setQueueItemEditLockMutation(
  item: QueueItem,
  lockToken: string,
  locked: boolean
): OperationMutation {
  if (locked && item.version?.revision === undefined) throw new Error("Queue item has no entity version.");
  return create(OperationMutationSchema, {
    preconditions: locked ? [{
      entity: { kind: EntityKind.QUEUE_ITEM, id: item.queueItemId },
      expectedRevision: { value: item.version!.revision!.value },
      expectedGeneration: item.version!.generation
    }] : [],
    payload: {
      case: "setQueueItemEditLock",
      value: create(SetQueueItemEditLockMutationSchema, { queueItemId: item.queueItemId, lockToken, locked })
    }
  });
}

export function editQueuedInputMutation(
  item: QueueItem,
  text: string,
  deliveryMode: QueueDeliveryMode,
  lockToken: string
): OperationMutation {
  if (item.version?.revision === undefined) throw new Error("Queue item has no entity version.");
  return create(OperationMutationSchema, {
    preconditions: [{
      entity: { kind: EntityKind.QUEUE_ITEM, id: item.queueItemId },
      expectedRevision: { value: item.version.revision.value },
      expectedGeneration: item.version.generation
    }],
    payload: {
      case: "editQueueItem",
      value: create(EditQueueItemMutationSchema, {
        queueItemId: item.queueItemId,
        input: textInput(text),
        deliveryMode,
        lockToken
      })
    }
  });
}

export function setQueueInteractionLockMutation(
  control: QueueControl,
  lockToken: string,
  locked: boolean
): OperationMutation {
  if (locked && control.version?.revision === undefined) throw new Error("Queue control has no entity version.");
  return create(OperationMutationSchema, {
    preconditions: locked ? [{
      entity: { kind: EntityKind.QUEUE_CONTROL, id: control.sessionId },
      expectedRevision: { value: control.version!.revision!.value },
      expectedGeneration: control.version!.generation
    }] : [],
    payload: {
      case: "setQueueInteractionLock",
      value: create(SetQueueInteractionLockMutationSchema, { sessionId: control.sessionId, lockToken, locked })
    }
  });
}

export function reorderQueuedInputBeforeMutation(
  item: QueueItem,
  anchorQueueItemId: string,
  interactionLockToken: string
): OperationMutation {
  if (item.version?.revision === undefined) throw new Error("Queue item has no entity version.");
  return create(OperationMutationSchema, {
    preconditions: [{
      entity: { kind: EntityKind.QUEUE_ITEM, id: item.queueItemId },
      expectedRevision: { value: item.version.revision.value },
      expectedGeneration: item.version.generation
    }],
    payload: {
      case: "reorderQueueItem",
      value: create(ReorderQueueItemMutationSchema, {
        queueItemId: item.queueItemId,
        placement: create(QueuePlacementSchema, {
          anchor: { case: "beforeQueueItemId", value: anchorQueueItemId }
        }),
        interactionLockToken
      })
    }
  });
}

export function retryRunMutation(runId: string): OperationMutation {
  return create(OperationMutationSchema, {
    payload: { case: "retryRun", value: create(RetryRunMutationSchema, { runId }) }
  });
}

export function restartBackendMutation(backendId: string): OperationMutation {
  return create(OperationMutationSchema, {
    payload: {
      case: "restartBackend",
      value: create(RestartBackendMutationSchema, { backendId })
    }
  });
}

export function navigateMutation(sessionId: string, entryId: string): OperationMutation {
  return create(OperationMutationSchema, {
    payload: {
      case: "navigateSessionBranch",
      value: create(NavigateSessionBranchMutationSchema, { sessionId, nativeEntryId: entryId })
    }
  });
}

export function forkMutation(
  sessionId: string,
  entryId: string,
  sourceMessage: { readonly messageId: string; readonly eventId: string },
  displayName = "Forked task"
): OperationMutation {
  return create(OperationMutationSchema, {
    payload: {
      case: "forkSession",
      value: create(ForkSessionMutationSchema, {
        sourceSessionId: sessionId,
        nativeEntryId: entryId,
        newDisplayName: displayName,
        sourceMessageId: sourceMessage.messageId,
        sourceEventId: sourceMessage.eventId
      })
    }
  });
}

export function cloneMutation(sessionId: string, displayName = "Cloned task"): OperationMutation {
  return create(OperationMutationSchema, {
    payload: {
      case: "cloneSession",
      value: create(CloneSessionMutationSchema, { sourceSessionId: sessionId, newDisplayName: displayName })
    }
  });
}

export function compactMutation(sessionId: string): OperationMutation {
  return create(OperationMutationSchema, {
    payload: {
      case: "compactSession",
      value: create(CompactSessionMutationSchema, { sessionId, customInstructions: "Preserve decisions." })
    }
  });
}

export function exportMutation(sessionId: string): OperationMutation {
  return create(OperationMutationSchema, {
    payload: {
      case: "exportSession",
      value: create(ExportSessionMutationSchema, { sessionId, format: SessionExportFormat.HTML })
    }
  });
}

export function renameMutation(sessionId: string, displayName: string): OperationMutation {
  return create(OperationMutationSchema, {
    payload: { case: "renameSession", value: create(RenameSessionMutationSchema, { sessionId, displayName }) }
  });
}

export function pinMutation(sessionId: string, pinned: boolean): OperationMutation {
  return create(OperationMutationSchema, {
    payload: { case: "pinSession", value: create(PinSessionMutationSchema, { sessionId, pinned }) }
  });
}

export function archiveMutation(sessionId: string, archived: boolean): OperationMutation {
  return create(OperationMutationSchema, {
    payload: { case: "archiveSession", value: create(ArchiveSessionMutationSchema, { sessionId, archived }) }
  });
}

export function permissionMutation(sessionId: string, permissionMode: PermissionMode): OperationMutation {
  return create(OperationMutationSchema, {
    payload: {
      case: "setSessionPermission",
      value: create(SetSessionPermissionMutationSchema, { sessionId, permissionMode })
    }
  });
}

export function planModeMutation(sessionId: string, enabled: boolean): OperationMutation {
  return create(OperationMutationSchema, {
    payload: {
      case: "setSessionPlanMode",
      value: create(SetSessionPlanModeMutationSchema, { sessionId, enabled })
    }
  });
}

export function createManualScheduleMutation(input: {
  readonly backendId: string;
  readonly targetId: string;
  readonly sessionId: string;
  readonly text: string;
}): OperationMutation {
  const recurrence = create(ScheduleRecurrenceSchema, {
    kind: { case: "manual", value: create(ManualRecurrenceSchema, {}) }
  });
  const schedule = create(ScheduleInputSchema, {
    displayName: "E2E unattended schedule",
    backendId: input.backendId,
    targetId: input.targetId,
    sessionId: input.sessionId,
    recurrence,
    timeZone: "UTC",
    input: textInput(input.text),
    execution: create(ScheduleExecutionSnapshotSchema, { permissionMode: PermissionMode.ASK }),
    overlapPolicy: ScheduleOverlapPolicy.QUEUE,
    misfirePolicy: ScheduleMisfirePolicy.RUN_ONCE,
    enabled: true
  });
  return create(OperationMutationSchema, {
    payload: { case: "createSchedule", value: create(CreateScheduleMutationSchema, { schedule }) }
  });
}

export function triggerScheduleMutation(scheduleId: string): OperationMutation {
  return create(OperationMutationSchema, {
    payload: { case: "triggerSchedule", value: create(TriggerScheduleMutationSchema, { scheduleId }) }
  });
}

export function resolvePermissionMutation(input: {
  readonly connectionId: string;
  readonly interactionId: string;
  readonly generation: bigint;
}): OperationMutation {
  const resolution = create(InteractionResolutionSchema, {
    connectionId: input.connectionId,
    decision: {
      case: "permission",
      value: create(PermissionResolutionSchema, { decision: PermissionDecisionKind.ALLOW_ONCE })
    }
  });
  return create(OperationMutationSchema, {
    payload: {
      case: "resolveInteraction",
      value: create(ResolveInteractionMutationSchema, {
        interactionId: input.interactionId,
        interactionGeneration: input.generation,
        resolution
      })
    }
  });
}

export function sessionIdFrom(operation: Operation): string {
  if (operation.result?.payload.case !== "session") {
    throw new Error(`Expected Session result, received ${String(operation.result?.payload.case)}.`);
  }
  return operation.result.payload.value.sessionId;
}

export function queueItemIdFrom(operation: Operation): string {
  if (operation.result?.payload.case !== "queueItem") {
    throw new Error(`Expected QueueItem result, received ${String(operation.result?.payload.case)}.`);
  }
  return operation.result.payload.value.queueItemId;
}

export function queueItemFrom(operation: Operation): QueueItem {
  if (operation.result?.payload.case !== "queueItem") {
    throw new Error(`Expected QueueItem result, received ${unexpectedOperationResult(operation)}.`);
  }
  return operation.result.payload.value;
}

export function queueRunIdFrom(operation: Operation): string {
  if (operation.result?.payload.case !== "queueItem") {
    throw new Error(`Expected QueueItem result, received ${unexpectedOperationResult(operation)}.`);
  }
  return operation.result.payload.value.runId;
}

export function runIdFrom(operation: Operation): string {
  if (operation.result?.payload.case !== "run") {
    throw new Error(`Expected Run result, received ${unexpectedOperationResult(operation)}.`);
  }
  return operation.result.payload.value.runId;
}

function unexpectedOperationResult(operation: Operation): string {
  const result = String(operation.result?.payload.case);
  const message = operation.error?.message.trim();
  return message === undefined || message === ""
    ? `${result} (state ${operation.state})`
    : `${result} (state ${operation.state}: ${message})`;
}

export function scheduleIdFrom(operation: Operation): string {
  if (operation.result?.payload.case !== "schedule") {
    throw new Error(`Expected Schedule result, received ${String(operation.result?.payload.case)}.`);
  }
  return operation.result.payload.value.scheduleId;
}

export async function nextEvent(
  client: Client<typeof EventService>,
  request: { readonly scope?: Parameters<Client<typeof EventService>["streamEvents"]>[0]["scope"]; readonly afterCursor?: EventCursor },
  timeoutMs = 5_000
): Promise<Event> {
  const abort = new AbortController();
  const stream = client.streamEvents(request, { signal: abort.signal });
  const iterator = stream[Symbol.asyncIterator]();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const result = await iterator.next();
    if (result.done || result.value.event === undefined) throw new Error("Event stream ended before yielding an Event.");
    return result.value.event;
  } finally {
    clearTimeout(timer);
    abort.abort();
    await iterator.return?.();
  }
}

export function textInput(text: string) {
  return create(InputContentSchema, {
    parts: [create(InputPartSchema, { content: { case: "text", value: text } })]
  });
}
