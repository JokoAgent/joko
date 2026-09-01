import { describe, expect, it } from "vitest";
import { BrowserLeaseConflictError, BrowserLeaseRegistry, type BrowserLeaseFence } from "./leases.js";

describe("BrowserLeaseRegistry", () => {
  it("renews an identical full binding and fences stale generations", () => {
    let now = 1_000;
    const leases = new BrowserLeaseRegistry(() => now);
    const binding = { providerId: "provider-a", owner: "session-a", generation: 3 };
    const first = leases.acquire(binding, 5_000);
    now += 500;
    expect(leases.acquire(binding, 5_000).id).toBe(first.id);
    leases.fence(4);
    expect(leases.current()).toBeUndefined();
  });

  it("rejects every mismatched agent fence component", () => {
    const leases = new BrowserLeaseRegistry(() => 10_000);
    const lease = leases.acquire({ providerId: "provider-a", owner: "session-a", generation: 1 }, 5_000);
    const mutations: readonly BrowserLeaseFence[] = [
      { ...lease, id: "wrong-lease" },
      { ...lease, providerId: "provider-b" },
      { ...lease, owner: "session-b" },
      { ...lease, generation: 2 }
    ];
    for (const fence of mutations) {
      expect(() => leases.assert(fence)).toThrow(BrowserLeaseConflictError);
      expect(() => leases.release(fence)).toThrow(BrowserLeaseConflictError);
    }
    expect(leases.current()).toEqual(lease);
  });

  it("prevents different agent owners from overlapping", () => {
    const leases = new BrowserLeaseRegistry(() => 10_000);
    leases.acquire({ providerId: "provider-a", owner: "owner", generation: 1 }, 5_000);
    expect(() => leases.acquire({ providerId: "provider-a", owner: "session", generation: 1 }, 5_000))
      .toThrow(BrowserLeaseConflictError);
  });

  it("expires leases", () => {
    let now = 1_000;
    const leases = new BrowserLeaseRegistry(() => now);
    leases.acquire({ providerId: "provider-a", owner: "session", generation: 1 }, 1_000);
    now = 2_000;
    expect(leases.current()).toBeUndefined();
  });
});
