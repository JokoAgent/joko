import { describe, expect, it, vi } from "vitest";

import type { ErrorView, SubagentChildRunView, SubagentTranscriptEntryView } from "../model.js";
import {
  classifySubagentError,
  collectAllSubagentTranscript,
  currentSubagentChildren,
  filterSubagentTranscript,
  localizeSubagentSystemEntry,
  MAXIMUM_COMPLETE_SUBAGENT_TRANSCRIPT_PAGES,
  projectSubagentReply,
  resolveCurrentSubagentChild,
  subagentChildIdentitySet
} from "./subagent-panel-state.js";

describe("delegated-work panel state", () => {
  it("reads every transcript page without clipping the initial view", async () => {
    const transcriptLoader = vi.fn(async (token: string) => token === ""
      ? { entries: [entry("one", 1, "first")], nextPageToken: "entries-2", tailPageToken: "tail-1", totalSize: 2 }
      : { entries: [entry("two", 2, "last")], tailPageToken: "tail-2", totalSize: 2 });

    await expect(collectAllSubagentTranscript(transcriptLoader)).resolves.toMatchObject({
      entries: [expect.objectContaining({ id: "one" }), expect.objectContaining({ id: "two" })],
      tailPageToken: "tail-2",
      totalSize: 2
    });
    expect(transcriptLoader.mock.calls.map(([token]) => token)).toEqual(["", "entries-2"]);
  });

  it("rejects a cyclic cursor instead of spinning or returning a silent prefix", async () => {
    await expect(collectAllSubagentTranscript(async () => ({
      entries: [], nextPageToken: "same", totalSize: 0
    }), "same")).rejects.toThrow(/cyclic token/u);
  });

  it("fails closed at the unique-page safety bound and allows a later complete retry", async () => {
    let overLimit = true;
    const transcriptLoader = vi.fn(async (_token: string) => overLimit
      ? {
          entries: [entry(`partial-${transcriptLoader.mock.calls.length}`, transcriptLoader.mock.calls.length, "partial")],
          nextPageToken: `unique-${transcriptLoader.mock.calls.length}`,
          tailPageToken: `tail-${transcriptLoader.mock.calls.length}`,
          totalSize: MAXIMUM_COMPLETE_SUBAGENT_TRANSCRIPT_PAGES + 1
        }
      : {
          entries: [entry("recovered", 1, "complete retry")],
          tailPageToken: "recovered-tail",
          totalSize: 1
        });

    await expect(collectAllSubagentTranscript(transcriptLoader)).rejects.toThrow(/safe page limit/u);
    expect(transcriptLoader).toHaveBeenCalledTimes(MAXIMUM_COMPLETE_SUBAGENT_TRANSCRIPT_PAGES);

    overLimit = false;
    await expect(collectAllSubagentTranscript(transcriptLoader)).resolves.toMatchObject({
      entries: [expect.objectContaining({ id: "recovered", content: "complete retry" })],
      tailPageToken: "recovered-tail",
      totalSize: 1
    });
    expect(transcriptLoader).toHaveBeenCalledTimes(MAXIMUM_COMPLETE_SUBAGENT_TRANSCRIPT_PAGES + 1);
  });

  it("keeps a clicked lineage on its current generation and excludes parallel siblings", () => {
    const old = child("old", { identityAliases: ["logical-a"], endedAt: 2_000, state: "completed" });
    const current = child("current", { parentChildId: "old", identityAliases: ["logical-a", "old"], startedAt: 3_000 });
    const sibling = child("sibling", { role: "reviewer", startedAt: 4_000 });
    const children = [old, current, sibling];
    expect(currentSubagentChildren(children).map((value) => value.id)).toEqual(["current", "sibling"]);
    expect(resolveCurrentSubagentChild(children, "old")?.id).toBe("current");
    expect(resolveCurrentSubagentChild(children, "logical-a")?.id).toBe("current");
    expect([...subagentChildIdentitySet(current, children)]).toEqual(expect.arrayContaining(["current", "old", "logical-a"]));

    const transcript = [
      entry("shared", 1, "assignment"),
      entry("old-answer", 2, "old answer", { childId: "old" }),
      entry("current-answer", 3, "current answer", { childId: "current" }),
      entry("sibling-answer", 4, "sibling answer", { childId: "sibling" })
    ];
    expect(filterSubagentTranscript(transcript, current, children).map((value) => value.id)).toEqual([
      "shared", "old-answer", "current-answer"
    ]);
  });

  it("falls back only to a sole current child when an old selection disappears", () => {
    const current = child("current", { parentChildId: "departed" });
    expect(resolveCurrentSubagentChild([current], "unknown")?.id).toBe("current");
    expect(resolveCurrentSubagentChild([current, child("parallel")], "unknown")).toBeUndefined();
  });

  it("shows the current durable result for old-only, unread-tail and truncated records without duplicating a matching complete reply", () => {
    const currentIds = new Set(["current"]);
    const oldOnly = [entry("old", 1, "old answer", { childId: "old" })];
    expect(projectSubagentReply(oldOnly, currentIds, "new answer", true)).toMatchObject({ showDurableResult: true, hasReply: true });

    const matching = [entry("new", 2, "new answer", { childId: "current" })];
    expect(projectSubagentReply(matching, currentIds, "new answer", true).showDurableResult).toBe(false);
    expect(projectSubagentReply(matching, currentIds, "new answer", false).showDurableResult).toBe(true);

    const truncated = [...matching, entry("limit", 3, "stored limit", {
      role: "system",
      childId: "current",
      systemEvent: { kind: "transcript-truncated", params: [] }
    })];
    expect(projectSubagentReply(truncated, currentIds, "new answer", true)).toMatchObject({
      showDurableResult: true,
      recordTruncated: true
    });
  });

  it("localizes known synthesized rows, preserves runtime/future rows, and classifies friendly errors", () => {
    const t = vi.fn((key: string) => key === "subagents.systemEvent.turnEnded" ? "Localized ending" : key) as never;
    expect(localizeSubagentSystemEntry(entry("known", 1, "Recorded ending", {
      role: "system", systemEvent: { kind: "turn-ended", params: [] }
    }), t)).toBe("Localized ending");
    expect(localizeSubagentSystemEntry(entry("future", 2, "Future recorded content", {
      role: "system", systemEvent: { kind: "future-kind", params: [] }
    }), t)).toBe("Future recorded content");
    expect(localizeSubagentSystemEntry(entry("runtime", 3, "raw stderr", { role: "system" }), t)).toBe("raw stderr");
    expect(classifySubagentError(error("MODEL_NOT_FOUND", "Unknown model route"))).toBe("modelInvalid");
    expect(classifySubagentError(error("UPSTREAM", "HTTP 429 too many requests"))).toBe("rateLimited");
    expect(classifySubagentError(error("DENIED", "Permission denied by policy"))).toBe("permissionDenied");
  });
});

function child(id: string, patch: Partial<SubagentChildRunView> = {}): SubagentChildRunView {
  return {
    id,
    identityAliases: [],
    title: id,
    state: "running",
    startedAt: 1_000,
    ...patch
  };
}

function entry(
  id: string,
  sequence: number,
  content: string,
  patch: Partial<SubagentTranscriptEntryView> = {}
): SubagentTranscriptEntryView {
  return { id, sequence, role: "subagent", content, occurredAt: sequence * 1_000, ...patch };
}

function error(code: string, message: string): ErrorView {
  return { code, message, phase: "dispatch", severity: "fatal", retryable: false, recovery: [] };
}
