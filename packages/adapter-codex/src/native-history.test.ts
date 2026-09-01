import { describe, expect, it } from "vitest";
import { projectCodexNativeHistory } from "./native-history.js";
import type { NativeThread } from "./protocol.js";

describe("Codex native history projection", () => {
  it("projects messages, reasoning, tools, turn state, and unknown items without leaking raw persistence", () => {
    const thread: NativeThread = {
      id: "thread-history",
      cwd: "C:\\workspace",
      turns: [{
        id: "turn-history",
        status: "completed",
        durationMs: 15,
        items: [
          {
            type: "userMessage",
            id: "user-history",
            clientId: null,
            content: [
              { type: "text", text: "apiKey=secret-value-123" },
              { type: "localImage", path: "C:\\private\\image.png" }
            ]
          },
          {
            type: "reasoning",
            id: "reasoning-history",
            summary: ["password=hidden-value"],
            content: ["safe reasoning"]
          },
          {
            type: "commandExecution",
            id: "command-history",
            command: "echo sk-abcdefghijklmnop",
            cwd: "C:\\private",
            status: "completed",
            aggregatedOutput: "token=private-token-value"
          },
          {
            type: "futureNativeItem",
            id: "unknown-history",
            secretPayload: "must-not-cross-the-adapter"
          },
          {
            type: "agentMessage",
            id: "assistant-history",
            text: "final answer",
            phase: null,
            memoryCitation: null,
            delivery: null
          }
        ]
      }]
    };

    const first = projectCodexNativeHistory(thread, { maximumEvents: 32 });
    const second = projectCodexNativeHistory(thread, { maximumEvents: 32 });
    expect(first).toEqual(second);
    expect(first.activeEntryId).toBe("assistant-history");
    expect(first.activeLineage).toEqual([
      { entryId: "user-history" },
      { entryId: "reasoning-history", parentEntryId: "user-history" },
      { entryId: "command-history", parentEntryId: "reasoning-history" },
      { entryId: "unknown-history", parentEntryId: "command-history" },
      { entryId: "assistant-history", parentEntryId: "unknown-history" }
    ]);
    expect(first.events.map((event) => event.projectionKind)).toEqual([
      "message_user",
      "reasoning_summary",
      "reasoning_content",
      "tool_start",
      "tool_result",
      "item_status",
      "message_assistant",
      "turn_status"
    ]);
    expect(first.events.find((event) => event.projectionKind === "message_user")?.payload).toMatchObject({
      type: "message_complete",
      role: "user",
      blocks: [{ kind: "text", text: "apiKey=[REDACTED]" }, { kind: "text", text: "[Image input]" }]
    });
    expect(first.events.find((event) => event.projectionKind === "message_assistant")?.metadata?.fields)
      .toMatchObject({ nativeTerminalOutcome: "completed", turnStatus: "completed" });
    expect(first.events.find((event) => event.nativeEntryId === "unknown-history")?.payload)
      .toEqual({ type: "status", key: "native_item_unsupported", text: "Codex history contains an unsupported futureNativeItem item." });
    const serialized = JSON.stringify(first);
    expect(serialized).not.toContain("secret-value-123");
    expect(serialized).not.toContain("hidden-value");
    expect(serialized).not.toContain("sk-abcdefghijklmnop");
    expect(serialized).not.toContain("private-token-value");
    expect(serialized).not.toContain("must-not-cross-the-adapter");
    expect(serialized).not.toContain("C:\\\\private\\\\image.png");
  });

  it("fails closed on duplicate native identities or an event-bound overflow", () => {
    const duplicate: NativeThread = {
      id: "thread-duplicate",
      turns: [{
        id: "turn-duplicate",
        status: "completed",
        items: [
          { type: "userMessage", id: "same", content: [] },
          { type: "agentMessage", id: "same", text: "answer" }
        ]
      }]
    };
    expect(() => projectCodexNativeHistory(duplicate, { maximumEvents: 10 })).toThrow();

    const bounded: NativeThread = {
      id: "thread-bounded",
      turns: [{
        id: "turn-bounded",
        status: "completed",
        items: [{ type: "agentMessage", id: "assistant-bounded", text: "answer" }]
      }]
    };
    expect(() => projectCodexNativeHistory(bounded, { maximumEvents: 1 })).toThrow();
  });
});
