import { describe, expect, it } from "vitest";

import {
  isSafeSessionRuntimeRecoveryError,
  sessionRuntimeRecoveryDelayMs
} from "./session-runtime-recovery.js";

const error = (code: string, message: string) => ({
  code,
  message,
  phase: "stream",
  retryable: false,
  stateMayHaveChanged: true,
  recovery: "Inspect the task."
});

describe("session runtime recovery", () => {
  it("allows only classified infrastructure failures", () => {
    expect(isSafeSessionRuntimeRecoveryError(error("UPSTREAM_OVERLOAD", "at capacity"))).toBe(true);
    expect(isSafeSessionRuntimeRecoveryError(error("PI_RETRY_EXHAUSTED", "socket hang up"))).toBe(true);
    expect(isSafeSessionRuntimeRecoveryError(error("PI_RETRY_EXHAUSTED", "authentication failed"))).toBe(false);
    expect(isSafeSessionRuntimeRecoveryError(error("PI_RETRY_EXHAUSTED", "invalid request"))).toBe(false);
  });

  it("uses bounded exponential backoff", () => {
    expect(sessionRuntimeRecoveryDelayMs(1, () => 0.5)).toBe(3_000);
    expect(sessionRuntimeRecoveryDelayMs(2, () => 0.5)).toBe(6_000);
    expect(sessionRuntimeRecoveryDelayMs(8, () => 1)).toBe(20_000);
  });
});
