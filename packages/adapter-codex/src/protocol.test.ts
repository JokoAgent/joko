import { describe, expect, it } from "vitest";
import {
  commandApprovalAvailability,
  parseAccountRateLimits,
  parseModels,
  parseThreadList,
  parseThreadResult,
  parseFullTurnPage,
  parseTurnSteer,
  type JsonValue
} from "./protocol.js";

describe("Codex stable protocol guards", () => {
  it("preserves the published history mode and rejects unknown or null modes", () => {
    for (const historyMode of ["paginated", "legacy"] as const) {
      expect(parseThreadResult({ thread: { id: "thread", turns: [], historyMode } }).historyMode).toBe(historyMode);
    }
    expect(parseThreadResult({ thread: { id: "thread", turns: [] } }).historyMode).toBe("legacy");
    for (const historyMode of [null, "unknown", 1]) expect(() => parseThreadResult({ thread: { id: "thread", turns: [], historyMode } })).toThrow();
  });
  it("accepts only bounded complete turn pages and preserves opaque direction cursors", () => {
    const turn = { id: "turn", status: "completed", items: [{ type: "agentMessage", id: "item", text: "complete" }] };
    const bounds = { maximumTurns: 1, maximumItems: 1 };
    for (const full of [turn, { ...turn, itemsView: "full" }]) {
      expect(parseFullTurnPage({ data: [full], nextCursor: "opaque-next", backwardsCursor: "opaque-anchor" }, bounds))
        .toMatchObject({ turns: [turn], nextCursor: "opaque-next", backwardsCursor: "opaque-anchor" });
    }
    for (const incomplete of ["summary", "notLoaded", null, "unknown"]) {
      expect(() => parseFullTurnPage({ data: [{ ...turn, itemsView: incomplete }] }, bounds)).toThrow();
    }
    const malformedPages: JsonValue[] = [
      { data: [{ id: "turn", status: "completed" }] },
      { data: [{ ...turn, id: "unsafe\u0000id" }] },
      { data: [turn, { ...turn, id: "turn-two" }] },
      { data: [{ ...turn, items: [...turn.items, { type: "agentMessage", id: "two" }] }] },
      { data: [turn], nextCursor: "" },
      { data: [], nextCursor: "unproven-continuation" },
      { data: [turn], backwardsCursor: 3 }
    ];
    for (const malformed of malformedPages) expect(() => parseFullTurnPage(malformed, bounds)).toThrow();
    expect(parseFullTurnPage({ data: [], nextCursor: null, backwardsCursor: null }, bounds)).toEqual({ turns: [] });
  });

  it("bounds model and thread pages to the requested page size", () => {
    const model = {
      id: "record-one",
      model: "model-one",
      displayName: "Model One",
      hidden: false,
      supportedReasoningEfforts: [],
      inputModalities: ["text"],
      serviceTiers: [],
      isDefault: true
    };
    expect(() => parseModels({ data: [model, { ...model, id: "record-two" }], nextCursor: null }, 1))
      .toThrow("incompatible stable protocol shape");
    expect(() => parseThreadList({
      data: [
        { id: "thread-one", turns: [] },
        { id: "thread-two", turns: [] }
      ],
      nextCursor: null
    }, 1)).toThrow("incompatible stable protocol shape");
  });

  it("rejects non-string pagination cursors and malformed steer results", () => {
    expect(() => parseModels({ data: [], nextCursor: 7 })).toThrow("incompatible stable protocol shape");
    expect(() => parseThreadList({ data: [], nextCursor: "" })).toThrow("incompatible stable protocol shape");
    expect(() => parseTurnSteer({ turn: { id: "turn-one" } })).toThrow("incompatible stable protocol shape");
    expect(parseTurnSteer({ turnId: "turn-one" })).toBe("turn-one");
  });

  it("recognizes only scalar command decisions implemented by the adapter", () => {
    expect(commandApprovalAvailability(undefined)).toEqual({
      explicit: false,
      malformed: false,
      decisions: ["accept", "cancel"]
    });
    expect(commandApprovalAvailability(undefined, { networkApprovalContext: { host: "example.com" } })).toEqual({
      explicit: false,
      malformed: false,
      decisions: ["accept", "acceptForSession", "cancel"]
    });
    expect(commandApprovalAvailability([
      "accept",
      { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["git", "status"] } },
      "decline",
      "accept"
    ])).toEqual({
      explicit: true,
      malformed: false,
      decisions: ["accept", "decline"]
    });
    expect(commandApprovalAvailability(["unknown"])).toMatchObject({ malformed: true, decisions: [] });
    expect(commandApprovalAvailability([{ futureDecision: {} }, "decline"]))
      .toMatchObject({ malformed: true, decisions: [] });
    expect(commandApprovalAvailability(undefined, { networkApprovalContext: "invalid" }))
      .toMatchObject({ malformed: true, decisions: [] });
  });

  it("normalizes only bounded provider-level account quota fields", () => {
    expect(parseAccountRateLimits({
      rateLimits: {
        planType: "  plus  ",
        primary: { usedPercent: 125, windowDurationMins: 300, resetsAt: 1_800_000_000 },
        secondary: { usedPercent: -5, windowMinutes: 10_080, windowDurationMins: 60 },
        credits: { hasCredits: true, unlimited: false, balance: "  12.5  " },
        rateLimitReachedType: "rate_limit_reached",
        upstreamOnly: { credential: "must-not-project" }
      },
      rateLimitsByLimitId: {
        unrelated: { primary: { usedPercent: 99, windowMinutes: 60 } }
      },
      rateLimitResetCredits: { availableCount: 7 }
    }, 1_700_000_000_000)).toEqual({
      primaryWindow: { usedPercent: 100, windowMinutes: 300, resetAt: 1_800_000_000_000 },
      secondaryWindow: { usedPercent: 0, windowMinutes: 10_080 },
      limitReached: true,
      planType: "plus",
      credits: { hasCredits: true, unlimited: false, balance: "12.5", observedAt: 1_700_000_000_000 },
      observedAt: 1_700_000_000_000
    });
  });

  it("rejects malformed or unbounded account quota fields", () => {
    expect(() => parseAccountRateLimits({ rateLimits: [] }, 1)).toThrow("incompatible stable protocol shape");
    expect(() => parseAccountRateLimits({
      rateLimits: { primary: { usedPercent: 10, windowMinutes: 10 * 366 * 24 * 60 + 1 } }
    }, 1)).toThrow("incompatible stable protocol shape");
    expect(() => parseAccountRateLimits({
      rateLimits: { planType: "x".repeat(129) }
    }, 1)).toThrow("incompatible stable protocol shape");
    expect(() => parseAccountRateLimits({ rateLimits: {} }, 1)).toThrow("incompatible stable protocol shape");
  });
});
