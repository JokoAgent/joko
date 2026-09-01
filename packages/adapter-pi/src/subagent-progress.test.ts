import { describe, expect, it } from "vitest";
import { JOKO_SUBAGENT_ACTIVITY_MARKER, projectPiSubagentActivity } from "./subagent-progress.js";

describe("projectPiSubagentActivity", () => {
  it("projects bounded managed progress into a typed background task event", () => {
    const projected = projectPiSubagentActivity({
      details: {
        [JOKO_SUBAGENT_ACTIVITY_MARKER]: 1,
        taskId: "child-1",
        parentTaskId: "batch-1",
        agentName: "reviewer",
        status: "running",
        task: "audit the adapter",
        summary: "found two call sites",
        model: "fake/local-model",
        effort: "high",
        background: true,
        timeoutMs: 60_000,
        toolUses: 3,
        progressRatio: 0.4,
        startedAt: 1_000,
        usage: { input: 10, output: 4, cacheRead: 2, cacheWrite: 1, cost: 0.01 }
      }
    });

    expect(projected).toEqual({
      activity: {
        taskId: "child-1",
        parentTaskId: "batch-1",
        agentName: "reviewer",
        state: "running",
        summary: "found two call sites",
        task: "audit the adapter",
        model: "fake/local-model",
        effort: "high",
        background: true,
        timeoutMs: 60_000,
        toolUses: 3,
        progressRatio: 0.4,
        startedAt: 1_000,
        usage: {
          inputTokens: 10,
          outputTokens: 4,
          cacheReadTokens: 2,
          cacheWriteTokens: 1,
          totalTokens: 17,
          cost: 0.01
        }
      },
      event: {
        type: "background_task",
        taskId: "child-1",
        parentTaskId: "batch-1",
        title: "reviewer subagent",
        state: "running",
        detail: "found two call sites · model fake/local-model · effort high · 3 tool calls",
        progressRatio: 0.4,
        startedAt: 1_000
      }
    });
  });

  it("rejects unmarked, string-marked, and structurally incomplete data", () => {
    expect(projectPiSubagentActivity({ details: { taskId: "one", agentName: "scout" } })).toBeUndefined();
    expect(projectPiSubagentActivity({ details: { [JOKO_SUBAGENT_ACTIVITY_MARKER]: "1", taskId: "one", agentName: "scout" } })).toBeUndefined();
    expect(projectPiSubagentActivity({ details: { [JOKO_SUBAGENT_ACTIVITY_MARKER]: 1, taskId: "one" } })).toBeUndefined();
  });

  it("normalizes terminal aliases and truncates attacker-controlled text", () => {
    const projected = projectPiSubagentActivity({
      [JOKO_SUBAGENT_ACTIVITY_MARKER]: 1,
      taskId: `  ${"x".repeat(400)}  `,
      agentName: "scout",
      status: "timed_out",
      endedAt: 2_000,
      summary: "y".repeat(4_000),
      background: false,
      usage: { input: Number.NaN, output: -1, cost: 0 }
    });
    expect(projected?.activity.taskId).toHaveLength(256);
    expect(projected?.activity.summary).toHaveLength(2_048);
    expect(projected?.activity.state).toBe("aborted");
    expect(projected?.activity.usage).toBeUndefined();
  });

  it("projects terminal timing, measured progress, and a bounded public error", () => {
    const error = {
      code: "SUBAGENT_FAILED",
      message: "Child process failed safely.",
      phase: "background_task",
      retryable: true,
      stateMayHaveChanged: false,
      recovery: "Retry the delegated task."
    };
    const projected = projectPiSubagentActivity({
      [JOKO_SUBAGENT_ACTIVITY_MARKER]: 1,
      taskId: "child-2",
      parentTaskId: "batch-2",
      agentName: "scout",
      status: "failed",
      background: true,
      progressRatio: 0.75,
      startedAt: 3_000,
      endedAt: 4_000,
      error
    });

    expect(projected?.event).toMatchObject({
      type: "background_task",
      taskId: "child-2",
      parentTaskId: "batch-2",
      state: "failed",
      progressRatio: 0.75,
      startedAt: 3_000,
      endedAt: 4_000,
      error
    });
  });

  it("rejects lifecycle markers that cannot prove their timing", () => {
    const base = {
      [JOKO_SUBAGENT_ACTIVITY_MARKER]: 1,
      taskId: "child-3",
      agentName: "planner",
      background: true
    };
    expect(projectPiSubagentActivity({ ...base, status: "running" })).toBeUndefined();
    expect(projectPiSubagentActivity({ ...base, status: "completed", startedAt: 10 })).toBeUndefined();
    expect(projectPiSubagentActivity({ ...base, status: "running", startedAt: 20, endedAt: 10 })).toBeUndefined();
    expect(projectPiSubagentActivity({ ...base, status: "unknown", startedAt: 10 })).toBeUndefined();
  });
});
