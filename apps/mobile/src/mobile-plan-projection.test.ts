import { clone, create } from "@bufbuild/protobuf";
import {
  EventSchema, MessageRole, ToolCallOutputMode, ToolCallSchema, ToolCallState, type Event
} from "@joko/contracts";
import { describe, expect, it } from "vitest";
import { projectMobileInlinePlans, type MobilePlanOwner } from "./mobile-plan-projection";

const owner: MobilePlanOwner = { sessionId: "session", generation: 2n, nativeGeneration: 7n };
function tool(id: string, sequence: number, name: string, input: unknown, output = "", runId = "run-a",
  nativeGeneration = 7n, phase: "toolCallStarted" | "toolCallUpdated" | "toolCallCompleted" = "toolCallStarted"): Event {
  const call = create(ToolCallSchema, { toolCallId: id, toolId: name, sessionId: "session", runId,
    state: phase === "toolCallCompleted" ? ToolCallState.SUCCEEDED : ToolCallState.RUNNING,
    arguments: [{ fieldPath: "$", value: { case: "text", value: JSON.stringify(input) } }],
    ...(phase === "toolCallCompleted" ? { result: { parts: [{ content: { case: "text", value: output } }] } } : {}) });
  return create(EventSchema, { eventId: `${id}-${sequence}`, identity: { sessionId: "session", runId, generation: nativeGeneration },
    cursor: { generation: 2n, sequence: BigInt(sequence) }, payload: { kind: phase === "toolCallUpdated"
      ? { case: phase, value: { toolCall: call, incrementalResult: { parts: [{ content: { case: "text", value: output } }] }, outputMode: ToolCallOutputMode.REPLACE } }
      : { case: phase, value: { toolCall: call } } } });
}
function user(id: string, sequence: number, runId: string, nativeGeneration = 7n): Event {
  return create(EventSchema, { eventId: id, identity: { sessionId: "session", runId, generation: nativeGeneration },
    cursor: { generation: 2n, sequence: BigInt(sequence) }, payload: { kind: { case: "messageStarted", value: {
      messageId: id, role: MessageRole.USER, userInputAccepted: true
    } } } });
}
function terminal(sequence: number, runId = "run-a", kind: "runDone" | "runAborted" = "runDone"): Event {
  return create(EventSchema, { eventId: `terminal-${sequence}`, identity: { sessionId: "session", runId, generation: 7n },
    cursor: { generation: 2n, sequence: BigInt(sequence) }, payload: { kind: { case: kind, value: { runId } } } });
}

describe("mobile inline plan projection", () => {
  it("consolidates three-state same-source snapshots at the last row while retaining full content without a row cap", () => {
    const content = `Begin ${"x".repeat(5_000)} <<full-tail>>`;
    const steps = Array.from({ length: 205 }, (_, index) => ({ content: index === 204 ? content : `Step ${index}`,
      status: index === 0 ? "completed" : index === 204 ? "in_progress" : "pending", activeForm: "Doing it" }));
    const events = [user("user", 1, "run-a"), tool("plan-one", 2, "TodoWrite", { todos: [{ content: "Old", status: "pending" }] }),
      tool("plan-two", 3, "TodoWrite", { todos: steps })];
    const result = projectMobileInlinePlans(events, owner, true);
    expect(result.cards).toHaveLength(1); expect(result.cards[0]).toMatchObject({ source: "todo", eventId: "plan-two-3", sequence: 3n,
      completed: 1, total: 205, activeContent: content, streaming: true });
    expect(result.cards[0]?.steps.at(-1)).toMatchObject({ content, activeForm: "Doing it", state: "inProgress" });
    expect(result.cards[0]?.sourceToolScopeKeys).toHaveLength(2);
    expect(result.sourceEventIds).toEqual(new Set(["plan-one-2", "plan-two-3"]));
    expect(events).toHaveLength(3); // The projection does not remove parent tool payloads or source actions.
  });

  it("uses the latest stable-call replacement sequence past an ordinary tool and seals only the matching successful turn", () => {
    const first = tool("stable-plan", 2, "update_plan", { plan: [{ step: "First", status: "pending" }] });
    const updated = tool("stable-plan", 5, "update_plan", { plan: [{ step: "First", status: "completed" },
      { step: "Second", status: "inProgress" }] }, "", "run-a", 7n, "toolCallUpdated");
    const ordinary = tool("read", 3, "Read", { path: "a.ts" });
    const result = projectMobileInlinePlans([first, ordinary, updated, terminal(6)], owner, true);
    expect(result.cards[0]).toMatchObject({ sequence: 5n, eventId: "stable-plan-5", sealed: true, outcome: "completed", streaming: false });
    expect(result.cards[0]?.steps.map((step) => step.state)).toEqual(["completed", "inProgress"]);
    expect(result.cards[0]?.identity).toBe(projectMobileInlinePlans([first], owner).cards[0]?.identity);
    expect(result.byEventId.get("stable-plan-5")).toBe(result.cards[0]);
    const wrongRun = projectMobileInlinePlans([first, terminal(4, "another-run")], owner, true);
    expect(wrongRun.cards[0]).toMatchObject({ sealed: false, streaming: true });
    const stopped = projectMobileInlinePlans([first, terminal(4, "run-a", "runAborted")], owner, true);
    expect(stopped.cards[0]).toMatchObject({ sealed: false, outcome: "aborted", streaming: false });
  });

  it("retains a stable-call resolved snapshot across malformed, truncated and redacted replacements and keeps its raw scope association", () => {
    const first = tool("stable", 2, "update_plan", { plan: [{ step: "Resolved", status: "pending" }] });
    const malformed = tool("stable", 3, "update_plan", { unexpected: true }, "", "run-a", 7n, "toolCallUpdated");
    const truncated = tool("stable", 4, "update_plan", { plan: [{ step: "x".repeat(300_000), status: "pending" }] }, "", "run-a", 7n, "toolCallUpdated");
    const redacted = tool("stable", 5, "update_plan", { plan: [{ step: "Hidden", status: "pending" }] }, "", "run-a", 7n, "toolCallUpdated");
    if (redacted.payload?.kind.case !== "toolCallUpdated") throw new Error("fixture");
    redacted.payload.kind.value.toolCall!.arguments[0]!.redacted = true;
    const initial = projectMobileInlinePlans([first], owner).cards[0]!;
    const result = projectMobileInlinePlans([first, malformed, truncated, redacted], owner, true);
    expect(result.cards).toHaveLength(1); expect(result.cards[0]).toMatchObject({ identity: initial.identity,
      eventId: "stable-2", sequence: 2n, activeContent: "Resolved" });
    expect(result.byToolScopeKey.get(initial.sourceToolScopeKeys[0]!)).toEqual(result.cards);
    expect(result.byEventId.has("stable-5")).toBe(false);
    const recovered = tool("stable", 6, "update_plan", { plan: [{ step: "Recovered", status: "in_progress" }] }, "", "run-a", 7n, "toolCallUpdated");
    expect(projectMobileInlinePlans([first, malformed, truncated, redacted, recovered], owner).cards[0]).toMatchObject({
      identity: initial.identity, eventId: "stable-6", sequence: 6n, activeContent: "Recovered" });
    expect(projectMobileInlinePlans([first, malformed, tool("stable", 7, "update_plan", { plan: [] }, "", "run-a", 7n,
      "toolCallUpdated")], owner).cards).toEqual([]);
  });

  it("preserves completed-to-expanded stable-call phases with distinct stable identities and rejects late tool and run updates", () => {
    const first = tool("stable", 2, "update_plan", { plan: [{ step: "First", status: "pending" }] });
    const completedInput = { plan: [{ step: "First", status: "completed" }] };
    const done = tool("stable", 3, "update_plan", completedInput, "", "run-a", 7n, "toolCallUpdated");
    const repeated = tool("stable", 4, "update_plan", completedInput, "", "run-a", 7n, "toolCallUpdated");
    const expandedInput = { plan: [...completedInput.plan, { step: "Second phase", status: "pending" }] };
    const expanded = tool("stable", 5, "update_plan", expandedInput, "", "run-a", 7n, "toolCallUpdated");
    const finished = tool("stable", 6, "update_plan", expandedInput, "", "run-a", 7n, "toolCallCompleted");
    const lateTool = tool("stable", 7, "update_plan", { plan: [{ step: "Late tool text", status: "pending" }] }, "", "run-a", 7n, "toolCallUpdated");
    const lateRun = tool("another", 9, "update_plan", { plan: [{ step: "Late run text", status: "pending" }] });
    const result = projectMobileInlinePlans([first, done, repeated, expanded, finished, lateTool, terminal(8), lateRun], owner, true);
    expect(result.cards.map((plan) => [plan.sequence, plan.activeContent, plan.completed, plan.total, plan.sealed])).toEqual([
      [4n, "First", 1, 1, false], [6n, "Second phase", 1, 2, true]
    ]);
    expect(result.cards[0]?.identity).toBe(projectMobileInlinePlans([first], owner).cards[0]?.identity);
    expect(new Set(result.cards.map((plan) => plan.identity)).size).toBe(2);
    expect(result.cards.every((plan) => !plan.streaming)).toBe(true);
    expect(result.byToolScopeKey.get(result.cards[0]!.sourceToolScopeKeys[0]!)).toEqual(result.cards);
  });

  it("keeps completed/sealed/new-user history and treats explicit empty as clear while malformed input stays unresolved", () => {
    const first = tool("first", 2, "update_plan", { plan: [{ step: "Original", status: "pending" }] });
    const malformed = tool("broken", 3, "update_plan", { unexpected: true });
    expect(projectMobileInlinePlans([first, malformed], owner).cards[0]?.activeContent).toBe("Original");
    expect(projectMobileInlinePlans([first, tool("clear", 4, "update_plan", { plan: [] })], owner).cards).toEqual([]);
    const history = projectMobileInlinePlans([user("user-a", 1, "run-a"), first, terminal(3), user("user-b", 4, "run-b"),
      tool("new", 5, "update_plan", { text: "- New plan" }, "", "run-b")], owner, true);
    expect(history.cards.map((plan) => [plan.activeContent, plan.sealed, plan.streaming])).toEqual([["Original", true, false], ["New plan", false, true]]);
    const completed = projectMobileInlinePlans([tool("done", 1, "TodoWrite", { todos: [{ content: "Done", status: "completed" }] }),
      tool("new-todo", 2, "TodoWrite", { todos: [{ content: "Next", status: "pending" }] })], owner);
    expect(completed.cards.map((plan) => plan.activeContent)).toEqual(["Done", "Next"]);
  });

  it("reconstructs Task create/update/list/get, preserves explicit existing-task continuation and excludes unresolved deletes", () => {
    const events = [user("user-a", 1, "run-a"), tool("a", 2, "TaskCreate", { subject: "First" }, '{"taskId":"a"}', "run-a", 7n, "toolCallCompleted"),
      tool("b", 3, "TaskCreate", { subject: "Second" }, '{"taskId":"b"}', "run-a", 7n, "toolCallCompleted"),
      user("user-b", 4, "run-b"), tool("update-a", 5, "TaskUpdate", { taskId: "a", status: "completed" }, "", "run-b", 7n, "toolCallCompleted"),
      tool("get-b", 6, "TaskGet", { taskId: "b" }, '{"taskId":"b","status":"in_progress"}', "run-b", 7n, "toolCallCompleted")];
    const projected = projectMobileInlinePlans(events, owner);
    expect(projected.cards).toHaveLength(1); expect(projected.cards[0]?.steps.map((step) => [step.id, step.state])).toEqual([["a", "completed"], ["b", "inProgress"]]);
    const next = projectMobileInlinePlans([...events, tool("c", 7, "TaskCreate", { subject: "New phase" }, '{"taskId":"c"}', "run-b", 7n, "toolCallCompleted")], owner);
    expect(next.cards.map((plan) => plan.steps.map((step) => step.id))).toEqual([["a", "b"], ["c"]]);
    const cleared = tool("list", 8, "TaskList", {}, '{"tasks":[]}', "run-b", 7n, "toolCallCompleted");
    expect(projectMobileInlinePlans([...events, cleared], owner).cards.map((plan) => plan.steps.map((step) => step.id))).toEqual([["a", "b"]]);
    expect(projectMobileInlinePlans([events[1]!, events[2]!, tool("clear-current", 8, "TaskList", {}, '{"tasks":[]}',
      "run-a", 7n, "toolCallCompleted")], owner).cards).toEqual([]);
    const unresolved = tool("unresolved", 8, "TaskUpdate", { taskId: "missing", status: "deleted" }, "", "run-b", 7n, "toolCallCompleted");
    expect(projectMobileInlinePlans([...events, unresolved], owner).cards[0]?.steps).toHaveLength(2);
    const started = tool("create", 1, "TaskCreate", { subject: "Canonical task" });
    const finished = tool("create", 2, "TaskCreate", { subject: "Canonical task" }, '{"taskId":"canonical"}', "run-a", 7n, "toolCallCompleted");
    const created = projectMobileInlinePlans([started, finished], owner);
    expect(created.cards).toHaveLength(1); expect(created.cards[0]?.steps).toEqual([{ id: "canonical", content: "Canonical task", state: "pending" }]);
  });

  it("keeps native generations independent, refuses foreign/redacted sources and leaves delegated transcript plans inside their child", () => {
    const old = tool("old", 1, "TodoWrite", { todos: [{ content: "Old generation", status: "pending" }] }, "", "old-run", 6n);
    const current = tool("current", 2, "TodoWrite", { todos: [{ content: "Current generation", status: "pending" }] });
    const foreign = clone(EventSchema, current); foreign.eventId = "foreign"; foreign.identity!.sessionId = "other";
    const child = create(EventSchema, { eventId: "child-plan", identity: { sessionId: "session", generation: 7n }, cursor: { generation: 2n, sequence: 3n },
      payload: { kind: { case: "subagentTranscriptAppended", value: { subagentRunId: "child", entry: { entryId: "child-entry", toolName: "TodoWrite",
        toolInputJson: '{"todos":[{"content":"Child-only","status":"pending"}]}' } } } } });
    const redacted = tool("redacted", 4, "TodoWrite", { todos: [{ content: "Hidden", status: "pending" }] });
    if (redacted.payload?.kind.case !== "toolCallStarted") throw new Error("fixture"); redacted.payload.kind.value.toolCall!.arguments[0]!.redacted = true;
    const result = projectMobileInlinePlans([old, current, foreign, child, redacted], owner, true);
    expect(result.cards.map((plan) => [plan.activeContent, plan.streaming])).toEqual([["Old generation", false], ["Current generation", true]]);
    expect(projectMobileInlinePlans([old, current], { ...owner, generation: 3n }).cards).toEqual([]);
  });
});
