import { create } from "@bufbuild/protobuf";
import {
  BackgroundTaskSchema, BackgroundTaskState, EntityVersionSchema, EventSchema, SubagentChildRunSchema, SubagentRunDetailSchema,
  SubagentRunSchema, SubagentRunState, SubagentToolPhase, SubagentTranscriptEntrySchema, SubagentTranscriptRole,
  ToolCallState
} from "@joko/contracts";
import { describe, expect, it } from "vitest";
import {
  buildMobileDelegatedConversation, currentMobileDelegatedChildren, mergeMobileDelegatedTranscript,
  mobileDelegatedEventKey, mobileDelegatedResultIsInTranscript, mobileDelegatedTimelineAffinity,
  projectMobileDelegated, projectMobileDelegatedEntries, resolveMobileDelegatedChild
} from "./mobile-delegated";
import { mobileDelegatedSystemText, mobileDelegatedTaskMessage } from "./mobile-delegated-task-messages";

const run = create(SubagentRunSchema, { subagentRunId: "delegated", sessionId: "session", logicalAgentId: "logical",
  identityAliases: ["alias"], providerRunIds: ["provider-run"], title: "Investigate", assignment: "Read logs", summary: "Found the cause",
  state: SubagentRunState.RUNNING, version: { generation: 3n, revision: { value: 8n } },
  capabilities: { viewActivity: true, viewReturnedResult: true, viewFullTranscript: true },
  usage: { totalTokens: 9007199254740993n, toolUses: 2n, duration: { seconds: 2n } },
  route: { providerId: "provider", modelId: "model" } });

describe("mobile delegated projection", () => {
  it("joins exact aliases once, keeps ordinary background state and never regresses generation/revision", () => {
    const task = (id: string) => create(BackgroundTaskSchema, { backgroundTaskId: id, sessionId: "session", displayName: "Worker",
      state: BackgroundTaskState.WAITING, version: { generation: 3n, revision: { value: 4n } } });
    const old = create(SubagentRunSchema, { ...run, state: SubagentRunState.COMPLETED, version: create(EntityVersionSchema, { generation: 2n, revision: { value: 99n } }) });
    const entries = projectMobileDelegatedEntries("session", [task("alias"), task("provider-run"), task("ordinary")], [run, old,
      create(SubagentRunSchema, { ...run, subagentRunId: "foreign", sessionId: "other" })]);
    expect(entries).toHaveLength(2);
    expect(entries[0]?.run).toBe(run);
    expect(projectMobileDelegated(entries[1]!)).toMatchObject({ state: "waiting", title: "Worker" });
    const staleDetail = create(SubagentRunDetailSchema, { run: old, returnedResult: "Old result" });
    expect(projectMobileDelegated(entries[0]!, staleDetail)).toMatchObject({ state: "running", summary: "Found the cause",
      tokens: "9007199254740993", toolUses: "2", model: "provider/model", durationMs: 2000 });
    const detail = create(SubagentRunDetailSchema, { run, returnedResult: "The result", returnedResultTruncated: true,
      activity: [{ sequence: 4n, lastToolName: "Read" }, { sequence: 2n, lastToolName: "Search" }] });
    expect(projectMobileDelegated(entries[0]!, detail)).toMatchObject({ summary: "The result", resultTruncated: true, lastToolName: "Read" });
  });

  it("pairs child-local tools and merges paged entries by ID without losing large sequence precision", () => {
    const entry = (id: string, sequence: bigint, childId: string, phase: SubagentToolPhase, content: string) => create(SubagentTranscriptEntrySchema,
      { entryId: id, sequence, childId, role: SubagentTranscriptRole.TOOL, toolCallId: "reused", toolPhase: phase, toolName: "Read", content });
    const entries = [entry("a", 9007199254740993n, "a", SubagentToolPhase.START, "First"),
      entry("b", 9007199254740994n, "b", SubagentToolPhase.START, "Second"),
      entry("c", 9007199254740995n, "a", SubagentToolPhase.END, "First result"),
      entry("d", 9007199254740996n, "b", SubagentToolPhase.END, "Second result")];
    const merged = mergeMobileDelegatedTranscript(entries.slice(0, 3), entries.slice(2));
    expect(merged).toHaveLength(4);
    expect(buildMobileDelegatedConversation(merged).map((item) => item.tool?.output)).toEqual(["First result", "Second result"]);
  });

  it("decorates the current parent tool edge without swallowing its row and refreshes only typed task events", () => {
    const parent = create(SubagentRunSchema, { ...run, parentToolCallId: "parent-tool", parentRunId: "parent-run" });
    const event = create(EventSchema, { eventId: "task-event", identity: { sessionId: "session" }, cursor: { generation: 1n, sequence: 4n },
      payload: { kind: { case: "backgroundTaskChanged", value: { backgroundTask: { backgroundTaskId: "alias", sessionId: "session" } } } } });
    const tool = (id: string, sequence: bigint, kind: "toolCallStarted" | "toolCallCompleted") => create(EventSchema,
      { eventId: id, identity: { sessionId: "session" }, cursor: { generation: 1n, sequence }, payload: { kind: { case: kind, value: {
        toolCall: { toolCallId: "parent-tool", sessionId: "session", runId: "parent-run", state: ToolCallState.SUCCEEDED }
      } } } });
    const delta = create(EventSchema, { eventId: "delta", identity: { sessionId: "session" }, cursor: { generation: 1n, sequence: 7n },
      payload: { kind: { case: "textDelta", value: { delta: "Hello" } } } });
    const entries = projectMobileDelegatedEntries("session", [event.payload!.kind.case === "backgroundTaskChanged" ? event.payload!.kind.value.backgroundTask! : create(BackgroundTaskSchema)], [parent]);
    const events = [tool("start", 2n, "toolCallStarted"), event, tool("end", 6n, "toolCallCompleted")];
    const affinity = mobileDelegatedTimelineAffinity("session", 1n, events, entries);
    expect(affinity.byEventId.get("end")?.[0]?.run).toBe(parent);
    expect(affinity.suppressedMetadataEventIds).toEqual(new Set(["task-event"]));
    expect(mobileDelegatedEventKey("session", 1n, events)).toBe(mobileDelegatedEventKey("session", 1n, [...events, delta]));
    expect(mobileDelegatedEventKey("session", 2n, events)).toBe("");
    const nested = create(SubagentRunSchema, { ...run, subagentRunId: "nested", parentSubagentRunId: "delegated" });
    const nestedEvent = create(EventSchema, { eventId: "nested-event", identity: { sessionId: "session" }, cursor: { generation: 1n, sequence: 8n },
      payload: { kind: { case: "subagentRunChanged", value: { run: { run: nested } } } } });
    const tail = create(EventSchema, { eventId: "nested-tail", identity: { sessionId: "session" }, cursor: { generation: 1n, sequence: 9n },
      payload: { kind: { case: "subagentTranscriptAppended", value: { subagentRunId: "nested", entry: { entryId: "reply" } } } } });
    const nestedEntries = projectMobileDelegatedEntries("session", [], [parent, nested]);
    const window = mobileDelegatedTimelineAffinity("session", 1n, [nestedEvent, tail], nestedEntries);
    expect(window.orphanEntries.map((entry) => entry.run?.subagentRunId)).toEqual(["delegated"]);
    expect(window.nestedByRunId.get("delegated")?.[0]?.run?.subagentRunId).toBe("nested");
    expect(window.suppressedMetadataEventIds).toEqual(new Set(["nested-event", "nested-tail"]));
    expect(mobileDelegatedTimelineAffinity("session", 1n, [nestedEvent], [nestedEntries[1]!]).byEventId.get("nested-event")?.[0]?.run).toBe(nested);
  });

  it("resolves resumed child aliases, preserves parallel identities and deduplicates only complete matching results", () => {
    const old = create(SubagentChildRunSchema, { childId: "old" });
    const resumed = create(SubagentChildRunSchema, { childId: "new", parentChildId: "old", identityAliases: ["old"] });
    const parallel = create(SubagentChildRunSchema, { childId: "parallel" });
    expect(currentMobileDelegatedChildren([old, resumed, parallel])).toEqual([resumed, parallel]);
    expect(resolveMobileDelegatedChild([old, resumed, parallel], "old")).toBe(resumed);
    expect(resolveMobileDelegatedChild([resumed, parallel], "missing")).toBeUndefined();
    const reply = create(SubagentTranscriptEntrySchema, { entryId: "reply", role: SubagentTranscriptRole.SUBAGENT, content: "Result" });
    expect(mobileDelegatedResultIsInTranscript("Result", [reply], false)).toBe(false);
    expect(mobileDelegatedResultIsInTranscript("Result", [reply], true)).toBe(true);
    const notice = create(SubagentTranscriptEntrySchema, { entryId: "notice", content: "Runtime text", systemEvent: { kind: "future-kind" } });
    expect(mobileDelegatedSystemText(notice, "ja")).toBe("Runtime text");
    for (const locale of ["en", "zh-CN", "zh-TW", "ja", "ko"] as const) expect(mobileDelegatedTaskMessage(locale, "children", { count: 2 })).toContain("2");
  });
});
