import { create } from "@bufbuild/protobuf";
import { EventSchema, MessageRole } from "@joko/contracts";
import { describe, expect, it } from "vitest";
import { timelineRows } from "./timeline";

function completed(blocks: any[], role = MessageRole.ASSISTANT) {
  return create(EventSchema, {
    eventId: "complete",
    cursor: { sequence: 1n },
    payload: { kind: { case: "messageCompleted", value: {
      messageId: "message",
      role,
      blocks
    } } }
  });
}

describe("mobile Timeline quote source", () => {
  it("exposes exact completed assistant pure text and nothing else as quote authority", () => {
    expect(timelineRows([completed([
      { content: { case: "text", value: "first" } },
      { content: { case: "text", value: "second" } }
    ])])[0]?.quoteSource).toEqual({
      sourceMessageId: "message",
      sourceEventId: "complete",
      text: "first\nsecond"
    });
    expect(timelineRows([completed([
      { content: { case: "text", value: "first" } },
      { content: { case: "artifact", value: {} } }
    ])])[0]?.quoteSource).toBeUndefined();
    expect(timelineRows([completed([{ content: { case: "text", value: "user" } }], MessageRole.USER)])[0]?.quoteSource)
      .toBeUndefined();
    expect(timelineRows([completed([{ content: { case: "text", value: "   " } }])])[0]?.quoteSource)
      .toBeUndefined();
  });
});
