import { describe, expect, it } from "vitest";
import { projectCodexNativeHistory } from "./native-history.js";
import type { NativeThread } from "./protocol.js";

describe("Codex native history projection", () => {
  it("projects file-change history with the same ordered source, target, and diff identity as live events", () => {
    const thread: NativeThread = { id: "file-changes", turns: [{ id: "turn", status: "completed", items: [{
      id: "change-one",
      type: "fileChange",
      status: "completed",
      changes: [
        { path: "src/old.ts", kind: { type: "update", movePath: "src/new.ts" }, diff: "-old\n+new" },
        { path: "src/gone.ts", kind: { type: "delete" }, diff: "-gone" }
      ]
    }] }] };

    const result = projectCodexNativeHistory(thread, { maximumEvents: 10 });
    expect(result.events.find((event) => event.projectionKind === "tool_start")?.payload).toMatchObject({
      type: "tool_start",
      name: "file_change",
      input: JSON.stringify({ changes: [
        { path: "src/old.ts", kind: { type: "update", movePath: "src/new.ts" }, diff: "-old\n+new" },
        { path: "src/gone.ts", kind: { type: "delete" }, diff: "-gone" }
      ] })
    });
    expect(result.events.find((event) => event.projectionKind === "tool_result")?.payload).toMatchObject({
      type: "tool_result",
      output: "move: src/old.ts -> src/new.ts\ndelete: src/gone.ts"
    });
  });

  it("publishes explicit pre-turn targets without treating a mid-turn user or an unavailable history as start", () => {
    const thread: NativeThread = { id: "turn-boundaries", historyMode: "paginated", turns: [
      { id: "first", status: "completed", items: [
        { id: "first-user", type: "userMessage", content: [{ type: "text", text: "First" }] },
        { id: "steer", type: "userMessage", content: [{ type: "text", text: "Steer" }] },
        { id: "first-answer", type: "agentMessage", text: "Answer" }
      ] },
      { id: "second", status: "completed", items: [{ id: "second-user", type: "userMessage", content: [{ type: "text", text: "Second" }] }] }
    ] };
    const result = projectCodexNativeHistory(thread, { maximumEvents: 20 });
    expect(result.events.find((event) => event.nativeEntryId === "first-user")?.nativeRewindBefore).toEqual({ kind: "session_start" });
    expect(result.events.find((event) => event.nativeEntryId === "steer")?.nativeRewindBefore).toBeUndefined();
    expect(result.events.find((event) => event.nativeEntryId === "second-user")?.nativeRewindBefore).toEqual({ kind: "native_entry", entryId: "first-answer" });
    expect(projectCodexNativeHistory({ ...thread, turns: [] }, { maximumEvents: 20 }).activeNavigationTarget).toEqual({ kind: "session_start" });
    const unavailable = projectCodexNativeHistory({ id: "unavailable", turns: [] }, { maximumEvents: 20 });
    expect(unavailable.activeNavigationTarget).toBeUndefined();
  });

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

  it("keeps yielded execution boundaries non-terminal until the persisted wait chain settles", () => {
    const privateOne = `joko-internal-yield:v1:${"a".repeat(64)}:1`;
    const privateTwo = `joko-internal-yield:v1:${"b".repeat(64)}:2`;
    const thread: NativeThread = { id: "yield-chain", turns: [
      { id: "yield-origin", status: "completed", items: [
        { id: "origin-user", type: "userMessage", clientId: "public-operation", content: [{ type: "text", text: "check" }] },
        {
          id: "origin-exec",
          type: "commandExecution",
          command: "pnpm check",
          status: "completed",
          aggregatedOutput: [
            "Script running with cell ID 11\nWall time 1.0 seconds\nOutput:\n",
            "Script running with cell ID 12\nWall time 1.0 seconds\nOutput:\n"
          ].join("\n")
        },
        {
          id: "origin-wait-11",
          type: "function_call",
          name: "wait",
          arguments: JSON.stringify({ cell_id: "11" }),
          content: [{ type: "output_text", text: "Script completed\nWall time 0.1 seconds\nOutput:\n" }]
        },
        { id: "origin-answer", type: "agentMessage", text: "waiting" }
      ] },
      { id: "yield-alive", status: "completed", items: [
        { id: "private-user-one", type: "userMessage", clientId: privateOne, content: [{ type: "text", text: "private" }] },
        {
          id: "alive-wait-12",
          type: "function_call",
          name: "wait",
          arguments: JSON.stringify({ cell_id: "12" }),
          content: [{ type: "output_text", text: "Script running with cell ID 12\nWall time 2.0 seconds\nOutput:\n" }]
        },
        { id: "alive-answer", type: "agentMessage", text: "still waiting" }
      ] },
      { id: "yield-settled", status: "completed", items: [
        { id: "private-user-two", type: "userMessage", clientId: privateTwo, content: [{ type: "text", text: "private" }] },
        {
          id: "settled-wait-12",
          type: "function_call",
          name: "wait",
          arguments: JSON.stringify({ cell_id: "12" }),
          content: [{ type: "output_text", text: "Script completed\nWall time 0.1 seconds\nOutput:\n" }]
        },
        { id: "settled-answer", type: "agentMessage", text: "done" }
      ] },
      { id: "near-prefix-turn", status: "completed", items: [
        {
          id: "near-prefix-user",
          type: "userMessage",
          clientId: `joko-internal-yield:v1:${"c".repeat(64)}:3`,
          content: [{ type: "text", text: "ordinary user" }]
        },
        { id: "near-prefix-answer", type: "agentMessage", text: "ordinary answer" }
      ] }
    ] };

    const projection = projectCodexNativeHistory(thread, { maximumEvents: 64 });
    for (const entryId of ["origin-answer", "alive-answer"]) {
      expect(projection.events.find((event) => event.nativeEntryId === entryId)?.metadata?.fields ?? {})
        .not.toHaveProperty("nativeTerminalOutcome");
    }
    expect(projection.events.some((event) =>
      event.projectionKind === "turn_status"
      && (event.metadata?.fields as { turnId?: string } | undefined)?.turnId === "yield-origin")).toBe(false);
    expect(projection.events.some((event) =>
      event.projectionKind === "turn_status"
      && (event.metadata?.fields as { turnId?: string } | undefined)?.turnId === "yield-alive")).toBe(false);
    expect(projection.events.find((event) => event.nativeEntryId === "settled-answer")?.metadata?.fields)
      .toMatchObject({ nativeTerminalOutcome: "completed" });
    expect((projection.activeLineage ?? []).map((entry) => entry.entryId)).toEqual(expect.arrayContaining([
      "private-user-one",
      "private-user-two"
    ]));
    expect(projection.events.some((event) =>
      event.nativeEntryId === "private-user-one" || event.nativeEntryId === "private-user-two")).toBe(false);
    expect(projection.events.find((event) => event.nativeEntryId === "near-prefix-user")?.payload)
      .toMatchObject({ type: "message_complete", role: "user" });
  });

  it("does not recover a completed product terminal from an origin turn whose yielded cell has no next turn", () => {
    const projection = projectCodexNativeHistory({ id: "yield-crash-window", turns: [{
      id: "crash-origin",
      status: "completed",
      items: [
        {
          id: "crash-command",
          type: "commandExecution",
          status: "completed",
          aggregatedOutput: "Script running with cell ID 226\nWall time 1.0 seconds\nOutput:\n"
        },
        { id: "crash-answer", type: "agentMessage", text: "waiting" }
      ]
    }] }, { maximumEvents: 16 });

    expect(projection.events.find((event) => event.nativeEntryId === "crash-answer")?.metadata?.fields ?? {})
      .not.toHaveProperty("nativeTerminalOutcome");
    expect(projection.events.some((event) => event.projectionKind === "turn_status")).toBe(false);
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
