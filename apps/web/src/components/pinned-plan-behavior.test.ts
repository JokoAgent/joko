import { describe, expect, it } from "vitest";
import type { TimelineItemView } from "../model.js";
import { pinnedPlanRetirement, pinnedPlanStepPosition, projectInlinePlanTimeline, projectPinnedPlan } from "./pinned-plan-behavior.js";

function toolItem(id: string, sequence: number, name: string, input: unknown, output?: string, runId?: string): TimelineItemView {
  return {
    id,
    ...(runId === undefined ? {} : { runId }),
    sequence: BigInt(sequence),
    kind: output === undefined ? "tool" : "toolResult",
    createdAt: sequence * 1_000,
    tool: {
      id,
      name,
      state: output === undefined ? "running" : "succeeded",
      input: `$: ${JSON.stringify(input)}`,
      ...(output === undefined ? {} : { output }),
      isError: false
    }
  };
}

function terminalItem(id: string, sequence: number, runId: string, outcome: "completed" | "aborted" | "failed"): TimelineItemView {
  return {
    id,
    runId,
    runTerminal: outcome,
    sequence: BigInt(sequence),
    kind: outcome === "failed" ? "error" : "status",
    createdAt: sequence * 1_000
  };
}

function userItem(id: string, sequence: number, runId: string): TimelineItemView {
  return { id, runId, sequence: BigInt(sequence), kind: "user", createdAt: sequence * 1_000, text: id };
}

describe("pinned plan projection", () => {
  it("projects the latest update_plan snapshot in canonical order", () => {
    const result = projectPinnedPlan([
      toolItem("old", 1, "update_plan", { plan: [{ step: "Old", status: "pending" }] }),
      toolItem("new", 2, "update_plan", { plan: [
        { step: "Inspect", status: "completed" },
        { step: "Implement", status: "in_progress" },
        { step: "Verify", status: "pending" }
      ] })
    ]);

    expect(result).toMatchObject({ sourceItemId: "new", source: "updatePlan", allCompleted: false });
    expect(result?.steps.map((step) => [step.content, step.state])).toEqual([
      ["Inspect", "completed"],
      ["Implement", "inProgress"],
      ["Verify", "pending"]
    ]);
    expect(pinnedPlanStepPosition(result?.steps ?? [])).toEqual({ current: 2, total: 3 });
  });

  it("supports TodoWrite active forms without using backend identity", () => {
    const result = projectPinnedPlan([toolItem("todo", 1, "TodoWrite", { todos: [
      { content: "First", activeForm: "Doing first", status: "completed" },
      { content: "Second", activeForm: "Doing second", status: "running" }
    ] })]);

    expect(result?.source).toBe("todo");
    expect(result?.steps.map((step) => step.state)).toEqual(["completed", "inProgress"]);
  });

  it("preserves every valid step beyond the former 200-item presentation boundary", () => {
    const steps = Array.from({ length: 205 }, (_, index) => ({
      step: `Plan step ${index + 1}`,
      status: index === 204 ? "in_progress" : "pending"
    }));
    const todos = steps.map((step) => ({ content: step.step, status: step.status }));
    const tasks = steps.map((step, index) => ({ id: `task-${index + 1}`, subject: step.step, status: step.status }));

    expect(projectPinnedPlan([toolItem("plan-all", 1, "update_plan", { plan: steps })])?.steps)
      .toHaveLength(205);
    expect(projectPinnedPlan([toolItem("todo-all", 1, "TodoWrite", { todos })])?.steps.at(-1)?.content)
      .toBe("Plan step 205");
    expect(projectPinnedPlan([toolItem("task-all", 1, "TaskList", {}, JSON.stringify({ tasks }))])?.steps)
      .toHaveLength(205);
    expect(projectPinnedPlan([toolItem("text-all", 1, "update_plan", {
      text: steps.map((step) => `- ${step.step}`).join("\n")
    })])?.steps.at(-1)?.content).toBe("Plan step 205");
  });

  it("preserves complete plan text and identifiers beyond the former 4096-character boundary", () => {
    const content = `Begin ${"x".repeat(5_000)} <<full-tail>>`;
    const taskId = `task-${"i".repeat(5_000)}-tail`;

    expect(projectPinnedPlan([toolItem("plan-long", 1, "update_plan", {
      plan: [{ step: content, status: "in_progress" }]
    })])?.steps[0]?.content).toBe(content);
    expect(projectPinnedPlan([toolItem("todo-long", 1, "TodoWrite", {
      todos: [{ content, status: "pending" }]
    })])?.steps[0]?.content).toBe(content);
    expect(projectPinnedPlan([toolItem("task-list-long", 1, "TaskList", {}, JSON.stringify({
      tasks: [{ id: taskId, subject: content, status: "pending" }]
    }))])?.steps[0]).toMatchObject({ id: taskId, content });
    expect(projectPinnedPlan([toolItem("task-create-long", 1, "TaskCreate", {
      subject: content
    }, JSON.stringify({ taskId }))])?.steps[0]).toMatchObject({ id: taskId, content });
    expect(projectPinnedPlan([toolItem("text-long", 1, "update_plan", {
      text: `- ${content}`
    })])?.steps[0]?.content).toBe(content);
  });

  it("treats an explicit empty latest snapshot as clearing instead of reviving an older plan", () => {
    expect(projectPinnedPlan([
      toolItem("old", 1, "update_plan", { plan: [{ step: "Old", status: "pending" }] }),
      toolItem("clear", 2, "update_plan", { plan: [] })
    ])).toBeUndefined();
  });

  it("reconstructs Task tools and applies completion and deletion updates", () => {
    const result = projectPinnedPlan([
      toolItem("create-a", 1, "TaskCreate", { subject: "Inspect" }, JSON.stringify({ taskId: "a", status: "pending" })),
      toolItem("create-b", 2, "TaskCreate", { subject: "Verify" }, JSON.stringify({ taskId: "b", status: "pending" })),
      toolItem("update-a", 3, "TaskUpdate", { taskId: "a", status: "completed" }, "{}"),
      toolItem("update-b", 4, "TaskUpdate", { taskId: "b", status: "in_progress" }, "{}")
    ]);

    expect(result?.steps.map((step) => [step.id, step.state])).toEqual([
      ["a", "completed"],
      ["b", "inProgress"]
    ]);
    expect(result?.sourceItemId).toBe("update-b");
  });

  it("treats an authoritative empty TaskList snapshot as clearing the current task plan", () => {
    expect(projectPinnedPlan([
      toolItem("create", 1, "TaskCreate", { subject: "Inspect" }, JSON.stringify({ taskId: "a" })),
      toolItem("list", 2, "TaskList", {}, JSON.stringify({ tasks: [] }))
    ])).toBeUndefined();
  });

  it("returns no projection for unrelated tools, malformed input, or an unresolved latest plan event", () => {
    expect(projectPinnedPlan([toolItem("read", 1, "read", { plan: [{ step: "Not a plan", status: "pending" }] })])).toBeUndefined();
    expect(projectPinnedPlan([{
      ...toolItem("broken", 1, "update_plan", {}),
      tool: { ...toolItem("broken", 1, "update_plan", {}).tool!, input: "$: {broken" }
    }])).toBeUndefined();
    expect(projectPinnedPlan([
      toolItem("old", 1, "TodoWrite", { todos: [{ content: "Old", status: "pending" }] }),
      toolItem("unknown-task", 2, "TaskUpdate", { taskId: "missing", status: "completed" })
    ])).toBeUndefined();
  });

  it("reports the final completed position", () => {
    const result = projectPinnedPlan([toolItem("done", 1, "update_plan", { plan: [
      { step: "One", status: "completed" },
      { step: "Two", status: "done" }
    ] })]);
    expect(result?.allCompleted).toBe(true);
    expect(pinnedPlanStepPosition(result?.steps ?? [])).toEqual({ current: 2, total: 2 });
  });

  it("uses a successful durable run terminal as the authoritative seal even with open steps", () => {
    const result = projectPinnedPlan([
      userItem("prompt", 1, "run-a"),
      toolItem("plan", 2, "update_plan", { plan: [
        { step: "Inspect", status: "completed" },
        { step: "Verify", status: "pending" }
      ] }, undefined, "run-a"),
      terminalItem("done", 3, "run-a", "completed")
    ]);

    expect(result).toMatchObject({ runId: "run-a", terminalOutcome: "completed", terminalAt: 3_000 });
    expect(pinnedPlanRetirement(result!, false)).toEqual({ retired: true, authoritative: true, anchorAt: 3_000 });
  });

  it.each(["failed", "aborted"] as const)("keeps an all-done plan after an authoritative %s terminal", (outcome) => {
    const result = projectPinnedPlan([
      toolItem("plan", 1, "update_plan", { plan: [
        { step: "Inspect", status: "completed" },
        { step: "Verify", status: "completed" }
      ] }, undefined, "run-a"),
      terminalItem("terminal", 2, "run-a", outcome)
    ]);

    expect(result?.terminalOutcome).toBe(outcome);
    expect(pinnedPlanRetirement(result!, false)).toEqual({ retired: false, authoritative: true });
  });

  it("retires on a later real user run but not same-run steering", () => {
    const plan = toolItem("plan", 2, "update_plan", { plan: [
      { step: "Inspect", status: "in_progress" },
      { step: "Verify", status: "pending" }
    ] }, undefined, "run-a");

    expect(projectPinnedPlan([userItem("prompt", 1, "run-a"), plan, userItem("steer", 3, "run-a")])?.sourceItemId).toBe("plan");
    expect(projectPinnedPlan([userItem("prompt", 1, "run-a"), plan, userItem("next-turn", 3, "run-b")])).toBeUndefined();
  });

  it("lets TaskUpdate explicitly reclaim a known task across a user boundary without absorbing a later TaskCreate", () => {
    const history = [
      userItem("prompt-a", 1, "run-a"),
      toolItem("create-a", 2, "TaskCreate", { subject: "Inspect" }, JSON.stringify({ taskId: "a" }), "run-a"),
      toolItem("create-b", 3, "TaskCreate", { subject: "Verify" }, JSON.stringify({ taskId: "b" }), "run-a"),
      userItem("prompt-b", 4, "run-b"),
      toolItem("update-a", 5, "TaskUpdate", { taskId: "a", status: "completed" }, "{}", "run-b")
    ];

    expect(projectPinnedPlan(history)?.steps.map((step) => step.id)).toEqual(["a", "b"]);
    expect(projectPinnedPlan([
      ...history,
      toolItem("create-c", 6, "TaskCreate", { subject: "New phase" }, JSON.stringify({ taskId: "c" }), "run-b")
    ])?.steps.map((step) => step.id)).toEqual(["c"]);
  });

  it("uses all-completed only as the idle untyped fallback when no terminal outcome exists", () => {
    const result = projectPinnedPlan([toolItem("done", 1, "TodoWrite", { todos: [
      { content: "One", status: "completed" },
      { content: "Two", status: "completed" }
    ] })])!;

    expect(pinnedPlanRetirement(result, true)).toEqual({ retired: false, authoritative: false });
    expect(pinnedPlanRetirement(result, false)).toEqual({ retired: true, authoritative: false, anchorAt: 1_000 });
  });
});

describe("inline plan timeline projection", () => {
  it("collapses same-session updates into one card at the latest durable row", () => {
    const projected = projectInlinePlanTimeline([
      userItem("prompt", 1, "run-a"),
      toolItem("plan-1", 2, "update_plan", { plan: [
        { step: "Inspect", status: "in_progress" },
        { step: "Verify", status: "pending" }
      ] }, undefined, "run-a"),
      toolItem("plan-2", 3, "update_plan", { plan: [
        { step: "Inspect", status: "completed" },
        { step: "Verify", status: "in_progress" }
      ] }, undefined, "run-a")
    ]);

    expect(projected.map((item) => item.id)).toEqual(["prompt", "plan-2"]);
    expect(projected[1]?.inlinePlan).toMatchObject({
      identity: "inline-plan:plan-1",
      sourceItemIds: ["plan-1", "plan-2"],
      steps: [{ content: "Inspect", state: "completed" }, { content: "Verify", state: "inProgress" }]
    });
  });

  it("keeps separate historical cards after a real user boundary", () => {
    const projected = projectInlinePlanTimeline([
      userItem("prompt-a", 1, "run-a"),
      toolItem("plan-a", 2, "update_plan", { plan: [{ step: "First", status: "pending" }] }, undefined, "run-a"),
      userItem("prompt-b", 3, "run-b"),
      toolItem("plan-b", 4, "update_plan", { plan: [{ step: "Second", status: "pending" }] }, undefined, "run-b")
    ]);

    expect(projected.filter((item) => item.inlinePlan !== undefined).map((item) => [item.id, item.inlinePlan?.identity])).toEqual([
      ["plan-a", "inline-plan:plan-a"],
      ["plan-b", "inline-plan:plan-b"]
    ]);
  });

  it("hides raw plan tools, lets explicit clear remove its card, and keeps the last resolved card across malformed input", () => {
    const first = toolItem("plan", 1, "update_plan", { plan: [{ step: "First", status: "pending" }] }, undefined, "run-a");
    expect(projectInlinePlanTimeline([first, toolItem("clear", 2, "update_plan", { plan: [] }, undefined, "run-a")])).toEqual([]);

    const malformed = {
      ...toolItem("broken", 2, "update_plan", {}, undefined, "run-a"),
      tool: { ...toolItem("broken", 2, "update_plan", {}, undefined, "run-a").tool!, input: "$: {broken" }
    };
    const projected = projectInlinePlanTimeline([first, malformed]);
    expect(projected).toHaveLength(1);
    expect(projected[0]).toMatchObject({ id: "plan", inlinePlan: { identity: "inline-plan:plan" } });
  });
});
