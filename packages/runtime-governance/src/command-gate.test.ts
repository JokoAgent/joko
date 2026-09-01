import { describe, expect, it, vi } from "vitest";

import { createCommandConcurrencyGate } from "./command-gate.js";

describe("command concurrency gate", () => {
  it("is global, strict FIFO across sessions, and reacts to a raised limit", async () => {
    let maximum = 1;
    const gate = createCommandConcurrencyGate({ readMaximum: () => maximum, repumpIntervalMs: 5 });
    await expect(gate.acquire({ commandId: "a", sessionId: "one" })).resolves.toBe("immediate");
    const second = gate.acquire({ commandId: "b", sessionId: "two" });
    const third = gate.acquire({ commandId: "c", sessionId: "one" });
    expect(gate.snapshot()).toEqual({ running: 1, queued: 2 });
    gate.release("a", "done");
    await expect(second).resolves.toBe("queued");
    expect(gate.snapshot()).toEqual({ running: 1, queued: 1 });
    maximum = 2;
    await expect(third).resolves.toBe("queued");
    gate.close();
  });

  it("treats zero as unlimited while retaining running leases", async () => {
    const gate = createCommandConcurrencyGate({ readMaximum: () => 0 });
    await Promise.all([
      gate.acquire({ commandId: "a", sessionId: "one" }),
      gate.acquire({ commandId: "b", sessionId: "two" })
    ]);
    expect(gate.snapshot()).toEqual({ running: 2, queued: 0 });
    gate.close();
  });

  it("removes aborted waiters and releases all leases for a session", async () => {
    const gate = createCommandConcurrencyGate({ readMaximum: () => 1 });
    await gate.acquire({ commandId: "a", sessionId: "one" });
    const abort = new AbortController();
    const waiting = gate.acquire({ commandId: "b", sessionId: "two", signal: abort.signal });
    abort.abort();
    await expect(waiting).resolves.toBe("aborted");
    gate.releaseSession("one", "closed");
    expect(gate.snapshot()).toEqual({ running: 0, queued: 0 });
    gate.close();
  });

  it("fails open after the bounded wait instead of deadlocking forever", async () => {
    vi.useFakeTimers();
    try {
      const gate = createCommandConcurrencyGate({ readMaximum: () => 1, maximumWaitMs: 25, repumpIntervalMs: 5 });
      await gate.acquire({ commandId: "a", sessionId: "one" });
      const waiting = gate.acquire({ commandId: "b", sessionId: "two" });
      await vi.advanceTimersByTimeAsync(25);
      await expect(waiting).resolves.toBe("wait_timeout");
      expect(gate.snapshot()).toEqual({ running: 2, queued: 0 });
      gate.close();
    } finally {
      vi.useRealTimers();
    }
  });
});
