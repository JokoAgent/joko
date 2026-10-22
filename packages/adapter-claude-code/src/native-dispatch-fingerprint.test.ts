import { describe, expect, it } from "vitest";
import { claudeNativeDispatchFingerprint } from "./native-dispatch-fingerprint.js";

describe("Claude persisted native input fingerprint", () => {
  it("matches native text spelling and property order while retaining exact text and image bytes", () => {
    expect(claudeNativeDispatchFingerprint("Read this")).toBe(claudeNativeDispatchFingerprint([{ text: "Read this", type: "text" }]));
    const content = [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" } }, { type: "text", text: "Source image" }];
    expect(claudeNativeDispatchFingerprint(content)).toBe(claudeNativeDispatchFingerprint([
      { source: { data: "AA==", media_type: "image/png", type: "base64" }, type: "image" }, { text: "Source image", type: "text" }
    ]));
    expect(claudeNativeDispatchFingerprint(content)).not.toBe(claudeNativeDispatchFingerprint([...content].reverse()));
    expect(claudeNativeDispatchFingerprint(content)).not.toBe(claudeNativeDispatchFingerprint([
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AQ==" } }, content[1]
    ]));
    expect(claudeNativeDispatchFingerprint("Read this")).not.toBe(claudeNativeDispatchFingerprint("Read that"));
  });
});
