import type { OperationalStore, PersistedEvent } from "@joko/store";

/** Only the public parent trace of the admitted input is retained. It grants no authority. */
export function inputTraceparent(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length !== 55 || !/^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/u.test(value)
    || /^00-0{32}-|^00-[0-9a-f]{32}-0{16}-/u.test(value)) return undefined;
  return value;
}

export function acceptedInputTrace(store: OperationalStore, event: PersistedEvent) {
  if (event.payload.type !== "message_complete" || event.payload.role !== "user"
    || event.payload.acceptedInput === undefined || !event.operationId) return undefined;
  const parent = inputTraceparent(store.getAcceptedInputTraceparent(event.operationId, event.sessionId));
  return parent === undefined ? undefined : { traceId: parent.slice(3, 35), parentSpanId: parent.slice(36, 52) };
}
