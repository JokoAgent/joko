import { create } from "@bufbuild/protobuf";
import { EventSchema, MessageRole, PartnerLearningAction, PartnerLearningKind } from "@joko/contracts";
import { describe, expect, it } from "vitest";
import { timelineRows } from "./timeline";

const feedback = (revision: bigint, title = "Release") => ({ revision: { value: revision }, receipts: [{
  kind: PartnerLearningKind.SKILL, entryId: "skill", title, action: PartnerLearningAction.UPDATED }] });
const complete = create(EventSchema, { eventId: "completion", identity: { sessionId: "session" }, cursor: { generation: 1n, sequence: 2n },
  payload: { kind: { case: "messageCompleted", value: { messageId: "message", role: MessageRole.ASSISTANT,
    blocks: [{ content: { case: "text", value: "Done." } }], learning: feedback(1n) } } } });
const update = (revision: bigint, completionEventId = "completion", sessionId = "session", generation = 1n) => create(EventSchema, {
  eventId: `learning-${revision}`, identity: { sessionId }, cursor: { generation, sequence: 3n },
  payload: { kind: { case: "partnerLearningChanged", value: { completionEventId, messageId: "message", feedback: feedback(revision, "Release steps") } } }
});

describe("Mobile Partner learning original reply projection", () => {
  it("replaces the original message footer from live or cold events without changing its body, cursor or row count", () => {
    const before = timelineRows([complete])[0]!;
    const rows = timelineRows([complete, update(2n)]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: before.id, eventId: "completion", sequence: before.sequence, completionCursor: before.completionCursor,
      text: "Done.", learning: { revision: 2n, receipts: [{ title: "Release steps" }] } });
    expect(timelineRows([update(2n), complete])).toEqual(rows);
  });

  it("ignores unrelated, older and foreign-generation footer changes without creating an activity", () => {
    const before = timelineRows([complete]);
    for (const changed of [update(2n, "another-completion"), update(2n, "completion", "foreign-session"), update(2n, "completion", "session", 2n), update(1n)]) {
      expect(timelineRows([complete, changed])).toEqual(before);
    }
  });
});
