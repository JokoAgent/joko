import { describe, expect, it } from "vitest";
import type { PublicError } from "@joko/core";
import {
  currentProviderRateLimit,
  providerRateLimitFromError,
  providerRateLimitSettingKey
} from "./provider-rate-limit.js";

const NOW = 1_788_000_000_000;

describe("Provider rate-limit observations", () => {
  it("keeps dotted Backend and Provider identities collision-free", () => {
    expect(providerRateLimitSettingKey("runtime.a", "provider"))
      .not.toBe(providerRateLimitSettingKey("runtime", "a.provider"));
  });

  it("retains only a future structured reset timestamp", () => {
    expect(providerRateLimitFromError(failure(
      'Request rejected: {"type":"usage_limit_reached","resets_at":1788003600}'
    ), NOW)).toEqual({ limited: true, resetsAt: NOW + 3_600_000, observedAt: NOW });
  });

  it("normalizes a friendly relative retry without retaining its text", () => {
    expect(providerRateLimitFromError(failure(
      "You have hit your account usage limit. Try again in ~1 h 7 min."
    ), NOW)).toEqual({ limited: true, resetsAt: NOW + 4_020_000, observedAt: NOW });
  });

  it.each([
    "insufficient_quota: add billing credits",
    "The upstream service is at capacity",
    "server overloaded"
  ])("does not classify billing or overload failures: %s", (message) => {
    expect(providerRateLimitFromError(failure(message), NOW)).toBeUndefined();
  });

  it("expires a limited observation at its reset fence", () => {
    const stored = { limited: true, resetsAt: NOW + 1_000, observedAt: NOW };
    expect(currentProviderRateLimit(stored, NOW + 999)).toEqual(stored);
    expect(currentProviderRateLimit(stored, NOW + 1_000)).toBeUndefined();
  });
});

function failure(message: string): PublicError {
  return {
    code: "PI_PROVIDER_REQUEST_FAILED",
    message,
    phase: "stream",
    retryable: false,
    stateMayHaveChanged: false,
    recovery: "Retry after the Provider quota resets."
  };
}
