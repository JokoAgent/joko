import { beforeEach, describe, expect, it } from "vitest";
import type { ErrorView, ScheduleDraft, SessionView } from "./model.js";
import {
  buildUsageLimitScheduleDraft,
  consumeUsageLimitScheduleIntent,
  providerAccountUsageResetAt,
  stageUsageLimitScheduleIntent,
  usageLimitRecoveryHint
} from "./usage-limit-recovery.js";

const NOW = Date.parse("2026-08-26T10:00:00.000Z");

beforeEach(() => { consumeUsageLimitScheduleIntent(); });

describe("usage-limit recovery", () => {
  it("uses only the reached primary account window", () => {
    expect(providerAccountUsageResetAt([
      providerUsage(100, NOW + 3_600_000, 42, NOW + 7_200_000)
    ], "provider-one", NOW)).toBe(NOW + 3_600_000);
  });

  it("uses only the reached secondary account window", () => {
    expect(providerAccountUsageResetAt([
      providerUsage(42, NOW + 3_600_000, 100, NOW + 7_200_000)
    ], "provider-one", NOW)).toBe(NOW + 7_200_000);
  });

  it("waits for every simultaneously reached account window to reset", () => {
    expect(providerAccountUsageResetAt([
      providerUsage(100, NOW + 3_600_000, 99.9999999, NOW + 7_200_000)
    ], "provider-one", NOW)).toBe(NOW + 7_200_000);
  });

  it("does not substitute an unrelated window when no specific account window is reached", () => {
    expect(providerAccountUsageResetAt([
      providerUsage(42, NOW + 3_600_000, 75, NOW + 7_200_000)
    ], "provider-one", NOW)).toBeUndefined();
  });

  it("extracts a conservative reset hint and excludes billing depletion", () => {
    expect(usageLimitRecoveryHint(error("usage_limit_reached; try again in 1 h 5 min"), NOW))
      .toEqual({ resetAtMs: NOW + 3_900_000 });
    expect(usageLimitRecoveryHint(error("insufficient_quota: add billing credits"), NOW)).toBeNull();
    expect(usageLimitRecoveryHint(error("temporary server overloaded"), NOW)).toBeNull();
  });

  it("prefers a future Provider-authoritative reset over text inference", () => {
    expect(usageLimitRecoveryHint(
      error("usage_limit_reached; try again in 5 min"),
      NOW,
      NOW + 3_600_000
    )).toEqual({ resetAtMs: NOW + 3_600_000 });
    expect(usageLimitRecoveryHint(
      error("usage_limit_reached; try again in 5 min"),
      NOW,
      NOW - 1
    )).toEqual({ resetAtMs: NOW + 300_000 });
  });

  it("consumes the navigation intent exactly once", () => {
    const staged = stageUsageLimitScheduleIntent("session-one", { resetAtMs: NOW + 60_000 });
    expect(consumeUsageLimitScheduleIntent()).toEqual(staged);
    expect(consumeUsageLimitScheduleIntent()).toBeUndefined();
  });

  it("prefills a bound one-shot task at reset plus one minute", () => {
    const draft = buildUsageLimitScheduleDraft(
      baseDraft(),
      { requestId: "request-one", sessionId: "session-one", resetAtMs: NOW + 60_000 },
      session(),
      { name: "Continue after reset", prompt: "Continue this task from where it stopped." },
      NOW
    );
    expect(draft).toMatchObject({
      name: "Continue after reset",
      sessionMode: "bound",
      sessionId: "session-one",
      kind: "once",
      expression: "2026-08-26T10:02",
      targetId: "target-one",
      providerId: "provider-one",
      modelId: "model-one"
    });
  });
});

function error(message: string): ErrorView {
  return { code: "PROVIDER_REQUEST_FAILED", message, phase: "stream", severity: "blocked", retryable: false, recovery: [] };
}

function providerUsage(
  primaryUsedPercent: number,
  primaryResetAt: number,
  secondaryUsedPercent: number,
  secondaryResetAt: number
) {
  return {
    backendId: "backend-one",
    id: "provider-one",
    name: "Provider",
    kind: "subscription" as const,
    compatibility: "native" as const,
    authenticationState: "authenticated" as const,
    endpoint: "",
    ownerManaged: true,
    supportsLogin: true,
    loginMethods: ["subscription" as const],
    supportsLogout: true,
    supportsRefresh: true,
    credentialSurfaces: [],
    capabilities: new Set(["provider.account_usage"]),
    accountUsage: {
      primaryWindow: { usedPercent: primaryUsedPercent, resetAt: primaryResetAt },
      secondaryWindow: { usedPercent: secondaryUsedPercent, resetAt: secondaryResetAt },
      limitReached: true
    }
  };
}

function session(): SessionView {
  return {
    id: "session-one",
    backendId: "backend-one",
    targetId: "target-one",
    name: "Task",
    state: "error",
    pinned: false,
    archived: false,
    permissionMode: "ask",
    planMode: false,
    fastMode: false,
    model: { providerId: "provider-one", modelId: "model-one", label: "Model", available: true, efforts: [] },
    revision: 1n
  } as unknown as SessionView;
}

function baseDraft(): ScheduleDraft {
  return {
    name: "",
    backendId: "",
    targetId: "",
    sessionMode: "fresh",
    sessionId: "",
    enabled: true,
    kind: "manual",
    expression: "",
    timezone: "UTC",
    inputText: "",
    executionMode: "agent",
    scriptCommand: "",
    scriptDispatchSessions: false,
    providerId: "",
    modelId: "",
    fastMode: false,
    permissionMode: "ask",
    planMode: false,
    useWorktree: false,
    refreshWorktreeRemote: false,
    extraDirectoryIds: [],
    silentWhenIdle: false,
    notifyDesktop: true,
    expireAtExpression: "",
    overlapPolicy: "queue",
    misfirePolicy: "runOnce"
  };
}
