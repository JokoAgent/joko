import { clone, create, equals } from "@bufbuild/protobuf";
import { EventSchema, SnapshotSchema, type Event, type PiSessionSnapshot, type Snapshot } from "@joko/contracts";

export function mobileEventWithoutCursorTicket(event: Event): Event {
  const exact = clone(EventSchema, event);
  // Independent reads issue fresh tickets for the same durable event.
  if (exact.cursor) {
    exact.cursor.opaqueToken = "";
    exact.cursor.issuedAt = undefined;
  }
  return exact;
}

export function historyInvalidated(event: Event): boolean {
  switch (event.payload?.kind.case) {
    case "messageDeleted":
    case "sessionReset":
    case "historyPruned": return true;
    case "nativeBranchChanged": return event.payload.kind.value.timelineRebuilt;
    default: return false;
  }
}

export function mobilePiHistoryRetired(next: Snapshot, previous: Snapshot | undefined): boolean {
  const session = next.sessions[0];
  const prior = previous?.sessions[0];
  if (!previous || next.server?.serverId !== previous.server?.serverId || next.generation !== previous.generation
    || next.scope?.kind.case !== "session" || previous.scope?.kind.case !== "session"
    || next.sessions.length !== 1 || previous.sessions.length !== 1 || !session || !prior
    || next.scope.kind.value.sessionId !== session.sessionId || previous.scope.kind.value.sessionId !== prior.sessionId
    || session.sessionId !== prior.sessionId || session.backendId !== prior.backendId || session.targetId !== prior.targetId
    || session.automationOrigin || session.derivationOrigin?.sideChat) return false;

  const matchesPiSession = (entry: PiSessionSnapshot) =>
    entry.productSessionId === session.sessionId && entry.backendId === session.backendId && entry.targetId === session.targetId;
  const nativeSessions = next.pi?.sessions.filter(matchesPiSession);
  const native = nativeSessions?.length === 1 ? nativeSessions[0] : undefined;
  if (session.backendId !== "pi" && !native && !previous.pi?.sessions.some(matchesPiSession)) return false;
  if (session.nativeBinding?.runtimeGeneration !== prior.nativeBinding?.runtimeGeneration
    || session.nativeBinding?.opaqueReference !== prior.nativeBinding?.opaqueReference) return true;
  if (session.activeNativeEntryId === prior.activeNativeEntryId) return false;

  // A new leaf can also be an ordinary append. Only the durable Pi ancestry
  // for this exact public leaf can prove that the previous leaf survived.
  if (!prior.activeNativeEntryId) return false;
  if (!native?.entriesComplete || native.activeLeafId !== session.activeNativeEntryId) return true;
  const parents = new Map<string, string>();
  for (const entry of native.entries) {
    const known = parents.get(entry.entryId);
    if (known !== undefined && known !== entry.parentId) return true;
    parents.set(entry.entryId, entry.parentId);
  }
  const visited = new Set<string>();
  let leaf = native.activeLeafId;
  while (leaf && !visited.has(leaf)) {
    if (leaf === prior.activeNativeEntryId) return false;
    visited.add(leaf);
    leaf = parents.get(leaf) ?? "";
  }
  return true;
}

/** Retain an older prefix only when the new first event proves the same immutable history boundary. */
export function retainMobileHistoryPrefix(next: Snapshot, previous: Snapshot | undefined): Snapshot {
  const session = next.sessions[0];
  const prior = previous?.sessions[0];
  if (!previous || next.generation !== previous.generation || next.server?.serverId !== previous.server?.serverId
    || next.sessions.length !== 1 || previous.sessions.length !== 1 || !session || !prior
    || session.sessionId !== prior.sessionId || session.backendId !== prior.backendId || session.targetId !== prior.targetId
    || session.nativeBinding?.runtimeGeneration !== prior.nativeBinding?.runtimeGeneration
    || session.nativeBinding?.opaqueReference !== prior.nativeBinding?.opaqueReference
    || next.timeline.length === 0 || previous.timeline.length === 0) return next;
  // A short Session snapshot already includes the whole visible timeline.
  if (next.scope?.kind.case === "session" && next.timeline.length < next.scope.kind.value.recentTimelineItems) return next;
  const previousEdge = previous.resumeCursor?.sequence ?? previous.timeline.at(-1)?.cursor?.sequence;
  if (next.timeline.some(event => historyInvalidated(event)
    && (previousEdge === undefined || event.cursor === undefined || event.cursor.sequence > previousEdge))) return next;

  const first = next.timeline[0]!;
  const boundary = previous.timeline.findIndex(event => event.eventId === first.eventId);
  if (boundary <= 0 || !equals(
    EventSchema,
    mobileEventWithoutCursorTicket(previous.timeline[boundary]!),
    mobileEventWithoutCursorTicket(first)
  )) return next;
  const timeline = [...previous.timeline.slice(0, boundary), ...next.timeline];
  if (new Set(timeline.map(event => event.eventId)).size !== timeline.length) return next;
  return create(SnapshotSchema, { ...next, timeline });
}
