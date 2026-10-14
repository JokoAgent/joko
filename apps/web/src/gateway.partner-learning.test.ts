import { create } from "@bufbuild/protobuf";
import { EventSchema, MessageRole, PartnerLearningAction, PartnerLearningKind, SnapshotSchema } from "@joko/contracts";
import { describe, expect, it } from "vitest";
import { mapSnapshot, projectSnapshotEvent } from "./gateway.js";
import { timelineUnreadItemIds } from "./components/timeline-behavior.js";

const feedback = (revision: bigint, title = "Release") => ({ revision: { value: revision }, receipts: [{ kind: PartnerLearningKind.MEMORY,
  entryId: "memory", title, action: PartnerLearningAction.CREATED }] });
const completion = create(EventSchema, { eventId: "completion", identity: { sessionId: "session" }, cursor: { generation: 1n, sequence: 2n },
  payload: { kind: { case: "messageCompleted", value: { messageId: "message", role: MessageRole.ASSISTANT,
    blocks: [{ content: { case: "text", value: "Done." } }], learning: feedback(1n) } } } });
const changed = (revision: bigint, completionEventId = "completion", sessionId = "session") => create(EventSchema, {
  eventId: `feedback-${revision}`, identity: { sessionId }, cursor: { generation: 1n, sequence: 3n },
  payload: { kind: { case: "partnerLearningChanged", value: { messageId: "message", completionEventId, feedback: feedback(revision, "Updated release") } } }
});

describe("Partner learning message projection", () => {
  it("reads cold history and replaces only the exact original bubble during a live footer update", () => {
    const raw = create(SnapshotSchema, { generation: 1n, timeline: [completion], resumeCursor: { generation: 1n, sequence: 2n } });
    const initial = mapSnapshot(raw), bubble = initial.timelineBySession.get("session")![0]!;
    expect(bubble.learning?.revision).toBe(1n);
    const projected = projectSnapshotEvent(raw, initial, changed(2n));
    const result = projected.snapshot.timelineBySession.get("session")!;
    expect(projected.refresh).toBe("none");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: bubble.id, sourceEventId: "completion", sequence: bubble.sequence, completionCursor: bubble.completionCursor,
      text: "Done.", learning: { revision: 2n, receipts: [{ title: "Updated release" }] } });
    expect(timelineUnreadItemIds(result)).toEqual(timelineUnreadItemIds([bubble]));
    expect(mapSnapshot(create(SnapshotSchema, { timeline: [completion, changed(2n)] })).timelineBySession.get("session")).toEqual(result);
  });

  it("does not create a row or move feedback to a different completion, session, or earlier revision", () => {
    const raw = create(SnapshotSchema, { generation: 1n, timeline: [completion] });
    const snapshot = mapSnapshot(raw);
    for (const event of [changed(2n, "other-completion"), changed(2n, "completion", "other-session"), changed(1n)]) {
      const result = projectSnapshotEvent(raw, snapshot, event).snapshot;
      expect(result.timelineBySession.get("session")).toEqual(snapshot.timelineBySession.get("session"));
      expect(result.timelineBySession.get("other-session") ?? []).toEqual([]);
    }
  });
});
