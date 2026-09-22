import { describe, expect, it } from "vitest";

import { safeSlackText, SLACK_TEXT_LIMIT, splitSlackText } from "./text.js";

describe("Slack text splitting", () => {
  it("bounds the escaped output and preserves Unicode scalar boundaries", () => {
    const input = "<&>😀".repeat(1_000);
    const parts = splitSlackText(input);
    expect(parts.join("")).toBe(input);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect(safeSlackText(part).length).toBeLessThanOrEqual(SLACK_TEXT_LIMIT);
      expect(part.codePointAt(0)).not.toBeUndefined();
      expect(/^[\uDC00-\uDFFF]/u.test(part)).toBe(false);
      expect(/[\uD800-\uDBFF]$/u.test(part)).toBe(false);
    }
  });
});
