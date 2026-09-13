import { describe, expect, it } from "vitest";

import { isPiCompactionNoopEvent, isPiCompactionNoopRejection } from "./compaction.js";
import { piError } from "./errors.js";

describe("Pi compaction no-op classification", () => {
  it.each([
    "Already compacted",
    "Nothing to compact (session too small)"
  ])("accepts the exact upstream rejection %j", (message) => {
    expect(isPiCompactionNoopRejection(piError("PI_RPC_REJECTED", message, "dispatch"))).toBe(true);
    expect(isPiCompactionNoopEvent({
      reason: "manual",
      aborted: false,
      willRetry: false,
      errorMessage: `Compaction failed: ${message}`
    })).toBe(true);
  });

  it("does not turn broad provider or protocol failures into no-ops", () => {
    expect(isPiCompactionNoopRejection(piError("PI_RPC_REJECTED", "Provider context too small", "dispatch"))).toBe(false);
    expect(isPiCompactionNoopRejection(piError("PI_PROTOCOL_COMMAND_MISMATCH", "Nothing to compact (session too small)", "stream"))).toBe(false);
    expect(isPiCompactionNoopEvent({
      reason: "manual",
      result: undefined,
      aborted: false,
      willRetry: false,
      errorMessage: "Compaction failed: Provider context too small"
    })).toBe(false);
    expect(isPiCompactionNoopEvent({
      reason: "manual",
      result: { summary: "authoritative result" },
      aborted: false,
      willRetry: false,
      errorMessage: "Compaction failed: Already compacted"
    })).toBe(false);
  });
});
