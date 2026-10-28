import { create, toBinary } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import * as contract from "@joko/contracts";
import { TaskShareStore, type OperationalStore } from "@joko/store";
import { fromProtoInputContent } from "./proto-mapper.js";
import { coreTurnOverrides, interactionDecisionSubmission, outcomeFromRecord, toProtoOperation,
  validatePreconditions, QUEUE_LOCK_TTL_MS, wakeQueueAfterLockExpiry, type ConnectServiceDependencies } from "./connect-services.js";
import type { PreparedTaskShareOperation, TaskShareLease, TaskSharingRuntimePort } from "./task-sharing-host-types.js";
import { minimizeSharedTaskOperation } from "./task-sharing-reads.js";

type Outcome = { readonly accepted: boolean; readonly resultCase?: "queueItem" | "queueControl" | "session" | "interaction";
  readonly entityId?: string };

/** Internal composition with the original task runtime. Public guest dispatch
 * cannot reach the ordinary node mutation dispatcher or manufacture a Connection. */
export function createTaskSharingRuntime(
  dependencies: ConnectServiceDependencies,
  reads: Pick<TaskSharingRuntimePort, "snapshot" | "read" | "projectEvent">
): TaskSharingRuntimePort {
  const { store, sessionHost: host } = dependencies;
  return {
    snapshot: (lease, signal) => reads.snapshot(lease, signal),
    read: (lease, method, requestBytes, signal) => reads.read(lease, method, requestBytes, signal),
    projectEvent: (lease, event) => reads.projectEvent(lease, event),
    canShare: sessionId => {
      const session = store.getSession(sessionId).descriptor;
      return !session.archived && session.deletedAt === undefined
        && host.canShareSession(sessionId)
        && dependencies.partnerGroupRuntime?.isGroupSession(sessionId) !== true;
    },
    prepareOperation: (lease, request) => {
      const mutation = request.mutation;
      if (!mutation?.payload.case || !request.operationId || request.connectionId) throw denied();
      // A collision with an ordinary/service operation is never adopted as a guest receipt.
      if (store.findOperation(request.operationId)) throw denied();
      const sessionId = lease.scope.sessionId;
      const currentBackendId = store.getSession(sessionId).descriptor.backendId;
      const targetBackendId = mutation.payload.case === "setSessionRuntime" ? mutation.payload.value.backendId ?? currentBackendId : currentBackendId;
      if (["sendInput", "setSessionRuntime", "resumeQueue", "resumeSession", "editQueueItem", "setSessionModel", "resolveInteraction"].includes(mutation.payload.case)
        && [currentBackendId, targetBackendId].some(id => store.getBackend(id).descriptor.capabilities.get("model.remote_execution")?.supported === true)) throw denied();
      const assertCurrent = () => {
        lease.assertCurrent();
        validatePreconditions(store, mutation);
      };
      assertCurrent();
      const response = () => toBinary(contract.SubmitOperationResponseSchema, create(contract.SubmitOperationResponseSchema, {
        operation: minimizeSharedTaskOperation(toProtoOperation(dependencies, store.getOperation(request.operationId), mutation,
          outcomeFromRecord(store.getOperation(request.operationId)), Date.now()), lease)
      }));
      const transactional = (commit: (transaction: OperationalStore) => Outcome,
        afterCommit?: () => void): PreparedTaskShareOperation => ({ kind: "transactional",
        commit: transaction => {
          assertCurrent();
          transaction.runOperation({ id: request.operationId, kind: mutation.payload.case!, body: mutation }, target => {
            assertCurrent(); return commit(target);
          });
          return response();
        }, ...(afterCommit === undefined ? {} : { afterCommit }) });
      const effect = (execute: (signal: AbortSignal, complete: () => Uint8Array) => Promise<Uint8Array>,
        outcome: Outcome): PreparedTaskShareOperation => {
        const claim = store.claimDeferredEffectOperation<Outcome>({ id: request.operationId, kind: mutation.payload.case!, body: mutation }, assertCurrent);
        if (!claim.claimed) throw denied();
        return { kind: "effect", execute: async (_author, signal) => {
          signal.throwIfAborted(); lease.assertCurrent();
          return execute(signal, () => {
            lease.assertCurrent(); signal.throwIfAborted();
            store.completeDeferredEffectOperation(request.operationId, claim.operation.bodyHash, () => outcome);
            return response();
          });
        } };
      };
      const payload = mutation.payload;
      switch (payload.case) {
        case "sendInput": {
          const generation = mutation.preconditions.find(item => item.entity?.kind === contract.EntityKind.SESSION
            && item.entity.id === sessionId)?.expectedGeneration;
          if (!generation || generation < 1n || generation > BigInt(Number.MAX_SAFE_INTEGER)) throw new ConnectError("The source task generation is required.", Code.InvalidArgument);
          const prompt = fromProtoInputContent(payload.value.input, disposition(payload.value.deliveryMode));
          const overrides = coreTurnOverrides(payload.value.overrides);
          return transactional(transaction => {
            const queued = host.commitQueuedInput(transaction, { operationId: request.operationId, sessionId,
              prompt, ...(overrides === undefined ? {} : { overrides }) });
            return { accepted: true, resultCase: "queueItem", entityId: queued.queueItemId };
          }, () => host.drainQueuedInput(sessionId));
        }
        case "resumeQueue":
          requireRevision(mutation, contract.EntityKind.QUEUE_CONTROL, sessionId);
          return transactional(transaction => {
            transaction.setQueuePaused({ sessionId, paused: false, traceId: `operation:${request.operationId}` });
            return { accepted: true, resultCase: "queueControl", entityId: sessionId };
          }, () => host.requestQueueDrain(sessionId));
        case "cancelQueueItem": {
          const queueItemId = payload.value.queueItemId;
          requireRevision(mutation, contract.EntityKind.QUEUE_ITEM, queueItemId);
          return transactional(transaction => {
            transaction.cancelQueueItem({ queueItemId, taskShare: lease.proof, traceId: `operation:${request.operationId}` });
            return { accepted: true, resultCase: "queueItem", entityId: queueItemId };
          }, () => host.requestQueueDrain(sessionId));
        }
        case "setQueueItemEditLock": {
          const { queueItemId, lockToken, locked } = payload.value;
          if (locked) requireRevision(mutation, contract.EntityKind.QUEUE_ITEM, queueItemId);
          return transactional(transaction => {
            transaction.setTaskShareQueueItemEditLock({ proof: lease.proof, queueItemId, lockToken, locked,
              ttlMs: QUEUE_LOCK_TTL_MS, traceId: `operation:${request.operationId}:queue-edit-lock` });
            return { accepted: true, resultCase: "queueItem", entityId: queueItemId };
          }, () => {
            if (!locked) host.requestQueueDrain(sessionId);
            else wakeQueueAfterLockExpiry(host, sessionId, () => {
              store.expireQueueLocks({ sessionId, traceId: `queue:${sessionId}:lock-expiry` });
            });
          });
        }
        case "editQueueItem": {
          const { queueItemId, lockToken, input, deliveryMode, textSplices } = payload.value;
          requireRevision(mutation, contract.EntityKind.QUEUE_ITEM, queueItemId);
          return transactional(transaction => {
            new TaskShareStore(transaction).assertOwnPending(lease.proof, queueItemId);
            const current = transaction.getQueueItem(queueItemId);
            const prompt = host.canonicalQueueItemEdit(current, {
              ...fromProtoInputContent(input, deliveryMode === undefined ? current.disposition : disposition(deliveryMode)),
              disposition: deliveryMode === undefined ? current.disposition : disposition(deliveryMode)
            }, textSplices.map(splice => ({ start: splice.start, end: splice.end, replacementText: splice.replacementText })));
            host.assertInputCapabilities(sessionId, prompt);
            const updated = transaction.editQueueItem({ queueItemId, body: prompt, taskShare: lease.proof,
              lockToken, traceId: `operation:${request.operationId}` });
            if (prompt.disposition === "steer") transaction.reorderQueueItem({ queueItemId,
              taskShare: lease.proof, editLockToken: lockToken, placement: { edge: "first" },
              expectedRevision: updated.revision, traceId: `operation:${request.operationId}:steer` });
            return { accepted: true, resultCase: "queueItem", entityId: queueItemId };
          });
        }
        case "resolveInteraction": {
          if (!payload.value.resolution) throw denied();
          const decision = interactionDecisionSubmission(payload.value.resolution);
          const current = store.getInteraction(payload.value.interactionId);
          if (current.sessionId !== sessionId || decision.kind !== "decision"
            || !(current.kind === "permission" && decision.value.kind === "permission"
              || current.kind === "question" && decision.value.kind === "question"
              || current.kind === "plan_review" && decision.value.kind === "plan_review")) throw denied();
          return transactional(() => {
            host.resolveInteraction(current.id, Number(payload.value.interactionGeneration), decision.value,
              `operation:${request.operationId}`, request.operationId);
            return { accepted: true, resultCase: "interaction", entityId: current.id };
          });
        }
        case "abortRun": {
          const run = store.getRun(payload.value.runId);
          if (run.descriptor.sessionId !== sessionId) throw denied();
          // The original abort only stops the active Run and retains pending input.
          return effect(async (signal, complete) => {
            lease.assertCurrent(); signal.throwIfAborted();
            await host.abort(sessionId, run.descriptor.id);
            return complete();
          }, { accepted: true });
        }
        case "resumeSession":
          return effect(async (signal, complete) => {
            lease.assertCurrent(); signal.throwIfAborted();
            await host.resume(sessionId);
            return complete();
          }, { accepted: true, resultCase: "session", entityId: sessionId });
        case "setSessionModel": {
          const selection = payload.value.model, model = selection?.model;
          if (!selection || !model) throw new ConnectError("A model selection is required.", Code.InvalidArgument);
          return effect(async (signal, complete) => host.applyAuthorizedSessionModel({ sessionId,
            providerId: model.providerId, modelId: model.modelId,
            ...(selection.effortId ? { effort: selection.effortId } : {}), fastMode: contract.decodeModelSpeed(selection),
            assertCurrent: () => { lease.assertCurrent(); signal.throwIfAborted(); }, commit: () => complete()
          }), { accepted: true, resultCase: "session", entityId: sessionId });
        }
        case "setSessionRuntime": {
          const value = payload.value, expectedGeneration = Number(value.expectedRuntimeGeneration);
          if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 0) throw new ConnectError("The runtime generation is invalid.", Code.InvalidArgument);
          const patch = { ...(value.backendId === undefined ? {} : { backendId: value.backendId }),
            ...(value.providerId === undefined ? {} : { providerId: value.providerId }),
            ...(value.modelId === undefined ? {} : { modelId: value.modelId }),
            ...(value.effort === undefined ? {} : { effort: value.effort }),
            ...(value.fastMode === undefined && value.ultrafastMode === undefined ? {} : { fastMode: contract.decodeModelSpeed(value) }) };
          return effect(async (signal, complete) => {
            await host.setSessionRuntimeControl({ sessionId, expectedGeneration, patch,
              assertAuthority: () => { lease.assertCurrent(); signal.throwIfAborted(); } });
            return complete();
          }, { accepted: true });
        }
        default: throw denied();
      }
    }
  };
}

function disposition(mode: contract.QueueDeliveryMode): "prompt" | "steer" | "follow_up" {
  if (mode === contract.QueueDeliveryMode.PROMPT) return "prompt";
  if (mode === contract.QueueDeliveryMode.STEER) return "steer";
  if (mode === contract.QueueDeliveryMode.FOLLOW_UP) return "follow_up";
  throw new ConnectError("The input delivery mode is invalid.", Code.InvalidArgument);
}
function requireRevision(mutation: contract.OperationMutation, kind: contract.EntityKind, id: string): void {
  if (!mutation.preconditions.some(item => item.entity?.kind === kind && item.entity.id === id && item.expectedRevision)) {
    throw new ConnectError("The current entity revision is required.", Code.InvalidArgument);
  }
}
function denied(): ConnectError { return new ConnectError("This action is not available to this task participant.", Code.PermissionDenied); }
