import { create } from "@bufbuild/protobuf";
import { EventSchema, MessageRole } from "@joko/contracts";
import { describe, expect, it } from "vitest";
import {
  referencedMobileNativeTreeText,
  referencedMobileTimelineText
} from "./mobile-composer-route-resolution";

describe("mobile composer task-link resolution", () => {
  it("resolves only exact user/assistant timeline message or Event identities", () => {
    const events = [create(EventSchema, {
      eventId: "event-complete",
      cursor: { opaqueToken: "cursor", sequence: 1n, generation: 7n },
      identity: { sessionId: "session" },
      payload: { kind: { case: "messageCompleted", value: {
        messageId: "message",
        role: MessageRole.ASSISTANT,
        blocks: [{ content: { case: "text", value: "  Exact\nanswer  " } }]
      } } }
    })];
    expect(referencedMobileTimelineText(events, {
      kind: "message", href: "#/tasks/session?message=message", sessionId: "session", messageId: "message"
    })).toBe("Exact\nanswer");
    expect(referencedMobileTimelineText(events, {
      kind: "message", href: "#/tasks/session?event=event-complete", sessionId: "session", eventId: "event-complete"
    })).toBe("Exact\nanswer");
    expect(referencedMobileTimelineText(events, {
      kind: "message", href: "#/tasks/session?message=missing", sessionId: "session", messageId: "missing"
    })).toBeUndefined();
  });

  it("reads one exact user/assistant native message summary and rejects other rows", () => {
    const tree = {
      authorityKey: "tree",
      controlsAuthorityKey: "controls",
      surfaceOwnerKey: "surface",
      sessionId: "session",
      revisionValue: 1n,
      revisionEtag: "r1",
      rows: [
        { entryId: "message", kind: "message" as const, role: "assistant" as const, label: " Native answer ", active: true, activePath: true, branchDepth: 0, branching: false },
        { entryId: "tool", kind: "message" as const, role: "tool" as const, label: "secret", active: false, activePath: false, branchDepth: 0, branching: false }
      ]
    };
    expect(referencedMobileNativeTreeText(tree, "message")).toBe("Native answer");
    expect(referencedMobileNativeTreeText(tree, "tool")).toBeUndefined();
  });
});
