import { describe, expect, it } from "vitest";
import { CodexNativeTaskProjection, type CodexNativeTaskEffects } from "./native-task-projection.js";

function projection(): CodexNativeTaskProjection {
  return new CodexNativeTaskProjection({
    sessionId: "session-one",
    rootThreadId: "root-thread",
    now: () => 100
  });
}

function latestRun(effects: CodexNativeTaskEffects) {
  return effects.emissions.filter((emission) => emission.type === "subagent_run").at(-1)?.run;
}

describe("CodexNativeTaskProjection", () => {
  it("accepts the native completed-only done spelling", () => {
    const tasks = projection();
    const effects = tasks.observeRootNotification("item/completed", {
      threadId: "root-thread",
      item: {
        type: "collabAgentToolCall",
        id: "spawn-one",
        tool: "spawnAgent",
        status: "completed",
        receiverThreadIds: ["child-one"],
        agentsStates: { "child-one": { status: "done", message: "Finished" } },
        prompt: "Inspect one module"
      },
      completedAtMs: 110
    });

    expect(latestRun(effects)).toMatchObject({
      state: "completed",
      returnedResult: "Finished",
      children: [expect.objectContaining({ state: "completed", result: "Finished" })]
    });
  });

  it("latches a failed spawn against late child activity and terminal snapshots", () => {
    const tasks = projection();
    tasks.observeRootNotification("item/started", {
      threadId: "root-thread",
      item: {
        type: "collabAgentToolCall",
        id: "spawn-failed",
        tool: "spawnAgent",
        status: "inProgress",
        receiverThreadIds: ["child-failed"],
        agentsStates: { "child-failed": { status: "running", message: null } }
      },
      startedAtMs: 120
    });
    const failed = tasks.observeRootNotification("item/completed", {
      threadId: "root-thread",
      item: {
        type: "collabAgentToolCall",
        id: "spawn-failed",
        tool: "spawnAgent",
        status: "failed",
        receiverThreadIds: ["child-failed"],
        agentsStates: { "child-failed": { status: "running", message: null } }
      },
      completedAtMs: 130
    });
    expect(latestRun(failed)).toMatchObject({ state: "failed", children: [expect.objectContaining({ state: "failed" })] });

    expect(tasks.observeDescendantNotification("child-failed", "turn/started", {
      threadId: "child-failed",
      turn: { id: "late-turn", status: "inProgress", items: [] },
      startedAtMs: 140
    }).emissions).toEqual([]);
    const late = tasks.observeRootNotification("item/completed", {
      threadId: "root-thread",
      item: {
        type: "collabAgentToolCall",
        id: "spawn-failed",
        tool: "spawnAgent",
        status: "completed",
        receiverThreadIds: ["child-failed"],
        agentsStates: { "child-failed": { status: "done", message: "Late success" } }
      },
      completedAtMs: 150
    });
    expect(latestRun(late)).toMatchObject({ state: "failed", children: [expect.objectContaining({ state: "failed" })] });
  });

  it("rejects oversized or cyclic native lineage before registration", () => {
    const tasks = projection();
    expect(() => tasks.observeRootNotification("item/started", {
      item: {
        type: "collabAgentToolCall",
        id: "spawn-cycle",
        tool: "spawnAgent",
        status: "inProgress",
        receiverThreadIds: ["root-thread"],
        agentsStates: {}
      }
    })).toThrow(/root or parent/u);

    expect(() => tasks.observeRootNotification("item/started", {
      item: {
        type: "collabAgentToolCall",
        id: "spawn-too-many",
        tool: "spawnAgent",
        status: "inProgress",
        receiverThreadIds: Array.from({ length: 4_097 }, (_, index) => `child-${index}`),
        agentsStates: {}
      }
    })).toThrow(/safe limit/u);
  });
});
