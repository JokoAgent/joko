import { describe, expect, it } from "vitest";

import { DINGTALK_TEXT_LIMIT, splitDingTalkText } from "./text.js";

describe("splitDingTalkText", () => {
  it("prefers line boundaries and never splits a surrogate pair", () => {
    const chunks = splitDingTalkText(`${"a".repeat(DINGTALK_TEXT_LIMIT - 2)}\n\n😀tail`);

    expect(chunks.join("\n").replace(/\n+/gu, "\n")).toBe(`${"a".repeat(DINGTALK_TEXT_LIMIT - 2)}\n😀tail`);
    expect(chunks.every((chunk) => chunk.length <= DINGTALK_TEXT_LIMIT)).toBe(true);
    expect(chunks.some((chunk) => /[\ud800-\udbff]$/u.test(chunk))).toBe(false);
    expect(splitDingTalkText("   ")).toEqual(["(Empty response)"]);
  });
});
