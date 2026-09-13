import { describe, expect, it } from "vitest";
import { CodexNativeTaskProjection, type CodexNativeTaskEffects } from "./native-task-projection.js";
import type { NativeThread, NativeThreadItem } from "./protocol.js";

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
  it("discovers history without replacing newer child completion with an old spawn snapshot", () => {
    const tasks = projection();
    const spawn = delegatedSpawn("retained-spawn", "child-one", "running");
    tasks.observeRootNotification("item/completed", { item: spawn });
    tasks.observeDescendantNotification("child-one", "turn/started", { turn: { id: "child-turn", status: "inProgress" } });
    expect(tasks.ownsActiveThread("child-one")).toBe(true);
    tasks.observeDescendantNotification("child-one", "turn/completed", { turn: { id: "child-turn", status: "completed" } });
    expect(tasks.ownsActiveThread("child-one")).toBe(false);
    expect(tasks.hasActiveTasks()).toBe(false);
    expect(tasks.mergeHistory(taskHistory(spawn))).toEqual([{ childThreadId: "child-one", parentThreadId: "root-thread" }]);
    expect(tasks.hasActiveTasks()).toBe(false);
    tasks.mergeHistory(taskHistory(spawn, delegatedSpawn("unseen-spawn", "unseen-child", "running")));
    expect(tasks.hasActiveTasks()).toBe(true);
  });

  it("retains the complete known subtree of a retained parent and drops removed branches", () => {
    const tasks = projection();
    const retained = delegatedSpawn("retained-spawn", "retained-child", "done");
    const removed = delegatedSpawn("removed-spawn", "removed-child", "done");
    tasks.seed(taskHistory(retained, removed));
    tasks.observeDescendantNotification("retained-child", "item/completed", { item: delegatedSpawn("nested-retained", "retained-grandchild", "done") });
    tasks.observeDescendantNotification("removed-child", "item/completed", { item: delegatedSpawn("nested-removed", "removed-grandchild", "done") });
    expect(tasks.replaceHistory(taskHistory(retained))).toEqual([
      { childThreadId: "retained-child", parentThreadId: "root-thread" },
      { childThreadId: "retained-grandchild", parentThreadId: "retained-child" }
    ]);
    expect(tasks.hasActiveTasks()).toBe(false);
    expect(latestRun(tasks.observeDescendantNotification("retained-grandchild", "turn/started", {
      turn: { id: "resumed-child", status: "inProgress" }
    }))).toMatchObject({ state: "running" });
    expect(tasks.observeDescendantNotification("removed-grandchild", "turn/started", {
      turn: { id: "removed-child", status: "inProgress" }
    }).emissions).toEqual([]);
  });

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

function delegatedSpawn(id: string, childId: string, status: string): NativeThreadItem {
  return { id, type: "collabAgentToolCall", tool: "spawnAgent", status: "completed", receiverThreadIds: [childId], agentsStates: { [childId]: { status, message: null } } };
}

function taskHistory(...items: NativeThreadItem[]): NativeThread {
  return { id: "root-thread", turns: [{ id: "retained-turn", status: "completed", items }] };
}
