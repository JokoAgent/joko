import { describe, expect, it } from "vitest";
import type { QueueItemView, SessionView } from "../model.js";
import { reviewGitWriteBlock } from "./review-write-gate.js";

function session(id: string, targetId: string, state: SessionView["state"] = "idle", activeRunId?: string): SessionView {
  return {
    id,
    backendId: "backend-review",
    targetId,
    name: id,
    state,
    pinned: false,
    archived: false,
    generation: 0n,
    fastMode: false,
    permissionMode: "ask",
    planMode: false,
    updatedAt: 1,
    ...(activeRunId === undefined ? {} : { activeRunId })
  };
}

function queueItem(sessionId: string, state: QueueItemView["state"]): QueueItemView {
  return {
    id: `queue-${sessionId}`,
    sessionId,
    revision: 1n,
    generation: 1n,
    source: "user",
    mode: "prompt",
    text: "",
    state,
    editLocked: false,
    ordinal: 1,
    createdAt: 1
  };
}

describe("Review Git write activity gate", () => {
  it("blocks an active run in any task bound to the workspace Target", () => {
    expect(reviewGitWriteBlock([
      session("selected", "target-review"),
      session("other", "target-review", "running", "run-other"),
      session("unrelated", "target-other", "running", "run-unrelated")
    ], [], "target-review")).toBe("agent-running");
  });

  it("blocks durable queued work but ignores terminal or unrelated items", () => {
    const sessions = [session("selected", "target-review"), session("unrelated", "target-other")];
    expect(reviewGitWriteBlock(sessions, [queueItem("selected", "accepted")], "target-review")).toBe("queued-work");
    expect(reviewGitWriteBlock(sessions, [queueItem("selected", "dispatchUnknown")], "target-review")).toBe("queued-work");
    expect(reviewGitWriteBlock(sessions, [queueItem("selected", "completed"), queueItem("unrelated", "accepted")], "target-review")).toBeUndefined();
  });
});
