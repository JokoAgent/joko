import { QueueItemState, SessionState, type QueueItem, type Snapshot } from "@joko/contracts";

/** Refresh the version of the same failed input if its native task has reattached. */
export function currentQueueRetryInput(before: Snapshot, source: QueueItem, after: Snapshot,
  options?: { readonly allowStaleQueueProjection?: boolean }): QueueItem | undefined {
  const prior = before.sessions.find(session => session.sessionId === source.sessionId);
  const current = after.sessions.find(session => session.sessionId === source.sessionId);
  const originalBinding = prior?.nativeBinding;
  const binding = current?.nativeBinding;
  const revision = source.version?.revision?.value;
  const sourceGeneration = source.version?.generation;
  if (!before.server?.serverId || after.server?.serverId !== before.server.serverId
    || after.generation !== before.generation || revision === undefined || revision < 1n
    || !originalBinding?.opaqueReference || !binding || binding.opaqueReference !== originalBinding.opaqueReference
    || sourceGeneration === undefined || sourceGeneration < 1n || originalBinding.runtimeGeneration < 1n
    || binding.runtimeGeneration < originalBinding.runtimeGeneration
    || prior?.backendId !== source.backendId || current?.backendId !== source.backendId
    || prior.targetId !== source.targetId || current.targetId !== source.targetId
    || current.archived || current.state === SessionState.CLOSED || current.state === SessionState.CLOSING) return undefined;

  return after.queueItems.find(item => item.queueItemId === source.queueItemId && item.sessionId === source.sessionId
    && item.runId === source.runId && item.sourceId === source.sourceId && item.backendId === source.backendId
    && item.targetId === source.targetId && item.state === QueueItemState.FAILED && item.retryBeforeDispatch
    && item.version?.revision?.value === revision && item.version.generation >= sourceGeneration
    // A sessionChanged Event can arrive independently of a durable QueueItem.
    // Only the directly fetched snapshot supplies the version for the mutation.
    && (options?.allowStaleQueueProjection === true || item.version.generation === binding.runtimeGeneration));
}
