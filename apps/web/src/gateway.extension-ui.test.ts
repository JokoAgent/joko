import { create } from "@bufbuild/protobuf";
import {
  EventSchema,
  ExtensionNotificationKind,
  ExtensionUiEffectKind,
  type Event
} from "@joko/contracts";
import { describe, expect, it } from "vitest";

import {
  extensionUiEffect,
  transientUiEffectContinuitySafe
} from "./gateway.js";

describe("extension UI gateway truth", () => {
  it.each([
    [ExtensionNotificationKind.INFO, "info"],
    [ExtensionNotificationKind.WARNING, "warning"],
    [ExtensionNotificationKind.ERROR, "error"],
    [ExtensionNotificationKind.UNSPECIFIED, "unknown"]
  ] as const)("maps notification severity %s without replacing the public redacted body", (kind, expected) => {
    expect(extensionUiEffect(notificationEvent(kind))).toEqual({
      eventId: `notify-${kind}`,
      sessionId: "session-a",
      kind: "notification",
      notificationKind: expected,
      text: "[redacted notification]"
    });
  });

  it("publishes one-shot UI effects only across a proven contiguous stream edge", () => {
    expect(transientUiEffectContinuitySafe("contiguous")).toBe(true);
    expect(transientUiEffectContinuitySafe("duplicate")).toBe(false);
    expect(transientUiEffectContinuitySafe("gap")).toBe(false);
    expect(transientUiEffectContinuitySafe("generationChanged")).toBe(false);
    expect(transientUiEffectContinuitySafe("missingCursor")).toBe(false);
  });
});

function notificationEvent(kind: ExtensionNotificationKind): Event {
  return create(EventSchema, {
    eventId: `notify-${kind}`,
    cursor: { generation: 3n, sequence: 8n },
    identity: { sessionId: "session-a", runId: "run-a" },
    payload: {
      kind: {
        case: "extensionUiEffect",
        value: {
          kind: ExtensionUiEffectKind.NOTIFICATION,
          text: "[redacted notification]",
          notificationKind: kind
        }
      }
    }
  });
}
