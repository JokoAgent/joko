import { create } from "@bufbuild/protobuf";
import { SessionDerivationKind, SessionDerivationOriginSchema, SessionSchema, SessionState } from "@joko/contracts";
import { describe, expect, it } from "vitest";
import { mobileSessionOriginKey, projectMobileSessionOrigin } from "./mobile-session-origin";

const source = create(SessionSchema, { sessionId: "source", state: SessionState.IDLE });
const child = create(SessionSchema, { sessionId: "child", derivationOrigin: {
  kind: SessionDerivationKind.FORK, sourceSessionId: "source", sourceMessageId: "message", sourceEventId: "event",
  sourceSessionAvailable: true, sourceMessageAvailable: true
} });

describe("native Session origin availability", () => {
  it("preserves immutable fork and clone markers while only exact current service availability grants a candidate", () => {
    expect(projectMobileSessionOrigin(create(SessionSchema), [])).toBeUndefined();
    expect(projectMobileSessionOrigin(child, [source])).toMatchObject({ kind: "fork", canOpen: true,
      source: { sessionId: "source", messageId: "message", eventId: "event" } });
    const clone = create(SessionSchema, { ...child, derivationOrigin: create(SessionDerivationOriginSchema, {
      kind: SessionDerivationKind.CLONE, sourceSessionId: "source", sourceSessionAvailable: true
    }) });
    expect(projectMobileSessionOrigin(clone, [source])).toMatchObject({ kind: "clone", canOpen: true, source: { sessionId: "source" } });
    const unavailable = create(SessionDerivationOriginSchema, { ...child.derivationOrigin!, sourceSessionAvailable: false });
    expect(mobileSessionOriginKey(unavailable)).toBe(mobileSessionOriginKey(child.derivationOrigin));
    for (const origin of [unavailable, create(SessionDerivationOriginSchema, { ...child.derivationOrigin!, sourceMessageAvailable: false }),
      create(SessionDerivationOriginSchema, { ...child.derivationOrigin!, sourceEventId: undefined }),
      create(SessionDerivationOriginSchema, { ...child.derivationOrigin!, sourceMessageId: "" }),
      create(SessionDerivationOriginSchema, { ...child.derivationOrigin!, sourceSessionId: "child" }),
      create(SessionDerivationOriginSchema, { ...child.derivationOrigin!, sourceSessionId: "bad\n" }),
      create(SessionDerivationOriginSchema, { ...child.derivationOrigin!, sourceSessionId: "a".repeat(257) }),
      create(SessionDerivationOriginSchema, { ...child.derivationOrigin!, kind: SessionDerivationKind.UNSPECIFIED })]) {
      expect(projectMobileSessionOrigin(create(SessionSchema, { ...child, derivationOrigin: origin }), [source])?.canOpen).toBe(false);
    }
    for (const sources of [[], [source, source], [create(SessionSchema, { ...source, archived: true })],
      ...[SessionState.UNSPECIFIED, SessionState.ARCHIVED, SessionState.CLOSING, SessionState.CLOSED]
        .map((state) => [create(SessionSchema, { ...source, state })])]) {
      expect(projectMobileSessionOrigin(child, sources)).toMatchObject({ kind: "fork", canOpen: false });
    }
  });
});
