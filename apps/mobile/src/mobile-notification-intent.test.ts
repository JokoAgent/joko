import { describe, expect, it } from "vitest";

import {
  mobileNotificationResponseKey,
  parseMobileNotificationResponseIntent
} from "./mobile-notification-intent";

function response(data: unknown, payload?: unknown, identifier = "notification-1") {
  return {
    notification: {
      request: {
        identifier,
        content: { data },
        trigger: { payload }
      }
    }
  };
}

describe("mobile notification public intent", () => {
  it("accepts only portable public task intents from either Expo response outlet", () => {
    const intent = "joko://task/session-1?message=message-1&event=event-1";
    expect(parseMobileNotificationResponseIntent(response({ intent }))).toBe(intent);
    expect(parseMobileNotificationResponseIntent(response({}, { intent }))).toBe(intent);
  });

  it("rejects privileged, profile-bound, non-task, malformed, and recursively wrapped data", () => {
    for (const value of [
      "joko://task/session-1?profile=profile-1",
      "joko://settings",
      "joko://app/session-1",
      "https://example.test/task/session-1",
      " joko://task/session-1"
    ]) expect(parseMobileNotificationResponseIntent(response({ intent: value }))).toBeUndefined();
    expect(parseMobileNotificationResponseIntent(response({ data: { intent: "joko://task/session-1" } }))).toBeUndefined();
    expect(parseMobileNotificationResponseIntent(response({ intent: 1 }))).toBeUndefined();
  });

  it("uses a bounded native identifier and otherwise deduplicates by the validated intent", () => {
    const intent = "joko://task/session-1";
    expect(mobileNotificationResponseKey(response({ intent }, undefined, "native-1"), intent)).toBe("id:native-1");
    expect(mobileNotificationResponseKey(response({ intent }, undefined, "x".repeat(257)), intent)).toBe(`intent:${intent}`);
  });
});
