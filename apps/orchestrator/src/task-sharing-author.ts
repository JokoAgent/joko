import { TaskShareStore, type OperationalStore, type PersistedEvent, type SharedTaskAuthor } from "@joko/store";

/** Immutable admission provenance survives membership retirement and restarts.
 * It is presentation data; it never grants a current guest capability. */
export function taskShareEventAuthor(store: OperationalStore, event: PersistedEvent): SharedTaskAuthor | undefined {
  if (event.payload.type !== "message_complete" || event.payload.role !== "user") return undefined;
  const queue = event.runId === undefined ? undefined : store.findQueueItemByRunId(event.sessionId, event.runId);
  const operationId = queue?.operationId ?? event.operationId;
  if (operationId === undefined) return undefined;
  const author = new TaskShareStore(store).getAuthorForOperation(operationId);
  return author?.sessionId === event.sessionId ? author : undefined;
}
