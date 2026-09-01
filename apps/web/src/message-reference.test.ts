import { describe, expect, it } from "vitest";
import { activeComposerMentions, messageMentionWireText, sessionMessageDeepLink, upsertComposerMention } from "./message-reference.js";

const messageMention = {
  id: "message:task-one:event-9",
  kind: "message" as const,
  reference: "entry:42",
  label: "Review task",
  sessionId: "task/one",
  role: "assistant" as const,
  sourceEventId: "event/9"
};

describe("structured message references", () => {
  it("wires a structured mention to the canonical current-origin deep link", () => {
    expect(messageMentionWireText(messageMention, "https://joko.test/app?profile=local#/tasks/old")).toBe(
      "https://joko.test/app?profile=local#/tasks/task%2Fone?event=event%2F9&message=entry%3A42"
    );
    expect(sessionMessageDeepLink("task-one", "message-one", undefined, "joko://app/index.html#/tasks/old")).toBe(
      "joko://app/index.html#/tasks/task-one?message=message-one"
    );
    expect(sessionMessageDeepLink("task-one", "message-one", undefined, "https://joko.test/app?profile=local&authKey=must-not-leak#/tasks/old")).toBe(
      "https://joko.test/app?profile=local#/tasks/task-one?message=message-one"
    );
  });

  it("retains token mentions only while present and retains detachable message chips", () => {
    expect(activeComposerMentions("keep @one", [
      { id: "one", kind: "resource", reference: "one", label: "One", token: "@one" },
      { id: "two", kind: "resource", reference: "two", label: "Two", token: "@two" },
      messageMention
    ]).map((mention) => mention.id)).toEqual(["one", messageMention.id]);
  });

  it("upserts the same chip instead of duplicating it", () => {
    expect(upsertComposerMention([messageMention], { ...messageMention, label: "Renamed task" })).toEqual([
      { ...messageMention, label: "Renamed task" }
    ]);
  });
});
