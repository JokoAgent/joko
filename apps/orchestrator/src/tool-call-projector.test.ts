import type { EventPayload } from "@joko/core";
import type { PersistedSessionEvent } from "@joko/store";
import { ToolCallState } from "@joko/contracts";
import { describe, expect, it } from "vitest";

import { projectToolCalls } from "./tool-call-projector.js";

describe("Tool Call projector", () => {
  it("folds start/update/result and preserves complete output artifacts", () => {
    const calls = projectToolCalls([
      event(1, { type: "tool_start", callId: "call-1", name: "bash", input: "pnpm test" }),
      event(2, { type: "tool_update", callId: "call-1", name: "bash", output: "running" }),
      event(3, {
        type: "tool_result",
        callId: "call-1",
        name: "bash",
        output: "ok",
        parts: [
          { kind: "text", text: "ok" },
          { kind: "image", blob: { id: "image-1", sha256: "b".repeat(64), byteLength: 12, mimeType: "image/png", fileName: "preview.png" }, alt: "preview" }
        ],
        isError: false,
        artifact: { id: "blob-1", sha256: "a".repeat(64), byteLength: 2, mimeType: "text/plain", fileName: "output.txt" }
      })
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.value).toMatchObject({
      toolCallId: "call-1",
      toolId: "bash",
      toolProviderId: "backend:pi",
      state: ToolCallState.SUCCEEDED,
      result: { truncated: true, completeOutput: { blobId: "blob-1" } }
    });
    expect(calls[0]?.value.result?.parts[0]?.content).toEqual({ case: "text", value: "ok" });
    expect(calls[0]?.value.result?.parts[1]?.content).toMatchObject({
      case: "image",
      value: { blob: { blobId: "image-1" }, altText: "preview" }
    });
  });

  it("marks an in-flight Tool Call aborted when its run settles aborted", () => {
    const calls = projectToolCalls([
      event(1, { type: "tool_start", callId: "call-2", name: "edit", input: "{}" }),
      event(2, { type: "done", outcome: "aborted" })
    ]);
    expect(calls[0]?.value.state).toBe(ToolCallState.ABORTED);
    expect(calls[0]?.value.endedAt).toBeDefined();
  });

  it("replaces authoritative input only within its exact live call and preserves it after completion", () => {
    const start = event(1, { type: "tool_start", callId: "plan-1", name: "plan", input: "first" });
    const update = (cursor: number, input: string) => event(cursor, {
      type: "tool_update", callId: "plan-1", name: "plan", input, output: ""
    });
    const invalid = [
      { ...update(3, "foreign backend"), backendId: "other" },
      { ...update(4, "foreign run"), runId: "other" },
      { ...update(5, "foreign attempt"), attemptId: "other" },
      { ...update(6, "foreign generation"), generation: 2 },
      event(7, { type: "tool_update", callId: "plan-1", name: "other", input: "foreign name", output: "" })
    ];
    const live = [start, update(2, "latest"), ...invalid,
      event(8, { type: "tool_update", callId: "plan-1", name: "plan", output: "progress" })];
    expect(projectToolCalls(live)[0]?.value.arguments[0]?.value).toEqual({ case: "text", value: "latest" });
    const cleared = [...live, update(9, "")];
    expect(projectToolCalls(cleared)[0]?.value.arguments[0]?.value).toEqual({ case: "text", value: "" });
    const completed = [...live,
      event(9, { type: "tool_result", callId: "plan-1", name: "plan", output: "finished", isError: false }),
      update(10, "late")];
    expect(projectToolCalls(completed)[0]?.value).toMatchObject({
      state: ToolCallState.SUCCEEDED,
      arguments: [{ value: { case: "text", value: "latest" } }],
      result: { parts: [{ content: { case: "text", value: "finished" } }] }
    });
    expect(projectToolCalls(completed)[0]?.lastCursor).toBe(9n);
    expect(projectToolCalls([update(1, "update-only")])[0]?.value.arguments[0]?.value)
      .toEqual({ case: "text", value: "update-only" });
    expect(projectToolCalls([start, { ...update(2, "other session"), sessionId: "other" }]))
      .toHaveLength(2);
  });

  it("accumulates append-mode deltas from a fake non-specialized Backend", () => {
    const calls = projectToolCalls([
      event(1, { type: "tool_start", callId: "shell-1", name: "Shell", input: "pwd" }, "backend-streaming-tools"),
      event(2, { type: "tool_update", callId: "shell-1", name: "Shell", output: "first ", outputMode: "append" }, "backend-streaming-tools"),
      event(3, { type: "tool_update", callId: "shell-1", name: "Shell", output: "second", outputMode: "append" }, "backend-streaming-tools")
    ]);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.value).toMatchObject({
      toolCallId: "shell-1",
      toolId: "Shell",
      state: ToolCallState.RUNNING
    });
    expect(calls[0]?.value.result?.parts[0]?.content).toEqual({ case: "text", value: "first second" });
  });
});

function event(cursor: number, payload: Exclude<EventPayload, { type: "device_changed" }>, backendId = "pi"): PersistedSessionEvent {
  return {
    id: `event-${cursor}`,
    sequence: BigInt(cursor),
    globalCursor: BigInt(cursor),
    revision: BigInt(cursor),
    emittedAt: 1_000 + cursor,
    backendId,
    targetId: "target-1",
    sessionId: "session-1",
    runId: "run-1",
    attemptId: "attempt-1",
    generation: 1,
    traceId: `trace-${cursor}`,
    payload
  };
}
