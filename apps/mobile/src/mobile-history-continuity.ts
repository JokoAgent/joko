import { create, equals } from "@bufbuild/protobuf";
import { EventSchema, SnapshotSchema, type Snapshot } from "@joko/contracts";

/** Retain an older prefix only when the new first event proves the same immutable history boundary. */
export function retainMobileHistoryPrefix(next: Snapshot, previous: Snapshot | undefined): Snapshot {
  if (!previous || next.generation !== previous.generation || next.server?.serverId !== previous.server?.serverId
    || next.sessions.length !== 1 || previous.sessions.length !== 1
    || next.sessions[0]!.sessionId !== previous.sessions[0]!.sessionId
    || next.sessions[0]!.nativeBinding?.runtimeGeneration !== previous.sessions[0]!.nativeBinding?.runtimeGeneration
    || next.timeline.length === 0 || previous.timeline.length === 0) return next;
  const first = next.timeline[0]!;
  const boundary = previous.timeline.findIndex(event => event.eventId === first.eventId && equals(EventSchema, event, first));
  if (boundary <= 0) return next;
  const timeline = [...previous.timeline.slice(0, boundary), ...next.timeline];
  if (new Set(timeline.map(event => event.eventId)).size !== timeline.length) return next;
  return create(SnapshotSchema, { ...next, timeline });
}
