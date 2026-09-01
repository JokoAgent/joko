import { describe, expect, it } from "vitest";

import { redactAndroidOutput, redactAndroidUiValue } from "./redaction.js";

describe("Android output redaction", () => {
  it("removes credentials, private keys, URL userinfo, NUL bytes, and private roots", () => {
    const output = [
      "Authorization: Bearer abcdef",
      "password=hunter2 token:abcd",
      "https://person:pass@example.test/path",
      "-----BEGIN PRIVATE KEY-----",
      "secret-key-material",
      "-----END PRIVATE KEY-----",
      "C:\\Users\\Person\\artifacts\\build.apk\0"
    ].join("\n");

    const redacted = redactAndroidOutput(output, ["C:\\Users\\Person"]);

    expect(redacted).toContain("Authorization: [REDACTED]");
    expect(redacted).toContain("password=[REDACTED]");
    expect(redacted).toContain("token:[REDACTED]");
    expect(redacted).toContain("https://[REDACTED]@[HOST]/path");
    expect(redacted).toContain("[REDACTED PRIVATE KEY]");
    expect(redacted).toContain("[PATH]\\artifacts\\build.apk");
    expect(redacted).not.toContain("hunter2");
    expect(redacted).not.toContain("secret-key-material");
    expect(redacted).not.toContain("\0");
  });

  it("redacts password UI fields and bounds ordinary UI values", () => {
    expect(redactAndroidUiValue("typed secret", true)).toBe("[REDACTED]");
    expect(redactAndroidUiValue("", false)).toBeUndefined();
    expect(redactAndroidUiValue("x".repeat(700), false)).toBe(`${"x".repeat(511)}…`);
    expect(redactAndroidUiValue("token=visible", false)).toBe("token=[REDACTED]");
  });
});
