import { describe, expect, it } from "vitest";

import {
  LONG_USER_MESSAGE_VISUAL_LINE_THRESHOLD,
  mayExceedUserMessageLineThreshold,
  measuredUserMessageVisualLines,
  shouldCollapseMeasuredUserMessage,
  shouldInitiallyCollapseUserMessage
} from "./user-message-collapse.js";

describe("user-message visual-line collapse", () => {
  it("keeps exactly fourteen laid-out logical lines open and collapses the fifteenth", () => {
    const fourteenLines = Array.from({ length: 14 }, () => "x").join("\n");
    const fifteenLines = `${fourteenLines}\nx`;

    expect(LONG_USER_MESSAGE_VISUAL_LINE_THRESHOLD).toBe(14);
    expect(shouldInitiallyCollapseUserMessage(fourteenLines)).toBe(false);
    expect(shouldInitiallyCollapseUserMessage(fifteenLines)).toBe(true);
  });

  it("counts CJK full-width text conservatively in the pre-layout estimate", () => {
    expect(shouldInitiallyCollapseUserMessage("界".repeat(420))).toBe(false);
    expect(shouldInitiallyCollapseUserMessage("界".repeat(421))).toBe(true);
  });

  it("keeps a narrow-screen long URL eligible for real measurement", () => {
    const longUrl = `https://example.test/${"narrow-segment/".repeat(10)}`;

    expect(shouldInitiallyCollapseUserMessage(longUrl)).toBe(false);
    expect(mayExceedUserMessageLineThreshold(longUrl)).toBe(true);
  });

  it("uses measured line boxes with a half-line sub-pixel tolerance", () => {
    expect(measuredUserMessageVisualLines(336, 24)).toBe(14);
    expect(shouldCollapseMeasuredUserMessage(336, 24)).toBe(false);
    expect(shouldCollapseMeasuredUserMessage(347, 24)).toBe(false);
    expect(shouldCollapseMeasuredUserMessage(348, 24)).toBe(true);
    expect(shouldCollapseMeasuredUserMessage(360, Number.NaN)).toBe(true);
  });

  it("does not mount measurement work for empty or unconditionally short content", () => {
    expect(mayExceedUserMessageLineThreshold("   \n ")).toBe(false);
    expect(mayExceedUserMessageLineThreshold("short English 中文")).toBe(false);
  });
});
