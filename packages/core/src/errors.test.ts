import { describe, expect, it } from "vitest";

import { JokoError, redactSecrets, sanitizePublicError, toPublicError } from "./errors.js";

const credentialSample = (...parts: readonly string[]): string => parts.join("");

describe("redactSecrets", () => {
  it.each([
    credentialSample("gh", "p_abcdefghijklmnopqrstuvwxyz123456"),
    credentialSample("xo", "xb-1234567890-abcdefghijklmnop"),
    credentialSample("AK", "IA1234567890ABCDEF"),
    credentialSample("np", "m_abcdefghijklmnopqrstuvwxyz123456"),
    "headersegmentwithenoughcharacters.payloadpartwithenoughcharacters.signaturepartwithenoughcharacters",
    "-----BEGIN PRIVATE KEY-----\nprivate-material\n-----END PRIVATE KEY-----"
  ])("removes common credential material from persisted text", (secret) => {
    expect(redactSecrets(`before ${secret} after`)).not.toContain(secret);
  });

  it("redacts named assignments and URL user information without changing ordinary text", () => {
    expect(redactSecrets("password=hunter2 token: abcdefghijklmnop https://name:pass@example.com/path"))
      .toBe("password=[REDACTED] token: [REDACTED] https://[REDACTED]@example.com/path");
    const structured = JSON.stringify({
      secret: { nested: "value" },
      accessToken: [1, 2],
      apiKey: 'abc"def',
      "api key": "spaced-value",
      password: 1234,
      credential: null,
      Authorization: "Basic dXNlcjpwYXNz",
      Cookie: "session=abcdefghijklmnop",
      url: "https://x.test/?access_token=abcdefghijklmnop&safe=yes",
      message: "token: abcdefghijklmnop",
      tokenCount: 7,
      secretary: "Ada",
      passwordless: true
    }).replace('"apiKey"', '"api\\u004bey"');
    expect(JSON.parse(redactSecrets(structured))).toEqual({
      secret: "[REDACTED]",
      accessToken: "[REDACTED]",
      apiKey: "[REDACTED]",
      "api key": "[REDACTED]",
      password: "[REDACTED]",
      credential: null,
      Authorization: "[REDACTED]",
      Cookie: "[REDACTED]",
      url: "https://x.test/?access_token=[REDACTED]&safe=yes",
      message: "token: [REDACTED]",
      tokenCount: 7,
      secretary: "Ada",
      passwordless: true
    });
    const sourceSensitive = '{"id":9007199254740993,"huge":1e400,"negativeZero":-0,"dup":1,"dup":2}';
    expect(redactSecrets(sourceSensitive)).toBe(sourceSensitive);
    const credentialsInKeys = JSON.stringify({
      [credentialSample("gh", "p_abcdefghijklmnopqrstuvwxyz123456")]: "denied",
      "https://x.test/?access_token=abcdefghijklmnop": "denied",
      "Bearer abcdefghijklmnop": "denied"
    });
    const redactedKeys = redactSecrets(credentialsInKeys);
    expect(JSON.parse(redactedKeys)).toEqual({
      "[REDACTED]": "denied",
      "https://x.test/?access_token=[REDACTED]": "denied",
      "Bearer [REDACTED]": "denied"
    });
    expect(redactSecrets("private_key='abc\\'def'")).toBe("private_key='[REDACTED]'");
    expect(redactSecrets("ordinary task output")).toBe("ordinary task output");
  });

  it("keeps adversarial ordinary and credential-shaped output bounded", () => {
    const startedAt = performance.now();
    for (const fragment of ["z", "a-", "a+", "token"]) {
      const ordinary = fragment.repeat(Math.ceil((64 * 1024) / fragment.length)).slice(0, 64 * 1024);
      expect(redactSecrets(ordinary)).toBe(ordinary);
    }
    const escapedQuote = String.raw`\"`;
    const unterminatedQuotedText = `"${escapedQuote.repeat(32 * 1024)}`;
    expect(redactSecrets(unterminatedQuotedText)).toBe(unterminatedQuotedText);
    expect(performance.now() - startedAt).toBeLessThan(250);
    for (const [prefix, expected] of [["sk-", "[REDACTED]"], ["Bearer ", "Bearer [REDACTED]"]] as const) {
      expect(redactSecrets(`${prefix}${"x".repeat(8 * 1024 * 1024)}`)).toBe(expected);
    }
  });
});

describe("public error sanitization", () => {
  it("redacts every public text field at construction and mapping boundaries", () => {
    const secret = credentialSample("sk-", "abcdefghijklmnopqrstuvwxyz123456");
    const error = new JokoError({
      code: secret,
      phase: "dispatch",
      message: `Request failed at C:\\Users\\owner\\private\\request.json with ${secret}`,
      retryable: false,
      stateMayHaveChanged: false,
      recovery: `Inspect /home/owner/private/log.txt with token=${secret}`
    });
    expect(error.publicError.code).toBe("internal_error");
    expect(error.publicError.message).not.toContain(secret);
    expect(error.publicError.message).not.toContain("owner");
    expect(error.publicError.recovery).not.toContain(secret);
    expect(error.publicError.recovery).not.toContain("/home/");
    expect(toPublicError(error, {
      code: "fallback",
      phase: "fallback",
      retryable: false,
      stateMayHaveChanged: false,
      recovery: "Open diagnostics."
    })).toEqual(error.publicError);
  });

  it("bounds public messages and recovery guidance", () => {
    const sanitized = sanitizePublicError({
      code: "UPSTREAM_FAILURE",
      phase: "dispatch",
      message: "m".repeat(4_096),
      retryable: true,
      stateMayHaveChanged: false,
      recovery: "r".repeat(2_048)
    });
    expect(sanitized.message).toHaveLength(2_048);
    expect(sanitized.recovery).toHaveLength(1_024);
  });
});
