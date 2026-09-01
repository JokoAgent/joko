import { describe, expect, it } from "vitest";
import type { BackgroundTaskView, SubagentRunDetailView, SubagentRunView } from "../model.js";
import { collectTimelineSubagentRuns, formatSubagentDuration, projectSubagentInlineCard, timelineSubagentDetailResponseIsCurrent } from "./subagent-inline-card.js";

describe("delegated-run timeline projection", () => {
  it("joins only on the opaque durable id and exposes authoritative detail", () => {
    expect(projectSubagentInlineCard(task(), run())).toEqual({
      id: "run-one",
      title: "Research",
      state: "running",
      description: "Inspect the failure",
      summary: "Reading tests",
      model: "provider/model-large",
      thinkingLevel: "high",
      totalTokens: 1_234,
      toolUses: 7,
      durationMs: 65_400,
      canStop: true
    });
    expect(projectSubagentInlineCard({ ...task(), id: "other" }, run())).toBeUndefined();
  });

  it("does not parse generic detail into missing model or usage facts", () => {
    const projection = projectSubagentInlineCard(
      { ...task(), detail: "model guessed/model · 99 tool calls" },
      { ...run(), route: undefined, usage: undefined, summary: undefined, description: undefined, assignment: undefined }
    );
    expect(projection).toEqual({ id: "run-one", title: "Research", state: "running", canStop: true });
  });

  it("offers stop only when both the run state and run capability allow it", () => {
    expect(projectSubagentInlineCard(task(), { ...run(), state: "queued" })?.canStop).toBe(false);
    expect(projectSubagentInlineCard(task(), { ...run(), state: "completed" })?.canStop).toBe(false);
    expect(projectSubagentInlineCard(task(), { ...run(), capabilities: { ...run().capabilities, stop: false } })?.canStop).toBe(false);
  });

  it("projects explicit access and cost facts without inferring absent metadata", () => {
    expect(projectSubagentInlineCard(task(), {
      ...run(),
      readOnly: true,
      usage: { ...run().usage, costUsd: 0.005 }
    })).toMatchObject({ readOnly: true, costUsd: 0.005 });
  });

  it("prefers a capability-authorized returned result and projects the latest typed activity and observed children", () => {
    expect(projectSubagentInlineCard(task(), run(), detail({
      returnedResult: "Final durable answer",
      returnedResultTruncated: true,
      activity: [
        { sequence: 8, kind: "progress", state: "running", lastToolName: "read_file", occurredAt: 1_800 },
        { sequence: 13, kind: "completed", state: "completed", lastToolName: "run_tests", occurredAt: 2_200 }
      ],
      children: [child("child-one"), child("child-two")],
      childrenObserved: true
    }))).toMatchObject({
      summary: "Final durable answer",
      summaryTruncated: true,
      lastToolName: "run_tests",
      childCount: 2
    });
  });

  it("does not expose detail fields when the run capabilities or observation markers do not prove them", () => {
    const restricted = { ...run(), capabilities: { ...run().capabilities, viewActivity: false, viewReturnedResult: false } };
    expect(projectSubagentInlineCard(task(), restricted, detail({
      run: restricted,
      returnedResult: "Hidden result",
      activity: [{ sequence: 1, kind: "progress", state: "running", lastToolName: "hidden_tool", occurredAt: 1_500 }],
      children: [],
      childrenObserved: undefined
    }))).toMatchObject({ summary: "Reading tests" });
    expect(projectSubagentInlineCard(task(), restricted, detail({ run: restricted, children: [], childrenObserved: undefined }))).not.toHaveProperty("lastToolName");
    expect(projectSubagentInlineCard(task(), restricted, detail({ run: restricted, children: [], childrenObserved: undefined }))).not.toHaveProperty("childCount");
  });

  it("formats measured duration without adding unproved precision", () => {
    expect(formatSubagentDuration(420)).toBe("420ms");
    expect(formatSubagentDuration(4_600)).toBe("5s");
    expect(formatSubagentDuration(65_400)).toBe("1m 5s");
  });

  it("loads subsequent pages until every visible task has an exact run", async () => {
    const second = { ...run(), id: "run-two" };
    const collected = await collectTimelineSubagentRuns(new Set(["run-one", "run-two"]), async (token) => token === ""
      ? { runs: [run()], nextPageToken: "page-two", totalSize: 2 }
      : { runs: [second], totalSize: 2 });
    expect([...collected.keys()]).toEqual(["run-one", "run-two"]);
  });

  it("uses only typed aliases and keeps paging until a stronger exact identity replaces an old generation", async () => {
    const oldGeneration = { ...run(), id: "old-generation", logicalAgentId: "logical-task", revision: 1n };
    const exactGeneration = { ...run(), id: "logical-task", logicalAgentId: "logical-task", revision: 2n };
    const collected = await collectTimelineSubagentRuns(new Set(["logical-task"]), async (token) => token === ""
      ? { runs: [oldGeneration], nextPageToken: "page-two", totalSize: 2 }
      : { runs: [exactGeneration], totalSize: 2 });
    expect(collected.get("logical-task")?.id).toBe("logical-task");
  });

  it("fails closed after the safe page limit even when every continuation token is unique", async () => {
    let calls = 0;
    const loading = collectTimelineSubagentRuns(new Set(["run-one", "never-present"]), async () => {
      calls += 1;
      return {
        runs: calls === 1 ? [run()] : [],
        nextPageToken: `page-${calls}`,
        totalSize: 1_000_001
      };
    });
    await expect(loading).rejects.toThrow("safe page limit");
    expect(calls).toBe(1_000);
  });

  it("rejects late detail across epoch, session, run and revision fences", () => {
    const response = detail({ run: { ...run(), revision: 2n } });
    const base = {
      sourceSessionId: "session-one",
      requestEpoch: 4,
      activeSessionId: "session-one",
      activeEpoch: 4,
      requestedRun: run(),
      detail: response
    };
    expect(timelineSubagentDetailResponseIsCurrent(base)).toBe(true);
    expect(timelineSubagentDetailResponseIsCurrent({ ...base, activeEpoch: 5 })).toBe(false);
    expect(timelineSubagentDetailResponseIsCurrent({ ...base, activeSessionId: "session-two" })).toBe(false);
    expect(timelineSubagentDetailResponseIsCurrent({ ...base, requestedRun: { ...run(), id: "new-run" } })).toBe(false);
    expect(timelineSubagentDetailResponseIsCurrent({ ...base, requestedRun: { ...run(), revision: 3n } })).toBe(false);
  });
});

function task(): BackgroundTaskView {
  return { id: "run-one", title: "Generic activity", state: "running" };
}

function run(): SubagentRunView {
  return {
    id: "run-one",
    sessionId: "session-one",
    identityAliases: [],
    providerRunIds: [],
    state: "running",
    title: "Research",
    description: "Inspect the failure",
    assignment: "Inspect the failure",
    summary: "Reading tests",
    route: { providerId: "provider", modelId: "model-large", thinkingLevel: "high" },
    usage: { totalTokens: 1_234, toolUses: 7, durationMs: 65_400 },
    capabilities: { viewActivity: true, viewReturnedResult: true, viewFullTranscript: true, stop: true, steer: true, followUp: true, resume: false, parentContext: "snapshot" },
    startedAt: 1_000,
    updatedAt: 2_000,
    revision: 1n
  };
}

function detail(overrides: Partial<SubagentRunDetailView> = {}): SubagentRunDetailView {
  return {
    run: run(),
    activity: [],
    children: [],
    ...overrides
  };
}

function child(id: string): SubagentRunDetailView["children"][number] {
  return {
    id,
    identityAliases: [],
    title: id,
    state: "completed",
    startedAt: 1_000
  };
}
