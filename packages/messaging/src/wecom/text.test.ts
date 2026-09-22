import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";

import { splitWeComText, WECOM_TEXT_LIMIT_BYTES } from "./text.js";

describe("WeCom text codec", () => {
  it("splits by UTF-8 bytes without breaking code points", () => {
    const chunks = splitWeComText("中".repeat(20_000));
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => Buffer.byteLength(chunk, "utf8") <= WECOM_TEXT_LIMIT_BYTES)).toBe(true);
    expect(chunks.join("")).toBe("中".repeat(20_000));
  });

  it("normalizes line endings and omits empty text", () => {
    expect(splitWeComText(" \r\n ")).toEqual([]);
    expect(splitWeComText(" a\r\nb ")).toEqual(["a\nb"]);
  });
});
