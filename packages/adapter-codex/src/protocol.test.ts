import { describe, expect, it } from "vitest";
import {
  commandApprovalAvailability,
  parseAccountRateLimits,
  parseModels,
  parseThreadList,
  parseTurnSteer
} from "./protocol.js";

describe("Codex stable protocol guards", () => {
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
