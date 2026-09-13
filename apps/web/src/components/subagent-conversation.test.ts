import { describe, expect, it } from "vitest";

import type { SubagentTranscriptEntryView } from "../model.js";
import { buildSubagentConversation, mergeSubagentTranscript } from "./subagent-conversation.js";

const entry = (id: string, sequence: number, patch: Partial<SubagentTranscriptEntryView>): SubagentTranscriptEntryView => ({
  id,
  sequence,
  role: "subagent",
  content: "",
  occurredAt: sequence,
  ...patch
});

describe("delegated transcript projection", () => {
  it("folds tool start, update, and end entries into one readable card", () => {
    const conversation = buildSubagentConversation([
      entry("parent", 1, { role: "parent", content: "Inspect it", controlAction: "steer" }),
      entry("start", 2, { role: "tool", content: "read(safe.txt)", toolName: "read", toolCallId: "call", toolPhase: "start", toolInputJson: "{}" }),
      entry("update", 3, { role: "tool", content: "half", toolCallId: "call", toolPhase: "update" }),
      entry("end", 4, { role: "tool", content: "done", toolCallId: "call", toolPhase: "end" }),
      entry("system", 5, { role: "system", content: "checkpoint" })
    ]);

    expect(conversation.items).toEqual([
      expect.objectContaining({ kind: "parent", controlAction: "steer" }),
      expect.objectContaining({ kind: "tool", toolName: "read", result: "done", done: true, isError: false })
    ]);
    expect(conversation.system.map((item) => item.id)).toEqual(["system"]);
  });

  it("retains orphan results and merges live tail pages by stable identity", () => {
    const orphan = entry("end", 2, { role: "tool", content: "result", toolName: "search", toolPhase: "end", isError: true });
    expect(buildSubagentConversation([orphan]).items[0]).toMatchObject({ kind: "tool", result: "result", done: true, isError: true });
    expect(mergeSubagentTranscript(
      [entry("one", 1, { content: "old" }), orphan],
      [entry("one", 1, { content: "new" }), entry("three", 3, { content: "tail" })]
    ).map((item) => [item.id, item.content])).toEqual([["one", "new"], ["end", "result"], ["three", "tail"]]);
  });

  it("pairs id-less tool endings with the nearest start and preserves untyped or orphan rows", () => {
    const conversation = buildSubagentConversation([
      entry("outer", 1, { role: "tool", content: "outer call", toolName: "outer", toolPhase: "start" }),
      entry("inner", 2, { role: "tool", content: "inner call", toolName: "inner", toolPhase: "start" }),
      entry("inner-end", 3, { role: "tool", content: "inner result", toolPhase: "end" }),
      entry("outer-end", 4, { role: "tool", content: "outer result", toolPhase: "end", isError: true }),
      entry("orphan-update", 5, { role: "tool", content: "late update", toolPhase: "update" }),
      entry("untyped", 6, { role: "tool", content: "untyped output" }),
      entry("nameless-end", 7, { role: "tool", content: "nameless result", toolPhase: "end" })
    ]);

    expect(conversation.items).toEqual([
      expect.objectContaining({ id: "outer", result: "outer result", done: true, isError: true }),
      expect.objectContaining({ id: "inner", result: "inner result", done: true, isError: false }),
      expect.objectContaining({ id: "orphan-update", summary: "", result: "late update", done: true }),
      expect.objectContaining({ id: "untyped", summary: "", result: "untyped output", done: true }),
      expect.objectContaining({ id: "nameless-end", result: "nameless result", done: true })
    ]);
  });
});
