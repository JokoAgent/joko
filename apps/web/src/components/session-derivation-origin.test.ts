import { describe, expect, it } from "vitest";

import type { SessionView } from "../model.js";
import { sessionDerivationOriginRoute } from "./session-derivation-origin.js";

describe("session derivation origin navigation", () => {
  it("routes only to the exact currently visible source and message identity", () => {
    expect(sessionDerivationOriginRoute(origin(), [session()])).toEqual({
      kind: "session",
      sessionId: "source-task",
      messageId: "source-message",
      messageEventId: "source-event"
    });

    expect(sessionDerivationOriginRoute({
      ...origin(),
      kind: "clone",
      sourceMessageId: undefined,
      sourceEventId: undefined,
      sourceMessageAvailable: false
    }, [session()])).toEqual({ kind: "session", sessionId: "source-task" });
  });

  it.each([
    ["service unavailable", { origin: { ...origin(), sourceSessionAvailable: false }, sessions: [session()] }],
    ["message unavailable", { origin: { ...origin(), sourceMessageAvailable: false }, sessions: [session()] }],
    ["source absent", { origin: origin(), sessions: [] }],
    ["source archived", { origin: origin(), sessions: [{ ...session(), archived: true }] }],
    ["source closed", { origin: origin(), sessions: [{ ...session(), state: "closed" as const }] }],
    ["missing event identity", { origin: { ...origin(), sourceEventId: undefined }, sessions: [session()] }],
    ["missing message identity", { origin: { ...origin(), sourceMessageId: undefined }, sessions: [session()] }]
  ] as const)("fails closed when the %s fence is not current", (_name, input) => {
    expect(sessionDerivationOriginRoute(input.origin, input.sessions)).toBeUndefined();
  });
});

function origin(): NonNullable<SessionView["derivationOrigin"]> {
  return {
    kind: "fork",
    sourceSessionId: "source-task",
    sourceMessageId: "source-message",
    sourceEventId: "source-event",
    sourceSessionAvailable: true,
    sourceMessageAvailable: true
  };
}

function session(): SessionView {
  return {
    id: "source-task",
    backendId: "backend",
    targetId: "target",
    name: "Source",
    state: "idle",
    pinned: false,
    archived: false,
    generation: 1n,
    fastMode: false,
    permissionMode: "ask",
    planMode: false,
    updatedAt: 1
  };
}
