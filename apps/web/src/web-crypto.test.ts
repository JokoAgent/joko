import { describe, expect, it } from "vitest";
import { randomUuid, sha256Hex } from "./web-crypto.js";

describe("insecure-LAN browser crypto fallbacks", () => {
  it.each([
    ["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
    ["abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
    ["The quick brown fox jumps over the lazy dog", "d7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592"]
  ])("hashes %j without SubtleCrypto", async (input, expected) => {
    const bytes = new TextEncoder().encode(input);
    expect(await sha256Hex(bytes.buffer, undefined)).toBe(expected);
  });

  it("creates RFC 4122 version-4 identifiers", () => {
    expect(randomUuid()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  });
});
