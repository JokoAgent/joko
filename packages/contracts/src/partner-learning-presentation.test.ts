import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import { PartnerLearningAction, PartnerLearningFeedbackSchema, PartnerLearningKind } from "./gen/joko/v1/event_pb.js";
import { partnerLearningRows, projectPartnerLearningFeedback } from "./partner-learning-presentation.js";
import { partnerLearningMessage } from "./partner-learning-messages.js";

describe("Partner learning receipt presentation", () => {
  it("keeps exact receipt identities, replaces repeated saves and presents at most two complete summaries", () => {
    const receipts = Array.from({ length: 130 }, (_, index) => ({ kind: PartnerLearningKind.MEMORY,
      entryId: `memory-${index}`, title: `Memory ${index}`, action: PartnerLearningAction.CREATED }));
    const feedback = projectPartnerLearningFeedback(create(PartnerLearningFeedbackSchema, { revision: { value: 3n }, receipts: [
      { kind: PartnerLearningKind.SKILL, entryId: "same", title: "Release", action: PartnerLearningAction.CREATED },
      ...receipts, { kind: PartnerLearningKind.MEMORY, entryId: "memory-0", title: "Changed memory", action: PartnerLearningAction.UPDATED },
      { kind: PartnerLearningKind.SKILL, entryId: "same", title: "Release steps", action: PartnerLearningAction.UPDATED }
    ] }));
    expect(feedback?.receipts).toHaveLength(131);
    expect(feedback?.receipts[0]).toMatchObject({ entryId: "memory-0", title: "Changed memory" });
    const rows = partnerLearningRows(feedback);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ kind: "memory", destination: "memory", action: "updated" });
    expect(rows[0]?.title).toContain("Memory 129");
    expect(rows[1]).toEqual({ kind: "skill", title: "Release steps", action: "updated", destination: "skills" });
  });

  it("requires current typed success metadata without truncating or repairing invalid receipts", () => {
    const valid = { kind: PartnerLearningKind.MEMORY, entryId: "memory", title: "Clear language", action: PartnerLearningAction.CREATED };
    expect(projectPartnerLearningFeedback(undefined)).toBeUndefined();
    expect(partnerLearningRows(undefined)).toEqual([]);
    expect(() => projectPartnerLearningFeedback(create(PartnerLearningFeedbackSchema, { receipts: [valid] }))).toThrow();
    for (const receipt of [{ ...valid, title: "x".repeat(101) }, { ...valid, title: "\0Hidden" }, { ...valid, title: " Padded" },
      { ...valid, entryId: "" }, { ...valid, entryId: "x".repeat(257) }, { ...valid, kind: PartnerLearningKind.UNSPECIFIED },
      { ...valid, action: PartnerLearningAction.UNSPECIFIED }]) {
      expect(() => projectPartnerLearningFeedback(create(PartnerLearningFeedbackSchema, { revision: { value: 1n }, receipts: [receipt] }))).toThrow();
    }
    expect(projectPartnerLearningFeedback(create(PartnerLearningFeedbackSchema, { revision: { value: 1n }, receipts: [{ ...valid, title: "😀".repeat(100) }] }))?.receipts[0]?.title).toBe("😀".repeat(100));
    expect(projectPartnerLearningFeedback(create(PartnerLearningFeedbackSchema, { revision: { value: 1n }, receipts: [{ ...valid, title: "\u202eOriginal" }] }))?.receipts[0]?.title).toBe("\u202eOriginal");
  });

  it("localizes all five supported languages while preserving literal titles", () => {
    const memory = { kind: "memory", title: "$& <plain>", action: "created", destination: "memory" } as const;
    for (const locale of ["en", "zh-CN", "zh-TW", "ja", "ko"]) {
      expect(partnerLearningMessage(locale, memory)).toContain(memory.title);
      expect(partnerLearningMessage(locale, { kind: "skill", title: "Release", action: "created", destination: "skills" }))
        .not.toBe(partnerLearningMessage(locale, { kind: "skill", title: "Release", action: "updated", destination: "skills" }));
    }
  });
});
