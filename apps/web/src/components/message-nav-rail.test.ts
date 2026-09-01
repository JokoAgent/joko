import { describe, expect, it } from "vitest";

import type { TimelineItemView } from "../model.js";
import {
  deriveMessageNavEntries,
  messageNavTickProgress,
  messageNavHasRoom,
  normalizeMessageNavExcerpt,
  pickActiveMessageNavId,
  pickVisibleMessageNavRange,
  planMessageNavTicks,
  promptPreviewLine
} from "./message-nav-rail.js";

function item(id: string, kind: TimelineItemView["kind"], text = "", attachments?: TimelineItemView["attachments"]): TimelineItemView {
  return { id, kind, text, sequence: BigInt(id.replace(/\D/gu, "") || "0"), createdAt: 1, ...(attachments === undefined ? {} : { attachments }) };
}

describe("message navigation rail model", () => {
  it("derives real user turns, attachment fallbacks, and the first assistant excerpt", () => {
    const attachment = { id: "a", blobId: "b", title: "capture", kind: "image" as const, fileName: "capture.png", mediaType: "image/png", byteSize: 4 };
    expect(deriveMessageNavEntries([
      item("u1", "user", "> quoted\n\nFix the parser"),
      item("a2", "assistant", "## Done\n**Parser** is fixed."),
      item("a3", "assistant", "ignored"),
      item("u4", "user", "", [attachment])
    ])).toEqual([
      { id: "u1", preview: "Fix the parser", answerExcerpt: "Done Parser is fixed." },
      { id: "u4", preview: "capture.png" }
    ]);
  });

  it("cleans previews without leaking quote markers or markdown noise", () => {
    expect(promptPreviewLine("> old answer\n\ncontinue here")).toBe("continue here");
    expect(normalizeMessageNavExcerpt("<!-- secret --> ## **Answer** [`file`](x)\n- ready")).toBe("## Answer file ready");
  });

  it("marks scheduler prompts without inferring automation from their text", () => {
    const automated = {
      ...item("u1", "user", "nightly check"),
      inputDelivery: "scheduler" as const,
      automationOrigin: { kind: "scheduler", scheduleId: "schedule-1" } as const
    };
    expect(deriveMessageNavEntries([automated, item("u2", "user", "manual check")])).toEqual([
      { id: "u1", preview: "nightly check", isAutomation: true },
      { id: "u2", preview: "manual check" }
    ]);
  });

  it("keeps prompt, scheduler, and untyped imported turns while excluding typed steer and follow-up input", () => {
    expect(deriveMessageNavEntries([
      { ...item("u1", "user", "initial"), inputDelivery: "prompt" },
      { ...item("u2", "user", "redirect"), inputDelivery: "steer" },
      { ...item("u3", "user", "continue"), inputDelivery: "followUp" },
      { ...item("u4", "user", "scheduled"), inputDelivery: "scheduler" },
      item("u5", "user", "untyped import")
    ]).map((entry) => entry.id)).toEqual(["u1", "u4", "u5"]);
  });

  it("compresses then truncates ticks and chooses the last turn above the reading line", () => {
    expect(planMessageNavTicks(4, 36)).toEqual({ startIndex: 0, pitchPx: 9, hiddenCount: 0 });
    expect(planMessageNavTicks(8, 48)).toEqual({ startIndex: 0, pitchPx: 6, hiddenCount: 0 });
    expect(planMessageNavTicks(20, 50)).toEqual({ startIndex: 11, pitchPx: 5, hiddenCount: 11 });
    expect(pickActiveMessageNavId(["a", "b", "c"], 40, (index) => [10, 35, 70][index]!)).toBe("b");
    expect(messageNavHasRoom(1_014, 914)).toBe(true);
    expect(messageNavHasRoom(980, 914)).toBe(false);
  });

  it("tracks the visible turn range and graduated interaction scale", () => {
    const tops = [-100, 20, 300, 650, 900];
    expect(pickVisibleMessageNavRange(["a", "b", "c", "d", "e"], 40, 692, (index) => tops[index]!)).toEqual({
      startIndex: 1,
      endIndex: 3
    });
    expect(pickVisibleMessageNavRange(["a", "b"], -200, -10, (index) => [0, 100][index]!)).toBeUndefined();
    expect([undefined, 0, 1, 2, 3, 4].map(messageNavTickProgress)).toEqual([0, 1, 0.7, 0.4, 0.2, 0]);
  });
});
